const config = require('../../../config/runtimeConfig');

class CompanionToolLoop {
    constructor({ companionToolRegistry, completeCompanionWithTools, onManualCompaction = null }) {
        this.companionToolRegistry = companionToolRegistry;
        this.completeCompanionWithTools = completeCompanionWithTools;
        this.onManualCompaction = typeof onManualCompaction === 'function'
            ? onManualCompaction
            : null;
    }

    parseToolArguments(rawArguments) {
        if (!rawArguments) return {};
        if (typeof rawArguments === 'object') return rawArguments;
        try {
            return JSON.parse(rawArguments);
        } catch (error) {
            return {};
        }
    }

    getToolCallConcurrency() {
        const configured = Number(config.llm?.toolCallConcurrency || 1);
        if (!Number.isFinite(configured)) return 1;
        return Math.max(1, Math.floor(configured));
    }

    async executeToolCallsWithConcurrency(toolCalls = [], executeFn) {
        const calls = Array.isArray(toolCalls) ? toolCalls : [];
        if (calls.length === 0) return [];
        const runner = typeof executeFn === 'function' ? executeFn : async () => ({ ok: false, error: 'invalid executor' });
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

    buildAssistantToolMessage(message) {
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

    injectTodoReminder(messages) {
        messages.push({
            role: 'user',
            content: '<reminder>你已经连续数轮没有更新 todo。若当前任务是多步骤执行，请先调用 todo 工具维护计划，再继续执行。</reminder>'
        });
    }

    buildActionState() {
        return {
            spoke: false,
            spokenText: '',
            motion: '',
            expression: '',
            panelNote: '',
            observedState: '',
            usedOutputTool: false,
            sleepSeconds: null
        };
    }

    applyToolSideEffects(actionState, toolCall, toolResult) {
        if (!toolResult?.ok) return;
        const toolName = toolCall.function?.name;
        const result = toolResult.result || {};

        if (toolName === 'speak') {
            actionState.spoke = true;
            actionState.usedOutputTool = true;
            actionState.spokenText = String(result.text || actionState.spokenText || '').trim();
            actionState.motion = String(result.motion || actionState.motion || '').trim();
            actionState.expression = String(result.expression || actionState.expression || '').trim();
        } else if (toolName === 'update_panel_note') {
            actionState.panelNote = String(result.text || '').trim();
        } else if (toolName === 'detect') {
            actionState.observedState = String(result.summary || result.detail || '').trim();
        } else if (toolName === 'sleep') {
            actionState.sleepSeconds = Number(result.sleepSeconds || 0) || null;
        }
    }

    async run(messages) {
        const maxRounds = Math.max(1, Number(config.llm.maxToolRounds || 4));
        let roundsSinceTodo = 0;
        const actionState = this.buildActionState();

        for (let round = 0; round < maxRounds; round += 1) {
            const assistantOutput = await this.completeCompanionWithTools(messages);
            const assistantMessage = this.buildAssistantToolMessage(assistantOutput);
            messages.push(assistantMessage);

            if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
                return {
                    rawText: assistantMessage.content || '',
                    actionState
                };
            }

            let usedTodo = false;
            let compactRequested = false;
            let compactFocus = '';
            let compactToolCallId = '';
            const executedToolCalls = await this.executeToolCallsWithConcurrency(
                assistantMessage.tool_calls,
                (toolCall) => this.companionToolRegistry.executeToolCall(toolCall)
            );

            for (let i = 0; i < assistantMessage.tool_calls.length; i += 1) {
                const toolCall = assistantMessage.tool_calls[i];
                const toolResult = executedToolCalls[i];
                if (toolCall.function?.name === 'todo' && toolResult?.ok) {
                    usedTodo = true;
                }
                if (toolCall.function?.name === 'compact' && toolResult?.ok) {
                    compactRequested = true;
                    compactToolCallId = String(toolCall.id || '');
                    const parsedArguments = this.parseToolArguments(toolCall.function?.arguments);
                    compactFocus = String(parsedArguments?.focus || '').trim();
                }
                this.applyToolSideEffects(actionState, toolCall, toolResult);
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(toolResult, null, 2)
                });
            }

            if (compactRequested && this.onManualCompaction) {
                const compactResult = await this.onManualCompaction({ messages, focus: compactFocus });
                if (compactToolCallId) {
                    const compactToolMessage = messages.find((item) => (
                        item?.role === 'tool' && String(item?.tool_call_id || '') === compactToolCallId
                    ));
                    if (compactToolMessage) {
                        compactToolMessage.content = JSON.stringify({
                            ok: true,
                            tool: 'compact',
                            result: compactResult
                        }, null, 2);
                    }
                }
                roundsSinceTodo = 0;
                continue;
            }

            roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
            if (roundsSinceTodo >= 3 && this.companionToolRegistry.getTodoState().hasOpenItems) {
                this.injectTodoReminder(messages);
            }
        }

        throw new Error(`Companion tool loop exceeded max rounds (${maxRounds})`);
    }
}

module.exports = CompanionToolLoop;
