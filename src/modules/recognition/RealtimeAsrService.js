/* 主要职责：管理 DashScope 实时语音识别 WebSocket 会话，收口任务生命周期与音频帧传输。 */
const { randomUUID } = require('crypto');
const WebSocket = require('ws');

class RealtimeAsrService {
    constructor(options = {}) {
        this.defaultApiKey = String(options.apiKey || '').trim();
        this.defaultEndpoint = this.normalizeEndpoint(options.endpoint || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference');
        this.defaultModel = String(options.model || 'fun-asr-realtime').trim();
        this.defaultFormat = String(options.format || 'pcm').trim().toLowerCase();
        this.defaultSampleRate = Number(options.sampleRate || 16000);
        this.defaultSemanticPunctuationEnabled = Boolean(options.semanticPunctuationEnabled);
        this.defaultHeartbeat = Boolean(options.heartbeat);
        this.defaultMaxSentenceSilence = Number(options.maxSentenceSilence || 0);
        this.defaultMultiThresholdModeEnabled = Boolean(options.multiThresholdModeEnabled);

        this.session = null;
        this.eventHandler = null;
    }

    isActive() {
        return Boolean(this.session);
    }

    async startSession(options = {}) {
        if (this.session) {
            throw new Error('语音识别会话已在运行中');
        }

        const apiKey = String(options.apiKey || this.defaultApiKey || '').trim();
        if (!apiKey) {
            throw new Error('缺少 ASR API Key，请配置 ASR_API_KEY 或 DASHSCOPE_API_KEY');
        }

        const endpoint = this.normalizeEndpoint(options.endpoint || this.defaultEndpoint || '');
        if (!endpoint) {
            throw new Error('缺少 ASR WebSocket Endpoint');
        }

        const model = String(options.model || this.defaultModel || 'fun-asr-realtime').trim();
        const format = String(options.format || this.defaultFormat || 'pcm').trim().toLowerCase();
        const sampleRate = Math.max(8000, Number(options.sampleRate || this.defaultSampleRate || 16000));
        const semanticPunctuationEnabled = this.resolveOptionalBoolean(
            options.semanticPunctuationEnabled,
            this.defaultSemanticPunctuationEnabled
        );
        const heartbeat = this.resolveOptionalBoolean(options.heartbeat, this.defaultHeartbeat);
        const maxSentenceSilence = Number(options.maxSentenceSilence || this.defaultMaxSentenceSilence || 0);
        const multiThresholdModeEnabled = this.resolveOptionalBoolean(
            options.multiThresholdModeEnabled,
            this.defaultMultiThresholdModeEnabled
        );
        const startTimeoutMs = Math.max(2000, Number(options.startTimeoutMs || 10000));
        const taskId = randomUUID().replace(/-/g, '').slice(0, 32);
        this.eventHandler = typeof options.onEvent === 'function' ? options.onEvent : null;

        const ws = new WebSocket(endpoint, {
            headers: {
                Authorization: `Bearer ${apiKey}`
            }
        });

        this.session = {
            ws,
            taskId,
            model,
            format,
            sampleRate,
            semanticPunctuationEnabled,
            heartbeat,
            maxSentenceSilence,
            multiThresholdModeEnabled,
            started: false,
            finished: false,
            finishRequested: false,
            startResolver: null,
            startRejecter: null,
            stopResolver: null,
            stopPromise: null
        };

        const started = new Promise((resolve, reject) => {
            this.session.startResolver = resolve;
            this.session.startRejecter = reject;
        });

        const timeout = setTimeout(() => {
            this.rejectStart(new Error(`语音识别会话启动超时（${startTimeoutMs}ms）`));
            this.safeCloseSocket(1000, 'start timeout');
        }, startTimeoutMs);

        ws.on('open', () => {
            this.sendRunTaskCommand();
        });
        ws.on('message', (data, isBinary) => {
            this.handleSocketMessage(data, isBinary);
        });
        ws.on('error', (error) => {
            this.handleSocketError(error);
        });
        ws.on('unexpected-response', (_request, response) => {
            this.handleUnexpectedResponse(response);
        });
        ws.on('close', (code, reason) => {
            this.handleSocketClose(code, reason);
        });

        try {
            await started;
            return {
                taskId,
                model,
                format,
                sampleRate
            };
        } finally {
            clearTimeout(timeout);
        }
    }

    sendAudioFrame(frame) {
        const session = this.session;
        if (!session || !session.started || session.finishRequested || session.finished) {
            return false;
        }
        if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
            return false;
        }

        try {
            const binary = this.normalizeFrame(frame);
            if (!binary || binary.length === 0) return false;
            session.ws.send(binary, { binary: true });
            return true;
        } catch (error) {
            this.emitEvent({
                type: 'error',
                message: `发送音频帧失败: ${error?.message || error}`
            });
            return false;
        }
    }

    async stopSession() {
        const session = this.session;
        if (!session) {
            return { ok: true, alreadyStopped: true };
        }

        if (session.stopPromise) {
            return session.stopPromise;
        }

        session.stopPromise = new Promise((resolve) => {
            session.stopResolver = resolve;
            const timeout = setTimeout(() => {
                this.resolveStop({ ok: true, timeout: true });
                this.safeCloseSocket(1000, 'stop timeout');
            }, 4000);

            const wrappedResolve = (payload) => {
                clearTimeout(timeout);
                resolve(payload);
            };
            session.stopResolver = wrappedResolve;
        });

        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            if (session.started && !session.finishRequested) {
                session.finishRequested = true;
                const command = {
                    header: {
                        action: 'finish-task',
                        task_id: session.taskId,
                        streaming: 'duplex'
                    },
                    payload: {
                        input: {}
                    }
                };
                try {
                    session.ws.send(JSON.stringify(command));
                } catch (_error) {
                    this.safeCloseSocket(1000, 'finish-task send failed');
                }
            } else {
                this.safeCloseSocket(1000, 'stop without started task');
            }
        } else {
            this.resolveStop({ ok: true, alreadyClosed: true });
        }

        return session.stopPromise;
    }

    async abortSession() {
        const session = this.session;
        if (!session) {
            return { ok: true, alreadyStopped: true };
        }
        this.resolveStop({ ok: true, aborted: true });
        this.safeCloseSocket(1000, 'aborted');
        return { ok: true };
    }

    sendRunTaskCommand() {
        const session = this.session;
        if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) return;

        const parameters = {
            format: session.format,
            sample_rate: session.sampleRate
        };
        if (session.semanticPunctuationEnabled !== null) {
            parameters.semantic_punctuation_enabled = session.semanticPunctuationEnabled;
        }
        if (session.heartbeat !== null) {
            parameters.heartbeat = session.heartbeat;
        }
        if (session.maxSentenceSilence > 0) {
            parameters.max_sentence_silence = session.maxSentenceSilence;
        }
        if (session.multiThresholdModeEnabled !== null) {
            parameters.multi_threshold_mode_enabled = session.multiThresholdModeEnabled;
        }

        const command = {
            header: {
                action: 'run-task',
                task_id: session.taskId,
                streaming: 'duplex'
            },
            payload: {
                task_group: 'audio',
                task: 'asr',
                function: 'recognition',
                model: session.model,
                parameters,
                input: {}
            }
        };

        try {
            session.ws.send(JSON.stringify(command));
        } catch (error) {
            this.rejectStart(new Error(`run-task 发送失败: ${error?.message || error}`));
            this.safeCloseSocket(1000, 'run-task send failed');
        }
    }

    handleSocketMessage(data, isBinary) {
        if (isBinary) return;

        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
        if (!text.trim()) return;

        let message;
        try {
            message = JSON.parse(text);
        } catch (error) {
            this.emitEvent({
                type: 'warning',
                message: '收到无法解析的 ASR 消息'
            });
            return;
        }

        const event = String(message?.header?.event || '').trim();
        if (!event) return;

        if (event === 'task-started') {
            if (this.session) {
                this.session.started = true;
            }
            this.resolveStart();
            this.emitEvent({
                type: 'started',
                taskId: this.session?.taskId || ''
            });
            return;
        }

        if (event === 'result-generated') {
            const sentence = message?.payload?.output?.sentence || {};
            if (sentence?.heartbeat === true) return;
            const sentenceText = String(sentence?.text || '');
            if (!sentenceText.trim()) return;
            this.emitEvent({
                type: 'result',
                text: sentenceText,
                isFinal: Boolean(sentence?.sentence_end),
                beginTime: this.toNumberOrNull(sentence?.begin_time),
                endTime: this.toNumberOrNull(sentence?.end_time)
            });
            return;
        }

        if (event === 'task-finished') {
            if (this.session) {
                this.session.finished = true;
            }
            this.emitEvent({
                type: 'finished',
                taskId: this.session?.taskId || ''
            });
            this.resolveStop({ ok: true, finished: true });
            this.safeCloseSocket(1000, 'task finished');
            return;
        }

        if (event === 'task-failed') {
            const messageText = String(message?.header?.error_message || '语音识别任务失败');
            const errorCode = String(message?.header?.error_code || '');
            this.emitEvent({
                type: 'error',
                code: errorCode,
                message: messageText
            });
            this.rejectStart(new Error(messageText));
            this.resolveStop({ ok: false, code: errorCode, message: messageText });
            this.safeCloseSocket(1011, 'task failed');
            return;
        }

        this.emitEvent({
            type: 'event',
            event,
            payload: message
        });
    }

    handleSocketError(error) {
        const message = String(error?.message || error || 'WebSocket error');
        this.emitEvent({
            type: 'error',
            message
        });
        this.rejectStart(new Error(message));
        this.resolveStop({ ok: false, message });
    }

    handleUnexpectedResponse(response) {
        const statusCode = Number(response?.statusCode || 0);
        const statusText = String(response?.statusMessage || '');
        let body = '';
        response.on('data', (chunk) => {
            body += String(chunk || '');
            if (body.length > 4096) {
                body = body.slice(0, 4096);
            }
        });
        response.on('end', () => {
            let detail = '';
            if (body) {
                try {
                    const parsed = JSON.parse(body);
                    const code = String(parsed?.code || '').trim();
                    const message = String(parsed?.message || '').trim();
                    detail = [code, message].filter(Boolean).join(': ');
                } catch (_error) {
                    detail = body.trim();
                }
            }
            const readable = [
                `ASR 握手失败（HTTP ${statusCode}${statusText ? ` ${statusText}` : ''}）`,
                detail
            ].filter(Boolean).join(' - ');
            this.emitEvent({
                type: 'error',
                statusCode,
                message: readable
            });
            this.rejectStart(new Error(readable));
            this.resolveStop({ ok: false, statusCode, message: readable });
            this.safeCloseSocket(1000, 'unexpected response');
        });
    }

    handleSocketClose(code, reason) {
        const reasonText = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || '');
        this.rejectStart(new Error(`ASR 连接关闭（code=${code}）${reasonText ? `: ${reasonText}` : ''}`));
        this.resolveStop({
            ok: true,
            closed: true,
            code,
            reason: reasonText
        });
        this.emitEvent({
            type: 'closed',
            code,
            reason: reasonText
        });
        this.clearSession();
    }

    emitEvent(payload = {}) {
        if (typeof this.eventHandler !== 'function') return;
        try {
            this.eventHandler(payload);
        } catch (_error) {
            // ignore renderer callback failures
        }
    }

    resolveStart() {
        const session = this.session;
        if (!session || typeof session.startResolver !== 'function') return;
        const fn = session.startResolver;
        session.startResolver = null;
        session.startRejecter = null;
        fn(true);
    }

    rejectStart(error) {
        const session = this.session;
        if (!session || typeof session.startRejecter !== 'function') return;
        const fn = session.startRejecter;
        session.startResolver = null;
        session.startRejecter = null;
        fn(error instanceof Error ? error : new Error(String(error || '启动失败')));
    }

    resolveStop(payload) {
        const session = this.session;
        if (!session || typeof session.stopResolver !== 'function') return;
        const fn = session.stopResolver;
        session.stopResolver = null;
        session.stopPromise = null;
        fn(payload || { ok: true });
    }

    clearSession() {
        this.session = null;
        this.eventHandler = null;
    }

    safeCloseSocket(code, reason) {
        const session = this.session;
        if (!session || !session.ws) return;
        const readyState = session.ws.readyState;
        if (readyState === WebSocket.CLOSING || readyState === WebSocket.CLOSED) return;
        try {
            session.ws.close(code, reason);
        } catch (_error) {
            // ignore close failures
        }
    }

    normalizeFrame(frame) {
        if (!frame) return null;
        if (Buffer.isBuffer(frame)) return frame;
        if (frame instanceof Uint8Array) {
            return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
        }
        if (frame instanceof ArrayBuffer) {
            return Buffer.from(frame);
        }
        if (Array.isArray(frame)) {
            return Buffer.from(frame);
        }
        if (frame.buffer instanceof ArrayBuffer) {
            const offset = Number(frame.byteOffset || 0);
            const length = Number(frame.byteLength || frame.length || 0);
            return Buffer.from(frame.buffer, offset, length);
        }
        return null;
    }

    toNumberOrNull(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    normalizeEndpoint(value) {
        const normalized = String(value || '').trim();
        if (!normalized) return '';
        return normalized.replace(/\/+$/, '');
    }

    resolveOptionalBoolean(primaryValue, fallbackValue) {
        if (primaryValue === undefined || primaryValue === null || primaryValue === '') {
            if (fallbackValue === undefined || fallbackValue === null || fallbackValue === '') {
                return null;
            }
            return Boolean(fallbackValue);
        }
        return Boolean(primaryValue);
    }
}

module.exports = RealtimeAsrService;
