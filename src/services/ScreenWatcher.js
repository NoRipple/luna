const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const llmService = require('./LLMService');
const ttsService = require('./TTSService');
const os = require('os');

class ScreenWatcher {
    constructor() {
        this.intervalId = null;
        this.mainWindow = null;
        this.isAnalyzing = false;
        // Interval in ms (1 seconds)
        this.interval = 10000; 
    }

    setMainWindow(win) {
        this.mainWindow = win;
    }

    start() {
        if (this.intervalId) return;
        console.log('Starting Screen Watcher...');
        this.intervalId = setInterval(() => this.captureAndAnalyze(), this.interval);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            console.log('Stopped Screen Watcher.');
        }
    }

    async captureAndAnalyze() {
        if (this.isAnalyzing || !this.mainWindow) return;
        this.isAnalyzing = true;

        const tempImgPath = path.join(os.tmpdir(), `screenshot_${Date.now()}.jpg`);

        try {
            // 1. Capture Screenshot using ffmpeg
            // Windows command: ffmpeg -f gdigrab -framerate 1 -i desktop -vframes 1 output.jpg
            // Note: On Windows 'desktop' is the input device for gdigrab.
            // On Mac/Linux this command differs (e.g. avfoundation or x11grab), 
            // but since environment is Windows, we use gdigrab.
            
            await new Promise((resolve, reject) => {
                execFile(ffmpegPath, [
                    '-y', // overwrite
                    '-f', 'gdigrab',
                    '-framerate', '1',
                    '-i', 'desktop',
                    '-vframes', '1',
                    '-q:v', '5', // quality 1-31 (lower is better, 5 is good)
                    tempImgPath
                ], (error, stdout, stderr) => {
                    if (error) {
                        console.error('FFmpeg error:', stderr);
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });

            // 2. Read file and convert to Base64
            const imageBuffer = fs.readFileSync(tempImgPath);
            const base64Image = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;

            // Clean up temp file
            fs.unlinkSync(tempImgPath);

            // 3. LLM 1: Analyze Image
            console.log('Analyzing screenshot...');
            const analysis = await llmService.chatWithImage(
                base64Image,
                "请详细分析这张屏幕截图。请注意：屏幕上可能有一个二次元美少女角色（Live2D模型），请完全忽略她，专注于她背后的应用窗口和内容。请描述：1. 当前打开的窗口和应用程序名称。2. 屏幕上显示的具体内容（例如：代码段、正在编辑的文档、浏览的网页内容、观看的视频画面等）。3. 用户的活动意图（例如：正在写代码、正在看番剧、正在搜索资料、正在聊天等）。请尽可能详细和精确。"
            );
            console.log('Analysis:', analysis);

            // 4. LLM 2: Companion Response
            console.log('Generating companion response...');
            const companionResponse = await llmService.chatWithCompanion(analysis);
            console.log('Companion Response:', companionResponse);

            // 5. Send to Renderer
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('companion-message', companionResponse);
                
                // 6. Trigger TTS
                if (companionResponse.text) {
                    ttsService.speakStream(companionResponse.text, (chunk) => {
                         if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                             this.mainWindow.webContents.send('tts-chunk', chunk);
                         }
                    });
                }
            }

        } catch (err) {
            console.error('ScreenWatcher Error:', err);
        } finally {
            this.isAnalyzing = false;
        }
    }
}

module.exports = new ScreenWatcher();
