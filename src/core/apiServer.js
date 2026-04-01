/* 主要职责：提供轻量 HTTP 控制接口，用于外部控制命令转发和基础调试访问。 */
const http = require('http');
const config = require('../config/runtimeConfig');
const { GenieTTSBridge } = require('../modules/output/GenieTTSBridge');

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body || '{}'));
            } catch (error) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', (error) => reject(error));
    });
}

function startApiServer({ llmService, getOverlayWindow }) {
    const port = Number(config.api?.port) || 3001;
    const ttsBridge = new GenieTTSBridge();

    if (ttsBridge.isEnabled() && config.tts?.genieWarmupOnStart) {
        ttsBridge.start().catch((error) => {
            console.warn('[API] Genie warmup failed:', error?.message || error);
        });
    }

    const server = http.createServer((req, res) => {
        // 设置 CORS，允许任何来源调用（方便测试）
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        if (
            req.method === 'POST' &&
            req.url === String(config.tts?.localProxyPath || '/v1/t2a_v2') &&
            ttsBridge.isEnabled()
        ) {
            readJsonBody(req)
                .then(async (payload) => {
                    const text = String(payload?.text || '').trim();
                    if (!text) {
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({
                            base_resp: {
                                status_code: 400,
                                status_msg: 'text is required'
                            }
                        }));
                        return;
                    }

                    const startedAt = Date.now();
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream; charset=utf-8',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive',
                        'X-Accel-Buffering': 'no'
                    });
                    const streamResult = await ttsBridge.synthesizeStreamingSse(res, text);
                    res.end();
                    console.log(
                        `[TTS Local API] success | text_len=${text.length} | events=${streamResult?.streamedAudioEvents || 0} | elapsed_ms=${Date.now() - startedAt}`
                    );
                })
                .catch((error) => {
                    const message = error?.message || String(error || 'unknown error');
                    console.error('[TTS Local API] failed:', message);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({
                            base_resp: {
                                status_code: 500,
                                status_msg: message
                            }
                        }));
                        return;
                    }
                    res.write(`data: ${JSON.stringify({ base_resp: { status_code: 500, status_msg: message } })}\n\n`);
                    res.end();
                });
            return;
        }

        if (req.method === 'POST' && req.url === '/api/control') {
            readJsonBody(req)
                .then((data) => {
                    console.log('Received command:', data);

                    // 将指令发送给前端渲染进程
                    const overlayWindow = getOverlayWindow();
                    if (overlayWindow && !overlayWindow.isDestroyed()) {
                        overlayWindow.webContents.send('live2d-command', data);
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'ok', command: data }));
                })
                .catch(() => {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'error', message: 'Invalid JSON' }));
                }
            );
        } else if (req.url.startsWith('/chat')) {
            const urlObj = new URL(req.url, 'http://localhost');
            const prompt = urlObj.searchParams.get('prompt');
            if (prompt) {
                llmService
                    .chatWithCompanion(prompt, {
                        inputType: 'command'
                    })
                    .then((response) => {
                        const text = String(response?.text || '');
                        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ response: text }));
                    })
                    .catch((err) => {
                        res.writeHead(500);
                        res.end(err.message);
                    });
            } else {
                res.writeHead(400);
                res.end('Missing prompt');
            }
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });

    server.listen(port, () => {
        console.log(`Live2D Control API running at http://localhost:${port}/api/control`);
        if (ttsBridge.isEnabled()) {
            console.log(`Local TTS API running at http://localhost:${port}${String(config.tts?.localProxyPath || '/v1/t2a_v2')}`);
        }
    });

    const originalClose = server.close.bind(server);
    server.close = (...args) => {
        ttsBridge.dispose().catch(() => {});
        return originalClose(...args);
    };

    return server;
}

module.exports = {
    startApiServer
};

