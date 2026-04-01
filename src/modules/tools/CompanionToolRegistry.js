/* 主要职责：作为工具注册中心，负责装配所有工具定义、保存 runtime adapter，并统一执行工具调用。 */
const path = require('path');
const config = require('../../config/runtimeConfig');
const live2dModelService = require('../output/Live2DModelService');
const skillService = require('../skill/SkillService');
const TodoManager = require('./TodoManager');
const TaskGraphManager = require('./TaskGraphManager');
const { createRuntimeTools } = require('./runtimeTools');
const { createSystemTools } = require('./systemTools');
const { createMemoryTools } = require('./memoryTools');
const { createTaskTools } = require('./taskTools');
const { memoryStoreService, memorySearchService } = require('../memory/MemoryServices');

class CompanionToolRegistry {
    constructor() {
        this.todoManager = new TodoManager();
        this.taskGraphManager = new TaskGraphManager(path.resolve(config.projectRoot, '.tasks'));
        this.runtimeAdapters = {};
        const dependencies = {
            todoManager: this.todoManager,
            getSkillContent: (name) => skillService.getSkillContent(name),
            taskGraphManager: this.taskGraphManager,
            live2dModelService,
            getRuntimeAdapters: () => this.runtimeAdapters,
            memoryStoreService,
            memorySearchService,
            memoryEnabled: config.memory?.enabled !== false
        };
        this.tools = [
            ...createRuntimeTools(dependencies),
            ...createMemoryTools(dependencies),
            ...createSystemTools(dependencies),
            ...createTaskTools(dependencies)
        ];
        this.toolDefinitions = this.tools.map((tool) => tool.definition);
        this.subagentToolDefinitions = this.tools
            .filter((tool) => tool.subagentEnabled !== false)
            .map((tool) => tool.definition);
        this.executors = new Map(
            this.tools.map((tool) => [tool.definition.function.name, tool.execute])
        );
        this.toolMetas = new Map(
            this.tools.map((tool) => [
                tool.definition.function.name,
                {
                    description: tool.definition.function.description || '',
                    timelineEnabled: tool.timeline?.enabled !== false,
                    timelineKind: tool.timeline?.kind || tool.definition.function.name,
                    subagentEnabled: tool.subagentEnabled !== false
                }
            ])
        );
    }

    setRuntimeAdapters(adapters = {}) {
        this.runtimeAdapters = adapters || {};
    }

    getToolsSnapshot() {
        return this.tools.map((tool) => {
            const name = String(tool?.definition?.function?.name || '').trim();
            const description = String(tool?.definition?.function?.description || '').trim();
            const meta = this.toolMetas.get(name) || {};
            return {
                name,
                description,
                subagentEnabled: Boolean(meta.subagentEnabled !== false),
                timelineEnabled: Boolean(meta.timelineEnabled !== false),
                timelineKind: String(meta.timelineKind || name || 'tool')
            };
        });
    }

    detectTaskGraphCycle(tasks = []) {
        const nodes = new Set();
        const indegree = new Map();
        const adjacency = new Map();

        tasks.forEach((task) => {
            const taskId = Number(task?.id);
            if (!Number.isInteger(taskId) || taskId <= 0) return;
            nodes.add(taskId);
            if (!indegree.has(taskId)) indegree.set(taskId, 0);
            if (!adjacency.has(taskId)) adjacency.set(taskId, new Set());
        });

        tasks.forEach((task) => {
            const to = Number(task?.id);
            if (!nodes.has(to)) return;
            const blockedBy = Array.isArray(task?.blockedBy) ? task.blockedBy : [];
            blockedBy.forEach((dependencyIdRaw) => {
                const from = Number(dependencyIdRaw);
                if (!nodes.has(from)) return;
                if (!adjacency.has(from)) adjacency.set(from, new Set());
                const edges = adjacency.get(from);
                if (edges.has(to)) return;
                edges.add(to);
                indegree.set(to, Number(indegree.get(to) || 0) + 1);
            });
        });

        const queue = [];
        indegree.forEach((value, nodeId) => {
            if (value === 0) queue.push(nodeId);
        });

        let visited = 0;
        while (queue.length) {
            const current = queue.shift();
            visited += 1;
            const nextNodes = adjacency.get(current) || new Set();
            nextNodes.forEach((nextNodeId) => {
                const nextIndegree = Number(indegree.get(nextNodeId) || 0) - 1;
                indegree.set(nextNodeId, nextIndegree);
                if (nextIndegree === 0) {
                    queue.push(nextNodeId);
                }
            });
        }
        return visited !== nodes.size;
    }

    getTaskGraphSnapshot() {
        const tasks = this.taskGraphManager.listAllObjects();
        return {
            tasks,
            generatedAt: Date.now(),
            hasCycle: this.detectTaskGraphCycle(tasks)
        };
    }

    clearTaskGraph() {
        return this.taskGraphManager.clearAllTasks();
    }

    getRuntimeAdapters() {
        return this.runtimeAdapters || {};
    }

    getToolDefinitions(options = {}) {
        const scope = options.scope === 'subagent' ? 'subagent' : 'parent';
        if (scope === 'subagent') {
            return this.subagentToolDefinitions;
        }
        return this.toolDefinitions;
    }

    getToolDefinitionsByNames(toolNames = []) {
        const nameSet = new Set((Array.isArray(toolNames) ? toolNames : [])
            .map((name) => String(name || '').trim())
            .filter(Boolean));
        if (nameSet.size === 0) return [];
        return this.tools
            .filter((tool) => nameSet.has(String(tool?.definition?.function?.name || '').trim()))
            .map((tool) => tool.definition);
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

    isToolAllowed(functionName, options = {}) {
        const scope = options.scope === 'subagent' ? 'subagent' : 'parent';
        if (scope !== 'subagent') return true;
        const meta = this.toolMetas.get(functionName);
        return Boolean(meta?.subagentEnabled);
    }

    async executeToolCall(toolCall, options = {}) {
        const functionName = toolCall?.function?.name;
        const executor = this.executors.get(functionName);
        const argumentsObject = this.parseArguments(toolCall?.function?.arguments);
        const scope = options.scope === 'subagent' ? 'subagent' : 'parent';
        const timelineContext = options.timelineContext && typeof options.timelineContext === 'object'
            ? options.timelineContext
            : {};
        const meta = this.toolMetas.get(functionName) || {
            description: '',
            timelineEnabled: true,
            timelineKind: functionName || 'tool',
            subagentEnabled: true
        };

        if (!executor) {
            return {
                ok: false,
                error: `Unknown tool: ${functionName || 'unknown'}`
            };
        }
        if (!this.isToolAllowed(functionName, { scope })) {
            return {
                ok: false,
                tool: functionName,
                error: `Tool not allowed for subagent scope: ${functionName}`
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
                createdAt: startedAt,
                ...timelineContext
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
                    durationMs: Date.now() - startedAt,
                    ...timelineContext
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
                    durationMs: Date.now() - startedAt,
                    ...timelineContext
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

