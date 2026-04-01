const fs = require('fs');
const path = require('path');

function safeJsonParse(value, fallback = null) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch (error) {
        return fallback;
    }
}

function estimateTokenCount(messages) {
    try {
        return Math.ceil(JSON.stringify(messages).length / 4);
    } catch (error) {
        return Math.ceil(String(messages || '').length / 4);
    }
}

function serializeMessagesForPrompt(messages, maxChars = 80000) {
    const normalizedMaxChars = Math.max(4000, Number(maxChars) || 80000);
    let serialized = '';
    try {
        serialized = JSON.stringify(messages, null, 2);
    } catch (error) {
        serialized = String(messages || '');
    }
    if (serialized.length <= normalizedMaxChars) {
        return serialized;
    }
    return `${serialized.slice(0, normalizedMaxChars)}\n...[truncated]`;
}

function generateCompactId(prefix = 'cmp') {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function writeTextFile(filePath, content) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, String(content || ''), 'utf8');
}

function persistTranscript({ messages, transcriptDir, compactId }) {
    ensureDir(transcriptDir);
    const transcriptPath = path.join(transcriptDir, `transcript-${compactId}.jsonl`);
    const lines = Array.isArray(messages)
        ? messages.map((message) => JSON.stringify(message))
        : [JSON.stringify({ role: 'system', content: String(messages || '') })];
    fs.writeFileSync(transcriptPath, `${lines.join('\n')}\n`, 'utf8');
    return transcriptPath;
}

function extractReattachedFileRefs(messages) {
    const refs = new Set();
    if (!Array.isArray(messages)) return [];

    for (const message of messages) {
        if (Array.isArray(message?.tool_calls)) {
            for (const toolCall of message.tool_calls) {
                const name = String(toolCall?.function?.name || '').trim();
                if (!name) continue;
                const args = safeJsonParse(toolCall?.function?.arguments, {});
                if (args && typeof args.path === 'string' && args.path.trim()) {
                    refs.add(args.path.trim());
                }
                if (args && typeof args.file === 'string' && args.file.trim()) {
                    refs.add(args.file.trim());
                }
            }
        }
    }

    return Array.from(refs).slice(0, 40);
}

function findSystemMessage(messages, fallbackText) {
    if (Array.isArray(messages)) {
        const existing = messages.find((item) => item?.role === 'system');
        if (existing && typeof existing.content === 'string') return { ...existing };
    }
    return {
        role: 'system',
        content: String(fallbackText || '')
    };
}

function validateSummarySections(summaryText) {
    const requiredHeadings = [
        /^##\s*Architecture decisions \(NEVER summarize\)/im,
        /^##\s*Modified files and key changes/im,
        /^##\s*Current verification status \(pass\/fail\)/im,
        /^##\s*Open TODOs and rollback notes/im,
        /^##\s*Tool outputs \(pass\/fail only\)/im
    ];
    return requiredHeadings.every((pattern) => pattern.test(String(summaryText || '')));
}

module.exports = {
    safeJsonParse,
    estimateTokenCount,
    serializeMessagesForPrompt,
    generateCompactId,
    ensureDir,
    writeTextFile,
    persistTranscript,
    extractReattachedFileRefs,
    findSystemMessage,
    validateSummarySections
};

