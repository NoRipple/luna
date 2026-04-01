function summarizeDebugString(value, maxLength = 240) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.length > maxLength
        ? `${normalized.slice(0, maxLength - 1)}…`
        : normalized;
}

function sanitizeDebugValue(value) {
    if (typeof value === 'string') {
        if (value.startsWith('data:image/')) {
            return `[image data omitted, length=${value.length}]`;
        }
        return summarizeDebugString(value);
    }

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeDebugValue(item));
    }

    if (value && typeof value === 'object') {
        const sanitized = {};
        Object.entries(value).forEach(([key, nestedValue]) => {
            if (key === 'base64Image' && typeof nestedValue === 'string') {
                sanitized[key] = `[base64 image omitted, length=${nestedValue.length}]`;
                return;
            }
            if (key === 'image_url' && nestedValue && typeof nestedValue === 'object') {
                sanitized[key] = {
                    ...nestedValue,
                    url: sanitizeDebugValue(nestedValue.url)
                };
                return;
            }
            sanitized[key] = sanitizeDebugValue(nestedValue);
        });
        return sanitized;
    }

    return value;
}

function logMessages(enabled, tag, messages) {
    if (!enabled) return;
    try {
        console.log(`[LLM DEBUG] ${tag} | message_count=${messages.length}`);
        messages.forEach((msg, idx) => {
            const role = msg?.role || 'unknown';
            const content = typeof msg?.content === 'string'
                ? summarizeDebugString(msg.content)
                : JSON.stringify(sanitizeDebugValue(msg?.content || ''));
            console.log(`[LLM DEBUG] ${tag} | #${idx + 1} role=${role} content=${content}`);
        });
    } catch (error) {
        console.warn('[LLM DEBUG] Failed to log messages:', error.message);
    }
}

module.exports = {
    summarizeDebugString,
    sanitizeDebugValue,
    logMessages
};

