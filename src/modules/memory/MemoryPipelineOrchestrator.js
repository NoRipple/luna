/* 主要职责：编排记忆快照构建、自动写回和 flush 触发，不承载 LLM 其他会话逻辑。 */
class MemoryPipelineOrchestrator {
    constructor({
        config,
        client,
        companionToolRegistry,
        memoryStoreService,
        memorySearchService,
        estimateTokenCount,
        memoryContextLimits = {},
        memoryToolNames = ['memory_search', 'memory_get', 'memory_append_log', 'memory_store']
    } = {}) {
        if (!config || !client || !companionToolRegistry || !memoryStoreService || !memorySearchService || !estimateTokenCount) {
            throw new Error('MemoryPipelineOrchestrator requires complete dependencies');
        }
        this.config = config;
        this.client = client;
        this.companionToolRegistry = companionToolRegistry;
        this.memoryStoreService = memoryStoreService;
        this.memorySearchService = memorySearchService;
        this.estimateTokenCount = estimateTokenCount;
        this.memoryToolNames = Array.isArray(memoryToolNames) ? memoryToolNames : [];
        this.memoryContextLimits = {
            longTerm: Number(memoryContextLimits.longTerm) || 3200,
            daily: Number(memoryContextLimits.daily) || 3200,
            retrieved: Number(memoryContextLimits.retrieved) || 2600
        };
        this.memoryFlushTriggeredSinceCompaction = false;
    }

    onCompactionBoundary() {
        this.memoryFlushTriggeredSinceCompaction = false;
    }

    getToolCallConcurrency() {
        const configured = Number(this.config?.llm?.toolCallConcurrency || 1);
        if (!Number.isFinite(configured)) return 1;
        return Math.max(1, Math.floor(configured));
    }

    async executeToolCallsWithConcurrency(toolCalls = [], executeFn) {
        const calls = Array.isArray(toolCalls) ? toolCalls : [];
        if (calls.length === 0) return [];
        const runner = typeof executeFn === 'function'
            ? executeFn
            : async () => ({ ok: false, error: 'invalid executor' });
        const limit = Math.min(this.getToolCallConcurrency(), calls.length);
        const results = new Array(calls.length);
        let cursor = 0;

        const worker = async () => {
            while (true) {
                const index = cursor;
                cursor += 1;
                if (index >= calls.length) return;
                const toolCall = calls[index];
                results[index] = await runner(toolCall, index);
            }
        };

        await Promise.all(Array.from({ length: limit }, () => worker()));
        return results;
    }

    truncateForContext(text, maxChars = 2000) {
        const normalized = String(text || '').trim();
        if (!normalized) return '';
        if (normalized.length <= maxChars) return normalized;
        return `${normalized.slice(0, maxChars)}\n...[truncated]`;
    }

    formatRetrievedMemoryResults(results = []) {
        if (!Array.isArray(results) || results.length === 0) {
            return '（暂无）';
        }
        return results.map((item, index) => {
            const score = Number(item?.score || 0).toFixed(3);
            const pathName = String(item?.path || '');
            const lineStart = Number(item?.line_start || 1);
            const lineEnd = Number(item?.line_end || lineStart);
            const snippet = String(item?.snippet || '').trim() || '（空）';
            return `${index + 1}. [${score}] ${pathName}:${lineStart}-${lineEnd}\n${snippet}`;
        }).join('\n\n');
    }

    async buildMemorySnapshot(inputText, inputType) {
        if (this.config.memory?.enabled === false) {
            return { longTerm: '', recentDaily: '', retrieved: '' };
        }
        const sessionMemory = this.memoryStoreService.loadSessionMemory();
        const longTerm = this.truncateForContext(
            sessionMemory.longTerm || '（暂无）',
            this.memoryContextLimits.longTerm
        );
        const daily = this.truncateForContext(
            (sessionMemory.daily || [])
                .map((item) => `# ${item.date}\n${item.content || '（暂无）'}`)
                .join('\n\n') || '（暂无）',
            this.memoryContextLimits.daily
        );

        let retrieved = '（暂无）';
        if (this.config.memory?.searchEnabled !== false && inputType === 'command') {
            try {
                const hits = await this.memorySearchService.search({
                    query: inputText,
                    max_results: this.config.memory?.searchMaxResults || 5
                });
                retrieved = this.truncateForContext(
                    this.formatRetrievedMemoryResults(hits),
                    this.memoryContextLimits.retrieved
                );
            } catch (error) {
                retrieved = `（检索失败：${error?.message || String(error)}）`;
            }
        }

        return {
            longTerm,
            recentDaily: daily,
            retrieved
        };
    }

    shouldPersistRound(inputType, combinedText) {
        const normalizedType = inputType === 'command' ? 'command' : 'perception';
        if (normalizedType === 'command') {
            return this.config.memory?.autoWriteCommandRounds !== false;
        }
        if (this.config.memory?.autoWriteAutonomousRounds === true) {
            return true;
        }
        const signalPatterns = [
            /记住/,
            /偏好|习惯|长期|以后都|一直|总是/,
            /important|preference|always|long[- ]?term/i
        ];
        return signalPatterns.some((pattern) => pattern.test(String(combinedText || '')));
    }

    shouldStoreLongTerm(combinedText) {
        const text = String(combinedText || '');
        const longTermPatterns = [
            /记住/,
            /偏好|喜好|习惯|讨厌|过敏|禁忌/,
            /长期|持续|固定|以后都|一直/,
            /计划|目标|里程碑/
        ];
        return longTermPatterns.some((pattern) => pattern.test(text));
    }

    async autoPersistRoundMemory({
        inputType,
        inputText,
        observedState,
        responseText
    } = {}) {
        if (this.config.memory?.enabled === false) return;
        const merged = [
            `输入(${inputType === 'command' ? 'command' : 'perception'})：${String(inputText || '').trim() || '（空）'}`,
            observedState ? `观察：${String(observedState).trim()}` : '',
            responseText ? `回复：${String(responseText).trim()}` : ''
        ].filter(Boolean).join('\n');
        if (!this.shouldPersistRound(inputType, merged)) {
            return;
        }

        if (inputType === 'command' || this.config.memory?.autoWriteAutonomousRounds === true) {
            this.memoryStoreService.memory_append_log({
                content: merged,
                source: inputType === 'command' ? 'command_round' : 'autonomous_round'
            });
        }

        if (this.shouldStoreLongTerm(merged)) {
            this.memoryStoreService.memory_store({
                content: merged,
                source: inputType === 'command' ? 'command_round' : 'autonomous_round'
            });
        }
    }

    async runMemoryFlushRound(messages = []) {
        const toolDefinitions = this.companionToolRegistry.getToolDefinitionsByNames(this.memoryToolNames);
        if (!Array.isArray(toolDefinitions) || toolDefinitions.length === 0) return;

        messages.push({
            role: 'user',
            content: [
                '<memory_flush>',
                'Context is near compaction. Persist only durable memories using memory_store (MEMORY.md).',
                'Use memory_append_log only for ephemeral run logs in daily notes.',
                'If nothing durable, respond exactly: NO_REPLY',
                'Do not call speak, detect, look, sleep, task, or todo in this round.',
                '</memory_flush>'
            ].join('\n')
        });

        for (let round = 0; round < 2; round += 1) {
            const completion = await this.client.chat.completions.create({
                model: this.config.llm.textModel,
                messages,
                stream: false,
                tools: toolDefinitions,
                tool_choice: 'auto',
                extra_body: { enable_thinking: true }
            });
            const rawMessage = completion.choices?.[0]?.message || {};
            const assistantMessage = this.buildAssistantToolMessage(rawMessage);
            messages.push(assistantMessage);

            if (!Array.isArray(assistantMessage.tool_calls) || assistantMessage.tool_calls.length === 0) {
                break;
            }

            const toolResults = await this.executeToolCallsWithConcurrency(
                assistantMessage.tool_calls,
                (toolCall) => this.companionToolRegistry.executeToolCall(toolCall)
            );

            for (let i = 0; i < assistantMessage.tool_calls.length; i += 1) {
                const toolCall = assistantMessage.tool_calls[i];
                const toolResult = toolResults[i];
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(toolResult, null, 2)
                });
            }
        }
    }

    buildAssistantToolMessage(message = {}) {
        return {
            role: 'assistant',
            content: typeof message?.content === 'string' ? message.content : '',
            ...(Array.isArray(message?.tool_calls) && message.tool_calls.length
                ? {
                    tool_calls: message.tool_calls.map((toolCall) => ({
                        id: toolCall.id,
                        type: toolCall.type,
                        function: {
                            name: toolCall.function?.name,
                            arguments: toolCall.function?.arguments || '{}'
                        }
                    }))
                }
                : {})
        };
    }

    async maybeRunMemoryFlush(messages = []) {
        if (this.config.memory?.enabled === false) return;
        if (this.config.memory?.flushEnabled === false) return;
        if (this.memoryFlushTriggeredSinceCompaction) return;
        const threshold = Math.max(0, Number(this.config.llm.contextCompactThresholdTokens || 0));
        if (threshold < 1) return;
        const softThreshold = Math.max(200, Number(this.config.memory?.flushSoftThresholdTokens || 4000));
        const flushTrigger = Math.max(1, threshold - softThreshold);
        const estimated = this.estimateTokenCount(messages);
        if (estimated < flushTrigger) return;

        await this.runMemoryFlushRound(messages);
        this.memoryFlushTriggeredSinceCompaction = true;
    }
}

module.exports = MemoryPipelineOrchestrator;
