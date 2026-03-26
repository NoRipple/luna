function logMessages(enabled, tag, messages) {
    if (!enabled) return;
    try {
        console.log(`[LLM DEBUG] ${tag} | message_count=${messages.length}`);
        messages.forEach((msg, idx) => {
            const role = msg?.role || 'unknown';
            const content = typeof msg?.content === 'string'
                ? msg.content
                : JSON.stringify(msg?.content || '');
            console.log(`[LLM DEBUG] ${tag} | #${idx + 1} role=${role} content=${content}`);
        });
    } catch (error) {
        console.warn('[LLM DEBUG] Failed to log messages:', error.message);
    }
}

module.exports = {
    logMessages
};
