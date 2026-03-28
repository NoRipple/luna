/* 主要职责：作为 Electron 应用启动入口，负责装配窗口、IPC、TTS 队列、AgentRuntime 和 API 服务。 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

const llmService = require('../modules/thinking/LLMService');
const ttsService = require('../modules/output/TTSService');
const screenSensor = require('../modules/perception/ScreenSensor');
const visionService = require('../modules/recognition/VisionService');
const live2dModelService = require('../modules/output/Live2DModelService');
const live2dModelCatalogService = require('../modules/output/Live2DModelCatalogService');
const config = require('../config/runtimeConfig');
const { AgentRuntime } = require('./agentRuntime');
const { startApiServer } = require('./apiServer');
const { registerIpcHandlers } = require('./ipcHandlers');

let overlayWindow;
let panelWindow;
let apiServer;

let ttsController = null;
let ttsQueue = [];
let isTtsPlaying = false;
let ttsPlaybackEndedResolve = null;
let waitingPlaybackJobId = null;
let nextTtsJobId = 1;
let globalMouseTimer = null;
let lastGlobalMousePayload = null;
let backgroundPerceptionTimer = null;
let backgroundPerceptionRunning = false;
let latestUiPanelState = null;
let uiStateVersion = 0;
let uiPerfEmitSeq = 0;
let lastUiPerfEmitAt = 0;

function ensureOverlayOnTop() {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    try {
        overlayWindow.setAlwaysOnTop(true, 'screen-saver');
        overlayWindow.moveTop();
    } catch (error) {
        // noop
    }
}

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

function commitUiPanelState(payload) {
    const nextState = payload || runtime.buildUiPanelState();
    uiStateVersion += 1;
    latestUiPanelState = {
        ...nextState,
        meta: {
            ...(nextState?.meta || {}),
            version: uiStateVersion,
            updatedAt: Date.now()
        }
    };

    if (config.debug?.uiPerf) {
        const now = Date.now();
        const deltaMs = lastUiPerfEmitAt ? (now - lastUiPerfEmitAt) : 0;
        lastUiPerfEmitAt = now;
        uiPerfEmitSeq += 1;
        const timelineCount = Array.isArray(latestUiPanelState?.timeline) ? latestUiPanelState.timeline.length : 0;
        const chatCount = Array.isArray(latestUiPanelState?.chatRecords) ? latestUiPanelState.chatRecords.length : 0;
        const queueLength = Number(latestUiPanelState?.status?.queueLength || 0);
        if (deltaMs <= Math.max(10, Number(config.debug?.uiPerfSlowMs) || 32) || uiPerfEmitSeq % 25 === 0) {
            console.log(
                `[UI PERF][main] emit seq=${uiPerfEmitSeq} delta_ms=${deltaMs} chat=${chatCount} timeline=${timelineCount} queue=${queueLength}`
            );
        }
    }
}

function getUiPanelStateSnapshot() {
    if (latestUiPanelState) {
        return latestUiPanelState;
    }
    commitUiPanelState(runtime.buildUiPanelState());
    return latestUiPanelState;
}

function emitPanelVisibilityChanged(open) {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('panel-visibility-changed', { open: Boolean(open) });
        if (open) {
            ensureOverlayOnTop();
        }
    }
}

const runtime = new AgentRuntime({
    llmService,
    screenSensor,
    visionService,
    live2dModelService,
    buildSerializedLive2DCapabilities,
    getLive2DConfigFallback,
    enqueueTtsJob,
    onStateChanged: commitUiPanelState
});

function startGlobalMouseTracking() {
    if (globalMouseTimer) return;

    const pollInterval = Math.max(8, Number(config.core?.globalMousePollIntervalMs) || 16);
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
    }, pollInterval);
}

function stopGlobalMouseTracking() {
    if (globalMouseTimer) {
        clearInterval(globalMouseTimer);
        globalMouseTimer = null;
    }
    lastGlobalMousePayload = null;
}

function startBackgroundPerceptionLoop() {
    if (backgroundPerceptionTimer) return;
    const intervalMs = Math.max(1000, Number(config.vision?.backgroundIntervalMs) || 10000);

    const runOnce = async () => {
        if (backgroundPerceptionRunning) return;
        backgroundPerceptionRunning = true;
        try {
            await runtime.captureAnalyzePersist('background');
            commitUiPanelState(runtime.buildUiPanelState());
        } catch (error) {
            console.warn('[BackgroundPerception] run failed:', error?.message || error);
        } finally {
            backgroundPerceptionRunning = false;
        }
    };

    runOnce().catch(() => {});
    backgroundPerceptionTimer = setInterval(() => {
        runOnce().catch(() => {});
    }, intervalMs);
}

function stopBackgroundPerceptionLoop() {
    if (backgroundPerceptionTimer) {
        clearInterval(backgroundPerceptionTimer);
        backgroundPerceptionTimer = null;
    }
    backgroundPerceptionRunning = false;
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
    if (isTtsPlaying || !ttsQueue.length) return;

    isTtsPlaying = true;
    const { jobId, job, resolve } = ttsQueue.shift();
    const normalizedJob = { ...job };
    const hardTimeoutMs = Math.max(1000, Number(config.core?.ttsHardTimeoutMs) || 70000);
    const playbackEndedFallbackMs = Math.max(1000, Number(config.core?.ttsPlaybackEndedFallbackMs) || 60000);
    const speakTimeoutMs = Math.max(1000, Number(config.core?.ttsSpeakTimeoutMs) || 25000);

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

    const hardTimeout = setTimeout(() => {
        console.warn(`[TTS Queue] hard_timeout_release=true | timeout_ms=${hardTimeoutMs}`);
        if (ttsController) {
            try {
                ttsController.abort();
            } catch (error) {
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
                }, playbackEndedFallbackMs);
            });

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

            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`TTS speak timeout after ${speakTimeoutMs}ms`));
                }, speakTimeoutMs);
            });

            await Promise.race([speakPromise, timeoutPromise]).catch((error) => {
                console.warn('[TTS Queue] speak_failed_or_timeout=true', error.message);
                if (ttsController) {
                    try {
                        ttsController.abort();
                    } catch (abortError) {
                        // ignore
                    }
                }
            });

            console.log(`[TTS Queue] stream_finished | chunk_count=${chunkCount} | elapsed_ms=${Date.now() - ttsStartedAt}`);
            if (chunkCount > 0) {
                if (overlayWindow && !overlayWindow.isDestroyed()) {
                    overlayWindow.webContents.send('tts-ended', { jobId });
                }
                await waitForEnded;
                waitingPlaybackJobId = null;
                console.log(`[TTS Queue] waiting_for_ended=false | job_id=${jobId}`);
            } else {
                waitingPlaybackJobId = null;
                ttsPlaybackEndedResolve = null;
                console.log(`[TTS Queue] no_audio_chunk_skip_wait=true | job_id=${jobId}`);
                if (overlayWindow && !overlayWindow.isDestroyed()) {
                    overlayWindow.webContents.send('tts-ended', { jobId });
                }
            }
        } else if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('tts-ended', { jobId });
        }
    } catch (error) {
        console.error('TTS playback error:', error);
    }

    clearTimeout(hardTimeout);
    finishJob();
}

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
        ensureOverlayOnTop();
        commitUiPanelState(runtime.buildUiPanelState());
    });

    overlayWindow.on('closed', () => {
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
        emitPanelVisibilityChanged(true);
        ensureOverlayOnTop();
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
            preload: path.join(__dirname, 'preload.js'),
            backgroundThrottling: false
        }
    });

    panelWindow.loadFile(path.join(__dirname, '../renderer/panel.html'));
    panelWindow.once('ready-to-show', () => {
        if (!panelWindow || panelWindow.isDestroyed()) return;
        panelWindow.maximize();
        panelWindow.show();
        emitPanelVisibilityChanged(true);
        ensureOverlayOnTop();
        commitUiPanelState(runtime.buildUiPanelState());
    });

    panelWindow.on('show', () => {
        emitPanelVisibilityChanged(true);
        ensureOverlayOnTop();
    });
    panelWindow.on('focus', () => {
        ensureOverlayOnTop();
    });
    panelWindow.on('move', () => {
        ensureOverlayOnTop();
    });
    panelWindow.on('resize', () => {
        ensureOverlayOnTop();
    });
    panelWindow.on('hide', () => {
        emitPanelVisibilityChanged(false);
    });
    panelWindow.on('minimize', () => {
        emitPanelVisibilityChanged(false);
    });

    panelWindow.on('closed', () => {
        emitPanelVisibilityChanged(false);
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
    buildUiPanelState: () => getUiPanelStateSnapshot(),
    enqueueOrMergeCommandTask: (text) => runtime.enqueueOrMergeCommandTask(text),
    live2dModelService,
    live2dModelCatalogService,
    buildSerializedLive2DCapabilities,
    getLive2DConfigFallback,
    llmService,
    enqueueTtsJob
});

app.on('ready', () => {
    commitUiPanelState(runtime.buildUiPanelState());
    runtime.bindTodoStateUpdates();
    llmService.configureRuntimeAdapters(runtime.createRuntimeAdapters());
    createOverlayWindow();
    startBackgroundPerceptionLoop();
    runtime.enqueueAutonomousTask('boot');
    apiServer = startApiServer({
        llmService,
        getOverlayWindow: () => overlayWindow
    });
});

app.on('window-all-closed', () => {
    stopGlobalMouseTracking();
    stopBackgroundPerceptionLoop();
    runtime.dispose();
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (overlayWindow === null) {
        createOverlayWindow();
    }
});

app.on('before-quit', () => {
    stopGlobalMouseTracking();
    stopBackgroundPerceptionLoop();
    runtime.dispose();
    if (apiServer && typeof apiServer.close === 'function') {
        apiServer.close();
    }
});

