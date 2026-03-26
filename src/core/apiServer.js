const http = require('http');

function startApiServer({ llmService, getOverlayWindow }) {
    const port = 3001;
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

        if (req.method === 'POST' && req.url === '/api/control') {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk.toString();
            });
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    console.log('Received command:', data);

                    // 将指令发送给前端渲染进程
                    const overlayWindow = getOverlayWindow();
                    if (overlayWindow && !overlayWindow.isDestroyed()) {
                        overlayWindow.webContents.send('live2d-command', data);
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'ok', command: data }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'error', message: 'Invalid JSON' }));
                }
            });
        } else if (req.url.startsWith('/chat')) {
            const urlObj = new URL(req.url, 'http://localhost');
            const prompt = urlObj.searchParams.get('prompt');
            if (prompt) {
                llmService
                    .chatWithText(prompt, () => {
                        // Optional: stream to stdout or handle otherwise
                    })
                    .then((response) => {
                        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ response }));
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
    });

    return server;
}

module.exports = {
    startApiServer
};
