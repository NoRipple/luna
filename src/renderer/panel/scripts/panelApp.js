/* 主要职责：作为面板前端入口，负责事件绑定、初始状态获取与渲染调度。 */
import { createPanelDom } from './dom.js';
import { renderPanelState } from './panelStateRenderer.js';
import { hasActiveTimelineEvents, renderTimelineSection } from './timelineLanesRenderer.js';
import { renderExtensionsPage } from './extensionsRenderer.js';
import { renderTaskGraph } from './taskGraphRenderer.js';

function getAudioContextCtor() {
    return window.AudioContext || window.webkitAudioContext || null;
}

function downsamplePcmBuffer(input, inputSampleRate, targetSampleRate) {
    if (!(input instanceof Float32Array)) return new Float32Array();
    if (!Number.isFinite(inputSampleRate) || !Number.isFinite(targetSampleRate) || targetSampleRate <= 0) {
        return new Float32Array(input);
    }
    if (inputSampleRate === targetSampleRate) {
        return new Float32Array(input);
    }
    if (inputSampleRate < targetSampleRate) {
        return new Float32Array(input);
    }

    const sampleRateRatio = inputSampleRate / targetSampleRate;
    const outputLength = Math.max(1, Math.round(input.length / sampleRateRatio));
    const output = new Float32Array(outputLength);
    let outputOffset = 0;
    let inputOffset = 0;
    while (outputOffset < outputLength) {
        const nextInputOffset = Math.round((outputOffset + 1) * sampleRateRatio);
        let sum = 0;
        let count = 0;
        for (let i = inputOffset; i < nextInputOffset && i < input.length; i += 1) {
            sum += input[i];
            count += 1;
        }
        output[outputOffset] = count > 0 ? sum / count : 0;
        outputOffset += 1;
        inputOffset = nextInputOffset;
    }
    return output;
}

function encodePcm16LittleEndian(float32Pcm) {
    if (!(float32Pcm instanceof Float32Array) || float32Pcm.length === 0) {
        return new Uint8Array();
    }
    const buffer = new ArrayBuffer(float32Pcm.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Pcm.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, float32Pcm[i]));
        const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(i * 2, int16, true);
    }
    return new Uint8Array(buffer);
}

function logError(dom, msg) {
    console.error(msg);
    if (!dom.errorLogEl) return;
    const text = String(msg || '').trim();
    if (!text) return;
    const now = new Date();
    const stamp = now.toLocaleTimeString('zh-CN', { hour12: false });
    const lines = String(dom.errorLogEl.dataset.lines || '')
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(-3);
    lines.push(`[${stamp}] ${text}`);
    dom.errorLogEl.dataset.lines = lines.join('\n');
    dom.errorLogEl.style.display = 'block';
    dom.errorLogEl.textContent = lines.join('\n');
    if (logError.hideTimer) {
        clearTimeout(logError.hideTimer);
    }
    logError.hideTimer = setTimeout(() => {
        if (!dom.errorLogEl) return;
        dom.errorLogEl.style.display = 'none';
        dom.errorLogEl.dataset.lines = '';
        dom.errorLogEl.textContent = '';
    }, 9000);
}

window.addEventListener('DOMContentLoaded', () => {
    const dom = createPanelDom();
    if (!dom.historyEl || !dom.chatInputEl || !dom.sendButtonEl) {
        return;
    }
    const panelShell = document.getElementById('panel-shell');
    const panelScaleState = {
        baseWidth: Math.max(1280, window.innerWidth || 1280),
        baseHeight: Math.max(760, window.innerHeight || 760)
    };
    document.body.classList.add('scaled-layout');

    function applyPanelViewportScale() {
        if (!panelShell) return;
        const viewportWidth = Math.max(1, window.innerWidth || 1);
        const viewportHeight = Math.max(1, window.innerHeight || 1);

        if (viewportWidth > panelScaleState.baseWidth) {
            panelScaleState.baseWidth = viewportWidth;
        }
        if (viewportHeight > panelScaleState.baseHeight) {
            panelScaleState.baseHeight = viewportHeight;
        }

        const scale = Math.min(
            viewportWidth / panelScaleState.baseWidth,
            viewportHeight / panelScaleState.baseHeight,
            1
        );
        const scaledWidth = panelScaleState.baseWidth * scale;
        const scaledHeight = panelScaleState.baseHeight * scale;
        const offsetX = (viewportWidth - scaledWidth) / 2;
        const offsetY = (viewportHeight - scaledHeight) / 2;

        panelShell.style.position = 'absolute';
        panelShell.style.left = '0';
        panelShell.style.top = '0';
        panelShell.style.width = `${panelScaleState.baseWidth}px`;
        panelShell.style.height = `${panelScaleState.baseHeight}px`;
        panelShell.style.transformOrigin = 'top left';
        panelShell.style.transform = `translate3d(${offsetX.toFixed(2)}px, ${offsetY.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
    }

    applyPanelViewportScale();
    window.addEventListener('resize', () => {
        applyPanelViewportScale();
    }, { passive: true });

    let latestUiState = {
        status: { text: '空闲', activeType: null, queueLength: 0 },
        realtimePerception: { status: 'idle', summary: '暂无感知结果', detail: '', updatedAt: null },
        recentPerceptions: [],
        panelNote: '',
        autonomousWakeAt: null,
        subagent: { limit: 0, running: 0, queued: 0, channelCount: 0 },
        timelineChannels: [{ id: 'main', name: '主线程', type: 'main' }],
        chatRecords: [],
        rawMessages: [],
        timeline: []
    };
    let latestExtensionsSnapshot = {
        skills: [],
        tools: [],
        mcp: { status: 'placeholder' }
    };
    let latestTaskGraphSnapshot = null;

    let pendingUiState = latestUiState;
    let hasPendingState = false;
    const RENDER_INTERVAL_MS = 200;
    const SNAPSHOT_POLL_MS = 1000;
    const TIMELINE_FRAME_MS = 1000 / 60;
    let perfDebug = { uiPerf: false, uiPerfSlowMs: 32 };
    let uiUpdateCount = 0;
    let flushCount = 0;
    let lastUiUpdateAt = 0;
    let pollingInFlight = false;
    let lastSnapshotVersion = 0;
    let timelineRafId = 0;
    let timelineLastFrameAt = 0;
    let chatViewMode = 'user';
    let currentRoute = 'chat';
    let extensionsLoading = false;
    let taskGraphLoading = false;
    const TARGET_ASR_SAMPLE_RATE = 16000;
    const AudioContextCtor = getAudioContextCtor();
    const voiceState = {
        unsupportedReason: '',
        recording: false,
        stopping: false,
        pendingSubmit: false,
        draftBeforeRecording: '',
        transcriptFinal: '',
        transcriptPartial: '',
        stream: null,
        audioContext: null,
        sourceNode: null,
        processorNode: null,
        gainNode: null
    };

    function resolveVoiceUnsupportedReason() {
        if (!dom.voiceButtonEl) return '语音按钮未初始化';
        if (!window.electronAPI?.voiceAsrStart || !window.electronAPI?.voiceAsrSendAudioFrame || !window.electronAPI?.voiceAsrStop) {
            return '语音 IPC 通道不可用';
        }
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
            return '当前环境不支持麦克风采集';
        }
        if (!AudioContextCtor) {
            return '当前环境不支持音频处理';
        }
        return '';
    }

    function syncChatViewToggle() {
        if (!dom.chatViewToggleEl) return;
        const isRaw = chatViewMode === 'raw';
        dom.chatViewToggleEl.dataset.mode = isRaw ? 'raw' : 'user';
        dom.chatViewToggleEl.textContent = isRaw ? '用户视图' : '真实视野';
        dom.chatViewToggleEl.title = isRaw
            ? '切换回用户视图（仅用户命令与 speak 回复）'
            : '切换到真实视野（显示原始 messages）';
    }

    function syncRouteView() {
        document.body.dataset.route = currentRoute;
        if (dom.pageChatEl) dom.pageChatEl.classList.toggle('active', currentRoute === 'chat');
        if (dom.pageExtensionsEl) dom.pageExtensionsEl.classList.toggle('active', currentRoute === 'extensions');
        if (dom.pageTaskGraphEl) dom.pageTaskGraphEl.classList.toggle('active', currentRoute === 'task_graph');
        if (dom.navChatEl) dom.navChatEl.dataset.active = currentRoute === 'chat' ? 'true' : 'false';
        if (dom.navExtensionsEl) dom.navExtensionsEl.dataset.active = currentRoute === 'extensions' ? 'true' : 'false';
        if (dom.navTaskGraphEl) dom.navTaskGraphEl.dataset.active = currentRoute === 'task_graph' ? 'true' : 'false';
    }

    function setRoute(route = 'chat') {
        const nextRoute = ['chat', 'extensions', 'task_graph'].includes(route) ? route : 'chat';
        if (currentRoute === nextRoute) return;
        currentRoute = nextRoute;
        syncRouteView();
        if (currentRoute === 'extensions') {
            refreshExtensionsSnapshot().catch(() => {});
        } else if (currentRoute === 'task_graph') {
            refreshTaskGraphSnapshot().catch(() => {});
        }
        flushPanelState(true);
    }

    syncChatViewToggle();
    syncRouteView();

    function reportPerf(type, data = {}) {
        if (!perfDebug.uiPerf) return;
        const payload = {
            type,
            at: Date.now(),
            ...data
        };
        try {
            console.log('[UI PERF]', payload);
            if (window.electronAPI?.sendUIPerfLog) {
                window.electronAPI.sendUIPerfLog(payload);
            }
        } catch (error) {
            // ignore debug log failures
        }
    }

    function flushPanelState(force = false) {
        if (!force && !hasPendingState) return;
        const started = performance.now();
        latestUiState = pendingUiState || latestUiState;
        hasPendingState = false;
        const renderStarted = performance.now();
        renderPanelState(dom, latestUiState, { chatViewMode });
        renderExtensionsPage(dom, latestExtensionsSnapshot);
        renderTaskGraph(dom, latestTaskGraphSnapshot);
        const renderMs = performance.now() - renderStarted;
        const timelineStarted = performance.now();
        renderTimelineSection(dom, latestUiState, Date.now());
        ensureTimelineLoop();
        const timelineMs = performance.now() - timelineStarted;
        const totalMs = performance.now() - started;
        flushCount += 1;

        if (perfDebug.uiPerf && (
            totalMs >= perfDebug.uiPerfSlowMs ||
            renderMs >= perfDebug.uiPerfSlowMs
        )) {
            reportPerf('panel_flush_slow', {
                flush_count: flushCount,
                render_ms: Number(renderMs.toFixed(2)),
                timeline_ms: Number(timelineMs.toFixed(2)),
                total_ms: Number(totalMs.toFixed(2)),
                chat_size: Array.isArray(latestUiState?.chatRecords) ? latestUiState.chatRecords.length : 0,
                timeline_size: Array.isArray(latestUiState?.timeline) ? latestUiState.timeline.length : 0
            });
        }
    }

    function schedulePanelRender(nextState) {
        const nowPerf = performance.now();
        pendingUiState = nextState || pendingUiState;
        hasPendingState = true;
        uiUpdateCount += 1;
        if (lastUiUpdateAt) {
            const gapMs = nowPerf - lastUiUpdateAt;
            if (perfDebug.uiPerf && gapMs >= 120) {
                reportPerf('ui_update_gap', {
                    gap_ms: Number(gapMs.toFixed(2)),
                    update_count: uiUpdateCount
                });
            }
        }
        lastUiUpdateAt = nowPerf;
    }

    function applySnapshot(state) {
        const nextState = state || latestUiState;
        const version = Number(nextState?.meta?.version || 0);
        if (version > 0 && version === lastSnapshotVersion) {
            return;
        }
        if (version > 0) {
            lastSnapshotVersion = version;
        }
        schedulePanelRender(nextState);
    }

    function stopTimelineLoop() {
        if (!timelineRafId) return;
        window.cancelAnimationFrame(timelineRafId);
        timelineRafId = 0;
    }

    function runTimelineLoop(frameNow) {
        if (frameNow - timelineLastFrameAt >= TIMELINE_FRAME_MS) {
            timelineLastFrameAt = frameNow;
            renderTimelineSection(dom, latestUiState, Date.now());
        }

        if (!document.hidden && hasActiveTimelineEvents(latestUiState, Date.now())) {
            timelineRafId = window.requestAnimationFrame(runTimelineLoop);
            return;
        }

        timelineRafId = 0;
    }

    function ensureTimelineLoop() {
        if (document.hidden) {
            stopTimelineLoop();
            return;
        }
        if (!hasActiveTimelineEvents(latestUiState, Date.now())) {
            stopTimelineLoop();
            return;
        }
        if (timelineRafId) return;
        timelineLastFrameAt = 0;
        timelineRafId = window.requestAnimationFrame(runTimelineLoop);
    }

    async function refreshExtensionsSnapshot() {
        if (extensionsLoading || !window.electronAPI?.getPanelExtensionsSnapshot) return;
        extensionsLoading = true;
        try {
            const result = await window.electronAPI.getPanelExtensionsSnapshot();
            if (!result?.ok) {
                logError(dom, result?.message || '扩展能力数据加载失败');
                return;
            }
            latestExtensionsSnapshot = {
                skills: Array.isArray(result.skills) ? result.skills : [],
                tools: Array.isArray(result.tools) ? result.tools : [],
                mcp: result.mcp && typeof result.mcp === 'object' ? result.mcp : { status: 'placeholder' }
            };
            flushPanelState(true);
        } catch (error) {
            logError(dom, `扩展能力数据加载失败: ${error.message}`);
        } finally {
            extensionsLoading = false;
        }
    }

    async function refreshTaskGraphSnapshot() {
        if (taskGraphLoading || !window.electronAPI?.getPanelTaskGraph) return;
        taskGraphLoading = true;
        try {
            const result = await window.electronAPI.getPanelTaskGraph();
            if (!result?.ok) {
                logError(dom, result?.message || '任务图数据加载失败');
                return;
            }
            latestTaskGraphSnapshot = {
                tasks: Array.isArray(result.tasks) ? result.tasks : [],
                generatedAt: Number(result.generatedAt || Date.now()),
                hasCycle: Boolean(result.hasCycle)
            };
            flushPanelState(true);
        } catch (error) {
            logError(dom, `任务图数据加载失败: ${error.message}`);
        } finally {
            taskGraphLoading = false;
        }
    }

    async function handleSkillToggle(skillName, enabled) {
        if (!window.electronAPI?.setPanelSkillEnabled) return;
        try {
            const result = await window.electronAPI.setPanelSkillEnabled(skillName, enabled);
            if (!result?.ok) {
                logError(dom, result?.message || `Skill 开关更新失败: ${skillName}`);
            }
        } catch (error) {
            logError(dom, `Skill 开关更新失败: ${error.message}`);
        }
        await refreshExtensionsSnapshot();
    }

    async function pollSnapshot() {
        if (pollingInFlight || !window.electronAPI?.getUIHistorySnapshot) return;
        pollingInFlight = true;
        try {
            const state = await window.electronAPI.getUIHistorySnapshot();
            applySnapshot(state);
        } catch (error) {
            if (perfDebug.uiPerf) {
                reportPerf('snapshot_poll_failed', {
                    message: String(error?.message || error || 'unknown')
                });
            }
        } finally {
            pollingInFlight = false;
        }
    }

    function setVoiceMeta(text, state = 'idle') {
        if (!dom.voiceMetaEl) return;
        dom.voiceMetaEl.textContent = text;
        dom.voiceMetaEl.dataset.state = state;
    }

    function buildVoicePreviewText() {
        const finalText = String(voiceState.transcriptFinal || '').trim();
        const partialText = String(voiceState.transcriptPartial || '').trim();
        if (finalText && partialText) {
            return `${finalText}\n${partialText}`.trim();
        }
        return (finalText || partialText || '').trim();
    }

    function syncVoiceDraftToInput() {
        if (!voiceState.recording && !voiceState.stopping) return;
        const transcript = buildVoicePreviewText();
        const prefix = String(voiceState.draftBeforeRecording || '').trim();
        if (!transcript) {
            dom.chatInputEl.value = voiceState.draftBeforeRecording;
            return;
        }
        dom.chatInputEl.value = prefix ? `${prefix}\n${transcript}` : transcript;
    }

    async function stopVoiceCaptureGraph() {
        if (voiceState.processorNode) {
            try {
                voiceState.processorNode.disconnect();
            } catch (_error) {
                // ignore
            }
        }
        if (voiceState.sourceNode) {
            try {
                voiceState.sourceNode.disconnect();
            } catch (_error) {
                // ignore
            }
        }
        if (voiceState.gainNode) {
            try {
                voiceState.gainNode.disconnect();
            } catch (_error) {
                // ignore
            }
        }
        if (voiceState.stream) {
            for (const track of voiceState.stream.getTracks()) {
                try {
                    track.stop();
                } catch (_error) {
                    // ignore
                }
            }
        }
        if (voiceState.audioContext) {
            try {
                await voiceState.audioContext.close();
            } catch (_error) {
                // ignore
            }
        }

        voiceState.processorNode = null;
        voiceState.sourceNode = null;
        voiceState.gainNode = null;
        voiceState.stream = null;
        voiceState.audioContext = null;
    }

    function syncVoiceUi() {
        if (!dom.voiceButtonEl) return;
        const disabledByUnsupported = Boolean(voiceState.unsupportedReason);
        const busy = voiceState.stopping;
        const recording = voiceState.recording;

        dom.voiceButtonEl.dataset.state = recording ? 'recording' : 'idle';
        dom.voiceButtonEl.disabled = disabledByUnsupported || busy;
        dom.voiceButtonEl.textContent = recording ? '■' : '🎙';
        dom.voiceButtonEl.title = recording ? '停止并发送语音命令' : '开始语音输入';

        if (disabledByUnsupported) {
            dom.voiceButtonEl.title = voiceState.unsupportedReason;
            setVoiceMeta(`语音不可用：${voiceState.unsupportedReason}`, 'error');
            return;
        }
        if (voiceState.stopping) {
            setVoiceMeta('正在结束语音识别...', 'idle');
            return;
        }
        if (voiceState.recording) {
            setVoiceMeta('语音输入中...', 'recording');
            return;
        }
        setVoiceMeta('语音输入未开启', 'idle');
    }

    async function startVoiceCaptureGraph(stream) {
        if (!AudioContextCtor) {
            throw new Error('当前环境不支持音频处理');
        }

        const audioContext = new AudioContextCtor();
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        const sourceNode = audioContext.createMediaStreamSource(stream);
        const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 0;

        processorNode.onaudioprocess = (event) => {
            if (!voiceState.recording) return;
            const channelData = event.inputBuffer.getChannelData(0);
            const sampled = downsamplePcmBuffer(channelData, audioContext.sampleRate, TARGET_ASR_SAMPLE_RATE);
            const pcm16 = encodePcm16LittleEndian(sampled);
            if (!pcm16.length) return;
            window.electronAPI.voiceAsrSendAudioFrame(pcm16);
        };

        sourceNode.connect(processorNode);
        processorNode.connect(gainNode);
        gainNode.connect(audioContext.destination);

        voiceState.audioContext = audioContext;
        voiceState.sourceNode = sourceNode;
        voiceState.processorNode = processorNode;
        voiceState.gainNode = gainNode;
    }

    function appendVoiceFinalText(text) {
        const normalized = String(text || '').trim();
        if (!normalized) return;
        voiceState.transcriptFinal = voiceState.transcriptFinal
            ? `${voiceState.transcriptFinal}\n${normalized}`
            : normalized;
        voiceState.transcriptPartial = '';
        syncVoiceDraftToInput();
    }

    function getVoiceFinalTranscript() {
        const text = buildVoicePreviewText();
        return String(text || '').trim();
    }

    async function finalizeVoiceCapture() {
        if (!voiceState.recording && !voiceState.stopping) return;
        const transcript = getVoiceFinalTranscript();
        const shouldSubmit = voiceState.pendingSubmit;
        const fallbackDraft = voiceState.draftBeforeRecording;
        let finalMetaText = '';
        let finalMetaState = 'idle';
        voiceState.recording = false;
        voiceState.stopping = false;
        voiceState.pendingSubmit = false;

        if (!transcript) {
            dom.chatInputEl.value = fallbackDraft;
            finalMetaText = '未识别到有效语音';
        } else {
            dom.chatInputEl.value = transcript;
            if (shouldSubmit) {
                await sendCommand(transcript, { keepInputOnFailure: true });
                if (dom.chatInputEl.value.trim() === transcript) {
                    dom.chatInputEl.value = '';
                }
                finalMetaText = '语音命令已发送';
            } else {
                finalMetaText = '语音识别完成';
            }
        }

        voiceState.draftBeforeRecording = '';
        voiceState.transcriptFinal = '';
        voiceState.transcriptPartial = '';
        syncVoiceUi();
        if (finalMetaText) {
            setVoiceMeta(finalMetaText, finalMetaState);
        }
    }

    async function startVoiceInput() {
        if (voiceState.recording || voiceState.stopping) return;
        voiceState.unsupportedReason = resolveVoiceUnsupportedReason();
        if (voiceState.unsupportedReason) {
            syncVoiceUi();
            return;
        }

        voiceState.stopping = true;
        syncVoiceUi();
        let stream = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: TARGET_ASR_SAMPLE_RATE,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            const started = await window.electronAPI.voiceAsrStart({
                format: 'pcm',
                sampleRate: TARGET_ASR_SAMPLE_RATE
            });
            if (!started?.ok) {
                throw new Error(started?.message || '语音识别服务启动失败');
            }

            await startVoiceCaptureGraph(stream);
            voiceState.stream = stream;
            voiceState.recording = true;
            voiceState.stopping = false;
            voiceState.pendingSubmit = false;
            voiceState.draftBeforeRecording = dom.chatInputEl.value;
            voiceState.transcriptFinal = '';
            voiceState.transcriptPartial = '';
            syncVoiceUi();
        } catch (error) {
            if (stream) {
                for (const track of stream.getTracks()) {
                    try {
                        track.stop();
                    } catch (_error) {
                        // ignore
                    }
                }
            }
            await stopVoiceCaptureGraph();
            await window.electronAPI.voiceAsrAbort().catch(() => {});
            voiceState.recording = false;
            voiceState.stopping = false;
            voiceState.pendingSubmit = false;
            syncVoiceUi();
            const message = `语音输入启动失败: ${error?.message || error}`;
            setVoiceMeta(message, 'error');
            logError(dom, message);
        }
    }

    async function stopVoiceInput({ submit = true } = {}) {
        if (!voiceState.recording && !voiceState.stopping) return;
        if (voiceState.stopping && !voiceState.recording) return;

        voiceState.pendingSubmit = Boolean(submit);
        voiceState.recording = false;
        voiceState.stopping = true;
        syncVoiceUi();

        await stopVoiceCaptureGraph();
        try {
            const stopResult = await window.electronAPI.voiceAsrStop();
            if (!stopResult?.ok) {
                throw new Error(stopResult?.message || '语音识别停止失败');
            }
        } catch (error) {
            await window.electronAPI.voiceAsrAbort().catch(() => {});
            const message = `停止语音识别失败: ${error?.message || error}`;
            setVoiceMeta(message, 'error');
            logError(dom, message);
        }
        await finalizeVoiceCapture();
    }

    async function handleVoiceAsrEvent(payload = {}) {
        const eventType = String(payload?.type || '');
        if (!eventType) return;

        if (eventType === 'started') {
            setVoiceMeta('语音识别通道已建立', 'recording');
            return;
        }

        if (eventType === 'result') {
            if (!voiceState.recording && !voiceState.stopping) return;
            const text = String(payload?.text || '');
            if (!text.trim()) return;
            if (payload?.isFinal) {
                appendVoiceFinalText(text);
            } else {
                voiceState.transcriptPartial = text;
                syncVoiceDraftToInput();
            }
            return;
        }

        if (eventType === 'error') {
            const message = String(payload?.message || '语音识别发生错误');
            setVoiceMeta(`语音错误：${message}`, 'error');
            if (voiceState.recording) {
                await stopVoiceInput({ submit: false });
            }
            return;
        }

        if (eventType === 'closed') {
            if (voiceState.stopping || voiceState.recording) {
                await finalizeVoiceCapture();
            }
            return;
        }
    }

    async function sendCommand(overrideText = '', options = {}) {
        const text = String(overrideText || dom.chatInputEl.value || '').trim();
        const keepInputOnFailure = Boolean(options.keepInputOnFailure);
        if (!text || !window.electronAPI?.sendUICommand) return;
        dom.sendButtonEl.disabled = true;
        try {
            const result = await window.electronAPI.sendUICommand(text);
            if (!result?.ok) {
                logError(dom, result?.message || '命令发送失败');
                if (keepInputOnFailure) {
                    dom.chatInputEl.value = text;
                }
                return;
            }
            dom.chatInputEl.value = '';
        } catch (error) {
            logError(dom, `命令发送失败: ${error.message}`);
            if (keepInputOnFailure) {
                dom.chatInputEl.value = text;
            }
        } finally {
            dom.sendButtonEl.disabled = false;
        }
    }

    dom.sendButtonEl.addEventListener('click', () => {
        sendCommand().catch(() => {});
    });

    if (dom.voiceButtonEl) {
        dom.voiceButtonEl.addEventListener('click', () => {
            if (voiceState.recording) {
                stopVoiceInput({ submit: true }).catch(() => {});
                return;
            }
            startVoiceInput().catch(() => {});
        });
    }

    dom.chatInputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendCommand().catch(() => {});
        }
    });

    if (dom.chatViewToggleEl) {
        dom.chatViewToggleEl.addEventListener('click', () => {
            chatViewMode = chatViewMode === 'raw' ? 'user' : 'raw';
            syncChatViewToggle();
            flushPanelState(true);
        });
    }
    if (dom.navChatEl) {
        dom.navChatEl.addEventListener('click', () => setRoute('chat'));
    }
    if (dom.navExtensionsEl) {
        dom.navExtensionsEl.addEventListener('click', () => setRoute('extensions'));
    }
    if (dom.navTaskGraphEl) {
        dom.navTaskGraphEl.addEventListener('click', () => setRoute('task_graph'));
    }
    if (dom.chatOpenTaskGraphEl) {
        dom.chatOpenTaskGraphEl.addEventListener('click', () => setRoute('task_graph'));
    }
    if (dom.extensionsRefreshEl) {
        dom.extensionsRefreshEl.addEventListener('click', () => {
            refreshExtensionsSnapshot().catch(() => {});
        });
    }
    if (dom.taskGraphRefreshEl) {
        dom.taskGraphRefreshEl.addEventListener('click', () => {
            refreshTaskGraphSnapshot().catch(() => {});
        });
    }
    if (dom.skillsListEl) {
        dom.skillsListEl.addEventListener('change', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement)) return;
            if (target.dataset.role !== 'skill-toggle') return;
            const skillName = String(target.dataset.skillName || '').trim();
            if (!skillName) return;
            handleSkillToggle(skillName, target.checked).catch(() => {});
        });
    }
    if (window.electronAPI?.onVoiceAsrEvent) {
        window.electronAPI.onVoiceAsrEvent((payload) => {
            handleVoiceAsrEvent(payload).catch(() => {});
        });
    }

    voiceState.unsupportedReason = resolveVoiceUnsupportedReason();
    syncVoiceUi();

    if (window.electronAPI?.getDebugFlags) {
        window.electronAPI.getDebugFlags()
            .then((flags) => {
                perfDebug = {
                    uiPerf: Boolean(flags?.uiPerf),
                    uiPerfSlowMs: Number(flags?.uiPerfSlowMs) || 32
                };
                reportPerf('debug_flags_loaded', perfDebug);
            })
            .catch(() => {});
    }

    if (window.electronAPI?.getUIHistorySnapshot) {
        window.electronAPI.getUIHistorySnapshot()
            .then((state) => {
                applySnapshot(state);
                flushPanelState(true);
            })
            .catch((error) => logError(dom, `状态加载失败: ${error.message}`));
    } else {
        schedulePanelRender(latestUiState);
        flushPanelState(true);
    }

    refreshExtensionsSnapshot().catch(() => {});
    window.setInterval(() => {
        flushPanelState(false);
    }, RENDER_INTERVAL_MS);

    window.setInterval(() => {
        pollSnapshot().catch(() => {});
    }, SNAPSHOT_POLL_MS);

    if (window.ResizeObserver && dom.timelineLanesEl) {
        const resizeObserver = new window.ResizeObserver(() => {
            renderTimelineSection(dom, latestUiState, Date.now());
            ensureTimelineLoop();
        });
        resizeObserver.observe(dom.timelineLanesEl);
    }

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            flushPanelState(true);
            ensureTimelineLoop();
            return;
        }
        stopTimelineLoop();
    });

    window.addEventListener('beforeunload', () => {
        stopVoiceCaptureGraph().catch(() => {});
        const abortPromise = window.electronAPI?.voiceAsrAbort?.();
        if (abortPromise && typeof abortPromise.catch === 'function') {
            abortPromise.catch(() => {});
        }
    });

    let loopProbeExpected = performance.now() + 250;
    window.setInterval(() => {
        if (!perfDebug.uiPerf) {
            loopProbeExpected = performance.now() + 250;
            return;
        }
        const nowPerf = performance.now();
        const lagMs = nowPerf - loopProbeExpected;
        loopProbeExpected = nowPerf + 250;
        if (lagMs >= perfDebug.uiPerfSlowMs) {
            reportPerf('renderer_event_loop_lag', {
                lag_ms: Number(lagMs.toFixed(2)),
                has_pending_state: hasPendingState
            });
        }
    }, 250);
});
