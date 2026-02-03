const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const http = require('http');
const url = require('url');
const llmService = require('./services/LLMService');
const ttsService = require('./services/TTSService');
const screenWatcher = require('./services/ScreenWatcher');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        hasShadow: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js') // Since preload is also in src
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html')); // index.html is in src
    
    // Start Screen Watcher
    screenWatcher.setMainWindow(mainWindow);
    screenWatcher.start();

    // 打开开发者工具 (调试用，发布时可注释)
    // mainWindow.webContents.openDevTools({ mode: 'detach' });

    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}

// --- 窗口移动与缩放逻辑 ---
let dragStartPos = { x: 0, y: 0 };
let winStartPos = { x: 0, y: 0 };

ipcMain.on('window-drag-start', (event, pos) => {
    if (!mainWindow) return;
    const bounds = mainWindow.getBounds();
    winStartPos = { x: bounds.x, y: bounds.y };
    dragStartPos = pos; // screen coordinates from renderer
});

ipcMain.on('window-drag', (event, pos) => {
    if (!mainWindow) return;
    const deltaX = pos.x - dragStartPos.x;
    const deltaY = pos.y - dragStartPos.y;
    
    // Update window position
    mainWindow.setBounds({
        x: winStartPos.x + deltaX,
        y: winStartPos.y + deltaY,
        width: mainWindow.getBounds().width,
        height: mainWindow.getBounds().height
    });
});

ipcMain.on('window-resize', (event, factor) => {
        if (!mainWindow) return;
        const bounds = mainWindow.getBounds();
        const newWidth = Math.round(bounds.width * factor);
        const newHeight = Math.round(bounds.height * factor);
        
        // 最小尺寸限制
        if (newWidth < 100 || newHeight < 100) return;
        
        mainWindow.setSize(newWidth, newHeight);
    });

    ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        win.setIgnoreMouseEvents(ignore, options);
    });

    // LLM IPC Handlers
    ipcMain.handle('llm-text', async (event, prompt) => {
        return await llmService.chatWithText(prompt, (chunk) => {
            if (mainWindow) {
                mainWindow.webContents.send('llm-chunk', chunk);
            }
        });
    });

    ipcMain.handle('llm-image', async (event, imageUrl, prompt) => {
        return await llmService.chatWithImage(imageUrl, prompt, (chunk) => {
            if (mainWindow) {
                mainWindow.webContents.send('llm-chunk', chunk);
            }
        });
    });

    ipcMain.handle('tts-speak', async (event, text) => {
        return await ttsService.speakStream(text, (chunk) => {
            if (mainWindow) {
                mainWindow.webContents.send('tts-chunk', chunk);
            }
        });
    });

    app.on('ready', () => {
    createWindow();
    startApiServer();
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
    if (mainWindow === null) createWindow();
});

// --- 内置 HTTP 服务器，用于接收外部指令 ---
function startApiServer() {
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
            req.on('data', chunk => {
                body += chunk.toString();
            });
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    console.log('Received command:', data);
                    
                    // 将指令发送给前端渲染进程
                    if (mainWindow) {
                        mainWindow.webContents.send('live2d-command', data);
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
                llmService.chatWithText(prompt, (chunk) => {
                     // Optional: stream to stdout or handle otherwise
                }).then(response => {
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ response }));
                }).catch(err => {
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
}
