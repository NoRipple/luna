const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

// Modules
const llmService = require('../modules/thinking/LLMService');
const ttsService = require('../modules/output/TTSService');
const screenSensor = require('../modules/perception/ScreenSensor');
const visionService = require('../modules/recognition/VisionService');
const live2dModelService = require('../modules/output/Live2DModelService');
const live2dModelCatalogService = require('../modules/output/Live2DModelCatalogService');
const { startApiServer } = require('./apiServer');
const { registerIpcHandlers } = require('./ipcHandlers');

let overlayWindow;
let panelWindow;

let ttsController = null;
let ttsQueue = [];
let isTtsPlaying = false;
let ttsPlaybackEndedResolve = null;
let waitingPlaybackJobId = null;
let nextTtsJobId = 1;
let globalMouseTimer = null;
let lastGlobalMousePayload = null;
let nextUiTaskId = 1;
const taskQueue = [];
let activeTask = null;
const uiHistory = [];
const historyByTaskId = new Map();
const uiChatRecords = [];
const chatRecordByTaskId = new Map();
let latestPerceptionState = {
    status: 'idle',
    summary: '暂无感知结果',
    detail: '',
    updatedAt: null
};
let unsubscribeTodoState = null;

function buildSerializedLive2DCapabilities(capabilities) {
    return {
        modelJsonAbsolutePath: capabilities.modelJsonAbsolutePath,
        modelDisplayName: capabilities.modelDisplayName,
        rendererModelPath: capabilities.rendererModelPath,
        motions: capabilities.motions,
        expressions: capabilities.expressions,
        promptExpressions: capabilities.promptExpressions,
        expressionSemanticMap: capabilities.expressionSemanticMap,
        fallbackMotion: capabilities.fallbackMotion,
        fallbackExpression: capabilities.fallbackExpression
    };
}

function getLive2DConfigFallback() {
    return {
        modelJsonAbsolutePath: '',
        modelDisplayName: 'Unknown',
        rendererModelPath: '../../assets/Azue Lane(JP)/beierfasite_2/beierfasite_2.model3.json',
        motions: [],
        expressions: [],
        promptExpressions: [],
        expressionSemanticMap: {},
        fallbackMotion: 'idle',
        fallbackExpression: ''
    };
}

function summarizeText(text, maxLen = 80) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    if (normalized.length <= maxLen) return normalized;
    return `${normalized.slice(0, maxLen - 1)}…`;
}

function clampChatRecords() {
    while (uiChatRecords.length > 10) {
        const removed = uiChatRecords.shift();
        if (removed && removed.taskId !== undefined && removed.taskId !== null) {
            chatRecordByTaskId.delete(removed.taskId);
        }
    }
}

function appendChatRecord(record = {}) {
    const now = Date.now();
    const entry = {
        id: `chat-${now}-${Math.random().toString(16).slice(2, 8)}`,
        taskId: null,
        source: 'command',
        status: 'done',
        inputText: '',
        inputSummary: '',
        responseText: '',
        responseSummary: '',
        createdAt: now,
        updatedAt: now,
        ...record
    };
    uiChatRecords.push(entry);
    if (entry.taskId !== undefined && entry.taskId !== null) {
        chatRecordByTaskId.set(entry.taskId, entry);
    }
    clampChatRecords();
    return entry;
}

function upsertChatRecordByTaskId(taskId, patch = {}, defaults = {}) {
    const now = Date.now();
    if (taskId === undefined || taskId === null) {
        return appendChatRecord({
            ...defaults,
            ...patch,
            updatedAt: now
        });
    }

    const existing = chatRecordByTaskId.get(taskId);
    if (existing) {
        Object.assign(existing, patch, { updatedAt: now });
        return existing;
    }

    return appendChatRecord({
        taskId,
        source: 'command',
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        ...defaults,
        ...patch
    });
}

function updateLatestPerceptionState(patch = {}) {
    latestPerceptionState = {
        ...latestPerceptionState,
        ...patch,
        updatedAt: Date.now()
    };
}

function buildMergedCommandText(parts) {
    if (!Array.isArray(parts) || parts.length === 0) return '';
    if (parts.length === 1) return parts[0];
    return parts
        .map((item, index) => `用户追加命令${index + 1}：${item}`)
        .join('\n');
}

function clampUiHistory() {
    while (uiHistory.length > 10) {
        const removed = uiHistory.shift();
        if (removed) {
            historyByTaskId.delete(removed.taskId);
        }
    }
}

function pushHistoryEntry(task, extra = {}) {
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
    uiHistory.push(entry);
    historyByTaskId.set(task.id, entry);
    clampUiHistory();
}

function updateHistoryEntry(taskId, patch = {}) {
    const entry = historyByTaskId.get(taskId);
    if (!entry) return;
    Object.assign(entry, patch, { updatedAt: Date.now() });
}

function buildUiPanelState() {
    let statusText = '空闲';
    if (activeTask) {
        statusText = activeTask.type === 'perception' ? '正在感知' : '正在执行命令';
    } else if (taskQueue.length > 0) {
        statusText = `等待中（${taskQueue.length}）`;
    }

    return {
        status: {
            text: statusText,
            activeType: activeTask ? activeTask.type : null,
            queueLength: taskQueue.length
        },
        realtimePerception: { ...latestPerceptionState },
        todoBoard: llmService.getTodoState ? llmService.getTodoState() : { items: [], updatedAt: null, summary: 'No todos.', hasOpenItems: false },
        chatRecords: uiChatRecords.map((entry) => ({ ...entry })),
        history: uiHistory.map((entry) => ({ ...entry }))
    };
}

function emitUiHistoryUpdate() {
    const payload = buildUiPanelState();
    if (panelWindow && !panelWindow.isDestroyed()) {
        panelWindow.webContents.send('ui-history-updated', payload);
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('ui-history-updated', payload);
    }
}

function bindTodoStateUpdates() {
    if (unsubscribeTodoState || !llmService.onTodoStateChanged) {
        return;
    }

    unsubscribeTodoState = llmService.onTodoStateChanged(() => {
        emitUiHistoryUpdate();
    });
}

function createPerceptionTask(capturePayload) {
    return {
        id: nextUiTaskId++,
        type: 'perception',
        capturePayload
    };
}

function createCommandTask(text) {
    return {
        id: nextUiTaskId++,
        type: 'command',
        parts: [text]
    };
}

function enqueuePerceptionTask(capturePayload) {
    const task = createPerceptionTask(capturePayload);
    taskQueue.push(task);
    pushHistoryEntry(task, {
        inputSummary: '后台感知任务已入队',
        resultSummary: ''
    });
    updateLatestPerceptionState({
        status: 'queued',
        summary: '后台感知任务已入队',
        detail: ''
    });
    emitUiHistoryUpdate();
    processTaskQueue().catch(() => {});
}

function enqueueOrMergeCommandTask(text) {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) {
        return { ok: false, message: '命令不能为空' };
    }

    const pendingCommandTask = taskQueue.find((item) => item.type === 'command');
    if (pendingCommandTask) {
        pendingCommandTask.parts.push(normalizedText);
        const mergedText = buildMergedCommandText(pendingCommandTask.parts);
        updateHistoryEntry(pendingCommandTask.id, {
            mergedCount: pendingCommandTask.parts.length,
            inputSummary: summarizeText(mergedText)
        });
        upsertChatRecordByTaskId(pendingCommandTask.id, {
            source: 'command',
            status: 'queued',
            inputText: mergedText,
            inputSummary: summarizeText(mergedText),
            responseText: '等待执行…',
            responseSummary: '等待执行'
        });
        emitUiHistoryUpdate();
        return { ok: true, merged: true, taskId: pendingCommandTask.id };
    }

    const task = createCommandTask(normalizedText);
    taskQueue.unshift(task);
    pushHistoryEntry(task, {
        inputSummary: summarizeText(normalizedText)
    });
    upsertChatRecordByTaskId(task.id, {
        source: 'command',
        status: 'queued',
        inputText: normalizedText,
        inputSummary: summarizeText(normalizedText),
        responseText: '等待执行…',
        responseSummary: '等待执行'
    });
    emitUiHistoryUpdate();
    processTaskQueue().catch(() => {});
    return { ok: true, merged: false, taskId: task.id };
}

async function processTaskQueue() {
    if (activeTask) return;
    if (!taskQueue.length) {
        emitUiHistoryUpdate();
        return;
    }

    activeTask = taskQueue.shift();
    updateHistoryEntry(activeTask.id, {
        status: 'running',
        resultSummary: activeTask.type === 'perception' ? 'AI 正在感知...' : '命令执行中...'
    });
    if (activeTask.type === 'perception') {
        updateLatestPerceptionState({
            status: 'running',
            summary: 'AI 正在感知...',
            detail: ''
        });
    } else if (activeTask.type === 'command') {
        const mergedText = buildMergedCommandText(activeTask.parts || []);
        upsertChatRecordByTaskId(activeTask.id, {
            source: 'command',
            status: 'running',
            inputText: mergedText,
            inputSummary: summarizeText(mergedText),
            responseText: 'AI 正在生成回复…',
            responseSummary: '命令执行中'
        });
    }
    emitUiHistoryUpdate();

    try {
        if (activeTask.type === 'perception') {
            const analysis = await visionService.analyzeScreen(activeTask.capturePayload);
            const response = await llmService.chatWithCompanion(analysis, { inputType: 'perception' });
            await enqueueTtsJob(response);
            const responseText = response?.text || '';
            const analysisSummary = summarizeText(analysis);
            const responseSummary = summarizeText(responseText);
            updateHistoryEntry(activeTask.id, {
                status: 'done',
                resultSummary: `感知完成：${responseSummary}`,
                inputSummary: analysisSummary
            });
            updateLatestPerceptionState({
                status: 'done',
                summary: responseSummary || '感知完成',
                detail: [
                    `输入：${analysisSummary || '（空）'}`,
                    `AI：${responseText || '（空）'}`
                ].join('\n')
            });
            appendChatRecord({
                source: 'perception',
                status: 'done',
                inputText: analysis,
                inputSummary: analysisSummary,
                responseText,
                responseSummary
            });
        } else if (activeTask.type === 'command') {
            const mergedText = buildMergedCommandText(activeTask.parts);
            const response = await llmService.chatWithCompanion(mergedText, { inputType: 'command' });
            const responseText = response?.text || '';
            const mergedSummary = summarizeText(mergedText);
            const responseSummary = summarizeText(responseText);
            await enqueueTtsJob(response);
            updateHistoryEntry(activeTask.id, {
                status: 'done',
                mergedCount: activeTask.parts.length,
                inputSummary: mergedSummary,
                resultSummary: `命令完成：${responseSummary}`
            });
            upsertChatRecordByTaskId(activeTask.id, {
                source: 'command',
                status: 'done',
                inputText: mergedText,
                inputSummary: mergedSummary,
                responseText,
                responseSummary
            });
        }
    } catch (error) {
        const errorSummary = summarizeText(error?.message || error);
        updateHistoryEntry(activeTask.id, {
            status: 'error',
            resultSummary: `执行失败：${errorSummary}`
        });
        if (activeTask.type === 'perception') {
            updateLatestPerceptionState({
                status: 'error',
                summary: errorSummary || '感知失败',
                detail: `错误：${error?.message || error}`
            });
            appendChatRecord({
                source: 'perception',
                status: 'error',
                inputText: '',
                inputSummary: '后台感知任务',
                responseText: `执行失败：${error?.message || error}`,
                responseSummary: errorSummary
            });
        } else {
            upsertChatRecordByTaskId(activeTask.id, {
                source: 'command',
                status: 'error',
                inputText: buildMergedCommandText(activeTask.parts || []),
                inputSummary: summarizeText(buildMergedCommandText(activeTask.parts || [])),
                responseText: `执行失败：${error?.message || error}`,
                responseSummary: errorSummary
            });
        }
    } finally {
        activeTask = null;
        emitUiHistoryUpdate();
        processTaskQueue().catch(() => {});
    }
}

function startGlobalMouseTracking() {
    if (globalMouseTimer) return;

    globalMouseTimer = setInterval(() => {
        if (!overlayWindow || overlayWindow.isDestroyed()) return;

        const point = screen.getCursorScreenPoint();
        const bounds = overlayWindow.getBounds();
        const payload = {
            screenX: point.x,
            screenY: point.y,
            windowBounds: bounds
        };

        if (
            lastGlobalMousePayload &&
            lastGlobalMousePayload.screenX === payload.screenX &&
            lastGlobalMousePayload.screenY === payload.screenY &&
            lastGlobalMousePayload.windowBounds.x === payload.windowBounds.x &&
            lastGlobalMousePayload.windowBounds.y === payload.windowBounds.y &&
            lastGlobalMousePayload.windowBounds.width === payload.windowBounds.width &&
            lastGlobalMousePayload.windowBounds.height === payload.windowBounds.height
        ) {
            return;
        }

        lastGlobalMousePayload = payload;
        overlayWindow.webContents.send('global-mouse-position', payload);
    }, 16);
}

function stopGlobalMouseTracking() {
    if (globalMouseTimer) {
        clearInterval(globalMouseTimer);
        globalMouseTimer = null;
    }
    lastGlobalMousePayload = null;
}

function enqueueTtsJob(job) {
    return new Promise((resolve) => {
        const jobId = nextTtsJobId++;
        ttsQueue.push({ jobId, job, resolve });
        console.log(`[TTS Queue] enqueue | job_id=${jobId} | queue_length=${ttsQueue.length} | is_playing=${isTtsPlaying}`);
        if (!isTtsPlaying) {
            playNextTtsJob();
        }
    });
}

async function playNextTtsJob() {
    if (isTtsPlaying) return;
    if (!ttsQueue.length) return;

    isTtsPlaying = true;
    const { jobId, job, resolve } = ttsQueue.shift();
    const normalizedJob = {
        ...job
    };
    if (Object.prototype.hasOwnProperty.call(normalizedJob, 'motion')) {
        try {
            normalizedJob.motion = live2dModelService.sanitizeMotionName(job?.motion);
        } catch (error) {
            normalizedJob.motion = job?.motion || 'idle';
        }
    }
    if (Object.prototype.hasOwnProperty.call(normalizedJob, 'expression')) {
        try {
            normalizedJob.expression = live2dModelService.sanitizeExpressionName(job?.expression);
        } catch (error) {
            normalizedJob.expression = job?.expression || '';
        }
    }
    console.log(`[TTS Queue] dequeue | job_id=${jobId} | queue_length=${ttsQueue.length} | has_text=${!!(job && job.text)}`);
    const jobStartedAt = Date.now();
    let jobFinished = false;
    const finishJob = () => {
        if (jobFinished) return;
        jobFinished = true;
        resolve();
        isTtsPlaying = false;
        console.log(`[TTS Queue] job_done | queue_length=${ttsQueue.length} | is_playing=${isTtsPlaying} | elapsed_ms=${Date.now() - jobStartedAt}`);
        playNextTtsJob();
    };
    const hardTimeoutMs = 70000;
    const hardTimeout = setTimeout(() => {
        console.warn(`[TTS Queue] hard_timeout_release=true | timeout_ms=${hardTimeoutMs}`);
        if (ttsController) {
            try {
                ttsController.abort();
            } catch (e) {
                // ignore
            }
        }
        ttsPlaybackEndedResolve = null;
        finishJob();
    }, hardTimeoutMs);

    try {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('companion-message', normalizedJob);
        }

        if (normalizedJob && normalizedJob.text) {
            const waitForEnded = new Promise((endedResolve) => {
                waitingPlaybackJobId = jobId;
                ttsPlaybackEndedResolve = () => endedResolve();
                console.log(`[TTS Queue] waiting_for_ended=true | job_id=${jobId}`);
                setTimeout(() => {
                    if (ttsPlaybackEndedResolve && waitingPlaybackJobId === jobId) {
                        console.log(`[TTS Queue] ended_timeout_fallback=true | job_id=${jobId}`);
                        waitingPlaybackJobId = null;
                        ttsPlaybackEndedResolve = null;
                        endedResolve();
                    }
                }, 60000);
            });

            // Stream audio chunks; do not abort/interrupt current playback.
            ttsController = new AbortController();
            let chunkCount = 0;
            const ttsStartedAt = Date.now();

            const speakPromise = ttsService.speakStream(
                normalizedJob.text,
                (chunk) => {
                    chunkCount += 1;
                    if (overlayWindow && !overlayWindow.isDestroyed()) {
                        overlayWindow.webContents.send('tts-chunk', chunk);
                    }
                },
                ttsController.signal
            );

            const timeoutMs = 25000;
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`TTS speak timeout after ${timeoutMs}ms`));
                }, timeoutMs);
            });

            await Promise.race([speakPromise, timeoutPromise]).catch((error) => {
                console.warn('[TTS Queue] speak_failed_or_timeout=true', error.message);
                if (ttsController) {
                    try {
                        ttsController.abort();
                    } catch (e) {
                        // ignore
                    }
                }
            });

            console.log(`[TTS Queue] stream_finished | chunk_count=${chunkCount} | elapsed_ms=${Date.now() - ttsStartedAt}`);
            if (chunkCount > 0) {
                // Finalize MediaSource so <audio> can reach 'ended'.
                if (overlayWindow && !overlayWindow.isDestroyed()) {
                    overlayWindow.webContents.send('tts-ended', { jobId });
                }

                // Wait until audio playback is fully finished.
                await waitForEnded;
                waitingPlaybackJobId = null;
                console.log(`[TTS Queue] waiting_for_ended=false | job_id=${jobId}`);
            } else {
                // No audio data received, do not wait for renderer ended event.
                waitingPlaybackJobId = null;
                ttsPlaybackEndedResolve = null;
                console.log(`[TTS Queue] no_audio_chunk_skip_wait=true | job_id=${jobId}`);
                if (overlayWindow && !overlayWindow.isDestroyed()) {
                    overlayWindow.webContents.send('tts-ended', { jobId });
                }
            }
        } else {
            // No audio: immediately consider job done.
            if (overlayWindow && !overlayWindow.isDestroyed()) {
                overlayWindow.webContents.send('tts-ended', { jobId });
            }
        }
    } catch (e) {
        console.error('TTS playback error:', e);
    }

    clearTimeout(hardTimeout);
    finishJob();
}

// --- Module Wiring (Perception -> Unified Queue) ---
screenSensor.on('capture', async (capturePayload) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    enqueuePerceptionTask(capturePayload);
});

function createOverlayWindow() {
    overlayWindow = new BrowserWindow({
        width: 800,
        height: 600,
        resizable: false,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    overlayWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    overlayWindow.webContents.on('did-finish-load', () => {
        startGlobalMouseTracking();
        emitUiHistoryUpdate();
    });

    // Start Screen Sensor if not already started
    screenSensor.start();

    // 打开开发者工具 (调试用，发布时可注释)
    // overlayWindow.webContents.openDevTools({ mode: 'detach' });

    overlayWindow.on('closed', function () {
        stopGlobalMouseTracking();
        overlayWindow = null;
        if (!panelWindow || panelWindow.isDestroyed()) {
            app.quit();
        }
    });
}

function createPanelWindow() {
    if (panelWindow && !panelWindow.isDestroyed()) {
        panelWindow.show();
        panelWindow.focus();
        return panelWindow;
    }

    panelWindow = new BrowserWindow({
        width: 980,
        height: 760,
        minWidth: 760,
        minHeight: 560,
        resizable: true,
        frame: true,
        transparent: false,
        show: false,
        title: 'Chat',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    panelWindow.loadFile(path.join(__dirname, '../renderer/panel.html'));
    panelWindow.once('ready-to-show', () => {
        if (!panelWindow || panelWindow.isDestroyed()) return;
        panelWindow.show();
        emitUiHistoryUpdate();
    });

    // Clicking outside this independent panel focuses another window and should collapse it.
    panelWindow.on('blur', () => {
        if (!panelWindow || panelWindow.isDestroyed()) return;
        panelWindow.hide();
    });

    panelWindow.on('closed', () => {
        panelWindow = null;
        if (!overlayWindow || overlayWindow.isDestroyed()) {
            app.quit();
        }
    });

    return panelWindow;
}

function onTtsPlaybackEnded(endedJobId) {
    console.log(`[TTS Queue] received_playback_ended=true | job_id=${endedJobId ?? 'unknown'} | waiting_job_id=${waitingPlaybackJobId ?? 'none'}`);
    if (ttsPlaybackEndedResolve && endedJobId === waitingPlaybackJobId) {
        const fn = ttsPlaybackEndedResolve;
        waitingPlaybackJobId = null;
        ttsPlaybackEndedResolve = null;
        fn();
    }
}

registerIpcHandlers({
    ipcMain,
    BrowserWindow,
    createPanelWindow,
    getOverlayWindow: () => overlayWindow,
    getPanelWindow: () => panelWindow,
    onTtsPlaybackEnded,
    buildUiPanelState,
    enqueueOrMergeCommandTask,
    live2dModelService,
    live2dModelCatalogService,
    buildSerializedLive2DCapabilities,
    getLive2DConfigFallback,
    llmService,
    enqueueTtsJob
});

app.on('ready', () => {
    bindTodoStateUpdates();
    createOverlayWindow();
    startApiServer({
        llmService,
        getOverlayWindow: () => overlayWindow
    });
});

app.on('window-all-closed', function () {
    stopGlobalMouseTracking();
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
    if (overlayWindow === null) createOverlayWindow();
});

app.on('before-quit', () => {
    stopGlobalMouseTracking();
});
