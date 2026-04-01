/* 主要职责：实现 Markdown 记忆真相层（MEMORY.md + memory/YYYY-MM-DD.md）。 */
const fs = require('fs');
const path = require('path');

function toDateKey(input = new Date()) {
    const date = input instanceof Date ? input : new Date(input);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function normalizeLine(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

class MemoryStoreService {
    constructor({
        workspaceDir,
        memoryDirName = 'memory',
        rootMemoryFileName = 'MEMORY.md',
        enabled = true
    } = {}) {
        this.workspaceDir = path.resolve(String(workspaceDir || process.cwd()));
        this.memoryDirName = String(memoryDirName || 'memory');
        this.rootMemoryFileName = String(rootMemoryFileName || 'MEMORY.md');
        this.enabled = enabled !== false;
        this.rootMemoryPath = path.resolve(this.workspaceDir, this.rootMemoryFileName);
        this.dailyDirPath = path.resolve(this.workspaceDir, this.memoryDirName);
        this.blockedSecretPatterns = [
            /sk-[A-Za-z0-9_-]{16,}/,
            /api[_-]?key\s*[:=]/i,
            /secret\s*[:=]/i,
            /password\s*[:=]/i,
            /token\s*[:=]/i
        ];
    }

    ensureLayout() {
        if (!this.enabled) return;
        fs.mkdirSync(this.workspaceDir, { recursive: true });
        fs.mkdirSync(this.dailyDirPath, { recursive: true });

        if (!fs.existsSync(this.rootMemoryPath)) {
            const bootstrap = [
                '# MEMORY',
                '',
                '长期记忆（Markdown 真相层）。',
                '',
                '## 规则',
                '- 只记录稳定、可复用的事实与偏好。',
                '- 不记录密钥、口令、敏感隐私。',
                '- 每条记录尽量包含来源与时间。',
                '',
                '## Entries',
                ''
            ].join('\n');
            fs.writeFileSync(this.rootMemoryPath, `${bootstrap}\n`, 'utf8');
        }
    }

    getRootMemoryPath() {
        return this.rootMemoryPath;
    }

    getDailyDirPath() {
        return this.dailyDirPath;
    }

    getDailyPath(date = new Date()) {
        return path.resolve(this.dailyDirPath, `${toDateKey(date)}.md`);
    }

    isAllowedMemoryPath(inputPath) {
        const resolved = path.resolve(this.workspaceDir, String(inputPath || ''));
        if (resolved === this.rootMemoryPath) return true;
        const relative = path.relative(this.dailyDirPath, resolved);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
        return /^[^\\\/]+\.md$/i.test(relative);
    }

    blockSensitiveContent(content) {
        const text = String(content || '');
        return this.blockedSecretPatterns.some((pattern) => pattern.test(text));
    }

    buildRejectedWriteResult({ tier, path: targetPath, reason }) {
        return {
            ok: false,
            tier,
            path: targetPath,
            appended: false,
            deduped: false,
            reason
        };
    }

    buildSuccessfulWriteResult({ tier, path: targetPath, appended, deduped = false }) {
        return {
            ok: true,
            tier,
            path: targetPath,
            appended: appended === true,
            deduped: deduped === true
        };
    }

    normalizeWriteContent(content) {
        return String(content || '').trim();
    }

    buildTimestamp(input = new Date()) {
        const date = input instanceof Date ? input : new Date(input);
        return `${toDateKey(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }

    buildEntryLine({ timestamp, content, source }) {
        const normalizedSource = String(source || '').trim();
        if (normalizedSource) {
            return `- [${timestamp}] ${content} (source: ${normalizedSource})`;
        }
        return `- [${timestamp}] ${content}`;
    }

    safeRead(filePath) {
        try {
            return fs.readFileSync(filePath, 'utf8');
        } catch (error) {
            return '';
        }
    }

    listDailyFiles() {
        this.ensureLayout();
        const entries = fs.readdirSync(this.dailyDirPath, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
            .map((entry) => path.resolve(this.dailyDirPath, entry.name))
            .sort();
    }

    listMemorySources() {
        this.ensureLayout();
        const sources = [this.rootMemoryPath, ...this.listDailyFiles()];
        return sources.filter((source) => fs.existsSync(source));
    }

    getDailyFilesForSession(date = new Date()) {
        const today = toDateKey(date);
        const yesterdayDate = new Date(date.getTime() - 24 * 3600 * 1000);
        const yesterday = toDateKey(yesterdayDate);
        const fileNames = new Set([`${today}.md`, `${yesterday}.md`]);
        return Array.from(fileNames.values())
            .map((name) => path.resolve(this.dailyDirPath, name))
            .filter((filePath) => fs.existsSync(filePath))
            .sort();
    }

    loadSessionMemory(date = new Date()) {
        this.ensureLayout();
        const longTerm = this.safeRead(this.rootMemoryPath).trim();
        const dailyPaths = this.getDailyFilesForSession(date);
        const daily = dailyPaths.map((filePath) => ({
            path: filePath,
            date: path.basename(filePath, '.md'),
            content: this.safeRead(filePath).trim()
        }));
        return {
            longTermPath: this.rootMemoryPath,
            longTerm,
            daily
        };
    }

    memory_append_log({ content, source } = {}) {
        this.ensureLayout();
        const normalizedContent = this.normalizeWriteContent(content);
        if (!normalizedContent) {
            return this.buildRejectedWriteResult({
                tier: 'daily',
                path: this.getDailyPath(),
                reason: 'empty_content'
            });
        }
        if (this.blockSensitiveContent(normalizedContent)) {
            return this.buildRejectedWriteResult({
                tier: 'daily',
                path: this.getDailyPath(),
                reason: 'sensitive_content_blocked'
            });
        }

        const filePath = this.getDailyPath();
        const now = new Date();
        const timestamp = this.buildTimestamp(now);
        const line = this.buildEntryLine({
            timestamp,
            content: normalizedContent,
            source
        });

        if (!fs.existsSync(filePath)) {
            const heading = [`# ${toDateKey(now)}`, '', '## 会话记忆', ''].join('\n');
            fs.writeFileSync(filePath, `${heading}\n`, 'utf8');
        }
        fs.appendFileSync(filePath, `${line}\n`, 'utf8');
        return this.buildSuccessfulWriteResult({
            tier: 'daily',
            path: filePath,
            appended: true
        });
    }

    memory_store({ content, source } = {}) {
        this.ensureLayout();
        const normalizedContent = this.normalizeWriteContent(content);
        if (!normalizedContent) {
            return this.buildRejectedWriteResult({
                tier: 'longterm',
                path: this.rootMemoryPath,
                reason: 'empty_content'
            });
        }
        if (this.blockSensitiveContent(normalizedContent)) {
            return this.buildRejectedWriteResult({
                tier: 'longterm',
                path: this.rootMemoryPath,
                reason: 'sensitive_content_blocked'
            });
        }

        const current = this.safeRead(this.rootMemoryPath);
        const targetNormalized = normalizeLine(normalizedContent);
        const hasDuplicate = current
            .split(/\r?\n/)
            .some((line) => normalizeLine(line).includes(targetNormalized));
        if (hasDuplicate) {
            return this.buildSuccessfulWriteResult({
                tier: 'longterm',
                path: this.rootMemoryPath,
                appended: false,
                deduped: true
            });
        }

        const now = new Date();
        const timestamp = this.buildTimestamp(now);
        const line = this.buildEntryLine({
            timestamp,
            content: normalizedContent,
            source
        });

        let next = current;
        if (!/^##\s+Entries/im.test(next)) {
            next = `${next.trim()}\n\n## Entries\n\n`;
        } else if (!next.endsWith('\n')) {
            next += '\n';
        }
        next += `${line}\n`;
        fs.writeFileSync(this.rootMemoryPath, next, 'utf8');

        return this.buildSuccessfulWriteResult({
            tier: 'longterm',
            path: this.rootMemoryPath,
            appended: true
        });
    }

    memoryGet({ path: inputPath = '', startLine = 1, limitLines = 200 } = {}) {
        this.ensureLayout();
        const raw = String(inputPath || '').trim();
        if (!raw) {
            throw new Error('memory_get.path is required');
        }

        let resolved;
        if (raw === 'MEMORY.md') {
            resolved = this.rootMemoryPath;
        } else if (raw.startsWith('memory/')) {
            resolved = path.resolve(this.workspaceDir, raw);
        } else if (this.isAllowedMemoryPath(raw)) {
            resolved = path.resolve(this.workspaceDir, raw);
        } else {
            throw new Error(`Path not allowed for memory_get: ${raw}`);
        }

        if (!this.isAllowedMemoryPath(resolved)) {
            throw new Error(`Path escapes memory scope: ${raw}`);
        }
        const content = this.safeRead(resolved);
        const lines = content.split(/\r?\n/);
        const from = Math.max(1, Number(startLine) || 1);
        const limit = Math.max(1, Math.min(2000, Number(limitLines) || 200));
        const beginIndex = from - 1;
        const slice = lines.slice(beginIndex, beginIndex + limit);
        return {
            path: path.relative(this.workspaceDir, resolved).replace(/\\/g, '/'),
            content: slice.join('\n'),
            start_line: from,
            line_count: slice.length
        };
    }
}

module.exports = MemoryStoreService;
