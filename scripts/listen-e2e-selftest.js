/* Self-test for listen pipeline: capture(system+mic) -> dual ASR -> transcripts. */
const { app, BrowserWindow, ipcMain, session, desktopCapturer } = require('electron');
const config = require('../src/config/runtimeConfig');
const ListenCaptureService = require('../src/modules/recognition/ListenCaptureService');
const RealtimeAsrService = require('../src/modules/recognition/RealtimeAsrService');

function createBucket() {
    return {
        finalSegments: [],
        partial: '',
        errors: []
    };
}

function applyAsrEvent(bucket, event = {}) {
    const type = String(event?.type || '').trim();
    if (type === 'result') {
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
    if (type === 'error') {
        const message = String(event?.message || '').trim();
        if (message) bucket.errors.push(message);
    }
}

function buildText(bucket) {
    const finals = Array.isArray(bucket?.finalSegments)
        ? bucket.finalSegments.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
    if (finals.length) return finals.join('\n');
    return String(bucket?.partial || '').trim();
}

function configureMediaPermissions() {
    const defaultSession = session?.defaultSession;
    if (!defaultSession) return;
    const allowMediaPermission = (permission, details = {}) => {
        const normalized = String(permission || '').toLowerCase();
        if (normalized === 'microphone' || normalized === 'camera') {
            return true;
        }
        if (normalized === 'display-capture' || normalized === 'desktop-capture') {
            return true;
        }
        if (normalized !== 'media') {
            return false;
        }
        const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
        if (mediaTypes.length === 0) {
            return true;
        }
        return mediaTypes.includes('audio');
    };

    if (typeof defaultSession.setPermissionRequestHandler === 'function') {
        defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
            callback(allowMediaPermission(permission, details));
        });
    }
    if (typeof defaultSession.setPermissionCheckHandler === 'function') {
        defaultSession.setPermissionCheckHandler((_webContents, permission, _requestingOrigin, details) => {
            return allowMediaPermission(permission, details);
        });
    }
}

async function runSelftest() {
    configureMediaPermissions();

    const listenCaptureService = new ListenCaptureService({
        BrowserWindow,
        ipcMain,
        desktopCapturer,
        projectRoot: config.projectRoot
    });
    const systemAsr = new RealtimeAsrService(config.asr || {});
    const micAsr = new RealtimeAsrService(config.asr || {});
    const systemBucket = createBucket();
    const micBucket = createBucket();

    const seconds = Math.max(1, Math.min(10, Number(process.env.LISTEN_SELFTEST_SECONDS || 6)));
    const startedAt = Date.now();
    console.log(`[SELFTEST] start seconds=${seconds}`);
    console.log(`[SELFTEST] asr.endpoint=${String(config?.asr?.endpoint || '')}`);
    console.log(`[SELFTEST] asr.model=${String(config?.asr?.model || '')}`);
    console.log(`[SELFTEST] asr.key_present=${Boolean(String(config?.asr?.apiKey || '').trim())}`);

    let captureResult = null;
    try {
        await systemAsr.startSession({
            format: 'pcm',
            sampleRate: 16000,
            onEvent: (event) => applyAsrEvent(systemBucket, event)
        });
        await micAsr.startSession({
            format: 'pcm',
            sampleRate: 16000,
            onEvent: (event) => applyAsrEvent(micBucket, event)
        });

        captureResult = await listenCaptureService.captureSeparateAudio({
            seconds,
            sampleRate: 16000,
            onStatus: (payload) => {
                const status = String(payload?.status || '').trim();
                if (status) {
                    console.log(`[SELFTEST] capture.status=${status}`);
                }
            },
            onFrame: (source, frame) => {
                if (source === 'system') {
                    systemAsr.sendAudioFrame(frame);
                } else if (source === 'mic') {
                    micAsr.sendAudioFrame(frame);
                }
            }
        });
    } finally {
        await Promise.allSettled([
            systemAsr.stopSession(),
            micAsr.stopSession()
        ]);
        await Promise.allSettled([
            systemAsr.abortSession(),
            micAsr.abortSession()
        ]);
        listenCaptureService.dispose();
    }

    const elapsedMs = Date.now() - startedAt;
    const systemText = buildText(systemBucket);
    const micText = buildText(micBucket);
    const frameCount = captureResult?.frameCount || { system: 0, mic: 0 };
    const report = {
        elapsedMs,
        capture: captureResult,
        frameCount,
        system: {
            hasSpeech: Boolean(systemText),
            textPreview: systemText.slice(0, 300),
            finalSegments: systemBucket.finalSegments.length,
            errors: systemBucket.errors
        },
        mic: {
            hasSpeech: Boolean(micText),
            textPreview: micText.slice(0, 300),
            finalSegments: micBucket.finalSegments.length,
            errors: micBucket.errors
        }
    };
    console.log('[SELFTEST] result=' + JSON.stringify(report, null, 2));

    const hasSystemFrames = Number(frameCount?.system || 0) > 0;
    const hasMicFrames = Number(frameCount?.mic || 0) > 0;
    if (!hasSystemFrames || !hasMicFrames) {
        throw new Error(`frame check failed: system=${frameCount?.system || 0}, mic=${frameCount?.mic || 0}`);
    }
}

app.whenReady()
    .then(async () => {
        try {
            await runSelftest();
            console.log('[SELFTEST] PASS');
            app.exit(0);
        } catch (error) {
            console.error('[SELFTEST] FAIL:', error?.message || error);
            app.exit(1);
        }
    })
    .catch((error) => {
        console.error('[SELFTEST] BOOT FAIL:', error?.message || error);
        app.exit(1);
    });
