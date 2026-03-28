/* 主要职责：统一封装 LLM 调用、工具循环、上下文管理和回复解析，是思考层的总编排入口。 */
const OpenAI = require('openai');
const path = require('path');
const config = require('../../config/runtimeConfig');
const { buildCompanionSystemPrompt, LIVE2D_CONSTRAINTS_PLACEHOLDER } = require('./CompanionPromptBuilder');
const { extractFirstJsonObject } = require('./JsonUtils');
const CompanionContextMemory = require('./CompanionContextMemory');
const live2dModelService = require('../output/Live2DModelService');
const companionToolRegistry = require('../tools/CompanionToolRegistry');

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

class LLMService {
    constructor() {
        this.client = new OpenAI({
            apiKey: config.llm.apiKey,
            baseURL: config.llm.baseUrl
        });
        this.companionPromptDir = path.resolve(__dirname, '../../../workspace/CompanionAgent');
        this.textSessionMessages = [];
        this.companionSessionMessages = [];
        this.memory = new CompanionContextMemory();
        this.cachedCompanionSystemPrompt = null;
        this.activeRunContext = null;
    }

    getCompanionSystemPrompt() {
        if (this.cachedCompanionSystemPrompt) {
            return this.cachedCompanionSystemPrompt;
        }

        const basePrompt = buildCompanionSystemPrompt(this.companionPromptDir);
        let promptWithContext = basePrompt;
        let live2dConstraints = '';

        try {
            live2dConstraints = live2dModelService.buildCompanionMotionPromptSuffix();
        } catch (error) {
            console.warn('Failed to append dynamic Live2D motion constraints:', error.message);
        }

        if (promptWithContext.includes(LIVE2D_CONSTRAINTS_PLACEHOLDER)) {
            promptWithContext = promptWithContext.replace(
                LIVE2D_CONSTRAINTS_PLACEHOLDER,
                live2dConstraints || ''
            );
        } else if (live2dConstraints) {
            promptWithContext = `${promptWithContext}\n${live2dConstraints}`;
        }

        promptWithContext = `${promptWithContext}\n你运行在一个常驻 agent runtime 中。你的高阶能力主要是 detect、look、speak、sleep、todo，以及少量辅助工具。detect 会读取最近状态或按需截图分析；look 会立刻截图确认最新状态；speak 会完成文字播报、TTS 与 Live2D 动作表达；sleep 用于安排下一次自主苏醒时间。建议将 sleep 控制在 5 到 60 秒之间，并根据用户是否忙碌、是否刚被打扰过来保守选择；todo 用于维护多步骤计划。没有用户命令时，你也可以主动 detect 并决定是否 speak。若本轮未调用 speak，再输出 JSON 作为兼容回退。每轮结束前都应决定是否 sleep；若没有特别理由，保持沉默并 sleep。`;

        this.cachedCompanionSystemPrompt = promptWithContext;
        return this.cachedCompanionSystemPrompt;
    }

    refreshCompanionPromptContext() {
        this.cachedCompanionSystemPrompt = null;
        const nextPrompt = this.getCompanionSystemPrompt();
        const systemMessage = this.companionSessionMessages.find((item) => item.role === 'system');
        if (systemMessage) {
            systemMessage.content = nextPrompt;
        }
    }

    async streamTextCompletion(messages, onChunk = null) {
        logMessages(config.llm.debugMessages, 'streamTextCompletion', messages);
        const completion = await this.client.chat.completions.create({
            model: config.llm.textModel,
            messages,
            stream: true,
            extra_body: { enable_thinking: true }
        });

        let fullContent = '';
        let reasoningContent = '';

        for await (const chunk of completion) {
            const delta = chunk.choices[0]?.delta;

            if (delta?.reasoning_content) {
                reasoningContent += delta.reasoning_content;
                if (onChunk) onChunk({ type: 'reasoning', content: delta.reasoning_content });
            }

            if (delta?.content) {
                fullContent += delta.content;
                if (onChunk) onChunk({ type: 'content', content: delta.content });
            }
        }

        return { fullContent, reasoningContent };
    }

    async completeCompanionWithTools(messages) {
        logMessages(config.llm.debugMessages, 'completeCompanionWithTools', messages);
        const completion = await this.client.chat.completions.create({
            model: config.llm.textModel,
            messages,
            stream: false,
            tools: companionToolRegistry.getToolDefinitions(),
            tool_choice: 'auto',
            extra_body: { enable_thinking: true }
        });

        return completion.choices?.[0]?.message || { role: 'assistant', content: '' };
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

    async runCompanionToolLoop(messages) {
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
            for (const toolCall of assistantMessage.tool_calls) {
                const toolResult = await companionToolRegistry.executeToolCall(toolCall);
                if (toolCall.function?.name === 'todo' && toolResult?.ok) {
                    usedTodo = true;
                }
                this.applyToolSideEffects(actionState, toolCall, toolResult);
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(toolResult, null, 2)
                });
            }

            roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
            if (roundsSinceTodo >= 3 && companionToolRegistry.getTodoState().hasOpenItems) {
                this.injectTodoReminder(messages);
            }
        }

        throw new Error(`Companion tool loop exceeded max rounds (${maxRounds})`);
    }

    async repairToJsonObject(rawText) {
        const completion = await this.client.chat.completions.create({
            model: config.llm.textModel,
            messages: [
                {
                    role: 'system',
                    content: '你是 JSON 格式修复助手。请将用户输入修复为合法 JSON 对象，只输出 JSON。'
                },
                {
                    role: 'user',
                    content: String(rawText || '')
                }
            ],
            stream: false,
            response_format: { type: 'json_object' },
            extra_body: { enable_thinking: true }
        });
        return completion.choices?.[0]?.message?.content || '';
    }

    async chatWithText(prompt, onChunk = null) {
        try {
            this.textSessionMessages.push({ role: 'user', content: prompt });
            this.memory.trimSession(this.textSessionMessages);

            const { fullContent } = await this.streamTextCompletion(this.textSessionMessages, onChunk);

            this.textSessionMessages.push({ role: 'assistant', content: fullContent });
            this.memory.trimSession(this.textSessionMessages);

            return fullContent;
        } catch (error) {
            console.error('Error in chatWithText:', error);
            throw error;
        }
    }

    async chatWithImage(imageUrl, prompt = 'Describe this image', optionsOrOnChunk = null, maybeOnChunk = null) {
        try {
            let options = {};
            let onChunk = null;
            if (typeof optionsOrOnChunk === 'function') {
                onChunk = optionsOrOnChunk;
            } else {
                options = optionsOrOnChunk && typeof optionsOrOnChunk === 'object' ? optionsOrOnChunk : {};
                onChunk = typeof maybeOnChunk === 'function' ? maybeOnChunk : null;
            }

            const messages = [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image_url',
                            image_url: { url: imageUrl }
                        },
                        { type: 'text', text: prompt }
                    ]
                }
            ];

            const selectedModel = options.model || config.llm.visionModel;
            const thinkingBudget = Number.isFinite(Number(options.thinkingBudget))
                ? Number(options.thinkingBudget)
                : Number(config.llm.visionThinkingBudget || 2048);
            const maxTokens = Number.isFinite(Number(options.maxOutputTokens))
                ? Number(options.maxOutputTokens)
                : Number(config.llm.visionMaxOutputTokens || 0);
            const enableThinking = options.enableThinking !== false;

            logMessages(config.llm.debugMessages, 'chatWithImage', messages);
            const completion = await this.client.chat.completions.create({
                model: selectedModel,
                messages,
                stream: true,
                ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
                extra_body: enableThinking
                    ? { enable_thinking: true, thinking_budget: thinkingBudget }
                    : {}
            });

            let fullContent = '';
            let reasoningContent = '';

            for await (const chunk of completion) {
                const delta = chunk.choices[0]?.delta;

                if (delta?.reasoning_content) {
                    reasoningContent += delta.reasoning_content;
                    if (onChunk) onChunk({ type: 'reasoning', content: delta.reasoning_content });
                }

                if (delta?.content) {
                    fullContent += delta.content;
                    if (onChunk) onChunk({ type: 'content', content: delta.content });
                }
            }

            return fullContent;
        } catch (error) {
            console.error('Error in chatWithImage:', error);
            throw error;
        }
    }

    async chatWithCompanion(inputText, options = {}) {
        try {
            if (this.companionSessionMessages.length === 0) {
                this.companionSessionMessages.push({
                    role: 'system',
                    content: this.getCompanionSystemPrompt()
                });
            }

            const inputType = options.inputType === 'command' ? 'command' : 'perception';
            const globalContext = this.memory.buildGlobalContext(inputText, { inputType });
            this.companionSessionMessages.push({
                role: 'user',
                content: `${globalContext}\n请根据设定决定是否调用工具完成本轮任务；若未调用 speak，再输出 JSON 作为兼容回退。`
            });
            this.memory.trimSession(this.companionSessionMessages, 1);

            this.activeRunContext = {
                inputText,
                inputType
            };

            const { rawText, actionState } = await this.runCompanionToolLoop(this.companionSessionMessages);

            let parsed = null;
            if (rawText) {
                try {
                    const jsonStr = extractFirstJsonObject(rawText);
                    if (!jsonStr) {
                        throw new Error('Companion response does not contain valid JSON object');
                    }
                    parsed = JSON.parse(jsonStr);
                } catch (parseError) {
                    const repaired = await this.repairToJsonObject(rawText);
                    const repairedJsonStr = extractFirstJsonObject(repaired);
                    if (!repairedJsonStr) {
                        throw parseError;
                    }
                    parsed = JSON.parse(repairedJsonStr);
                }
            }

            if (parsed && typeof parsed !== 'object') {
                throw new Error('Companion response JSON is not an object');
            }

            this.memory.updateAfterRound(actionState.observedState || inputText, { inputType });
            if (this.memory.shouldRefreshSummary()) {
                const summaryPrompt = this.memory.buildSummaryPrompt();
                const completion = await this.client.chat.completions.create({
                    model: config.llm.textModel,
                    messages: [{ role: 'user', content: summaryPrompt }],
                    stream: false
                });
                const summary = completion.choices?.[0]?.message?.content?.trim() || '';
                this.memory.applySummary(summary);
                this.memory.compactSessionAfterSummary(this.companionSessionMessages, 1, 6);
                if (config.llm.debugMessages) {
                    console.log(`[LLM DEBUG] long_term_summary_refreshed | rounds=${this.memory.companionRoundCount}`);
                    console.log(`[LLM DEBUG] companion_session_compacted | message_count=${this.companionSessionMessages.length}`);
                }
            }

            const fallbackText = actionState.spokenText || actionState.panelNote || '';
            const defaultText = inputType === 'command'
                ? '嗯... 我暂时有点卡住了。'
                : '';
            const finalText = parsed && typeof parsed.text === 'string'
                ? parsed.text
                : (fallbackText || defaultText);
            const finalMotion = actionState.motion || (parsed ? live2dModelService.sanitizeMotionName(parsed.motion) : '');
            const finalExpression = actionState.expression || (parsed ? live2dModelService.sanitizeExpressionName(parsed.expression) : '');

            return {
                text: finalText,
                motion: finalMotion || live2dModelService.getCapabilities().fallbackMotion,
                expression: finalExpression,
                observedState: actionState.observedState || '',
                handledByAgentTools: actionState.usedOutputTool,
                spoke: actionState.spoke,
                sleepSeconds: actionState.sleepSeconds
            };
        } catch (error) {
            console.error('Error in chatWithCompanion:', error);
            let fallbackMotion = 'idle';
            let fallbackExpression = '';
            try {
                const capabilities = live2dModelService.getCapabilities();
                fallbackMotion = capabilities.fallbackMotion;
                fallbackExpression = capabilities.fallbackExpression || '';
            } catch (capError) {
                // ignore
            }
            return {
                text: 'Hmm... something went wrong...',
                motion: fallbackMotion,
                expression: fallbackExpression,
                observedState: '',
                handledByAgentTools: false,
                spoke: false,
                sleepSeconds: null
            };
        } finally {
            this.activeRunContext = null;
        }
    }

    getTodoState() {
        return companionToolRegistry.getTodoState();
    }

    onTodoStateChanged(listener) {
        return companionToolRegistry.subscribeTodoChanges(listener);
    }

    configureRuntimeAdapters(adapters = {}) {
        companionToolRegistry.setRuntimeAdapters(adapters);
    }

    getCompanionSessionMessagesSnapshot() {
        return this.companionSessionMessages.map((message, index) => {
            const normalized = {
                index,
                role: String(message?.role || ''),
                content: message?.content ?? ''
            };
            if (message?.tool_call_id) {
                normalized.tool_call_id = String(message.tool_call_id);
            }
            if (Array.isArray(message?.tool_calls)) {
                normalized.tool_calls = message.tool_calls.map((toolCall) => ({
                    id: toolCall?.id,
                    type: toolCall?.type,
                    function: {
                        name: toolCall?.function?.name,
                        arguments: toolCall?.function?.arguments ?? '{}'
                    }
                }));
            }
            return normalized;
        });
    }
}

module.exports = new LLMService();

