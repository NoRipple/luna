/* 主要职责：在隐藏渲染页中并行抓取系统音频与麦克风，并把双通道 PCM 帧回传主进程。 */
const path = require('path');

function normalizeFrame(payloadFrame) {
    if (!payloadFrame) return null;
    if (Buffer.isBuffer(payloadFrame)) return payloadFrame;
    if (payloadFrame instanceof Uint8Array) {
        return Buffer.from(payloadFrame.buffer, payloadFrame.byteOffset, payloadFrame.byteLength);
    }
    if (payloadFrame instanceof ArrayBuffer) {
        return Buffer.from(payloadFrame);
    }
    if (Array.isArray(payloadFrame)) {
        return Buffer.from(payloadFrame);
    }
    if (payloadFrame?.type === 'Buffer' && Array.isArray(payloadFrame?.data)) {
        return Buffer.from(payloadFrame.data);
    }
    if (payloadFrame?.buffer instanceof ArrayBuffer) {
        const offset = Number(payloadFrame.byteOffset || 0);
        const length = Number(payloadFrame.byteLength || payloadFrame.length || 0);
        return Buffer.from(payloadFrame.buffer, offset, length);
    }
    return null;
}

class ListenCaptureService {
    constructor(options = {}) {
        this.BrowserWindow = options.BrowserWindow;
        this.ipcMain = options.ipcMain;
        this.desktopCapturer = options.desktopCapturer || null;
        this.captureWindow = null;
        this.activeCapture = null;
        this.workerReady = false;
        this.workerReadyPromise = null;
        this.workerReadyResolver = null;

        this.captureHtmlPath = options.captureHtmlPath || path.resolve(
            options.projectRoot || process.cwd(),
            'src/renderer/listenCapture.html'
        );

        this.boundOnWorkerReady = this.onWorkerReady.bind(this);
        this.boundOnFrame = this.onFrame.bind(this);
        this.boundOnError = this.onError.bind(this);
        this.boundOnStatus = this.onStatus.bind(this);
        this.boundOnComplete = this.onComplete.bind(this);

        if (this.ipcMain) {
            this.ipcMain.on('listen-capture-worker-ready', this.boundOnWorkerReady);
            this.ipcMain.on('listen-capture-frame', this.boundOnFrame);
            this.ipcMain.on('listen-capture-error', this.boundOnError);
            this.ipcMain.on('listen-capture-status', this.boundOnStatus);
            this.ipcMain.on('listen-capture-complete', this.boundOnComplete);
        }
    }

    dispose() {
        if (this.ipcMain) {
            this.ipcMain.removeListener('listen-capture-worker-ready', this.boundOnWorkerReady);
            this.ipcMain.removeListener('listen-capture-frame', this.boundOnFrame);
            this.ipcMain.removeListener('listen-capture-error', this.boundOnError);
            this.ipcMain.removeListener('listen-capture-status', this.boundOnStatus);
            this.ipcMain.removeListener('listen-capture-complete', this.boundOnComplete);
        }
        this.activeCapture = null;
        this.workerReady = false;
        this.workerReadyPromise = null;
        this.workerReadyResolver = null;
        if (this.captureWindow && !this.captureWindow.isDestroyed()) {
            try {
                this.captureWindow.close();
            } catch (_error) {
                // ignore
            }
        }
        this.captureWindow = null;
    }

    async ensureCaptureWindow() {
        if (this.captureWindow && !this.captureWindow.isDestroyed()) {
            return this.captureWindow;
        }
        if (!this.BrowserWindow) {
            throw new Error('ListenCaptureService 缺少 BrowserWindow 依赖');
        }

        this.workerReady = false;
        this.workerReadyPromise = new Promise((resolve) => {
            this.workerReadyResolver = resolve;
        });

        this.captureWindow = new this.BrowserWindow({
            show: false,
            width: 1,
            height: 1,
            frame: false,
            transparent: true,
            resizable: false,
            movable: false,
            focusable: false,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                sandbox: false,
                backgroundThrottling: false
            }
        });

        this.captureWindow.on('closed', () => {
            this.captureWindow = null;
            this.workerReady = false;
            this.workerReadyPromise = null;
            this.workerReadyResolver = null;
            if (this.activeCapture) {
                const reject = this.activeCapture.reject;
                this.activeCapture = null;
                reject(new Error('音频采集窗口已关闭'));
            }
        });

        await this.captureWindow.loadFile(this.captureHtmlPath);
        return this.captureWindow;
    }

    async waitForWorkerReady(timeoutMs = 8000) {
        if (this.workerReady) return;
        if (!this.workerReadyPromise) {
            this.workerReadyPromise = new Promise((resolve) => {
                this.workerReadyResolver = resolve;
            });
        }
        let timeoutId = null;
        await Promise.race([
            this.workerReadyPromise,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`音频采集 Worker 启动超时（${timeoutMs}ms）`));
                }, timeoutMs);
            })
        ]).finally(() => {
            if (timeoutId) clearTimeout(timeoutId);
        });
    }

    async resolveSystemSourceId() {
        const capturer = this.desktopCapturer;
        if (!capturer || typeof capturer.getSources !== 'function') {
            throw new Error('系统音频采集失败：desktopCapturer 不可用（主进程）');
        }
        const sources = await capturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1, height: 1 },
            fetchWindowIcons: false
        });
        if (!Array.isArray(sources) || sources.length === 0) {
            throw new Error('系统音频采集失败：未找到可用屏幕源');
        }
        const source = sources[0];
        const sourceId = String(source?.id || '').trim();
        if (!sourceId) {
            throw new Error('系统音频采集失败：屏幕源 ID 为空');
        }
        return sourceId;
    }

    onWorkerReady(event, _payload = {}) {
        const senderId = Number(event?.sender?.id || 0);
        if (!this.captureWindow || this.captureWindow.isDestroyed()) return;
        if (senderId !== this.captureWindow.webContents.id) return;
        this.workerReady = true;
        if (typeof this.workerReadyResolver === 'function') {
            this.workerReadyResolver(true);
        }
        this.workerReadyResolver = null;
    }

    isCaptureSender(event) {
        const senderId = Number(event?.sender?.id || 0);
        if (!this.captureWindow || this.captureWindow.isDestroyed()) return false;
        return senderId === this.captureWindow.webContents.id;
    }

    onFrame(event, payload = {}) {
        if (!this.isCaptureSender(event)) return;
        if (!this.activeCapture) return;
        if (String(payload?.sessionId || '') !== this.activeCapture.sessionId) return;
        const source = String(payload?.source || '').trim().toLowerCase();
        if (source !== 'system' && source !== 'mic') return;
        const frame = normalizeFrame(payload?.frame);
        if (!frame || frame.length === 0) return;
        this.activeCapture.frameCount[source] += 1;
        this.activeCapture.lastFrameAt = Date.now();
        try {
            this.activeCapture.onFrame(source, frame);
        } catch (_error) {
            // ignore consumer errors
        }
    }

    onStatus(event, payload = {}) {
        if (!this.isCaptureSender(event)) return;
        if (!this.activeCapture) return;
        if (String(payload?.sessionId || '') !== this.activeCapture.sessionId) return;
        const status = String(payload?.status || '');
        this.activeCapture.lastStatus = status;
        if (status) {
            this.activeCapture.statusTrail.push({
                status,
                at: Date.now()
            });
        }
        if (typeof this.activeCapture.onStatus === 'function') {
            this.activeCapture.onStatus(payload);
        }
    }

    onError(event, payload = {}) {
        if (!this.isCaptureSender(event)) return;
        if (!this.activeCapture) return;
        if (String(payload?.sessionId || '') !== this.activeCapture.sessionId) return;
        const message = String(payload?.message || '音频采集失败').trim();
        const status = String(payload?.status || '').trim();
        const detail = [message, status ? `status=${status}` : ''].filter(Boolean).join(' | ');
        const reject = this.activeCapture.reject;
        this.activeCapture = null;
        reject(new Error(detail || '音频采集失败'));
    }

    onComplete(event, payload = {}) {
        if (!this.isCaptureSender(event)) return;
        if (!this.activeCapture) return;
        if (String(payload?.sessionId || '') !== this.activeCapture.sessionId) return;
        const resolve = this.activeCapture.resolve;
        const frameCount = this.activeCapture.frameCount;
        const startedAt = this.activeCapture.startedAt;
        const lastStatus = this.activeCapture.lastStatus;
        const statusTrail = Array.isArray(this.activeCapture.statusTrail)
            ? this.activeCapture.statusTrail.slice(-20)
            : [];
        this.activeCapture = null;
        resolve({
            ok: true,
            reason: String(payload?.reason || 'completed'),
            frameCount,
            elapsedMs: Math.max(0, Date.now() - startedAt),
            lastStatus,
            statusTrail
        });
    }

    async captureSeparateAudio(options = {}) {
        const seconds = Math.max(1, Math.min(10, Number(options.seconds || 5)));
        const sampleRate = Math.max(8000, Number(options.sampleRate || 16000));
        const onFrame = typeof options.onFrame === 'function' ? options.onFrame : () => {};
        const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;

        if (this.activeCapture) {
            throw new Error('音频采集正在进行中，请稍后再试');
        }

        const systemSourceId = await this.resolveSystemSourceId();
        await this.ensureCaptureWindow();
        await this.waitForWorkerReady();

        const sessionId = `listen-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const timeoutMs = Math.max(4000, Math.ceil(seconds * 1000 + 6000));

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                if (!this.activeCapture || this.activeCapture.sessionId !== sessionId) return;
                this.activeCapture = null;
                reject(new Error(`音频采集超时（${timeoutMs}ms）`));
                this.sendStop(sessionId);
            }, timeoutMs);

            this.activeCapture = {
                sessionId,
                startedAt: Date.now(),
                frameCount: {
                    system: 0,
                    mic: 0
                },
                statusTrail: [],
                lastFrameAt: 0,
                lastStatus: 'starting',
                onFrame,
                onStatus,
                resolve: (result) => {
                    clearTimeout(timeoutId);
                    resolve(result);
                },
                reject: (error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                }
            };

            this.sendStart({
                sessionId,
                seconds,
                sampleRate,
                systemSourceId
            });
        });
    }

    async captureMixedAudio(options = {}) {
        return this.captureSeparateAudio(options);
    }

    sendStart(payload = {}) {
        if (!this.captureWindow || this.captureWindow.isDestroyed()) {
            throw new Error('音频采集窗口不可用');
        }
        this.captureWindow.webContents.send('listen-capture-start', payload);
    }

    sendStop(sessionId) {
        if (!this.captureWindow || this.captureWindow.isDestroyed()) return;
        this.captureWindow.webContents.send('listen-capture-stop', { sessionId });
    }
}

module.exports = ListenCaptureService;
