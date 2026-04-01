const {
    estimateTokenCount,
    generateCompactId,
    safeJsonParse
} = require('./compactionUtils');

class AutoCompactionOrchestrator {
    constructor({
        config,
        strategyRegistry,
        getGeneration,
        onCompactionBoundary,
        onSwitchGeneration
    }) {
        this.config = config;
        this.strategyRegistry = strategyRegistry;
        this.getGeneration = typeof getGeneration === 'function'
            ? getGeneration
            : () => 1;
        this.onCompactionBoundary = typeof onCompactionBoundary === 'function'
            ? onCompactionBoundary
            : null;
        this.onSwitchGeneration = typeof onSwitchGeneration === 'function'
            ? onSwitchGeneration
            : null;
    }

    resolveAutoMode() {
        const raw = String(this.config.llm.autoCompactMode || 'summary').trim().toLowerCase();
        return raw === 'handoff' ? 'handoff' : 'summary';
    }

    getRetryCount() {
        return Math.max(0, Number(this.config.llm.autoCompactRetryCount || 2));
    }

    summarizeToolMessage(message) {
        const parsed = safeJsonParse(message?.content, {});
        const toolName = String(parsed?.tool || 'tool').trim();
        const status = parsed && Object.prototype.hasOwnProperty.call(parsed, 'ok')
            ? (parsed.ok ? 'pass' : 'fail')
            : 'pass';
        return `[Previous tool result omitted: ${toolName} ${status}]`;
    }

    microCompact(messages) {
        if (!Array.isArray(messages) || messages.length === 0) return;
        const keepRecent = Math.max(0, Number(this.config.llm.contextCompactKeepRecentToolMessages || 3));
        if (keepRecent < 1) return;
        const toolIndexes = [];
        for (let index = 0; index < messages.length; index += 1) {
            if (messages[index]?.role === 'tool') {
                toolIndexes.push(index);
            }
        }
        if (toolIndexes.length <= keepRecent) return;
        const staleIndexes = toolIndexes.slice(0, toolIndexes.length - keepRecent);
        for (const index of staleIndexes) {
            const message = messages[index];
            if (!message || typeof message.content !== 'string') continue;
            if (message.content.length <= 100) continue;
            message.content = this.summarizeToolMessage(message);
        }
    }

    async maybeCompactBeforeCall({ messages, reason = 'threshold' } = {}) {
        if (!Array.isArray(messages) || messages.length === 0) return null;
        this.microCompact(messages);
        const threshold = Math.max(0, Number(this.config.llm.contextCompactThresholdTokens || 0));
        if (threshold < 1) return null;
        const estimatedTokens = estimateTokenCount(messages);
        if (estimatedTokens < threshold) return null;
        return this.runStrategy({
            mode: this.resolveAutoMode(),
            messages,
            reason,
            estimatedTokens,
            focus: ''
        });
    }

    async runManualCompact({ messages, focus = '' } = {}) {
        if (!Array.isArray(messages) || messages.length === 0) {
            throw new Error('Manual compact requires existing session messages');
        }
        this.microCompact(messages);
        return this.runStrategy({
            mode: 'summary',
            messages,
            reason: 'manual',
            estimatedTokens: estimateTokenCount(messages),
            focus: String(focus || '').trim()
        });
    }

    async runStrategy({
        mode,
        messages,
        reason,
        estimatedTokens,
        focus
    }) {
        const strategy = this.strategyRegistry.get(mode);
        if (!strategy) {
            throw new Error(`Unknown compaction strategy mode: ${mode}`);
        }
        const retryCount = this.getRetryCount();
        const compactId = generateCompactId(mode === 'handoff' ? 'handoff' : 'summary');

        let lastError = null;
        for (let attempt = 0; attempt <= retryCount; attempt += 1) {
            try {
                const artifact = await strategy.run({
                    compactId,
                    mode,
                    messages,
                    reason,
                    focus,
                    generation: this.getGeneration(),
                    estimatedTokens,
                    attempt,
                    retryCount
                });
                const normalizedArtifact = {
                    ...artifact,
                    compactId,
                    mode,
                    meta: {
                        ...(artifact?.meta || {}),
                        attempt,
                        retryCount,
                        estimatedTokens
                    }
                };

                if (this.onCompactionBoundary) {
                    this.onCompactionBoundary(normalizedArtifact);
                }
                if (normalizedArtifact.generationAction === 'switch' && this.onSwitchGeneration) {
                    this.onSwitchGeneration(normalizedArtifact, messages);
                }
                return normalizedArtifact;
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError || new Error(`Compaction failed for mode ${mode}`);
    }
}

module.exports = AutoCompactionOrchestrator;

