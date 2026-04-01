/* 主要职责：统一封装 LLM 调用、工具循环、上下文管理和回复解析，是思考层的总编排入口。 */
const OpenAI = require('openai');
const path = require('path');
const config = require('../../config/runtimeConfig');
const {
    buildCompanionSystemPrompt,
    LIVE2D_CONSTRAINTS_PLACEHOLDER,
    SKILL_DESCRIPTION_PLACEHOLDER,
    TOOL_DESCRIPTION_PLACEHOLDER
} = require('./CompanionPromptBuilder');
const CompanionContextMemory = require('./CompanionContextMemory');
const live2dModelService = require('../output/Live2DModelService');
const companionToolRegistry = require('../tools/CompanionToolRegistry');
const { logMessages } = require('./llm/LLMDebugLogger');
const CompanionToolLoop = require('./llm/CompanionToolLoop');
const CompactionStrategyRegistry = require('./compact/CompactionStrategyRegistry');
const SummaryCompactStrategy = require('./compact/SummaryCompactStrategy');
const HandoffCompactStrategy = require('./compact/HandoffCompactStrategy');
const AutoCompactionOrchestrator = require('./compact/AutoCompactionOrchestrator');
const { estimateTokenCount } = require('./compact/compactionUtils');
const { createMemoryPipelineOrchestrator, graphMemoryService } = require('../memory/MemoryServices');
const {
    parseCompanionPayload,
    resolveCompanionResult,
    buildCompanionErrorFallback
} = require('./llm/CompanionResponseResolver');
const skillService = require('../skill/SkillService');

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
        this.generation = 1;
        this.pendingHandoffPath = '';
        this.pendingContinuationGoal = '';
        this.lastCompactionArtifact = null;
        this.memoryPipeline = createMemoryPipelineOrchestrator({
            config,
            client: this.client,
            companionToolRegistry,
            estimateTokenCount,
            memoryContextLimits: {
                longTerm: 3200,
                daily: 3200,
                retrieved: 2600
            },
            memoryToolNames: ['memory_search', 'memory_get', 'memory_append_log', 'memory_store']
        });
        this.compactionRegistry = new CompactionStrategyRegistry();
        this.compactionRegistry.register(new SummaryCompactStrategy({
            client: this.client,
            config,
            workspaceDir: this.companionPromptDir,
            getCompanionSystemPrompt: () => this.getCompanionSystemPrompt(),
            getToolDefinitions: () => companionToolRegistry.getToolDefinitions()
        }));
        this.compactionRegistry.register(new HandoffCompactStrategy({
            client: this.client,
            config,
            workspaceDir: this.companionPromptDir,
            getCompanionSystemPrompt: () => this.getCompanionSystemPrompt(),
            getToolDefinitions: () => companionToolRegistry.getToolDefinitions()
        }));
        this.compactionOrchestrator = new AutoCompactionOrchestrator({
            config,
            strategyRegistry: this.compactionRegistry,
            getGeneration: () => this.generation,
            onCompactionBoundary: (artifact) => this.onCompactionBoundary(artifact),
            onSwitchGeneration: (artifact, messages) => this.switchGeneration(artifact, messages)
        });
        this.companionToolLoop = new CompanionToolLoop({
            companionToolRegistry,
            completeCompanionWithTools: (messages) => this.completeCompanionWithTools(messages),
            onManualCompaction: ({ messages, focus }) => this.runManualCompact(messages, focus)
        });
        this.memoryPipeline.memoryStoreService.ensureLayout();
        try {
            graphMemoryService.ingestAndMaintain({ reason: 'startup' });
        } catch (error) {
            console.warn(`[GraphMemory] startup ingest failed: ${error?.message || error}`);
        }
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

        const skillDescriptions = this.buildSkillDescriptionsText();
        const toolDescriptions = this.buildToolDescriptionsText();
        promptWithContext = this.injectPromptPlaceholder(
            promptWithContext,
            SKILL_DESCRIPTION_PLACEHOLDER,
            skillDescriptions,
            'Skills available (load on demand):'
        );
        promptWithContext = this.injectPromptPlaceholder(
            promptWithContext,
            TOOL_DESCRIPTION_PLACEHOLDER,
            toolDescriptions,
            'Tools available:'
        );

        this.cachedCompanionSystemPrompt = promptWithContext;
        return this.cachedCompanionSystemPrompt;
    }

    injectPromptPlaceholder(promptWithContext, placeholder, content, fallbackHeader) {
        const base = String(promptWithContext || '');
        const needle = String(placeholder || '').trim();
        const body = String(content || '').trim() || '(none)';
        if (!needle) return base;
        if (base.includes(needle)) {
            return base.split(needle).join(body);
        }
        const header = String(fallbackHeader || '').trim();
        if (!header) {
            return `${base}\n${body}`;
        }
        return `${base}\n\n${header}\n${body}`;
    }

    buildSkillDescriptionsText() {
        if (skillService.getSkillDescriptions) {
            return skillService.getSkillDescriptions();
        }
        return '(no skills available)';
    }

    buildToolDescriptionsText() {
        const tools = companionToolRegistry.getToolsSnapshot
            ? companionToolRegistry.getToolsSnapshot()
            : [];
        if (!Array.isArray(tools) || tools.length === 0) {
            return '(no tools available)';
        }
        return tools
            .map((item = {}) => {
                const name = String(item.name || '').trim() || '(unknown tool)';
                const descriptionRaw = String(item.description || '').trim() || 'No description';
                const description = descriptionRaw.length > 180
                    ? `${descriptionRaw.slice(0, 179)}…`
                    : descriptionRaw;
                const scope = item.subagentEnabled === false ? ' [parent-only]' : '';
                return `- ${name}: ${description}${scope}`;
            })
            .join('\n');
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

    getToolCallConcurrency() {
        const configured = Number(config.llm?.toolCallConcurrency || 1);
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

    drainBackgroundNotificationsIntoMessages(messages = []) {
        if (!Array.isArray(messages)) return;
        const adapters = companionToolRegistry.getRuntimeAdapters
            ? companionToolRegistry.getRuntimeAdapters()
            : {};
        if (typeof adapters?.drainBackgroundNotifications !== 'function') {
            return;
        }
        const notifications = adapters.drainBackgroundNotifications();
        if (!Array.isArray(notifications) || notifications.length === 0) {
            return;
        }
        const lines = notifications.map((item = {}) => {
            const taskId = String(item.taskId || '').trim();
            const status = String(item.status || 'completed').trim();
            const headline = String(item.headline || '').trim() || '(no summary)';
            return `[bg:${taskId || 'unknown'}] ${status}: ${headline}`;
        });
        messages.push({
            role: 'user',
            content: `<background-results>\n${lines.join('\n')}\n</background-results>`
        });
        messages.push({
            role: 'assistant',
            content: 'Noted background results.'
        });
    }

    refreshCompanionPromptContext() {
        this.cachedCompanionSystemPrompt = null;
        const nextPrompt = this.getCompanionSystemPrompt();
        const systemMessage = this.companionSessionMessages.find((item) => item.role === 'system');
        if (systemMessage) {
            systemMessage.content = nextPrompt;
        }
    }

    onCompactionBoundary(artifact = {}) {
        this.lastCompactionArtifact = artifact;
        this.memoryPipeline.onCompactionBoundary();
        const adapters = companionToolRegistry.getRuntimeAdapters
            ? companionToolRegistry.getRuntimeAdapters()
            : {};
        if (typeof adapters?.onCompactionBoundary === 'function') {
            adapters.onCompactionBoundary({
                ...artifact,
                generation: this.generation,
                createdAt: Date.now()
            });
        }
    }

    switchGeneration(artifact = {}, messages = this.companionSessionMessages) {
        if (!Array.isArray(messages)) return;
        this.generation += 1;
        this.memory = new CompanionContextMemory();
        this.memoryPipeline.onCompactionBoundary();
        this.pendingHandoffPath = String(artifact.handoffPath || '').trim();
        this.pendingContinuationGoal = String(this.activeRunContext?.inputText || '').trim();

        const boundaryMessage = [
            `<compact_boundary id="${String(artifact.compactId || '')}" mode="handoff" generation="${this.generation}">`,
            `transcript=${String(artifact.transcriptPath || '')}`,
            `handoff=${this.pendingHandoffPath || '(none)'}`,
            this.pendingContinuationGoal ? `goal=${this.pendingContinuationGoal}` : '',
            '</compact_boundary>'
        ].filter(Boolean).join('\n');

        messages.splice(
            0,
            messages.length,
            {
                role: 'system',
                content: this.getCompanionSystemPrompt()
            },
            {
                role: 'user',
                content: boundaryMessage
            },
            {
                role: 'assistant',
                content: 'Understood. I will continue from the handoff file.'
            }
        );
    }

    async runManualCompact(messages = this.companionSessionMessages, focus = '') {
        const artifact = await this.compactionOrchestrator.runManualCompact({
            messages,
            focus
        });
        return {
            requested: true,
            mode: 'summary',
            compactId: artifact.compactId,
            transcriptPath: artifact.transcriptPath || '',
            summaryChars: String(artifact.summaryText || '').length
        };
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
        this.drainBackgroundNotificationsIntoMessages(messages);
        await this.memoryPipeline.maybeRunMemoryFlush(messages);
        await this.compactionOrchestrator.maybeCompactBeforeCall({
            messages,
            reason: 'threshold'
        });
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

    async completeSubagentWithTools(messages) {
        logMessages(config.llm.debugMessages, 'completeSubagentWithTools', messages);
        const completion = await this.client.chat.completions.create({
            model: config.llm.textModel,
            messages,
            stream: false,
            tools: companionToolRegistry.getToolDefinitions({ scope: 'subagent' }),
            tool_choice: 'auto',
            extra_body: { enable_thinking: true }
        });
        return completion.choices?.[0]?.message || { role: 'assistant', content: '' };
    }

    async runCompanionToolLoop(messages) {
        return this.companionToolLoop.run(messages);
    }

    async runSubagentTask(prompt, options = {}) {
        const normalizedPrompt = String(prompt || '').trim();
        if (!normalizedPrompt) {
            throw new Error('Subagent prompt is required');
        }
        const maxRounds = Math.max(1, Number(config.llm.maxSubagentToolRounds || 12));
        const maxSummaryChars = Math.max(400, Number(config.llm.subagentSummaryMaxChars || 2400));
        const maxToolResultChars = Math.max(1200, Number(config.llm.subagentToolResultMaxChars || 12000));
        const timelineContext = options.timelineContext && typeof options.timelineContext === 'object'
            ? options.timelineContext
            : {};
        const systemPrompt = [
            '你是一个编码子 Agent，负责完成父 Agent 分配的单个子任务。',
            '规则：',
            '1) 使用可用工具执行并验证结果；',
            '2) 不要输出与任务无关内容；',
            '3) 完成后输出简明总结（中文）；',
            '4) task 工具在子 Agent 中不可用，不要尝试递归创建子 Agent。'
        ].join('\n');
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: normalizedPrompt }
        ];

        let rounds = 0;
        let toolCalls = 0;
        let rawText = '';
        let stoppedByRoundLimit = false;

        for (let round = 0; round < maxRounds; round += 1) {
            const assistantOutput = await this.completeSubagentWithTools(messages);
            const assistantMessage = this.buildAssistantToolMessage(assistantOutput);
            messages.push(assistantMessage);
            rounds = round + 1;

            if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
                rawText = String(assistantMessage.content || '').trim();
                break;
            }

            const toolResults = await this.executeToolCallsWithConcurrency(
                assistantMessage.tool_calls,
                (toolCall) => companionToolRegistry.executeToolCall(toolCall, {
                    scope: 'subagent',
                    timelineContext
                })
            );

            for (let i = 0; i < assistantMessage.tool_calls.length; i += 1) {
                const toolCall = assistantMessage.tool_calls[i];
                const toolResult = toolResults[i];
                toolCalls += 1;
                let content = JSON.stringify(toolResult, null, 2);
                if (content.length > maxToolResultChars) {
                    content = `${content.slice(0, maxToolResultChars)}\n...[truncated]`;
                }
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content
                });
            }
        }

        if (!rawText) {
            stoppedByRoundLimit = rounds >= maxRounds;
            const fallback = messages
                .slice()
                .reverse()
                .find((item) => item?.role === 'assistant' && typeof item?.content === 'string' && item.content.trim());
            rawText = String(fallback?.content || '').trim();
        }

        let summary = rawText || '(no summary)';
        if (summary.length > maxSummaryChars) {
            summary = `${summary.slice(0, maxSummaryChars)}\n...[truncated]`;
        }

        return {
            summary,
            rawText: rawText || summary,
            rounds,
            toolCalls,
            stoppedByRoundLimit
        };
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

            const { fullContent } = await this.streamTextCompletion(this.textSessionMessages, onChunk);

            this.textSessionMessages.push({ role: 'assistant', content: fullContent });

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
            if (this.pendingHandoffPath) {
                this.companionSessionMessages.push({
                    role: 'user',
                    content: `请先调用 read_file 读取以下文件，再继续当前任务：${this.pendingHandoffPath}`
                });
                this.pendingHandoffPath = '';
            }
            if (this.pendingContinuationGoal) {
                this.companionSessionMessages.push({
                    role: 'user',
                    content: `延续目标：${this.pendingContinuationGoal}`
                });
                this.pendingContinuationGoal = '';
            }
            const memorySnapshot = await this.memoryPipeline.buildMemorySnapshot(inputText, inputType);
            const globalContext = this.memory.buildGlobalContext(inputText, {
                inputType,
                memorySnapshot
            });
            this.companionSessionMessages.push({
                role: 'user',
                content: `${globalContext}\n请根据设定决定是否调用工具完成本轮任务；若未调用 speak，再输出 JSON 作为兼容回退。`
            });

            this.activeRunContext = {
                inputText,
                inputType
            };

            const { rawText, actionState } = await this.runCompanionToolLoop(this.companionSessionMessages);

            const parsed = await parseCompanionPayload(rawText, (payload) => this.repairToJsonObject(payload));

            this.memory.updateAfterRound(actionState.observedState || inputText, { inputType });
            const resolved = resolveCompanionResult({ parsed, actionState, inputType, live2dModelService });
            await this.memoryPipeline.autoPersistRoundMemory({
                inputType,
                inputText,
                observedState: resolved.observedState,
                responseText: resolved.text
            });
            setImmediate(() => {
                try {
                    graphMemoryService.ingestAndMaintain({
                        reason: inputType === 'command' ? 'command_round' : 'perception_round'
                    });
                } catch (error) {
                    console.warn(`[GraphMemory] round ingest failed: ${error?.message || error}`);
                }
            });

            return resolved;
        } catch (error) {
            console.error('Error in chatWithCompanion:', error);
            return buildCompanionErrorFallback(live2dModelService);
        } finally {
            this.activeRunContext = null;
        }
    }

    getTodoState() {
        return companionToolRegistry.getTodoState();
    }

    getExtensionsSnapshot() {
        return {
            skills: skillService.getSkillsSnapshot
                ? skillService.getSkillsSnapshot()
                : [],
            tools: companionToolRegistry.getToolsSnapshot
                ? companionToolRegistry.getToolsSnapshot()
                : [],
            mcp: {
                status: 'placeholder'
            }
        };
    }

    setSkillEnabled(name, enabled) {
        const result = skillService.setSkillEnabled
            ? skillService.setSkillEnabled(name, enabled)
            : { ok: false, message: 'Skill toggle is not available.' };
        if (result?.ok) {
            this.refreshCompanionPromptContext();
        }
        return result;
    }

    getTaskGraphSnapshot() {
        return companionToolRegistry.getTaskGraphSnapshot
            ? companionToolRegistry.getTaskGraphSnapshot()
            : { tasks: [], generatedAt: Date.now(), hasCycle: false };
    }

    getMemoryGraph(payload = {}) {
        return graphMemoryService.getMemoryGraph(payload);
    }

    getMemoryRecallPreview(payload = {}) {
        return graphMemoryService.getRecallPreview(payload);
    }

    getMemoryNodeDetail(payload = {}) {
        const nodeId = typeof payload === 'string' ? payload : payload?.nodeId;
        return graphMemoryService.getNodeDetail(nodeId);
    }

    finalizeMemoryGraph() {
        return graphMemoryService.ingestAndMaintain({ reason: 'session_end' });
    }

    clearTaskGraph() {
        return companionToolRegistry.clearTaskGraph
            ? companionToolRegistry.clearTaskGraph()
            : { removed: 0, total: 0 };
    }

    onTodoStateChanged(listener) {
        return companionToolRegistry.subscribeTodoChanges(listener);
    }

    configureRuntimeAdapters(adapters = {}) {
        companionToolRegistry.setRuntimeAdapters(adapters);
    }

    getCompactionState() {
        return {
            generation: this.generation,
            mode: String(config.llm.autoCompactMode || 'summary').trim().toLowerCase() === 'handoff'
                ? 'handoff'
                : 'summary',
            lastArtifact: this.lastCompactionArtifact
                ? { ...this.lastCompactionArtifact }
                : null
        };
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

