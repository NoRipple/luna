/* 主要职责：承载常驻 Agent 运行时，包括任务调度、休眠唤醒、UI 状态汇总和 runtime adapter 装配。 */
const config = require('../config/runtimeConfig');
const { spawn } = require('child_process');

class AgentRuntime {
    constructor({
        llmService,
        screenSensor,
        visionService,
        live2dModelService,
        buildSerializedLive2DCapabilities,
        getLive2DConfigFallback,
        enqueueTtsJob,
        createRealtimeAsrService,
        listenCaptureService,
        onStateChanged
    }) {
        this.llmService = llmService;
        this.screenSensor = screenSensor;
        this.visionService = visionService;
        this.live2dModelService = live2dModelService;
        this.buildSerializedLive2DCapabilities = buildSerializedLive2DCapabilities;
        this.getLive2DConfigFallback = getLive2DConfigFallback;
        this.enqueueTtsJob = enqueueTtsJob;
        this.createRealtimeAsrService = typeof createRealtimeAsrService === 'function'
            ? createRealtimeAsrService
            : null;
        this.listenCaptureService = listenCaptureService || null;
        this.onStateChanged = typeof onStateChanged === 'function' ? onStateChanged : () => {};

        this.nextUiTaskId = 1;
        this.taskQueue = [];
        this.activeTask = null;
        this.uiHistory = [];
        this.historyByTaskId = new Map();
        this.uiChatRecords = [];
        this.chatRecordByTaskId = new Map();
        this.recentPerceptions = [];
        this.timelineEvents = [];
        this.timelineSeq = 0;
        this.latestPerceptionState = {
            status: 'idle',
            summary: '暂无感知结果',
            detail: '',
            updatedAt: null
        };
        this.latestPanelNote = '';
        this.unsubscribeTodoState = null;
        this.autonomousWakeTimer = null;
        this.nextAutonomousWakeAt = null;
        this.activeSleepTimelineEventId = null;
        this.activeSpeakTimelineEventId = null;
        this.autonomousSleepMinSeconds = Math.max(1, Number(config.core?.autonomousSleepMinSeconds) || 5);
        this.autonomousSleepMaxSeconds = Math.max(
            this.autonomousSleepMinSeconds,
            Number(config.core?.autonomousSleepMaxSeconds) || 60
        );
        this.maxSubagentConcurrency = Math.max(1, Number(config.core?.maxSubagentConcurrency) || 2);
        this.subagentActiveCount = 0;
        this.subagentWaitQueue = [];
        this.subagentChannels = new Map();
        this.nextSubagentSeq = 1;
        this.backgroundTasks = new Map();
        this.backgroundTaskNotifications = [];
        this.nextBackgroundTaskSeq = 1;
        this.maxBackgroundTaskHistory = 120;
        this.maxBackgroundTaskNotifications = 120;
        this.latestCompactionBoundary = null;
    }

    bindTodoStateUpdates() {
        if (this.unsubscribeTodoState || !this.llmService.onTodoStateChanged) {
            return;
        }

        this.unsubscribeTodoState = this.llmService.onTodoStateChanged(() => {
            const todoState = this.llmService.getTodoState
                ? this.llmService.getTodoState()
                : { items: [] };
            const openCount = Array.isArray(todoState.items)
                ? todoState.items.filter((item) => item.status !== 'completed').length
                : 0;
            const createdAt = Date.now();
            this.appendTimelineEvent({
                lane: 'tool',
                kind: 'todo',
                status: 'done',
                title: 'todo',
                detail: openCount > 0 ? `当前仍有 ${openCount} 项未完成 todo。` : '当前 todo 已全部完成或为空。',
                relatedTaskId: this.activeTask?.id ?? null,
                createdAt,
                startedAt: createdAt - 120,
                durationMs: 120
            });
            this.emitUiHistoryUpdate();
        });
    }

    dispose() {
        this.clearAutonomousWakeTimer();
        if (typeof this.unsubscribeTodoState === 'function') {
            this.unsubscribeTodoState();
        }
        this.unsubscribeTodoState = null;
    }

    summarizeText(text, maxLen = 80) {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (!normalized) return '';
        if (normalized.length <= maxLen) return normalized;
        return `${normalized.slice(0, maxLen - 1)}…`;
    }

    makeSubagentReasonLabel({ description, prompt } = {}) {
        const reason = this.summarizeText(description || '', 42);
        if (reason) return reason;
        const promptSummary = this.summarizeText(prompt || '', 42);
        return promptSummary || '未命名子任务';
    }

    createSubagentChannel({ description, prompt } = {}) {
        const channelId = `subagent-${Date.now()}-${this.nextSubagentSeq++}`;
        const label = this.makeSubagentReasonLabel({ description, prompt });
        const now = Date.now();
        const channel = {
            id: channelId,
            name: label,
            type: 'subagent',
            status: 'queued',
            createdAt: now,
            updatedAt: now
        };
        this.subagentChannels.set(channelId, channel);
        return channel;
    }

    updateSubagentChannel(channelId, patch = {}) {
        const channel = this.subagentChannels.get(channelId);
        if (!channel) return null;
        Object.assign(channel, patch, { updatedAt: Date.now() });
        return channel;
    }

    removeSubagentChannel(channelId) {
        if (!channelId) return;
        this.subagentChannels.delete(channelId);
    }

    getTimelineChannelsSnapshot() {
        const channels = [
            {
                id: 'main',
                name: '主线程',
                type: 'main',
                status: 'running',
                createdAt: 0,
                updatedAt: Date.now()
            }
        ];
        for (const channel of this.subagentChannels.values()) {
            channels.push({ ...channel });
        }
        return channels;
    }

    async acquireSubagentSlot() {
        if (this.subagentActiveCount < this.maxSubagentConcurrency) {
            this.subagentActiveCount += 1;
            return { queued: false };
        }
        await new Promise((resolve) => {
            this.subagentWaitQueue.push(resolve);
        });
        this.subagentActiveCount += 1;
        return { queued: true };
    }

    releaseSubagentSlot() {
        this.subagentActiveCount = Math.max(0, this.subagentActiveCount - 1);
        const next = this.subagentWaitQueue.shift();
        if (typeof next === 'function') {
            next();
        }
    }

    createBackgroundTask({ prompt, description, relatedTaskId, kind = 'task' } = {}) {
        const now = Date.now();
        const taskId = `bg-${now}-${this.nextBackgroundTaskSeq++}`;
        const record = {
            taskId,
            kind: String(kind || 'task'),
            status: 'queued',
            promptSummary: this.summarizeText(prompt || '', 120),
            description: this.summarizeText(description || '', 72),
            relatedTaskId: relatedTaskId ?? null,
            channelId: '',
            channelName: '',
            summary: '',
            rawText: '',
            error: '',
            rounds: 0,
            toolCalls: 0,
            stoppedByRoundLimit: false,
            createdAt: now,
            startedAt: null,
            finishedAt: null,
            updatedAt: now
        };
        this.backgroundTasks.set(taskId, record);
        while (this.backgroundTasks.size > this.maxBackgroundTaskHistory) {
            const oldestTaskId = this.backgroundTasks.keys().next().value;
            if (!oldestTaskId) break;
            this.backgroundTasks.delete(oldestTaskId);
        }
        return record;
    }

    updateBackgroundTask(taskId, patch = {}) {
        const record = this.backgroundTasks.get(taskId);
        if (!record) return null;
        Object.assign(record, patch, { updatedAt: Date.now() });
        return record;
    }

    buildBackgroundTaskSnapshot(record, options = {}) {
        if (!record) return null;
        const includeRawText = options.includeRawText === true;
        return {
            taskId: record.taskId,
            kind: record.kind || 'task',
            status: record.status,
            promptSummary: record.promptSummary,
            description: record.description,
            relatedTaskId: record.relatedTaskId,
            channelId: record.channelId,
            channelName: record.channelName,
            summary: record.summary,
            ...(includeRawText ? { rawText: record.rawText } : {}),
            error: record.error,
            rounds: record.rounds,
            toolCalls: record.toolCalls,
            stoppedByRoundLimit: record.stoppedByRoundLimit,
            createdAt: record.createdAt,
            startedAt: record.startedAt,
            finishedAt: record.finishedAt,
            updatedAt: record.updatedAt
        };
    }

    startBackgroundCommandTask({ command } = {}) {
        const normalizedCommand = String(command || '').trim();
        if (!normalizedCommand) {
            throw new Error('background_run.command 不能为空');
        }

        const record = this.createBackgroundTask({
            prompt: normalizedCommand,
            description: 'background_run',
            relatedTaskId: this.activeTask?.id ?? null,
            kind: 'command'
        });
        const startedAt = Date.now();
        this.updateBackgroundTask(record.taskId, {
            status: 'running',
            startedAt
        });
        const child = spawn('powershell.exe', ['-NoProfile', '-Command', normalizedCommand], {
            cwd: config.projectRoot || process.cwd(),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const maxOutputChars = 50000;
        const timeout = setTimeout(() => {
            timedOut = true;
            try {
                child.kill();
            } catch (error) {
                // ignore
            }
        }, 300000);

        child.stdout.on('data', (chunk) => {
            stdout += String(chunk || '');
            if (stdout.length > maxOutputChars) {
                stdout = stdout.slice(0, maxOutputChars);
            }
        });
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk || '');
            if (stderr.length > maxOutputChars) {
                stderr = stderr.slice(0, maxOutputChars);
            }
        });

        child.on('close', (code) => {
            clearTimeout(timeout);
            const output = `${stdout}${stderr}`.trim();
            const finishedAt = Date.now();
            const hasError = !timedOut && Number(code) !== 0;
            const status = timedOut ? 'timeout' : (hasError ? 'error' : 'completed');
            const errorMessage = hasError ? `Command exited with code ${code}` : '';
            const summaryBase = output || errorMessage || (timedOut ? 'Error: Timeout (300s)' : '(no output)');
            const snapshot = this.updateBackgroundTask(record.taskId, {
                status,
                summary: this.summarizeText(summaryBase, 180),
                rawText: output || (timedOut ? 'Error: Timeout (300s)' : ''),
                error: errorMessage,
                finishedAt
            });
            this.enqueueBackgroundNotification(snapshot);
            this.emitUiHistoryUpdate();
        });

        child.on('error', (error) => {
            clearTimeout(timeout);
            const finishedAt = Date.now();
            const snapshot = this.updateBackgroundTask(record.taskId, {
                status: 'error',
                summary: this.summarizeText(error?.message || String(error), 180),
                rawText: '',
                error: String(error?.message || error || 'unknown error'),
                finishedAt
            });
            this.enqueueBackgroundNotification(snapshot);
            this.emitUiHistoryUpdate();
        });

        return this.buildBackgroundTaskSnapshot(record);
    }

    enqueueBackgroundNotification(record) {
        if (!record) return;
        const headline = record.status === 'completed'
            ? this.summarizeText(record.summary || record.rawText || '', 180)
            : this.summarizeText(record.error || '后台任务执行失败', 180);
        this.backgroundTaskNotifications.push({
            taskId: record.taskId,
            status: record.status,
            channelName: record.channelName,
            headline: headline || '(no summary)',
            finishedAt: record.finishedAt || Date.now()
        });
        while (this.backgroundTaskNotifications.length > this.maxBackgroundTaskNotifications) {
            this.backgroundTaskNotifications.shift();
        }
    }

    drainBackgroundNotifications() {
        if (!this.backgroundTaskNotifications.length) return [];
        const notifications = this.backgroundTaskNotifications.map((item) => ({ ...item }));
        this.backgroundTaskNotifications = [];
        return notifications;
    }

    checkBackgroundTasks({ taskId } = {}) {
        const normalizedTaskId = String(taskId || '').trim();
        if (normalizedTaskId) {
            const record = this.backgroundTasks.get(normalizedTaskId);
            if (!record) {
                return {
                    ok: false,
                    error: `Unknown background task: ${normalizedTaskId}`
                };
            }
            return {
                ok: true,
                task: this.buildBackgroundTaskSnapshot(record, { includeRawText: true })
            };
        }

        const tasks = Array.from(this.backgroundTasks.values())
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .slice(0, 20)
            .map((record) => this.buildBackgroundTaskSnapshot(record));
        return {
            ok: true,
            total: this.backgroundTasks.size,
            tasks
        };
    }

    async executeSubagentTask({ normalizedPrompt, description, relatedTaskId, backgroundTaskId } = {}) {
        const channel = this.createSubagentChannel({
            description,
            prompt: normalizedPrompt
        });
        if (backgroundTaskId) {
            this.updateBackgroundTask(backgroundTaskId, {
                channelId: channel.id,
                channelName: channel.name
            });
        }
        this.appendTimelineEvent({
            lane: 'tool',
            kind: 'task',
            status: 'queued',
            title: 'task',
            detail: `创建子 Agent：${channel.name}`,
            channelId: channel.id,
            channelName: channel.name,
            relatedTaskId: relatedTaskId ?? null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            durationMs: 180
        });
        this.emitUiHistoryUpdate();

        let acquired = false;
        const startedAt = Date.now();
        try {
            await this.acquireSubagentSlot();
            acquired = true;
            if (backgroundTaskId) {
                this.updateBackgroundTask(backgroundTaskId, {
                    status: 'running',
                    startedAt
                });
            }
            this.updateSubagentChannel(channel.id, { status: 'running' });
            this.appendTimelineEvent({
                lane: 'tool',
                kind: 'task-running',
                status: 'running',
                title: 'task',
                detail: `子 Agent 开始执行：${channel.name}`,
                channelId: channel.id,
                channelName: channel.name,
                relatedTaskId: relatedTaskId ?? null,
                createdAt: Date.now(),
                startedAt: Date.now(),
                durationMs: 160
            });
            this.emitUiHistoryUpdate();

            const subagentResult = await this.llmService.runSubagentTask(normalizedPrompt, {
                timelineContext: {
                    channelId: channel.id,
                    channelName: channel.name
                }
            });
            const summary = String(subagentResult?.summary || '').trim() || '(no summary)';
            const finishedAt = Date.now();
            this.appendTimelineEvent({
                lane: 'tool',
                kind: 'task-finish',
                status: 'done',
                title: 'task',
                detail: this.summarizeText(summary, 96),
                channelId: channel.id,
                channelName: channel.name,
                relatedTaskId: relatedTaskId ?? null,
                createdAt: finishedAt,
                startedAt,
                durationMs: finishedAt - startedAt,
                result: {
                    rounds: Number(subagentResult?.rounds || 0),
                    toolCalls: Number(subagentResult?.toolCalls || 0),
                    stoppedByRoundLimit: Boolean(subagentResult?.stoppedByRoundLimit)
                }
            });
            if (backgroundTaskId) {
                const record = this.updateBackgroundTask(backgroundTaskId, {
                    status: 'completed',
                    summary,
                    rawText: String(subagentResult?.rawText || ''),
                    rounds: Number(subagentResult?.rounds || 0),
                    toolCalls: Number(subagentResult?.toolCalls || 0),
                    stoppedByRoundLimit: Boolean(subagentResult?.stoppedByRoundLimit),
                    finishedAt
                });
                this.enqueueBackgroundNotification(record);
            }
            return {
                summary,
                channelName: channel.name,
                channelId: channel.id,
                rounds: Number(subagentResult?.rounds || 0),
                toolCalls: Number(subagentResult?.toolCalls || 0)
            };
        } catch (error) {
            const finishedAt = Date.now();
            this.appendTimelineEvent({
                lane: 'tool',
                kind: 'task-error',
                status: 'error',
                title: 'task',
                detail: this.summarizeText(error?.message || String(error), 96),
                channelId: channel.id,
                channelName: channel.name,
                relatedTaskId: relatedTaskId ?? null,
                createdAt: finishedAt,
                startedAt,
                durationMs: finishedAt - startedAt
            });
            if (backgroundTaskId) {
                const record = this.updateBackgroundTask(backgroundTaskId, {
                    status: 'error',
                    error: String(error?.message || error || 'unknown error'),
                    finishedAt
                });
                this.enqueueBackgroundNotification(record);
            }
            throw error;
        } finally {
            this.removeSubagentChannel(channel.id);
            if (acquired) {
                this.releaseSubagentSlot();
            }
            this.emitUiHistoryUpdate();
        }
    }

    startBackgroundSubagentTask({ normalizedPrompt, description, relatedTaskId } = {}) {
        const record = this.createBackgroundTask({
            prompt: normalizedPrompt,
            description,
            relatedTaskId
        });
        this.executeSubagentTask({
            normalizedPrompt,
            description,
            relatedTaskId,
            backgroundTaskId: record.taskId
        }).catch(() => {
            // Background errors are persisted in task record and notification queue.
        });
        return this.buildBackgroundTaskSnapshot(record);
    }

    clampChatRecords() {
        while (this.uiChatRecords.length > 40) {
            const removed = this.uiChatRecords.shift();
            if (removed && removed.taskId !== undefined && removed.taskId !== null) {
                this.chatRecordByTaskId.delete(removed.taskId);
            }
        }
    }

    appendChatRecord(record = {}) {
        const now = Date.now();
        const entry = {
            id: `chat-${now}-${Math.random().toString(16).slice(2, 8)}`,
            taskId: null,
            role: 'system',
            kind: 'system',
            source: 'runtime',
            status: 'done',
            text: '',
            createdAt: now,
            updatedAt: now,
            meta: {},
            ...record
        };
        this.uiChatRecords.push(entry);
        if (entry.taskId !== undefined && entry.taskId !== null) {
            this.chatRecordByTaskId.set(entry.taskId, entry);
        }
        this.clampChatRecords();
        return entry;
    }

    findLatestMatchingChatRecord(predicate) {
        if (typeof predicate !== 'function') return null;
        for (let index = this.uiChatRecords.length - 1; index >= 0; index -= 1) {
            const entry = this.uiChatRecords[index];
            if (predicate(entry)) {
                return entry;
            }
        }
        return null;
    }

    upsertChatRecordByTaskId(taskId, patch = {}, defaults = {}) {
        const now = Date.now();
        if (taskId === undefined || taskId === null) {
            return this.appendChatRecord({
                ...defaults,
                ...patch,
                updatedAt: now
            });
        }

        const existing = this.chatRecordByTaskId.get(taskId);
        if (existing) {
            Object.assign(existing, patch, { updatedAt: now });
            return existing;
        }

        return this.appendChatRecord({
            taskId,
            role: 'user',
            kind: 'command',
            source: 'command',
            status: 'queued',
            createdAt: now,
            updatedAt: now,
            ...defaults,
            ...patch
        });
    }

    updateLatestPerceptionState(patch = {}) {
        this.latestPerceptionState = {
            ...this.latestPerceptionState,
            ...patch,
            updatedAt: Date.now()
        };
    }

    clampRecentPerceptions() {
        while (this.recentPerceptions.length > 3) {
            this.recentPerceptions.shift();
        }
    }

    appendPerceptionSnapshot(snapshot = {}) {
        const normalized = {
            id: `perception-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            status: snapshot.status || 'done',
            summary: this.summarizeText(snapshot.summary || '暂无感知摘要', 88),
            detail: String(snapshot.detail || ''),
            updatedAt: snapshot.updatedAt || Date.now()
        };
        this.recentPerceptions.push(normalized);
        this.clampRecentPerceptions();
        return normalized;
    }

    clampTimelineEvents() {
        while (this.timelineEvents.length > 240) {
            this.timelineEvents.shift();
        }
    }

    appendTimelineEvent(event = {}) {
        const entry = {
            id: `timeline-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            seq: ++this.timelineSeq,
            lane: event.lane || 'tool',
            channelId: event.channelId || 'main',
            channelName: this.summarizeText(event.channelName || '', 42),
            kind: event.kind || 'event',
            status: event.status || 'done',
            title: this.summarizeText(event.title || '运行时事件', 40),
            detail: this.summarizeText(event.detail || '', 96),
            relatedTaskId: event.relatedTaskId ?? null,
            createdAt: event.createdAt || Date.now(),
            startedAt: event.startedAt || event.createdAt || Date.now(),
            durationMs: Math.max(1, Number(event.durationMs) || 120),
            result: event.result ?? null
        };
        this.timelineEvents.push(entry);
        this.clampTimelineEvents();
        return entry;
    }

    getTimelineEventsSince(sinceSeq = 0, limit = 64) {
        const since = Math.max(0, Number(sinceSeq) || 0);
        const cap = Math.max(1, Math.min(256, Number(limit) || 64));
        const events = this.timelineEvents
            .filter((event) => Number(event.seq) > since)
            .slice(0, cap)
            .map((event) => ({ ...event }));
        return {
            cursor: this.timelineSeq,
            events
        };
    }

    async recordToolTimeline(kind, detail, runner) {
        const startedAt = Date.now();
        try {
            const result = await runner();
            this.appendTimelineEvent({
                lane: 'tool',
                kind,
                status: 'done',
                title: kind,
                detail,
                relatedTaskId: this.activeTask?.id ?? null,
                createdAt: Date.now(),
                startedAt,
                durationMs: Date.now() - startedAt
            });
            return result;
        } catch (error) {
            this.appendTimelineEvent({
                lane: 'tool',
                kind,
                status: 'error',
                title: kind,
                detail,
                relatedTaskId: this.activeTask?.id ?? null,
                createdAt: Date.now(),
                startedAt,
                durationMs: Date.now() - startedAt
            });
            throw error;
        }
    }

    buildMergedCommandText(parts) {
        if (!Array.isArray(parts) || parts.length === 0) return '';
        if (parts.length === 1) return parts[0];
        return parts
            .map((item, index) => `用户追加命令${index + 1}：${item}`)
            .join('\n');
    }

    clampUiHistory() {
        while (this.uiHistory.length > 10) {
            const removed = this.uiHistory.shift();
            if (removed) {
                this.historyByTaskId.delete(removed.taskId);
            }
        }
    }

    pushHistoryEntry(task, extra = {}) {
        const entry = {
            taskId: task.id,
            type: task.type,
            status: 'queued',
            inputSummary: '',
            resultSummary: '',
            mergedCount: task.type === 'command' ? (task.parts?.length || 1) : 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ...extra
        };
        this.uiHistory.push(entry);
        this.historyByTaskId.set(task.id, entry);
        this.clampUiHistory();
    }

    updateHistoryEntry(taskId, patch = {}) {
        const entry = this.historyByTaskId.get(taskId);
        if (!entry) return;
        Object.assign(entry, patch, { updatedAt: Date.now() });
    }

    buildUiPanelState() {
        let statusText = '空闲';
        if (this.activeTask) {
            statusText = this.activeTask.type === 'autonomous' ? 'Agent 自主运行中' : '正在执行命令';
        } else if (this.taskQueue.length > 0) {
            statusText = `等待中（${this.taskQueue.length}）`;
        }

        return {
            status: {
                text: statusText,
                activeType: this.activeTask ? this.activeTask.type : null,
                queueLength: this.taskQueue.length
            },
            subagent: {
                limit: this.maxSubagentConcurrency,
                running: this.subagentActiveCount,
                queued: this.subagentWaitQueue.length,
                channelCount: this.subagentChannels.size
            },
            timelineChannels: this.getTimelineChannelsSnapshot(),
            realtimePerception: { ...this.latestPerceptionState },
            recentPerceptions: this.recentPerceptions.map((entry) => ({ ...entry })),
            panelNote: this.latestPanelNote,
            autonomousWakeAt: this.nextAutonomousWakeAt,
            todoBoard: this.llmService.getTodoState
                ? this.llmService.getTodoState()
                : { items: [], updatedAt: null, summary: 'No todos.', hasOpenItems: false },
            chatRecords: this.uiChatRecords.map((entry) => ({ ...entry })),
            rawMessages: this.llmService.getCompanionSessionMessagesSnapshot
                ? this.llmService.getCompanionSessionMessagesSnapshot()
                : [],
            history: this.uiHistory.map((entry) => ({ ...entry })),
            timeline: this.timelineEvents.map((entry) => ({ ...entry }))
            ,
            compaction: this.latestCompactionBoundary
                ? { ...this.latestCompactionBoundary }
                : null
        };
    }

    emitUiHistoryUpdate() {
        this.onStateChanged(this.buildUiPanelState());
    }

    updatePanelNote(text = '', options = {}) {
        const shouldEmit = options.emit !== false;
        this.latestPanelNote = String(text || '').trim();
        if (shouldEmit) {
            this.emitUiHistoryUpdate();
        }
        return this.latestPanelNote;
    }

    buildRuntimeSnapshot() {
        let live2d = this.getLive2DConfigFallback();
        try {
            live2d = this.buildSerializedLive2DCapabilities(this.live2dModelService.getCapabilities());
        } catch (error) {
            // Keep fallback.
        }

        return {
            activeTaskType: this.activeTask ? this.activeTask.type : null,
            queueLength: this.taskQueue.length,
            subagent: {
                limit: this.maxSubagentConcurrency,
                running: this.subagentActiveCount,
                queued: this.subagentWaitQueue.length,
                channelCount: this.subagentChannels.size
            },
            latestPerceptionState: { ...this.latestPerceptionState },
            panelNote: this.latestPanelNote,
            nextWakeAt: this.nextAutonomousWakeAt,
            live2d,
            todoBoard: this.llmService.getTodoState
                ? this.llmService.getTodoState()
                : { items: [], updatedAt: null, summary: 'No todos.', hasOpenItems: false }
        };
    }

    createAutonomousTask(reason = 'wake') {
        return {
            id: this.nextUiTaskId++,
            type: 'autonomous',
            reason
        };
    }

    createCommandTask(text) {
        return {
            id: this.nextUiTaskId++,
            type: 'command',
            parts: [text]
        };
    }

    enqueueAutonomousTask(reason = 'wake') {
        const task = this.createAutonomousTask(reason);
        this.taskQueue.push(task);
        this.pushHistoryEntry(task, {
            inputSummary: reason === 'boot' ? 'Agent 启动任务已入队' : 'Agent 自主轮次已入队',
            resultSummary: ''
        });
        this.updateLatestPerceptionState({
            status: 'queued',
            summary: reason === 'boot' ? 'Agent 正在启动' : 'Agent 自主轮次已入队',
            detail: ''
        });
        this.emitUiHistoryUpdate();
        this.processTaskQueue().catch(() => {});
    }

    findTimelineEventById(eventId) {
        if (!eventId) return null;
        return this.timelineEvents.find((event) => event.id === eventId) || null;
    }

    getProjectedTimelineEventId(kind) {
        if (kind === 'sleep') return this.activeSleepTimelineEventId;
        if (kind === 'speak') return this.activeSpeakTimelineEventId;
        return null;
    }

    setProjectedTimelineEventId(kind, eventId) {
        if (kind === 'sleep') this.activeSleepTimelineEventId = eventId || null;
        if (kind === 'speak') this.activeSpeakTimelineEventId = eventId || null;
    }

    beginProjectedTimelineEvent(kind, event = {}) {
        if (!kind) return null;
        const activeEventId = this.getProjectedTimelineEventId(kind);
        if (activeEventId) {
            this.finalizeProjectedTimelineEvent(kind, {
                status: 'done',
                detail: `被新的 ${kind} 任务覆盖`,
                createdAt: Date.now(),
                result: { interrupted: true, interruptReason: 'overlap' }
            });
        }

        const startAt = Number(event.startedAt) || Date.now();
        const plannedEndAt = Number(event.createdAt) || (startAt + Math.max(1, Number(event.durationMs) || 120));
        const projectedEvent = this.appendTimelineEvent({
            lane: 'tool',
            kind,
            status: event.status || 'running',
            title: event.title || kind,
            detail: event.detail || '',
            relatedTaskId: event.relatedTaskId ?? this.activeTask?.id ?? null,
            startedAt: startAt,
            createdAt: plannedEndAt,
            durationMs: Math.max(1, plannedEndAt - startAt),
            result: event.result ?? null
        });
        this.setProjectedTimelineEventId(kind, projectedEvent.id);
        return projectedEvent.id;
    }

    finalizeProjectedTimelineEvent(kind, options = {}) {
        const eventId = this.getProjectedTimelineEventId(kind);
        if (!eventId) return false;
        const timelineEvent = this.findTimelineEventById(eventId);
        if (!timelineEvent || timelineEvent.kind !== kind) {
            this.setProjectedTimelineEventId(kind, null);
            return false;
        }

        const eventEndAt = Number(options.createdAt) || Date.now();
        const eventStartAt = Number(timelineEvent.startedAt || eventEndAt);
        const plannedEndAt = Number(timelineEvent.createdAt || eventEndAt);
        if (options.skipIfElapsed && plannedEndAt <= eventEndAt + 8) {
            this.setProjectedTimelineEventId(kind, null);
            return false;
        }

        timelineEvent.createdAt = eventEndAt;
        timelineEvent.durationMs = Math.max(1, eventEndAt - Math.min(eventStartAt, eventEndAt));
        timelineEvent.status = options.status || 'done';
        if (options.detail) {
            timelineEvent.detail = this.summarizeText(options.detail, 96);
        }
        timelineEvent.result = {
            ...(timelineEvent.result && typeof timelineEvent.result === 'object' ? timelineEvent.result : {}),
            ...(options.result && typeof options.result === 'object' ? options.result : {}),
            finalized: true,
            finalStatus: timelineEvent.status,
            actualEndAt: eventEndAt,
            interrupted: eventEndAt + 8 < plannedEndAt
        };
        this.setProjectedTimelineEventId(kind, null);
        return true;
    }

    clearAutonomousWakeTimer(reason = 'interrupted') {
        const hadWakePlan = Boolean(this.autonomousWakeTimer || this.nextAutonomousWakeAt);
        if (this.autonomousWakeTimer) {
            clearTimeout(this.autonomousWakeTimer);
            this.autonomousWakeTimer = null;
        }
        this.nextAutonomousWakeAt = null;
        if (hadWakePlan) {
            const sleepEvent = this.findTimelineEventById(this.getProjectedTimelineEventId('sleep'));
            const reasonMap = {
                command: '被用户命令提前打断',
                reschedule: '被新的睡眠计划覆盖',
                dispose: '运行时结束，睡眠提前终止',
                interrupted: '睡眠提前结束'
            };
            const interruptNote = reasonMap[reason] || reasonMap.interrupted;
            const mergedDetail = sleepEvent?.detail
                ? `${sleepEvent.detail}；${interruptNote}`
                : interruptNote;
            this.finalizeProjectedTimelineEvent('sleep', {
                status: 'done',
                detail: mergedDetail,
                createdAt: Date.now(),
                result: {
                    interrupted: true,
                    interruptReason: reason,
                    interruptedAt: Date.now(),
                    plannedWakeAt: Number(sleepEvent?.createdAt || 0) || null
                },
                skipIfElapsed: true
            });
        }
    }

    normalizeSleepSeconds(seconds) {
        return Math.min(
            this.autonomousSleepMaxSeconds,
            Math.max(this.autonomousSleepMinSeconds, Number(seconds) || this.autonomousSleepMaxSeconds)
        );
    }

    normalizeListenSeconds(seconds) {
        return Math.min(10, Math.max(1, Number(seconds) || 4));
    }

    createListenBucket() {
        return {
            finalSegments: [],
            partial: '',
            errors: []
        };
    }

    buildListenText(bucket) {
        const finals = Array.isArray(bucket?.finalSegments)
            ? bucket.finalSegments.map((item) => String(item || '').trim()).filter(Boolean)
            : [];
        if (finals.length) {
            return finals.join('\n');
        }
        return String(bucket?.partial || '').trim();
    }

    applyListenAsrEvent(bucket, event = {}) {
        const eventType = String(event?.type || '').trim();
        if (!eventType || !bucket) return;
        if (eventType === 'result') {
            const text = String(event?.text || '').trim();
            if (!text) return;
            if (event?.isFinal) {
                bucket.finalSegments.push(text);
                bucket.partial = '';
            } else {
                bucket.partial = text;
            }
            return;
        }
        if (eventType === 'error') {
            const message = String(event?.message || '').trim();
            if (message) {
                bucket.errors.push(message);
            }
        }
    }

    async listenAndTranscribeAudioChannels({ seconds } = {}) {
        const listenSeconds = this.normalizeListenSeconds(seconds);
        if (!this.listenCaptureService) {
            throw new Error('listen 捕获服务未初始化');
        }
        if (!this.createRealtimeAsrService) {
            throw new Error('listen ASR 会话工厂未初始化');
        }

        const systemBucket = this.createListenBucket();
        const micBucket = this.createListenBucket();
        const systemAsr = this.createRealtimeAsrService();
        const micAsr = this.createRealtimeAsrService();

        let systemStarted = false;
        let micStarted = false;
        try {
            await systemAsr.startSession({
                format: 'pcm',
                sampleRate: 16000,
                onEvent: (event) => this.applyListenAsrEvent(systemBucket, event)
            });
            systemStarted = true;
            await micAsr.startSession({
                format: 'pcm',
                sampleRate: 16000,
                onEvent: (event) => this.applyListenAsrEvent(micBucket, event)
            });
            micStarted = true;
        } catch (startError) {
            if (systemStarted) {
                await systemAsr.abortSession().catch(() => {});
            }
            if (micStarted) {
                await micAsr.abortSession().catch(() => {});
            }
            throw startError;
        }
        let captureResult = null;
        try {
            captureResult = await this.listenCaptureService.captureSeparateAudio({
                seconds: listenSeconds,
                sampleRate: 16000,
                onFrame: (source, frame) => {
                    if (!frame) return;
                    if (source === 'system') {
                        systemAsr.sendAudioFrame(frame);
                        return;
                    }
                    if (source === 'mic') {
                        micAsr.sendAudioFrame(frame);
                    }
                }
            });
            const systemFrames = Number(captureResult?.frameCount?.system || 0);
            const micFrames = Number(captureResult?.frameCount?.mic || 0);
            if (systemFrames <= 0 || micFrames <= 0) {
                const captureStatus = String(captureResult?.lastStatus || '').trim();
                throw new Error(
                    `listen 采集异常：system_frames=${systemFrames}, mic_frames=${micFrames}`
                    + (captureStatus ? `, status=${captureStatus}` : '')
                );
            }
        } finally {
            const stopResults = await Promise.allSettled([
                systemAsr.stopSession(),
                micAsr.stopSession()
            ]);
            if (stopResults[0]?.status === 'rejected') {
                await systemAsr.abortSession().catch(() => {});
            }
            if (stopResults[1]?.status === 'rejected') {
                await micAsr.abortSession().catch(() => {});
            }
        }

        const systemText = this.buildListenText(systemBucket);
        const micText = this.buildListenText(micBucket);
        const summaryParts = [];
        if (systemText) summaryParts.push(`system: ${this.summarizeText(systemText, 80)}`);
        if (micText) summaryParts.push(`mic: ${this.summarizeText(micText, 80)}`);
        if (summaryParts.length === 0) {
            summaryParts.push('未识别到有效语音');
        }

        return {
            seconds: listenSeconds,
            summary: summaryParts.join(' | '),
            system: {
                text: systemText,
                segments: systemBucket.finalSegments,
                partial: systemBucket.partial,
                errors: systemBucket.errors,
                hasSpeech: Boolean(systemText)
            },
            mic: {
                text: micText,
                segments: micBucket.finalSegments,
                partial: micBucket.partial,
                errors: micBucket.errors,
                hasSpeech: Boolean(micText)
            },
            capture: captureResult || {
                ok: true,
                reason: 'unknown',
                frameCount: { system: 0, mic: 0 },
                elapsedMs: Math.round(listenSeconds * 1000)
            }
        };
    }

    scheduleAutonomousWake(seconds) {
        const normalizedSeconds = this.normalizeSleepSeconds(seconds);
        this.clearAutonomousWakeTimer('reschedule');
        this.nextAutonomousWakeAt = Date.now() + normalizedSeconds * 1000;
        this.autonomousWakeTimer = setTimeout(() => {
            this.autonomousWakeTimer = null;
            this.nextAutonomousWakeAt = null;
            this.setProjectedTimelineEventId('sleep', null);
            this.enqueueAutonomousTask('wake');
        }, normalizedSeconds * 1000);
        this.emitUiHistoryUpdate();
        return {
            scheduled: true,
            sleepSeconds: normalizedSeconds,
            wakeAt: this.nextAutonomousWakeAt
        };
    }

    enqueueOrMergeCommandTask(text) {
        const normalizedText = String(text || '').trim();
        if (!normalizedText) {
            return { ok: false, message: '命令不能为空' };
        }

        // User commands take priority over autonomous wake timers.
        // Cancel any scheduled wake so an old sleep plan doesn't trigger
        // a redundant autonomous round right after command handling.
        if (this.autonomousWakeTimer || this.nextAutonomousWakeAt) {
            this.clearAutonomousWakeTimer('command');
        }

        const pendingCommandTask = this.taskQueue.find((item) => item.type === 'command');
        if (pendingCommandTask) {
            pendingCommandTask.parts.push(normalizedText);
            const mergedText = this.buildMergedCommandText(pendingCommandTask.parts);
            this.updateHistoryEntry(pendingCommandTask.id, {
                mergedCount: pendingCommandTask.parts.length,
                inputSummary: this.summarizeText(mergedText)
            });
            this.upsertChatRecordByTaskId(pendingCommandTask.id, {
                role: 'user',
                kind: 'command',
                source: 'command',
                status: 'queued',
                text: mergedText,
                meta: {
                    mergedCount: pendingCommandTask.parts.length
                }
            });
            this.emitUiHistoryUpdate();
            return { ok: true, merged: true, taskId: pendingCommandTask.id };
        }

        const task = this.createCommandTask(normalizedText);
        this.taskQueue.unshift(task);
        this.pushHistoryEntry(task, {
            inputSummary: this.summarizeText(normalizedText)
        });
        this.upsertChatRecordByTaskId(task.id, {
            role: 'user',
            kind: 'command',
            source: 'command',
            status: 'queued',
            text: normalizedText,
            meta: {
                mergedCount: 1
            }
        });
        this.emitUiHistoryUpdate();
        this.processTaskQueue().catch(() => {});
        return { ok: true, merged: false, taskId: task.id };
    }

    async handleAutonomousTask(task) {
        const prompt = task.reason === 'boot'
            ? '系统刚刚启动。请先感知当前环境，再决定是否需要说话，并安排下一次 sleep。'
            : '你已经从 sleep 中醒来。请先判断是否需要 detect 当前环境，再决定是否 speak，并安排下一次 sleep。';
        const response = await this.llmService.chatWithCompanion(prompt, {
            inputType: 'perception'
        });
        if (!this.nextAutonomousWakeAt) {
            this.scheduleAutonomousWake(response?.sleepSeconds);
        }

        const responseText = response?.text || '';
        const observedState = response?.observedState || '';
        const analysisSummary = this.summarizeText(observedState);
        const responseSummary = this.summarizeText(responseText);
        this.appendPerceptionSnapshot({
            status: response?.spoke ? 'spoken' : 'done',
            summary: responseSummary || analysisSummary || '完成一次后台感知',
            detail: observedState || responseText || ''
        });
        this.updateHistoryEntry(task.id, {
            status: 'done',
            resultSummary: `感知完成：${responseSummary}`,
            inputSummary: analysisSummary
        });
        this.updateLatestPerceptionState({
            status: 'done',
            summary: responseSummary || '感知完成',
            detail: [
                `输入：${analysisSummary || '（空）'}`,
                `AI：${responseText || '（空）'}`
            ].join('\n')
        });
    }

    async handleCommandTask(task) {
        const mergedText = this.buildMergedCommandText(task.parts);
        const response = await this.llmService.chatWithCompanion(mergedText, { inputType: 'command' });
        const responseText = response?.text || '';
        const mergedSummary = this.summarizeText(mergedText);
        const responseSummary = this.summarizeText(responseText);

        this.updateHistoryEntry(task.id, {
            status: 'done',
            mergedCount: task.parts.length,
            inputSummary: mergedSummary,
            resultSummary: `命令完成：${responseSummary}`
        });
        this.upsertChatRecordByTaskId(task.id, {
            role: 'user',
            kind: 'command',
            source: 'command',
            status: 'done',
            text: mergedText,
            meta: {
                mergedCount: task.parts.length
            }
        });
    }

    handleTaskError(task, error) {
        const errorSummary = this.summarizeText(error?.message || error);
        this.updateHistoryEntry(task.id, {
            status: 'error',
            resultSummary: `执行失败：${errorSummary}`
        });

        if (task.type === 'autonomous') {
            this.scheduleAutonomousWake();
            this.updateLatestPerceptionState({
                status: 'error',
                summary: errorSummary || '感知失败',
                detail: `错误：${error?.message || error}`
            });
            return;
        }

        const mergedText = this.buildMergedCommandText(task.parts || []);
        this.upsertChatRecordByTaskId(task.id, {
            role: 'user',
            kind: 'command',
            source: 'command',
            status: 'error',
            text: mergedText,
            meta: {
                mergedCount: Array.isArray(task.parts) ? task.parts.length : 1,
                error: errorSummary
            }
        });
    }

    markTaskRunning(task) {
        this.updateHistoryEntry(task.id, {
            status: 'running',
            resultSummary: task.type === 'autonomous' ? 'Agent 自主轮次执行中...' : '命令执行中...'
        });

        if (task.type === 'autonomous') {
            this.updateLatestPerceptionState({
                status: 'running',
                summary: 'AI 正在感知...',
                detail: ''
            });
            return;
        }

        const mergedText = this.buildMergedCommandText(task.parts || []);
        this.upsertChatRecordByTaskId(task.id, {
            role: 'user',
            kind: 'command',
            source: 'command',
            status: 'running',
            text: mergedText,
            meta: {
                mergedCount: Array.isArray(task.parts) ? task.parts.length : 1
            }
        });
    }

    async processTaskQueue() {
        if (this.activeTask) return;
        if (!this.taskQueue.length) {
            this.emitUiHistoryUpdate();
            return;
        }

        this.activeTask = this.taskQueue.shift();
        this.markTaskRunning(this.activeTask);
        this.emitUiHistoryUpdate();

        try {
            if (this.activeTask.type === 'autonomous') {
                await this.handleAutonomousTask(this.activeTask);
            } else if (this.activeTask.type === 'command') {
                await this.handleCommandTask(this.activeTask);
            }
        } catch (error) {
            this.handleTaskError(this.activeTask, error);
        } finally {
            this.activeTask = null;
            this.emitUiHistoryUpdate();
            this.processTaskQueue().catch(() => {});
        }
    }

    buildPerceptionResult(analysis, capturePayload = {}) {
        return {
            summary: this.summarizeText(analysis, 160),
            detail: analysis,
            capturedAt: capturePayload?.capturedAt || Date.now(),
            activeWindowTitle: capturePayload?.activeWindowTitle || ''
        };
    }

    async captureAnalyzePersist(source, options = {}) {
        const capturePayload = await this.screenSensor.captureOnce();
        if (!capturePayload?.base64Image) {
            throw new Error('截图失败，当前没有可用的屏幕内容');
        }

        const { analysis, record } = await this.visionService.analyzeAndPersist(capturePayload, {
            source,
            bypassAdmission: options.bypassAdmission === true
        });
        this.updateLatestPerceptionState({
            status: 'done',
            summary: this.summarizeText(analysis, 80),
            detail: analysis
        });
        return this.buildPerceptionResult(analysis, {
            ...capturePayload,
            capturedAt: record?.capturedAt || capturePayload?.capturedAt
        });
    }

    buildToolPanelNote({ tool, status, args, detail }) {
        const name = String(tool || 'tool');
        const phase = String(status || 'running');
        const speakText = this.summarizeText(args?.text || '', 52);
        const sleepSeconds = Number(args?.seconds || 0);
        const listenSeconds = Number(args?.seconds || 0);
        const base = {
            running: `Agent 正在执行 ${name}...`,
            done: `Agent 已完成 ${name}`,
            error: `Agent 执行 ${name} 失败`
        };

        if (phase === 'running') {
            if (name === 'detect') return 'Agent 正在读取或分析当前屏幕状态...';
            if (name === 'look') return 'Agent 正在立即确认最新屏幕状态...';
            if (name === 'speak') return speakText ? `Agent 准备播报：${speakText}` : 'Agent 正在准备播报...';
            if (name === 'sleep') return sleepSeconds > 0 ? `Agent 准备进入休眠 ${sleepSeconds} 秒` : 'Agent 准备安排下一次休眠';
            if (name === 'listen') return listenSeconds > 0
                ? `Agent 正在监听系统音频与麦克风（${Math.min(10, Math.max(1, listenSeconds))} 秒）...`
                : 'Agent 正在监听系统音频与麦克风...';
            return base.running;
        }

        if (phase === 'error') {
            const err = this.summarizeText(detail || '', 42);
            return err ? `${base.error}：${err}` : base.error;
        }

        if (name === 'sleep' && sleepSeconds > 0) {
            return `Agent 已进入休眠 ${sleepSeconds} 秒`;
        }
        if (name === 'speak') {
            return 'Agent 已完成一次播报';
        }
        return base.done;
    }

    createRuntimeAdapters() {
        return {
            onToolTimeline: ({
                tool,
                kind,
                status,
                detail,
                createdAt,
                startedAt,
                durationMs,
                args,
                result,
                channelId,
                channelName
            } = {}) => {
                const normalizedStatus = status || 'done';
                const speakText = String(result?.text || args?.text || '').trim();
                const normalizedKind = kind || tool || 'tool';
                const effectiveChannelId = channelId || 'main';
                const effectiveChannelName = channelName || '';
                const isMainChannel = effectiveChannelId === 'main';

                if (normalizedKind === 'speak' && normalizedStatus === 'running' && isMainChannel) {
                    const projectedStartAt = Number(startedAt) || Date.now();
                    const projectedDurationMs = Math.max(
                        800,
                        Math.min(25000, Math.round(String(args?.text || '').trim().length * 120))
                    );
                    this.beginProjectedTimelineEvent('speak', {
                        status: 'running',
                        title: 'speak',
                        detail: detail || this.summarizeText(speakText, 72),
                        startedAt: projectedStartAt,
                        createdAt: projectedStartAt + projectedDurationMs,
                        durationMs: projectedDurationMs,
                        result: {
                            planned: true,
                            estimatedDurationMs: projectedDurationMs
                        }
                    });
                }

                // Timeline only records completed/error tool events. Running state stays in panel note.
                if (normalizedStatus !== 'running') {
                    const now = Date.now();
                    const eventCreatedAt = createdAt || now;
                    const eventStartedAt = startedAt || eventCreatedAt;
                    let shouldAppendTimelineEvent = true;
                    const eventPayload = {
                        lane: 'tool',
                        channelId: effectiveChannelId,
                        channelName: effectiveChannelName,
                        kind: normalizedKind,
                        status: normalizedStatus,
                        title: tool || kind || 'tool',
                        detail: detail || '',
                        relatedTaskId: this.activeTask?.id ?? null,
                        createdAt: eventCreatedAt,
                        startedAt: eventStartedAt,
                        durationMs: durationMs || 120,
                        result: result ?? null
                    };

                    if (normalizedKind === 'sleep') {
                        const requestedSleepSeconds = Number(args?.seconds || 0);
                        const toolResult = result || {};
                        const plannedSleepSeconds = Number(toolResult?.sleepSeconds || requestedSleepSeconds || 0);
                        const sleepStartAt = eventCreatedAt;
                        const sleepEndAt = Number(toolResult?.wakeAt) || (
                            plannedSleepSeconds > 0 ? (sleepStartAt + plannedSleepSeconds * 1000) : sleepStartAt
                        );
                        eventPayload.startedAt = sleepStartAt;
                        eventPayload.createdAt = sleepEndAt;
                        eventPayload.durationMs = plannedSleepSeconds > 0
                            ? plannedSleepSeconds * 1000
                            : (durationMs || 120);
                        if (!eventPayload.detail) {
                            eventPayload.detail = plannedSleepSeconds > 0
                                ? `计划休眠 ${plannedSleepSeconds} 秒，预计唤醒于 ${new Date(sleepEndAt).toLocaleTimeString()}`
                                : '已安排下一次唤醒';
                        }
                    }
                    if (normalizedKind === 'speak') {
                        const updated = isMainChannel && this.finalizeProjectedTimelineEvent('speak', {
                            status: normalizedStatus,
                            detail: detail || this.summarizeText(speakText, 72),
                            createdAt: eventCreatedAt,
                            result
                        });
                        shouldAppendTimelineEvent = !updated;
                    }

                    if (shouldAppendTimelineEvent) {
                        const appendedEvent = this.appendTimelineEvent({
                            ...eventPayload
                        });
                        if (isMainChannel && normalizedKind === 'sleep' && normalizedStatus === 'done') {
                            this.setProjectedTimelineEventId('sleep', appendedEvent.id);
                        }
                    }
                }
                if (isMainChannel && tool === 'speak' && speakText) {
                    const matchingSpeakRecord = this.findLatestMatchingChatRecord((entry) => (
                        entry?.role === 'assistant' &&
                        entry?.kind === 'speak' &&
                        entry?.text === speakText &&
                        (entry?.status === 'running' || entry?.status === 'queued')
                    ));

                    if (normalizedStatus === 'running') {
                        if (matchingSpeakRecord) {
                            Object.assign(matchingSpeakRecord, {
                                status: 'running',
                                updatedAt: Date.now(),
                                meta: {
                                    ...(matchingSpeakRecord.meta || {}),
                                    motion: String(args?.motion || ''),
                                    expression: String(args?.expression || '')
                                }
                            });
                        } else {
                            this.appendChatRecord({
                                role: 'assistant',
                                kind: 'speak',
                                source: 'tool',
                                status: 'running',
                                text: speakText,
                                createdAt: startedAt || createdAt || Date.now(),
                                meta: {
                                    motion: String(args?.motion || ''),
                                    expression: String(args?.expression || '')
                                }
                            });
                        }
                    } else if (normalizedStatus === 'done') {
                        if (matchingSpeakRecord) {
                            Object.assign(matchingSpeakRecord, {
                                status: 'done',
                                updatedAt: Date.now(),
                                meta: {
                                    ...(matchingSpeakRecord.meta || {}),
                                    motion: String(result?.motion || args?.motion || ''),
                                    expression: String(result?.expression || args?.expression || '')
                                }
                            });
                        } else {
                            this.appendChatRecord({
                                role: 'assistant',
                                kind: 'speak',
                                source: 'tool',
                                status: 'done',
                                text: speakText,
                                createdAt: startedAt || createdAt || Date.now(),
                                meta: {
                                    motion: String(result?.motion || args?.motion || ''),
                                    expression: String(result?.expression || args?.expression || '')
                                }
                            });
                        }
                    } else if (normalizedStatus === 'error' && matchingSpeakRecord) {
                        Object.assign(matchingSpeakRecord, {
                            status: 'error',
                            updatedAt: Date.now()
                        });
                    }
                }
                if (isMainChannel) {
                    this.updatePanelNote(this.buildToolPanelNote({ tool, status, args, detail }), { emit: false });
                }
                this.emitUiHistoryUpdate();
            },
            onCompactionBoundary: ({
                compactId,
                mode,
                generation,
                transcriptPath,
                handoffPath,
                summaryText,
                createdAt
            } = {}) => {
                const now = Date.now();
                const detail = [
                    `mode=${mode || 'summary'}`,
                    `generation=${Number(generation || 1)}`,
                    compactId ? `compactId=${compactId}` : '',
                    transcriptPath ? `transcript=${transcriptPath}` : '',
                    handoffPath ? `handoff=${handoffPath}` : ''
                ].filter(Boolean).join(' | ');
                this.latestCompactionBoundary = {
                    compactId: String(compactId || ''),
                    mode: String(mode || 'summary'),
                    generation: Number(generation || 1),
                    transcriptPath: String(transcriptPath || ''),
                    handoffPath: String(handoffPath || ''),
                    summaryPreview: this.summarizeText(summaryText || '', 140),
                    createdAt: Number(createdAt || now)
                };
                this.appendTimelineEvent({
                    lane: 'memory',
                    kind: 'compaction_boundary',
                    status: 'done',
                    title: 'compact',
                    detail: detail || 'context compacted',
                    relatedTaskId: this.activeTask?.id ?? null,
                    createdAt: Number(createdAt || now),
                    startedAt: Number(createdAt || now),
                    durationMs: 120,
                    result: {
                        mode: String(mode || 'summary'),
                        compactId: String(compactId || ''),
                        generation: Number(generation || 1)
                    }
                });
                this.emitUiHistoryUpdate();
            },
            detect: async () => {
                const cacheMaxAgeMs = Number(config.vision?.cacheMaxAgeMs) || 5000;
                const latest = this.visionService.getLatestState(cacheMaxAgeMs);
                if (latest?.analysis) {
                    this.updateLatestPerceptionState({
                        status: 'done',
                        summary: this.summarizeText(latest.analysis, 80),
                        detail: latest.analysis
                    });
                    return {
                        summary: this.summarizeText(latest.analysis, 160),
                        detail: latest.analysis,
                        capturedAt: latest.capturedAt || latest.timestamp || Date.now(),
                        activeWindowTitle: latest.activeWindowTitle || ''
                    };
                }
                return this.captureAnalyzePersist('detect');
            },
            look: async () => {
                return this.captureAnalyzePersist('look', { bypassAdmission: true });
            },
            speak: async ({ text, motion, expression } = {}) => {
                const payload = { text: String(text || '').trim(), motion, expression };
                await this.enqueueTtsJob(payload);
                return {
                    text: payload.text,
                    motion: payload.motion || '',
                    expression: payload.expression || '',
                    queued: true
                };
            },
            sleep: async ({ seconds } = {}) => {
                const normalizedSeconds = this.normalizeSleepSeconds(seconds);
                return ({
                    scheduled: true,
                    sleepSeconds: normalizedSeconds,
                    wakeAt: Date.now() + normalizedSeconds * 1000
                });
            },
            listen: async ({ seconds } = {}) => {
                return this.listenAndTranscribeAudioChannels({ seconds });
            },
            task: async ({ prompt, description, wait } = {}) => {
                const normalizedPrompt = String(prompt || '').trim();
                if (!normalizedPrompt) {
                    throw new Error('task.prompt 不能为空');
                }
                const shouldWait = wait !== false;
                const relatedTaskId = this.activeTask?.id ?? null;
                if (shouldWait) {
                    return this.executeSubagentTask({
                        normalizedPrompt,
                        description,
                        relatedTaskId
                    });
                }
                const snapshot = this.startBackgroundSubagentTask({
                    normalizedPrompt,
                    description,
                    relatedTaskId
                });
                return {
                    accepted: true,
                    mode: 'background',
                    taskId: snapshot?.taskId || '',
                    status: snapshot?.status || 'queued',
                    message: `Background task ${snapshot?.taskId || ''} started`,
                    task: snapshot
                };
            },
            compact: async ({ focus } = {}) => {
                return {
                    requested: true,
                    mode: 'summary',
                    focus: String(focus || '').trim()
                };
            },
            backgroundRun: async ({ command } = {}) => {
                const snapshot = this.startBackgroundCommandTask({ command });
                return {
                    accepted: true,
                    mode: 'background_command',
                    taskId: snapshot?.taskId || '',
                    status: snapshot?.status || 'queued',
                    command: snapshot?.promptSummary || '',
                    task: snapshot
                };
            },
            checkBackground: ({ task_id } = {}) => {
                return this.checkBackgroundTasks({ taskId: task_id });
            },
            drainBackgroundNotifications: () => {
                return this.drainBackgroundNotifications();
            }
        };
    }
}

module.exports = {
    AgentRuntime
};

