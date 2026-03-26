const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const live2dModelService = require('../output/Live2DModelService');
const TodoManager = require('./TodoManager');

const ALAS_DAILY_SCRIPT_PATH = 'D:\\WorkSpace\\ToolsCmds\\Start_MuMu_and_Alas2.bat';

class CompanionToolRegistry {
    constructor() {
        this.todoManager = new TodoManager();
        this.toolDefinitions = [
            {
                type: 'function',
                function: {
                    name: 'get_current_time',
                    description: '当你需要知道当前日期、时间、星期或时区时使用。',
                    parameters: {
                        type: 'object',
                        properties: {
                            timezone: {
                                type: 'string',
                                description: 'IANA 时区名称，例如 Asia/Hong_Kong。留空时使用系统本地时区。'
                            }
                        },
                        required: []
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'get_live2d_model_info',
                    description: '查询当前 Live2D 模型的路径、可用动作、表情和默认回退动作。',
                    parameters: {
                        type: 'object',
                        properties: {
                            include_motions: {
                                type: 'boolean',
                                description: '是否返回完整动作列表。默认 true。'
                            },
                            include_expressions: {
                                type: 'boolean',
                                description: '是否返回完整表情列表。默认 true。'
                            }
                        },
                        required: []
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'todo',
                    description: '更新当前执行计划。适合多步命令任务，状态仅允许 pending、in_progress、completed。',
                    parameters: {
                        type: 'object',
                        properties: {
                            items: {
                                type: 'array',
                                description: '完整的待办列表。',
                                items: {
                                    type: 'object',
                                    properties: {
                                        id: {
                                            type: 'string',
                                            description: '待办项标识符。'
                                        },
                                        text: {
                                            type: 'string',
                                            description: '待办项描述。'
                                        },
                                        status: {
                                            type: 'string',
                                            enum: ['pending', 'in_progress', 'completed'],
                                            description: '待办项状态。'
                                        }
                                    },
                                    required: ['id', 'text', 'status']
                                }
                            }
                        },
                        required: ['items']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'run_azur_lane_daily_script',
                    description: '当用户明确要求执行碧蓝航线日常任务时，启动固定脚本 D:\\WorkSpace\\ToolsCmds\\Start_MuMu_and_Alas2.bat。',
                    parameters: {
                        type: 'object',
                        properties: {},
                        required: []
                    }
                }
            }
        ];

        this.executors = {
            get_current_time: async (argumentsObject = {}) => this.getCurrentTime(argumentsObject),
            get_live2d_model_info: async (argumentsObject = {}) => this.getLive2DModelInfo(argumentsObject),
            todo: async (argumentsObject = {}) => this.updateTodo(argumentsObject),
            run_azur_lane_daily_script: async () => this.runAzurLaneDailyScript()
        };
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

    async executeToolCall(toolCall) {
        const functionName = toolCall?.function?.name;
        const executor = this.executors[functionName];
        const argumentsObject = this.parseArguments(toolCall?.function?.arguments);

        if (!executor) {
            return {
                ok: false,
                error: `Unknown tool: ${functionName || 'unknown'}`
            };
        }

        try {
            const result = await executor(argumentsObject);
            return {
                ok: true,
                tool: functionName,
                result
            };
        } catch (error) {
            return {
                ok: false,
                tool: functionName,
                error: error?.message || String(error)
            };
        }
    }

    getCurrentTime(argumentsObject = {}) {
        const requestedTimezone = String(argumentsObject.timezone || '').trim();
        const now = new Date();
        let timezone = requestedTimezone;

        if (!timezone) {
            timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        }

        const formatter = new Intl.DateTimeFormat('zh-CN', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            weekday: 'long'
        });

        return {
            timezone,
            iso: now.toISOString(),
            localFormatted: formatter.format(now),
            timestampMs: now.getTime()
        };
    }

    getLive2DModelInfo(argumentsObject = {}) {
        const includeMotions = argumentsObject.include_motions !== false;
        const includeExpressions = argumentsObject.include_expressions !== false;
        const capabilities = live2dModelService.getCapabilities();

        return {
            rendererModelPath: capabilities.rendererModelPath,
            fallbackMotion: capabilities.fallbackMotion,
            motionCount: Array.isArray(capabilities.motions) ? capabilities.motions.length : 0,
            expressionCount: Array.isArray(capabilities.expressions) ? capabilities.expressions.length : 0,
            motions: includeMotions ? capabilities.motions : undefined,
            expressions: includeExpressions ? capabilities.expressions : undefined,
            expressionSemanticMap: includeExpressions ? capabilities.expressionSemanticMap : undefined
        };
    }

    updateTodo(argumentsObject = {}) {
        return {
            board: this.todoManager.update(argumentsObject.items || []),
            state: this.todoManager.getState()
        };
    }

    runAzurLaneDailyScript() {
        if (!fs.existsSync(ALAS_DAILY_SCRIPT_PATH)) {
            throw new Error(`Script not found: ${ALAS_DAILY_SCRIPT_PATH}`);
        }

        const scriptDirectory = path.dirname(ALAS_DAILY_SCRIPT_PATH);
        const escapedScriptPath = ALAS_DAILY_SCRIPT_PATH.replace(/'/g, "''");
        const escapedWorkingDirectory = scriptDirectory.replace(/'/g, "''");
        const startProcessCommand = [
            `$scriptPath = '${escapedScriptPath}'`,
            `$workingDirectory = '${escapedWorkingDirectory}'`,
            "Start-Process -FilePath $scriptPath -WorkingDirectory $workingDirectory"
        ].join('; ');

        const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', startProcessCommand], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
            cwd: scriptDirectory
        });

        child.unref();

        return {
            started: true,
            scriptPath: ALAS_DAILY_SCRIPT_PATH,
            workingDirectory: scriptDirectory,
            pid: child.pid || null
        };
    }
}

module.exports = new CompanionToolRegistry();

