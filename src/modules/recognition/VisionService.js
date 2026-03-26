const llmService = require('../thinking/LLMService');
const config = require('../../config/runtimeConfig');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

class VisionService {
    constructor() {
        this.lastWindowTitle = null;
        this.lastAiHash = null;
        this.lastAiAt = 0;
        this.phashSize = Number(config.vision?.phashSize) || 32;
        this.lowFreqSize = Number(config.vision?.lowFreqSize) || 8;
        this.phashMinorThreshold = Number(config.vision?.phashMinorThreshold) || 10;
        this.cooldownMs = Number(config.vision?.cooldownMs) || 30 * 1000;
        this.debugLogs = config.vision?.debugLogs === true;
        this.noChangeMessage = '用户当前保持上个截图周期的状态';
        this.promptFilePath = path.resolve(__dirname, 'vison_prompt.md');
        this.defaultVisionPrompt = '请详细分析这张屏幕截图。请注意：屏幕上可能有一个二次元美少女角色（Live2D模型），请完全忽略她，专注于她背后的应用窗口和内容。请描述：1. 当前打开的窗口和应用程序名称。2. 屏幕上显示的具体内容（例如：代码段、正在编辑的文档、浏览的网页内容、观看的视频画面等）。3. 用户的活动意图（例如：正在写代码、正在看番剧、正在搜索资料、正在聊天等）。请尽可能详细和精确。';
    }

    debugLog(message) {
        if (!this.debugLogs) return;
        console.log(message);
    }

    getVisionPrompt() {
        try {
            const prompt = fs.readFileSync(this.promptFilePath, 'utf8').trim();
            return prompt || this.defaultVisionPrompt;
        } catch (error) {
            return this.defaultVisionPrompt;
        }
    }

    decodeBase64ToBuffer(base64Image) {
        const raw = base64Image.includes(',') ? base64Image.split(',')[1] : base64Image;
        return Buffer.from(raw, 'base64');
    }

    buildDctKernel(n) {
        const kernel = Array.from({ length: n }, () => new Array(n).fill(0));
        const factor = Math.PI / (2 * n);
        for (let u = 0; u < n; u += 1) {
            const alpha = u === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n);
            for (let x = 0; x < n; x += 1) {
                kernel[u][x] = alpha * Math.cos((2 * x + 1) * u * factor);
            }
        }
        return kernel;
    }

    computeDct2D(matrix) {
        const n = matrix.length;
        const kernel = this.buildDctKernel(n);
        const temp = Array.from({ length: n }, () => new Array(n).fill(0));
        const output = Array.from({ length: n }, () => new Array(n).fill(0));

        for (let u = 0; u < n; u += 1) {
            for (let y = 0; y < n; y += 1) {
                let sum = 0;
                for (let x = 0; x < n; x += 1) {
                    sum += kernel[u][x] * matrix[x][y];
                }
                temp[u][y] = sum;
            }
        }

        for (let v = 0; v < n; v += 1) {
            for (let u = 0; u < n; u += 1) {
                let sum = 0;
                for (let y = 0; y < n; y += 1) {
                    sum += temp[u][y] * kernel[v][y];
                }
                output[u][v] = sum;
            }
        }
        return output;
    }

    async computePHash(base64Image) {
        const imageBuffer = this.decodeBase64ToBuffer(base64Image);
        if (!imageBuffer.length) return null;

        const { data, info } = await sharp(imageBuffer)
            .resize(this.phashSize, this.phashSize, { fit: 'fill' })
            .grayscale()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const matrix = Array.from({ length: info.height }, (_, row) => {
            const line = new Array(info.width).fill(0);
            for (let col = 0; col < info.width; col += 1) {
                line[col] = data[row * info.width + col];
            }
            return line;
        });

        const dct = this.computeDct2D(matrix);
        const coeffs = [];
        for (let u = 0; u < this.lowFreqSize; u += 1) {
            for (let v = 0; v < this.lowFreqSize; v += 1) {
                if (u === 0 && v === 0) continue;
                coeffs.push(dct[u][v]);
            }
        }

        const sorted = [...coeffs].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] || 0;
        return coeffs.map((value) => (value > median ? 1 : 0));
    }

    hammingDistance(hashA, hashB) {
        if (!hashA || !hashB || hashA.length !== hashB.length) return Number.MAX_SAFE_INTEGER;
        let diff = 0;
        for (let i = 0; i < hashA.length; i += 1) {
            if (hashA[i] !== hashB[i]) diff += 1;
        }
        return diff;
    }

    async analyzeScreen(capturePayload) {
        const base64Image = typeof capturePayload === 'string'
            ? capturePayload
            : capturePayload?.base64Image;
        const activeWindowTitle = typeof capturePayload === 'string'
            ? ''
            : (capturePayload?.activeWindowTitle || '');
        const now = typeof capturePayload === 'string'
            ? Date.now()
            : (capturePayload?.capturedAt || Date.now());

        if (!base64Image) {
            return this.noChangeMessage;
        }

        this.debugLog('VisionService: Analyzing screen...');
        const currentHash = await this.computePHash(base64Image);

        const hasLastWindow = this.lastWindowTitle !== null;
        const windowChanged = hasLastWindow && activeWindowTitle && activeWindowTitle !== this.lastWindowTitle;
        this.lastWindowTitle = activeWindowTitle || this.lastWindowTitle;

        if (!this.lastAiHash || !currentHash || windowChanged) {
            if (windowChanged) {
                this.debugLog(`VisionService: Active window changed: "${activeWindowTitle}"`);
            }
            this.lastAiHash = currentHash;
            this.lastAiAt = now;
            const prompt = this.getVisionPrompt();
            return await llmService.chatWithImage(base64Image, prompt);
        }

        const diff = this.hammingDistance(this.lastAiHash, currentHash);
        if (diff < this.phashMinorThreshold) {
            this.debugLog(`VisionService: pHash diff=${diff}, drop as minor/no change.`);
            return this.noChangeMessage;
        }

        const elapsed = now - this.lastAiAt;
        if (elapsed < this.cooldownMs) {
            this.debugLog(`VisionService: pHash diff=${diff}, in cooldown (${Math.round(elapsed / 1000)}s).`);
            return this.noChangeMessage;
        }

        this.lastAiHash = currentHash;
        this.lastAiAt = now;
        const prompt = this.getVisionPrompt();
        return await llmService.chatWithImage(base64Image, prompt);
    }
}

module.exports = new VisionService();
