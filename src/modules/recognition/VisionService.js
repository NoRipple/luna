/* 主要职责：负责截图去重、冷却判断和视觉模型调用，将屏幕内容转为结构化环境描述。 */
const llmService = require('../thinking/LLMService');
const { extractFirstJsonObject } = require('../thinking/JsonUtils');
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
        this.noChangeMessage = '用户当前保持上个截图周期的状态';
        this.promptFilePath = path.resolve(__dirname, 'vison_prompt.md');
        this.stateFilePath = String(config.vision?.stateFilePath || '').trim();
        this.stateHistoryLimit = Math.max(10, Number(config.vision?.stateHistoryLimit) || 120);
        this.stateCacheLoaded = false;
        this.stateCache = { latest: null, history: [] };
        this.persistTimer = null;
        this.persistInFlight = false;
        this.persistPending = false;
        this.defaultVisionPrompt = [
            '你是桌面状态识别器。忽略 Live2D 角色与气泡，仅依据可见屏幕信息判断用户状态。',
            '只输出一个 JSON 对象，不要输出其它文本。字段：',
            '{',
            '  "screen_summary": "一句话描述当前界面核心内容",',
            '  "user_activity": "用户当前动作（动词短语）",',
            '  "intent": "用户短期目标",',
            '  "labels": ["工作|学习|娱乐|沟通|搜索|摸鱼|待机"],',
            '  "confidence": 0.0',
            '}'
        ].join('\n');
    }

    debugLog(message) {
        void message;
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

    parseVisionJson(rawText) {
        const raw = String(rawText || '').trim();
        if (!raw) return null;

        const jsonStr = extractFirstJsonObject(raw);
        if (!jsonStr) return null;

        try {
            const parsed = JSON.parse(jsonStr);
            if (!parsed || typeof parsed !== 'object') return null;
            return {
                screenSummary: String(parsed.screen_summary || '').trim(),
                userActivity: String(parsed.user_activity || '').trim(),
                intent: String(parsed.intent || '').trim(),
                labels: Array.isArray(parsed.labels)
                    ? parsed.labels.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 2)
                    : [],
                confidence: Number.isFinite(Number(parsed.confidence))
                    ? Math.max(0, Math.min(1, Number(parsed.confidence)))
                    : null
            };
        } catch (error) {
            return null;
        }
    }

    normalizeVisionOutput(parsed, fallbackText) {
        if (!parsed) {
            const fallback = String(fallbackText || '').replace(/\s+/g, ' ').trim();
            return fallback || '当前屏幕状态无法可靠识别';
        }

        const labels = parsed.labels.length ? parsed.labels.join('/') : '未分类';
        const confidence = parsed.confidence === null
            ? '未知'
            : `${Math.round(parsed.confidence * 100)}%`;
        return [
            `状态标签：${labels}`,
            `用户行为：${parsed.userActivity || '未识别'}`,
            `界面内容：${parsed.screenSummary || '未识别'}`,
            `意图判断：${parsed.intent || '未识别'}`,
            `置信度：${confidence}`
        ].join('\n');
    }

    buildStateRecord({ analysis, capturedAt, activeWindowTitle, source }) {
        return {
            timestamp: Date.now(),
            capturedAt: Number(capturedAt) || Date.now(),
            activeWindowTitle: String(activeWindowTitle || ''),
            analysis: String(analysis || '').trim(),
            source: String(source || 'unknown')
        };
    }

    readStateFile() {
        if (this.stateCacheLoaded) return this.stateCache;
        this.stateCacheLoaded = true;

        if (!this.stateFilePath) {
            this.stateCache = { latest: null, history: [] };
            return this.stateCache;
        }

        try {
            if (!fs.existsSync(this.stateFilePath)) {
                this.stateCache = { latest: null, history: [] };
                return this.stateCache;
            }
            const raw = fs.readFileSync(this.stateFilePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') {
                this.stateCache = { latest: null, history: [] };
                return this.stateCache;
            }
            this.stateCache = {
                latest: parsed.latest && typeof parsed.latest === 'object' ? parsed.latest : null,
                history: Array.isArray(parsed.history) ? parsed.history : []
            };
            return this.stateCache;
        } catch (error) {
            this.stateCache = { latest: null, history: [] };
            return this.stateCache;
        }
    }

    schedulePersistStateFile() {
        if (!this.stateFilePath) return;
        this.persistPending = true;
        if (this.persistTimer) return;
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            this.flushPersistStateFile().catch(() => {});
        }, 0);
    }

    async flushPersistStateFile() {
        if (!this.stateFilePath || this.persistInFlight || !this.persistPending) return;
        this.persistInFlight = true;
        this.persistPending = false;
        try {
            await fs.promises.mkdir(path.dirname(this.stateFilePath), { recursive: true });
            const payload = JSON.stringify({
                latest: this.stateCache.latest,
                history: this.stateCache.history
            });
            await fs.promises.writeFile(this.stateFilePath, payload, 'utf8');
        } catch (error) {
            // Ignore persistence errors, do not block main perception flow.
        } finally {
            this.persistInFlight = false;
            if (this.persistPending) {
                this.flushPersistStateFile().catch(() => {});
            }
        }
    }

    persistStateRecord(record) {
        const current = this.readStateFile();
        const history = [...current.history, record].slice(-this.stateHistoryLimit);
        this.stateCache = {
            latest: record,
            history
        };
        this.schedulePersistStateFile();
    }

    getLatestState(maxAgeMs = 5000) {
        const current = this.readStateFile();
        const latest = current.latest;
        if (!latest || typeof latest.timestamp !== 'number') return null;
        if (Date.now() - latest.timestamp > maxAgeMs) return null;
        return latest;
    }

    async callVisionModel(base64Image, prompt, options = {}) {
        return llmService.chatWithImage(base64Image, prompt, {
            model: options.model,
            thinkingBudget: options.thinkingBudget,
            maxOutputTokens: options.maxOutputTokens
        });
    }

    async analyzeScreen(capturePayload, options = {}) {
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

        const bypassAdmission = options?.bypassAdmission === true;
        this.debugLog('VisionService: Analyzing screen...');
        const currentHash = await this.computePHash(base64Image);

        const hasLastWindow = this.lastWindowTitle !== null;
        const windowChanged = hasLastWindow && activeWindowTitle && activeWindowTitle !== this.lastWindowTitle;
        this.lastWindowTitle = activeWindowTitle || this.lastWindowTitle;

        if (bypassAdmission || !this.lastAiHash || !currentHash || windowChanged) {
            if (windowChanged) {
                this.debugLog(`VisionService: Active window changed: "${activeWindowTitle}"`);
            }
            this.lastAiHash = currentHash;
            this.lastAiAt = now;
            const prompt = this.getVisionPrompt();
            const raw = await this.callVisionModel(base64Image, prompt, {
                model: config.llm?.visionModel,
                thinkingBudget: Number(config.llm?.visionThinkingBudget) || 2048,
                maxOutputTokens: Number(config.llm?.visionMaxOutputTokens) || 240
            });
            return this.normalizeVisionOutput(this.parseVisionJson(raw), raw);
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
        const raw = await this.callVisionModel(base64Image, prompt, {
            model: config.llm?.visionModel,
            thinkingBudget: Number(config.llm?.visionThinkingBudget) || 2048,
            maxOutputTokens: Number(config.llm?.visionMaxOutputTokens) || 240
        });
        return this.normalizeVisionOutput(this.parseVisionJson(raw), raw);
    }

    async analyzeAndPersist(capturePayload, options = {}) {
        const analysis = await this.analyzeScreen(capturePayload, options);
        const record = this.buildStateRecord({
            analysis,
            capturedAt: capturePayload?.capturedAt,
            activeWindowTitle: capturePayload?.activeWindowTitle,
            source: options?.source || 'unknown'
        });
        this.persistStateRecord(record);
        return {
            analysis,
            record
        };
    }
}

module.exports = new VisionService();

