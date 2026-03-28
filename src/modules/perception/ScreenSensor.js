/* 主要职责：负责屏幕截图采集，支持按需抓取和可选的周期性采样。 */
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
        this.interval = 30000;
        this.isCapturing = false;
        this.capturePromise = null;
    }

    start() {
        if (this.intervalId) return;
        console.log('Starting Screen Sensor...');
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
        const payload = await this.captureOnce();
        if (payload) {
            this.emit('capture', payload);
        }
    }

    async captureOnce() {
        if (this.capturePromise) {
            return this.capturePromise;
        }

        this.capturePromise = this.performCaptureOnce();
        try {
            return await this.capturePromise;
        } finally {
            this.capturePromise = null;
        }
    }

    async performCaptureOnce() {
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
            const activeWindowTitle = await this.getActiveWindowTitle();
            const capturedAt = Date.now();

            fs.unlinkSync(tempImgPath);

            return { base64Image, activeWindowTitle, capturedAt };
        } catch (error) {
            console.error('Screen capture failed:', error);
            return null;
        } finally {
            this.isCapturing = false;
        }
    }

    async getActiveWindowTitle() {
        if (process.platform !== 'win32') return '';
        const script = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32 {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$hwnd = [Win32]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 1024
[Win32]::GetWindowText($hwnd, $sb, $sb.Capacity) | Out-Null
$sb.ToString()
`.trim();

        return await new Promise((resolve) => {
            execFile('powershell', ['-NoProfile', '-Command', script], (error, stdout) => {
                if (error) {
                    console.warn('Get active window title failed:', error.message);
                    resolve('');
                    return;
                }
                resolve(String(stdout || '').trim());
            });
        });
    }
}

module.exports = new ScreenSensor();

