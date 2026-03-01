const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const os = require('os');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

class ScreenSensor extends EventEmitter {
    constructor() {
        super();
        this.intervalId = null;
        this.interval = 20000; // 20 seconds
        this.isCapturing = false;
    }

    start() {
        if (this.intervalId) return;
        console.log('Starting Screen Sensor...');
        // Initial capture
        this.capture();
        this.intervalId = setInterval(() => this.capture(), this.interval);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            console.log('Stopped Screen Sensor.');
        }
    }

    async capture() {
        if (this.isCapturing) return;
        this.isCapturing = true;

        const tempImgPath = path.join(os.tmpdir(), `screenshot_${Date.now()}.jpg`);

        try {
            await new Promise((resolve, reject) => {
                execFile(ffmpegPath, [
                    '-y',
                    '-f', 'gdigrab',
                    '-framerate', '1',
                    '-i', 'desktop',
                    '-vframes', '1',
                    '-q:v', '5',
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

            const imageBuffer = fs.readFileSync(tempImgPath);
            const base64Image = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;

            fs.unlinkSync(tempImgPath);

            this.emit('capture', base64Image);
        } catch (error) {
            console.error('Screen capture failed:', error);
        } finally {
            this.isCapturing = false;
        }
    }
}

module.exports = new ScreenSensor();
