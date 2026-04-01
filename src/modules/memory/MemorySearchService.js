/* 主要职责：实现本地混合检索（BM25 + 向量），支持索引落盘与文件监听增量重建。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lunr = require('lunr');

function hashText(text) {
    return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function normalizeWhitespace(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function estimateCharsByToken(tokenCount) {
    return Math.max(200, Number(tokenCount || 400) * 4);
}

function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
    const len = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < len; i += 1) {
        const va = Number(a[i]) || 0;
        const vb = Number(b[i]) || 0;
        dot += va * vb;
        normA += va * va;
        normB += vb * vb;
    }
    if (normA <= 0 || normB <= 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizeScore(value, maxValue) {
    if (!Number.isFinite(value) || !Number.isFinite(maxValue) || maxValue <= 0) return 0;
    return Math.max(0, Math.min(1, value / maxValue));
}

function buildChunkWindows(text, {
    targetChars = 1600,
    overlapChars = 320
} = {}) {
    const normalized = String(text || '');
    if (!normalized.trim()) return [];
    const windows = [];
    const step = Math.max(128, targetChars - overlapChars);
    let start = 0;
    while (start < normalized.length) {
        let end = Math.min(normalized.length, start + targetChars);
        if (end < normalized.length) {
            const newline = normalized.lastIndexOf('\n', end);
            if (newline > start + Math.floor(targetChars * 0.4)) {
                end = newline + 1;
            }
        }
        if (end <= start) {
            end = Math.min(normalized.length, start + targetChars);
        }
        windows.push({ start, end, text: normalized.slice(start, end) });
        if (end >= normalized.length) break;
        start += step;
    }
    return windows;
}

function buildLineStarts(content) {
    const starts = [0];
    for (let i = 0; i < content.length; i += 1) {
        if (content[i] === '\n') {
            starts.push(i + 1);
        }
    }
    return starts;
}

function charOffsetToLine(lineStarts, offset) {
    if (!Array.isArray(lineStarts) || lineStarts.length === 0) return 1;
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (lineStarts[mid] <= offset) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return Math.max(1, high + 1);
}

class MemorySearchService {
    constructor({
        memoryStoreService,
        enabled = true,
        workspaceDir,
        indexDirName = '.memory-index',
        targetTokens = 400,
        overlapTokens = 80,
        debounceMs = 1500,
        provider = 'local_transformers',
        model = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
        vectorWeight = 0.7,
        textWeight = 0.3,
        maxResults = 5,
        extraPaths = []
    } = {}) {
        if (!memoryStoreService) {
            throw new Error('MemorySearchService requires memoryStoreService');
        }
        this.memoryStoreService = memoryStoreService;
        this.enabled = enabled !== false;
        this.workspaceDir = path.resolve(String(workspaceDir || process.cwd()));
        this.indexDir = path.resolve(this.workspaceDir, indexDirName);
        this.indexFilePath = path.resolve(this.indexDir, 'index.json');
        this.targetChars = estimateCharsByToken(targetTokens);
        this.overlapChars = estimateCharsByToken(overlapTokens);
        this.debounceMs = Math.max(100, Number(debounceMs) || 1500);
        this.provider = String(provider || 'local_transformers').trim();
        this.model = String(model || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2').trim();
        this.vectorWeight = Number(vectorWeight) || 0.7;
        this.textWeight = Number(textWeight) || 0.3;
        this.maxResults = Math.max(1, Number(maxResults) || 5);
        this.extraPaths = Array.isArray(extraPaths) ? extraPaths : [];

        this.currentFingerprint = this.computeFingerprint();
        this.chunks = [];
        this.lunrIndex = null;
        this.loaded = false;
        this.rebuildPromise = null;
        this.watchers = [];
        this.rebuildTimer = null;

        this.embeddingExtractor = null;
        this.embeddingAvailable = this.provider === 'local_transformers';
        this.embeddingInitError = '';
    }

    computeFingerprint() {
        return hashText(JSON.stringify({
            provider: this.provider,
            model: this.model,
            targetChars: this.targetChars,
            overlapChars: this.overlapChars
        }));
    }

    ensureIndexDir() {
        fs.mkdirSync(this.indexDir, { recursive: true });
    }

    resolveExtraSources() {
        const outputs = [];
        for (const rawPath of this.extraPaths) {
            const normalized = String(rawPath || '').trim();
            if (!normalized) continue;
            const resolved = path.isAbsolute(normalized)
                ? normalized
                : path.resolve(this.workspaceDir, normalized);
            if (!fs.existsSync(resolved)) continue;
            const stat = fs.statSync(resolved);
            if (stat.isFile() && /\.md$/i.test(resolved)) {
                outputs.push(path.resolve(resolved));
                continue;
            }
            if (stat.isDirectory()) {
                const stack = [resolved];
                while (stack.length > 0) {
                    const current = stack.pop();
                    const entries = fs.readdirSync(current, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isSymbolicLink()) continue;
                        const fullPath = path.resolve(current, entry.name);
                        if (entry.isDirectory()) {
                            stack.push(fullPath);
                            continue;
                        }
                        if (entry.isFile() && /\.md$/i.test(entry.name)) {
                            outputs.push(fullPath);
                        }
                    }
                }
            }
        }
        return Array.from(new Set(outputs.values())).sort();
    }

    listSources() {
        const core = this.memoryStoreService.listMemorySources();
        const extra = this.resolveExtraSources();
        return Array.from(new Set([...core, ...extra])).sort();
    }

    chunkFile(filePath) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const normalized = normalizeWhitespace(raw);
        if (!normalized) return [];

        const lineStarts = buildLineStarts(raw);
        const relativePath = path.relative(this.workspaceDir, filePath).replace(/\\/g, '/');
        const windows = buildChunkWindows(raw, {
            targetChars: this.targetChars,
            overlapChars: this.overlapChars
        });
        return windows
            .map((window, index) => {
                const normalizedText = normalizeWhitespace(window.text);
                if (!normalizedText) return null;
                const lineStart = charOffsetToLine(lineStarts, window.start);
                const lineEnd = charOffsetToLine(lineStarts, Math.max(window.start, window.end - 1));
                const chunkId = `${relativePath}#${lineStart}-${lineEnd}-${index}`;
                return {
                    id: chunkId,
                    path: relativePath,
                    abs_path: filePath,
                    line_start: lineStart,
                    line_end: lineEnd,
                    snippet: normalizedText.slice(0, 700),
                    text: normalizedText,
                    text_hash: hashText(normalizedText),
                    vector: null
                };
            })
            .filter(Boolean);
    }

    async initEmbeddingExtractor() {
        if (!this.embeddingAvailable) return null;
        if (this.embeddingExtractor) return this.embeddingExtractor;
        if (this.embeddingInitError) return null;

        try {
            const transformers = await import('@xenova/transformers');
            if (transformers?.env) {
                transformers.env.allowLocalModels = true;
                transformers.env.allowRemoteModels = true;
            }
            const extractor = await transformers.pipeline(
                'feature-extraction',
                this.model,
                { quantized: true }
            );
            this.embeddingExtractor = extractor;
            return extractor;
        } catch (error) {
            this.embeddingInitError = error?.message || String(error);
            this.embeddingAvailable = false;
            console.warn(`[MemorySearch] embedding unavailable, fallback to BM25 only: ${this.embeddingInitError}`);
            return null;
        }
    }

    async embedText(text) {
        const extractor = await this.initEmbeddingExtractor();
        if (!extractor) return null;
        const normalized = normalizeWhitespace(text);
        if (!normalized) return null;
        try {
            const output = await extractor(normalized, { pooling: 'mean', normalize: true });
            if (Array.isArray(output)) return output.map((v) => Number(v) || 0);
            if (output?.data) return Array.from(output.data, (v) => Number(v) || 0);
            if (typeof output?.tolist === 'function') {
                const list = output.tolist();
                if (Array.isArray(list) && Array.isArray(list[0])) {
                    return list[0].map((v) => Number(v) || 0);
                }
            }
            return null;
        } catch (error) {
            console.warn(`[MemorySearch] embedding failed: ${error?.message || error}`);
            return null;
        }
    }

    async buildVectors(chunks, oldVectorByHash = new Map()) {
        if (!Array.isArray(chunks) || chunks.length === 0) return;
        if (!this.embeddingAvailable) return;

        for (const chunk of chunks) {
            const previous = oldVectorByHash.get(chunk.text_hash);
            if (Array.isArray(previous) && previous.length > 0) {
                chunk.vector = previous;
                continue;
            }
            const vector = await this.embedText(chunk.text);
            if (Array.isArray(vector) && vector.length > 0) {
                chunk.vector = vector;
            }
        }
    }

    buildLunrIndex(chunks) {
        if (!Array.isArray(chunks) || chunks.length === 0) return null;
        return lunr(function indexBuilder() {
            this.ref('id');
            this.field('text');
            chunks.forEach((chunk) => {
                this.add({
                    id: chunk.id,
                    text: chunk.text
                });
            });
        });
    }

    loadPersistedIndex() {
        this.ensureIndexDir();
        if (!fs.existsSync(this.indexFilePath)) return null;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.indexFilePath, 'utf8'));
            if (!parsed || parsed.fingerprint !== this.currentFingerprint) return null;
            if (!Array.isArray(parsed.chunks)) return null;
            return parsed.chunks.map((chunk) => ({
                ...chunk,
                vector: Array.isArray(chunk.vector) ? chunk.vector.map((value) => Number(value) || 0) : null
            }));
        } catch (error) {
            return null;
        }
    }

    persistIndex(chunks) {
        this.ensureIndexDir();
        const payload = {
            fingerprint: this.currentFingerprint,
            updated_at: Date.now(),
            chunks: chunks.map((chunk) => ({
                ...chunk,
                // vectors will be reused by hash on next startup.
                vector: Array.isArray(chunk.vector) ? chunk.vector : null
            }))
        };
        fs.writeFileSync(this.indexFilePath, JSON.stringify(payload), 'utf8');
    }

    collectPersistedVectors(persistedChunks) {
        const oldVectorByHash = new Map();
        if (!Array.isArray(persistedChunks)) return oldVectorByHash;
        for (const chunk of persistedChunks) {
            if (chunk?.text_hash && Array.isArray(chunk.vector)) {
                oldVectorByHash.set(chunk.text_hash, chunk.vector);
            }
        }
        return oldVectorByHash;
    }

    collectSourceChunks() {
        const sources = this.listSources();
        const nextChunks = [];
        for (const source of sources) {
            if (!fs.existsSync(source)) continue;
            try {
                const stat = fs.statSync(source);
                if (!stat.isFile()) continue;
                nextChunks.push(...this.chunkFile(source));
            } catch (error) {
                // skip unreadable source
            }
        }
        return nextChunks;
    }

    async rebuildIndex() {
        if (!this.enabled) return;
        if (this.rebuildPromise) {
            return this.rebuildPromise;
        }
        this.rebuildPromise = (async () => {
            this.memoryStoreService.ensureLayout();
            const persisted = this.loadPersistedIndex();
            const oldVectorByHash = this.collectPersistedVectors(persisted);
            const nextChunks = this.collectSourceChunks();

            await this.buildVectors(nextChunks, oldVectorByHash);
            this.chunks = nextChunks;
            this.lunrIndex = this.buildLunrIndex(nextChunks);
            this.persistIndex(nextChunks);
            this.loaded = true;
        })()
            .finally(() => {
                this.rebuildPromise = null;
            });
        return this.rebuildPromise;
    }

    scheduleRebuild() {
        if (!this.enabled) return;
        if (this.rebuildTimer) {
            clearTimeout(this.rebuildTimer);
        }
        this.rebuildTimer = setTimeout(() => {
            this.rebuildTimer = null;
            this.rebuildIndex().catch((error) => {
                console.warn(`[MemorySearch] rebuild failed: ${error?.message || error}`);
            });
        }, this.debounceMs);
    }

    setupWatchers() {
        if (!this.enabled) return;
        this.disposeWatchers();
        const watchTargets = new Set([
            this.memoryStoreService.getRootMemoryPath(),
            this.memoryStoreService.getDailyDirPath(),
            ...this.resolveExtraSources()
        ]);
        for (const target of watchTargets.values()) {
            if (!fs.existsSync(target)) continue;
            try {
                const stat = fs.statSync(target);
                if (stat.isDirectory()) {
                    const watcher = fs.watch(target, { recursive: true }, () => this.scheduleRebuild());
                    this.watchers.push(watcher);
                } else {
                    const watcher = fs.watch(path.dirname(target), { recursive: false }, (eventType, fileName) => {
                        if (!fileName) return;
                        const changed = path.resolve(path.dirname(target), String(fileName));
                        if (changed === target) {
                            this.scheduleRebuild();
                        }
                    });
                    this.watchers.push(watcher);
                }
            } catch (error) {
                // watch failure should not break runtime.
            }
        }
    }

    disposeWatchers() {
        for (const watcher of this.watchers) {
            try {
                watcher.close();
            } catch (error) {
                // noop
            }
        }
        this.watchers = [];
    }

    async ensureReady() {
        if (!this.enabled) return;
        if (!this.loaded) {
            await this.rebuildIndex();
            this.setupWatchers();
        }
    }

    computeBm25Candidates(query, candidateLimit = 20) {
        if (!this.lunrIndex || !String(query || '').trim()) return new Map();
        try {
            const results = this.lunrIndex.search(String(query).trim());
            const maxScore = results.length > 0
                ? Math.max(...results.map((item) => Number(item.score) || 0), 0)
                : 0;
            const map = new Map();
            results.slice(0, candidateLimit).forEach((item) => {
                map.set(item.ref, normalizeScore(Number(item.score) || 0, maxScore));
            });
            return map;
        } catch (error) {
            return new Map();
        }
    }

    async computeVectorCandidates(query, candidateLimit = 20) {
        if (!this.embeddingAvailable || this.chunks.length === 0) return new Map();
        const queryVector = await this.embedText(query);
        if (!Array.isArray(queryVector) || queryVector.length === 0) return new Map();

        const scored = this.chunks
            .filter((chunk) => Array.isArray(chunk.vector) && chunk.vector.length > 0)
            .map((chunk) => ({
                id: chunk.id,
                score: cosineSimilarity(queryVector, chunk.vector)
            }))
            .filter((item) => Number.isFinite(item.score) && item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, candidateLimit);
        const maxScore = scored.length > 0 ? scored[0].score : 0;
        const output = new Map();
        for (const item of scored) {
            output.set(item.id, normalizeScore(item.score, maxScore));
        }
        return output;
    }

    normalizeWeights() {
        const vector = Math.max(0, Number(this.vectorWeight) || 0);
        const text = Math.max(0, Number(this.textWeight) || 0);
        const sum = vector + text;
        if (sum <= 0) {
            return { vectorWeight: 0.7, textWeight: 0.3 };
        }
        return {
            vectorWeight: vector / sum,
            textWeight: text / sum
        };
    }

    buildMergedCandidates({ bm25Map, vectorMap } = {}) {
        const { vectorWeight, textWeight } = this.normalizeWeights();
        const chunkMap = new Map(this.chunks.map((chunk) => [chunk.id, chunk]));
        const ids = new Set([
            ...Array.from((bm25Map || new Map()).keys()),
            ...Array.from((vectorMap || new Map()).keys())
        ]);
        const merged = [];
        for (const id of ids) {
            const chunk = chunkMap.get(id);
            if (!chunk) continue;
            const vectorScore = Number(vectorMap.get(id) || 0);
            const textScore = Number(bm25Map.get(id) || 0);
            const score = vectorWeight * vectorScore + textWeight * textScore;
            merged.push({
                snippet: chunk.snippet,
                path: chunk.path,
                line_start: chunk.line_start,
                line_end: chunk.line_end,
                score,
                vector_score: vectorScore,
                text_score: textScore
            });
        }
        return merged;
    }

    buildSubstringFallback(query, topK) {
        return this.chunks
            .filter((chunk) => chunk.text.toLowerCase().includes(query.toLowerCase()))
            .slice(0, topK)
            .map((chunk) => ({
                snippet: chunk.snippet,
                path: chunk.path,
                line_start: chunk.line_start,
                line_end: chunk.line_end,
                score: 0,
                vector_score: 0,
                text_score: 0
            }));
    }

    async search({
        query,
        max_results
    } = {}) {
        await this.ensureReady();
        const normalizedQuery = normalizeWhitespace(query);
        const topK = Math.max(1, Number(max_results) || this.maxResults);
        if (!normalizedQuery) return [];
        if (!Array.isArray(this.chunks) || this.chunks.length === 0) return [];

        const candidateLimit = Math.max(topK * 4, 20);
        const bm25Map = this.computeBm25Candidates(normalizedQuery, candidateLimit);
        const vectorMap = await this.computeVectorCandidates(normalizedQuery, candidateLimit);
        const merged = this.buildMergedCandidates({ bm25Map, vectorMap });

        if (merged.length === 0) {
            return this.buildSubstringFallback(normalizedQuery, topK);
        }

        return merged
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }
}

module.exports = MemorySearchService;
