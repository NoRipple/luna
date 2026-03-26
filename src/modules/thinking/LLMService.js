const OpenAI = require('openai');
const path = require('path');
const config = require('../../config/runtimeConfig');
const { getCompanionSystemPrompt, LIVE2D_CONSTRAINTS_PLACEHOLDER } = require('./promptLoader');
const { logMessages } = require('./messageDebug');
const { extractFirstJsonObject } = require('./jsonUtils');
const CompanionMemory = require('./companionMemory');
const live2dModelService = require('../output/Live2DModelService');
const companionToolRegistry = require('../tools/CompanionToolRegistry');

class LLMService {
    constructor() {
        this.client = new OpenAI({
            apiKey: config.llm.apiKey,
            baseURL: config.llm.baseUrl
        });
        this.companionPromptDir = path.resolve(__dirname, '../../../workspace/CompanionAgent');
        this.textSessionMessages = [];
        this.companionSessionMessages = [];
        this.memory = new CompanionMemory();
        this.cachedCompanionSystemPrompt = null;
    }

    getCompanionSystemPrompt() {
        if (this.cachedCompanionSystemPrompt) {
            return this.cachedCompanionSystemPrompt;
        }

        const basePrompt = getCompanionSystemPrompt(this.companionPromptDir);
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
            // Backward-compatible fallback when placeholder is absent.
            promptWithContext = `${promptWithContext}\n${live2dConstraints}`;
        }

        promptWithContext = `${promptWithContext}\n当需要获取当前时间、当前 Live2D 模型信息，或用户明确要求执行碧蓝航线日常脚本时，请优先调用已提供的工具。若用户请求是多步骤命令，请先使用 todo 工具列出计划，并在执行过程中持续更新状态。完成工具调用后，最终仍只输出 JSON。`;

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

    async completeCompanionAsJson(messages) {
        logMessages(config.llm.debugMessages, 'completeCompanionAsJson', messages);
        const completion = await this.client.chat.completions.create({
            model: config.llm.textModel,
            messages,
            stream: false,
            response_format: { type: 'json_object' },
            extra_body: { enable_thinking: true }
        });

        return completion.choices?.[0]?.message?.content || '';
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

    async runCompanionToolLoop(messages) {
        const maxRounds = Math.max(1, Number(config.llm.maxToolRounds || 4));
        let roundsSinceTodo = 0;

        for (let round = 0; round < maxRounds; round += 1) {
            const assistantOutput = await this.completeCompanionWithTools(messages);
            const assistantMessage = this.buildAssistantToolMessage(assistantOutput);
            messages.push(assistantMessage);

            if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
                return assistantMessage.content || '';
            }

            let usedTodo = false;
            for (const toolCall of assistantMessage.tool_calls) {
                const toolResult = await companionToolRegistry.executeToolCall(toolCall);
                if (toolCall.function?.name === 'todo' && toolResult?.ok) {
                    usedTodo = true;
                }
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

    /**
     * Text Interaction Service
     * @param {string} prompt - The user's input text
     * @param {function} onChunk - Callback for streaming chunks (optional)
     * @returns {Promise<string>} - The full response text
     */
    async chatWithText(prompt, onChunk = null) {
        try {
            this.textSessionMessages.push({ role: 'user', content: prompt });
            this.memory.trimSession(this.textSessionMessages);

            const { fullContent } = await this.streamTextCompletion(this.textSessionMessages, onChunk);

            // 多轮上下文仅保留 assistant.content，不写入 reasoning_content
            this.textSessionMessages.push({ role: 'assistant', content: fullContent });
            this.memory.trimSession(this.textSessionMessages);

            return fullContent;
        } catch (error) {
            console.error('Error in chatWithText:', error);
            throw error;
        }
    }

    /**
     * Image Interaction Service
     * @param {string} imageUrl - URL of the image or Base64 string (data:image/jpeg;base64,...)
     * @param {string} prompt - The question about the image
     * @param {function} onChunk - Callback for streaming chunks (optional)
     * @returns {Promise<string>} - The full response text
     */
    async chatWithImage(imageUrl, prompt = "Describe this image", onChunk = null) {
        try {
            const messages = [
                {
                    role: "user",
                    content: [
                        {
                            type: "image_url",
                            image_url: { url: imageUrl }
                        },
                        { type: "text", text: prompt }
                    ]
                }
            ];
            logMessages(config.llm.debugMessages, 'chatWithImage', messages);
            const completion = await this.client.chat.completions.create({
                model: config.llm.visionModel,
                messages,
                stream: true,
                extra_body: { 
                    enable_thinking: true,
                    thinking_budget: 81920
                }
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

    /**
     * Companion Chat Service (Chain: Context -> Response)
     * @param {string} inputText - Perception analysis or direct user command
     * @param {{ inputType?: 'perception'|'command' }} options
     * @returns {Promise<object>} - JSON response { text, action, expression }
     */
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
                content: `${globalContext}\n请根据设定输出 JSON。`
            });
            this.memory.trimSession(this.companionSessionMessages, 1);

            const responseText = await this.runCompanionToolLoop(this.companionSessionMessages);
            
            let parsed;
            try {
                const jsonStr = extractFirstJsonObject(responseText);
                if (!jsonStr) {
                    throw new Error('Companion response does not contain valid JSON object');
                }
                parsed = JSON.parse(jsonStr);
            } catch (parseError) {
                const repaired = await this.repairToJsonObject(responseText);
                const repairedJsonStr = extractFirstJsonObject(repaired);
                if (!repairedJsonStr) {
                    throw parseError;
                }
                parsed = JSON.parse(repairedJsonStr);
            }
            if (!parsed || typeof parsed !== 'object') {
                throw new Error('Companion response JSON is not an object');
            }

            // Keep a compact global trajectory so future rounds can reason beyond current frame.
            this.memory.updateAfterRound(inputText, { inputType });
            if (this.memory.shouldRefreshSummary()) {
                const summaryPrompt = this.memory.buildSummaryPrompt();
                const completion = await this.client.chat.completions.create({
                    model: config.llm.textModel,
                    messages: [{ role: 'user', content: summaryPrompt }],
                    stream: false
                });
                const summary = completion.choices?.[0]?.message?.content?.trim() || '';
                this.memory.applySummary(summary);
                // Summary now carries old context, so keep only system + recent short context.
                this.memory.compactSessionAfterSummary(this.companionSessionMessages, 1, 6);
                if (config.llm.debugMessages) {
                    console.log(`[LLM DEBUG] long_term_summary_refreshed | rounds=${this.memory.companionRoundCount}`);
                    console.log(`[LLM DEBUG] companion_session_compacted | message_count=${this.companionSessionMessages.length}`);
                }
            }

            return {
                text: typeof parsed.text === 'string' ? parsed.text : '嗯... 我暂时有点卡住了。',
                motion: live2dModelService.sanitizeMotionName(parsed.motion),
                expression: live2dModelService.sanitizeExpressionName(parsed.expression)
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
                text: "Hmm... something went wrong...", 
                motion: fallbackMotion, 
                expression: fallbackExpression
            };
        }
    }

    getTodoState() {
        return companionToolRegistry.getTodoState();
    }

    onTodoStateChanged(listener) {
        return companionToolRegistry.subscribeTodoChanges(listener);
    }
}

module.exports = new LLMService();

