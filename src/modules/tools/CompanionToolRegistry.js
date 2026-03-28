/* 主要职责：作为工具注册中心，负责装配所有工具定义、保存 runtime adapter，并统一执行工具调用。 */
const live2dModelService = require('../output/Live2DModelService');
const TodoManager = require('./TodoManager');
const { createRuntimeTools } = require('./runtimeTools');
const { createSystemTools } = require('./systemTools');
const { createTaskTools } = require('./taskTools');

class CompanionToolRegistry {
    constructor() {
        this.todoManager = new TodoManager();
        this.runtimeAdapters = {};
        const dependencies = {
            todoManager: this.todoManager,
            live2dModelService,
            getRuntimeAdapters: () => this.runtimeAdapters
        };
        this.tools = [
            ...createRuntimeTools(dependencies),
            ...createSystemTools(dependencies),
            ...createTaskTools(dependencies)
        ];
        this.toolDefinitions = this.tools.map((tool) => tool.definition);
        this.executors = new Map(
            this.tools.map((tool) => [tool.definition.function.name, tool.execute])
        );
        this.toolMetas = new Map(
            this.tools.map((tool) => [
                tool.definition.function.name,
                {
                    description: tool.definition.function.description || '',
                    timelineEnabled: tool.timeline?.enabled !== false,
                    timelineKind: tool.timeline?.kind || tool.definition.function.name
                }
            ])
        );
    }

    setRuntimeAdapters(adapters = {}) {
        this.runtimeAdapters = adapters || {};
    }

    getToolDefinitions() {
        return this.toolDefinitions;
    }

    getTodoState() {
        return this.todoManager.getState();
    }

    subscribeTodoChanges(listener) {
        return this.todoManager.subscribe(listener);
    }

    parseArguments(rawArguments) {
        if (!rawArguments) return {};
        if (typeof rawArguments === 'object') return rawArguments;

        try {
            return JSON.parse(rawArguments);
        } catch (error) {
            return {};
        }
    }

    emitToolTimeline(payload = {}) {
        const emitter = this.runtimeAdapters?.onToolTimeline;
        if (typeof emitter !== 'function') return;
        try {
            emitter(payload);
        } catch (error) {
            // Do not let timeline failures affect tool execution.
        }
    }

    summarizeToolResult(result) {
        if (typeof result === 'string') return result.trim();
        if (!result || typeof result !== 'object') return '';

        const preferred = [
            result.summary,
            result.detail,
            result.text,
            result.message
        ].find((item) => typeof item === 'string' && item.trim());
        if (preferred) return preferred.trim();

        try {
            return JSON.stringify(result);
        } catch (error) {
            return '';
        }
    }

    async executeToolCall(toolCall) {
        const functionName = toolCall?.function?.name;
        const executor = this.executors.get(functionName);
        const argumentsObject = this.parseArguments(toolCall?.function?.arguments);
        const meta = this.toolMetas.get(functionName) || {
            description: '',
            timelineEnabled: true,
            timelineKind: functionName || 'tool'
        };

        if (!executor) {
            return {
                ok: false,
                error: `Unknown tool: ${functionName || 'unknown'}`
            };
        }

        const startedAt = Date.now();
        if (meta.timelineEnabled) {
            this.emitToolTimeline({
                tool: functionName,
                kind: meta.timelineKind,
                status: 'running',
                description: meta.description,
                detail: meta.description,
                args: argumentsObject,
                startedAt,
                createdAt: startedAt
            });
        }

        try {
            const result = await executor(argumentsObject);
            if (meta.timelineEnabled) {
                this.emitToolTimeline({
                    tool: functionName,
                    kind: meta.timelineKind,
                    status: 'done',
                    description: meta.description,
                    detail: this.summarizeToolResult(result) || meta.description,
                    args: argumentsObject,
                    result,
                    startedAt,
                    createdAt: Date.now(),
                    durationMs: Date.now() - startedAt
                });
            }
            return {
                ok: true,
                tool: functionName,
                result
            };
        } catch (error) {
            if (meta.timelineEnabled) {
                this.emitToolTimeline({
                    tool: functionName,
                    kind: meta.timelineKind,
                    status: 'error',
                    description: meta.description,
                    detail: error?.message || String(error),
                    args: argumentsObject,
                    startedAt,
                    createdAt: Date.now(),
                    durationMs: Date.now() - startedAt
                });
            }
            return {
                ok: false,
                tool: functionName,
                error: error?.message || String(error)
            };
        }
    }
}

module.exports = new CompanionToolRegistry();

