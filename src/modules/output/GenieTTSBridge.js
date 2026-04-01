/* 主要职责：桥接本地 Genie-TTS Worker，输出主程序可消费的流式 MP3 SSE。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const config = require('../../config/runtimeConfig');

const WORKER_PREFIX = '@@GENIE@@';

function makeRequestId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

async function ensureDir(dirPath) {
    await fs.promises.mkdir(dirPath, { recursive: true });
}

function defaultPythonCandidate(envName) {
    const userProfile = process.env.USERPROFILE || os.homedir();
    return path.join(userProfile, 'miniconda3', 'envs', envName, 'python.exe');
}

class GenieTTSBridge {
    constructor() {
        this.enabled = Boolean(config.tts?.localProxyEnabled);
        this.outputDir = path.resolve(
            config.tts?.localProxyOutputDir || path.resolve(config.projectRoot, 'workspace/tts-cache')
        );
        this.projectDir = path.resolve(config.tts?.genieProjectDir || path.resolve(config.projectRoot, 'Genie-TTS'));
        this.character = String(config.tts?.genieCharacter || 'mika');
        this.genieDataDir = String(config.tts?.genieDataDir || '').trim();
        this.condaEnv = String(config.tts?.genieCondaEnv || 'GenieTTS').trim();
        this.pythonPath = String(config.tts?.geniePythonPath || '').trim();
        this.requestTimeoutMs = Math.max(5000, Number(config.tts?.localProxyRequestTimeoutMs) || 120000);

        this.worker = null;
        this.workerRl = null;
        this.pending = new Map();
        this.startingPromise = null;
        this.ready = false;
        this.onceReadyResolver = null;
        this.onceReadyRejecter = null;
    }

    isEnabled() {
        return this.enabled;
    }

    buildWorkerLaunch() {
        const workerScript = path.resolve(__dirname, 'genie_tts_worker.py');
        const args = [
            '-u',
            workerScript,
            '--project-dir',
            this.projectDir,
            '--character',
            this.character,
            '--output-dir',
            this.outputDir
        ];

        if (this.genieDataDir) {
            args.push('--genie-data-dir', this.genieDataDir);
        }

        if (this.pythonPath) {
            return {
                command: this.pythonPath,
                args
            };
        }

        const pythonFromConda = defaultPythonCandidate(this.condaEnv);
        if (fs.existsSync(pythonFromConda)) {
            return {
                command: pythonFromConda,
                args
            };
        }

        return {
            command: 'conda',
            args: ['run', '-n', this.condaEnv, 'python', ...args]
        };
    }

    async start() {
        if (!this.enabled) return;
        if (this.ready && this.worker && !this.worker.killed) return;
        if (this.startingPromise) return this.startingPromise;

        this.startingPromise = (async () => {
            await ensureDir(this.outputDir);
            const launch = this.buildWorkerLaunch();
            const child = spawn(launch.command, launch.args, {
                cwd: this.projectDir,
                windowsHide: true,
                env: {
                    ...process.env,
                    PYTHONIOENCODING: 'utf-8'
                },
                stdio: ['pipe', 'pipe', 'pipe']
            });

            this.worker = child;
            this.ready = false;

            this.workerRl = readline.createInterface({
                input: child.stdout
            });
            this.workerRl.on('line', (line) => this.onWorkerStdoutLine(line));

            child.stderr.on('data', (chunk) => {
                const text = String(chunk || '').trim();
                if (text) {
                    console.warn('[GenieTTSBridge][stderr]', text);
                }
            });

            child.on('error', (error) => {
                if (typeof this.onceReadyRejecter === 'function') {
                    const rejecter = this.onceReadyRejecter;
                    this.onceReadyResolver = null;
                    this.onceReadyRejecter = null;
                    rejecter(error);
                }
            });

            child.on('exit', (code, signal) => {
                const reason = `worker exited: code=${code}, signal=${signal || 'none'}`;
                this.ready = false;
                const pendingEntries = Array.from(this.pending.entries());
                this.pending.clear();
                for (const [, item] of pendingEntries) {
                    clearTimeout(item.timer);
                    item.reject(new Error(reason));
                }
                this.worker = null;
                if (this.workerRl) {
                    this.workerRl.close();
                    this.workerRl = null;
                }
                console.warn('[GenieTTSBridge]', reason);
            });

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Genie worker startup timeout'));
                }, 120000);

                const onReady = () => {
                    clearTimeout(timeout);
                    resolve();
                };
                const onExit = () => {
                    clearTimeout(timeout);
                    reject(new Error('Genie worker exited before ready'));
                };

                child.once('exit', onExit);
                this.onceReadyResolver = () => {
                    child.off('exit', onExit);
                    onReady();
                };
                this.onceReadyRejecter = (error) => {
                    child.off('exit', onExit);
                    clearTimeout(timeout);
                    reject(error);
                };
            });
        })();

        try {
            await this.startingPromise;
        } finally {
            this.startingPromise = null;
            this.onceReadyResolver = null;
            this.onceReadyRejecter = null;
        }
    }

    onWorkerStdoutLine(rawLine) {
        const line = String(rawLine || '').trim();
        if (!line || !line.startsWith(WORKER_PREFIX)) return;

        let payload = null;
        try {
            payload = JSON.parse(line.slice(WORKER_PREFIX.length));
        } catch (error) {
            console.warn('[GenieTTSBridge] failed to parse worker json:', error?.message || error);
            return;
        }

        const type = String(payload?.type || '').toLowerCase();
        if (type === 'ready' && payload?.ok === true) {
            this.ready = true;
            if (typeof this.onceReadyResolver === 'function') {
                const fn = this.onceReadyResolver;
                this.onceReadyResolver = null;
                this.onceReadyRejecter = null;
                fn();
            }
            console.log(`[GenieTTSBridge] ready | character=${payload.character || this.character}`);
            return;
        }

        if (type === 'boot_error') {
            const err = new Error(payload?.error || 'Genie worker boot failed');
            if (typeof this.onceReadyRejecter === 'function') {
                const rejecter = this.onceReadyRejecter;
                this.onceReadyResolver = null;
                this.onceReadyRejecter = null;
                rejecter(err);
            }
            if (this.worker && !this.worker.killed) {
                try {
                    this.worker.kill();
                } catch (error) {
                    // ignore
                }
            }
            console.error('[GenieTTSBridge] boot error:', err.message);
            return;
        }

        const requestId = String(payload?.id || '');
        if (!requestId) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;

        if (type === 'audio_chunk' && typeof pending.onAudioChunk === 'function') {
            pending.onAudioChunk(payload?.pcm_b64).catch((error) => {
                clearTimeout(pending.timer);
                this.pending.delete(requestId);
                pending.reject(error);
            });
            return;
        }

        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        if (payload?.ok === false) {
            pending.reject(new Error(payload?.error || 'genie_synthesis_failed'));
            return;
        }
        pending.resolve(payload);
    }

    async writeSseData(res, payload) {
        if (res.writableEnded || res.destroyed) {
            throw new Error('http_response_closed');
        }
        const line = `data: ${JSON.stringify(payload)}\n\n`;
        if (res.write(line)) return;
        await new Promise((resolve) => res.once('drain', resolve));
    }

    async writeToStdinWithBackpressure(stream, buffer) {
        if (!stream.write(buffer)) {
            await new Promise((resolve) => stream.once('drain', resolve));
        }
    }

    async synthesizeStreamingSse(res, text) {
        if (!this.enabled) {
            throw new Error('Genie local proxy is disabled');
        }
        if (!ffmpegPath) {
            throw new Error('ffmpeg-static not available');
        }

        const normalizedText = String(text || '').trim();
        if (!normalizedText) {
            throw new Error('text is empty');
        }

        await this.start();
        if (!this.worker || this.worker.killed || !this.ready) {
            throw new Error('Genie worker is unavailable');
        }

        const requestId = makeRequestId();
        const requestPayload = {
            type: 'synthesize',
            id: requestId,
            text: normalizedText
        };

        const ffmpeg = spawn(
            ffmpegPath,
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-f',
                's16le',
                '-ar',
                '32000',
                '-ac',
                '1',
                '-i',
                'pipe:0',
                '-ac',
                '1',
                '-ar',
                '32000',
                '-b:a',
                '96k',
                '-f',
                'mp3',
                'pipe:1'
            ],
            {
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            }
        );

        let ffmpegStderr = '';
        let streamedAudioEvents = 0;
        let sseWriteChain = Promise.resolve();

        const pushSse = (payload) => {
            sseWriteChain = sseWriteChain.then(() => this.writeSseData(res, payload));
            return sseWriteChain;
        };

        ffmpeg.stderr.on('data', (chunk) => {
            ffmpegStderr += String(chunk || '');
        });
        ffmpeg.stdout.on('data', (chunk) => {
            streamedAudioEvents += 1;
            const payload = {
                data: {
                    audio: Buffer.from(chunk).toString('hex')
                }
            };
            pushSse(payload).catch((error) => {
                console.warn('[GenieTTSBridge] SSE stream write failed:', error?.message || error);
            });
        });

        const ffmpegOutputPromise = new Promise((resolve, reject) => {
            ffmpeg.on('error', (error) => reject(error));
            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    resolve();
                    return;
                }
                reject(new Error(`ffmpeg exit code=${code}, stderr=${ffmpegStderr.trim()}`));
            });
        });

        const workerResult = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`genie request timeout (${this.requestTimeoutMs}ms)`));
            }, this.requestTimeoutMs);

            this.pending.set(requestId, {
                resolve,
                reject,
                timer,
                onAudioChunk: async (pcmB64) => {
                    if (!pcmB64) return;
                    const pcmBuffer = Buffer.from(String(pcmB64), 'base64');
                    if (!pcmBuffer.length) return;
                    await this.writeToStdinWithBackpressure(ffmpeg.stdin, pcmBuffer);
                }
            });
            this.worker.stdin.write(`${JSON.stringify(requestPayload)}\n`);
        });

        try {
            ffmpeg.stdin.end();
        } catch (error) {
            // ignore
        }

        await ffmpegOutputPromise;
        await sseWriteChain;

        await this.writeSseData(res, {
            base_resp: {
                status_code: 0,
                status_msg: 'success'
            }
        });

        return {
            requestId,
            streamedAudioEvents,
            workerResult
        };
    }

    async dispose() {
        if (!this.worker || this.worker.killed) return;
        try {
            this.worker.stdin.write(`${JSON.stringify({ type: 'shutdown', id: makeRequestId() })}\n`);
        } catch (error) {
            // ignore
        }
        try {
            this.worker.kill();
        } catch (error) {
            // ignore
        }
        this.ready = false;
    }
}

module.exports = {
    GenieTTSBridge
};
