/* 主要职责：集中定义 system 类工具并导出 createSystemTools。 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../../config/runtimeConfig');
const { getToolDescriptionConfig } = require('../../config/toolDescriptionConfig');

const WORKDIR = path.resolve(config.projectRoot || process.cwd());
const MAX_OUTPUT_CHARS = 50000;

function truncateOutput(text) {
    const normalized = String(text || '').trim();
    if (!normalized) return '(no output)';
    return normalized.length > MAX_OUTPUT_CHARS
        ? normalized.slice(0, MAX_OUTPUT_CHARS)
        : normalized;
}

function safePath(relativePath) {
    const resolved = path.resolve(WORKDIR, String(relativePath || ''));
    const relative = path.relative(WORKDIR, resolved);
    const escapesWorkspace = relative.startsWith('..') || path.isAbsolute(relative);
    if (escapesWorkspace) {
        throw new Error(`Path escapes workspace: ${relativePath}`);
    }
    return resolved;
}

function runBash(command) {
    const rawCommand = String(command || '').trim();
    if (!rawCommand) return '(no output)';

    const blockedPatterns = [
        'rm -rf /',
        'sudo',
        'shutdown',
        'reboot',
        '> /dev/',
        'format c:',
        'rd /s /q c:\\'
    ];
    const lowered = rawCommand.toLowerCase();
    if (blockedPatterns.some((item) => lowered.includes(item))) {
        return 'Error: Dangerous command blocked';
    }

    try {
        const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', rawCommand], {
            cwd: WORKDIR,
            encoding: 'utf8',
            timeout: 120000,
            windowsHide: true,
            maxBuffer: 1024 * 1024 * 8
        });

        if (result.error) {
            if (result.error.code === 'ETIMEDOUT') {
                return 'Error: Timeout (120s)';
            }
            return `Error: ${result.error.message}`;
        }

        const merged = `${result.stdout || ''}${result.stderr || ''}`;
        return truncateOutput(merged);
    } catch (error) {
        return `Error: ${error.message || String(error)}`;
    }
}

function runRead(pathArg, limit) {
    try {
        const target = safePath(pathArg);
        const content = fs.readFileSync(target, 'utf8');
        const lines = content.split(/\r?\n/);
        const lineLimit = Number.isFinite(Number(limit)) ? Number(limit) : null;
        let selected = lines;
        if (lineLimit && lineLimit > 0 && lineLimit < lines.length) {
            selected = lines.slice(0, lineLimit).concat([`... (${lines.length - lineLimit} more lines)`]);
        }
        return truncateOutput(selected.join('\n'));
    } catch (error) {
        return `Error: ${error.message || String(error)}`;
    }
}

function runWrite(pathArg, content) {
    try {
        const target = safePath(pathArg);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const text = String(content || '');
        fs.writeFileSync(target, text, 'utf8');
        return `Wrote ${text.length} bytes to ${pathArg}`;
    } catch (error) {
        return `Error: ${error.message || String(error)}`;
    }
}

function runEdit(pathArg, oldText, newText) {
    try {
        const target = safePath(pathArg);
        const source = fs.readFileSync(target, 'utf8');
        const oldValue = String(oldText || '');
        const newValue = String(newText || '');
        const index = source.indexOf(oldValue);
        if (index < 0) {
            return `Error: Text not found in ${pathArg}`;
        }
        const next = `${source.slice(0, index)}${newValue}${source.slice(index + oldValue.length)}`;
        fs.writeFileSync(target, next, 'utf8');
        return `Edited ${pathArg}`;
    } catch (error) {
        return `Error: ${error.message || String(error)}`;
    }
}

function createGetCurrentTime() {
    const descriptionConfig = getToolDescriptionConfig('get_current_time');
    return {
        subagentEnabled: true,
        definition: {
            type: 'function',
            function: {
                name: 'get_current_time',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        timezone: {
                            type: 'string',
                            description: descriptionConfig.parameters?.timezone?.description || ''
                        }
                    },
                    required: []
                }
            }
        },
        execute: (argumentsObject = {}) => {
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
    };
}

function createGetLive2DModelInfo({ live2dModelService }) {
    const descriptionConfig = getToolDescriptionConfig('get_live2d_model_info');
    return {
        subagentEnabled: true,
        definition: {
            type: 'function',
            function: {
                name: 'get_live2d_model_info',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        include_motions: {
                            type: 'boolean',
                            description: descriptionConfig.parameters?.include_motions?.description || ''
                        },
                        include_expressions: {
                            type: 'boolean',
                            description: descriptionConfig.parameters?.include_expressions?.description || ''
                        }
                    },
                    required: []
                }
            }
        },
        execute: (argumentsObject = {}) => {
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
    };
}

function createBashTool() {
    const descriptionConfig = getToolDescriptionConfig('bash');
    return {
        subagentEnabled: true,
        definition: {
            type: 'function',
            function: {
                name: 'bash',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        command: {
                            type: 'string',
                            description: descriptionConfig.parameters?.command?.description || ''
                        }
                    },
                    required: ['command']
                }
            }
        },
        execute: (argumentsObject = {}) => runBash(argumentsObject.command)
    };
}

function createReadFileTool() {
    const descriptionConfig = getToolDescriptionConfig('read_file');
    return {
        subagentEnabled: true,
        definition: {
            type: 'function',
            function: {
                name: 'read_file',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: descriptionConfig.parameters?.path?.description || ''
                        },
                        limit: {
                            type: 'integer',
                            description: descriptionConfig.parameters?.limit?.description || ''
                        }
                    },
                    required: ['path']
                }
            }
        },
        execute: (argumentsObject = {}) => runRead(argumentsObject.path, argumentsObject.limit)
    };
}

function createWriteFileTool() {
    const descriptionConfig = getToolDescriptionConfig('write_file');
    return {
        subagentEnabled: true,
        definition: {
            type: 'function',
            function: {
                name: 'write_file',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: descriptionConfig.parameters?.path?.description || ''
                        },
                        content: {
                            type: 'string',
                            description: descriptionConfig.parameters?.content?.description || ''
                        }
                    },
                    required: ['path', 'content']
                }
            }
        },
        execute: (argumentsObject = {}) => runWrite(argumentsObject.path, argumentsObject.content)
    };
}

function createEditFileTool() {
    const descriptionConfig = getToolDescriptionConfig('edit_file');
    return {
        subagentEnabled: true,
        definition: {
            type: 'function',
            function: {
                name: 'edit_file',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: descriptionConfig.parameters?.path?.description || ''
                        },
                        old_text: {
                            type: 'string',
                            description: descriptionConfig.parameters?.old_text?.description || ''
                        },
                        new_text: {
                            type: 'string',
                            description: descriptionConfig.parameters?.new_text?.description || ''
                        }
                    },
                    required: ['path', 'old_text', 'new_text']
                }
            }
        },
        execute: (argumentsObject = {}) => runEdit(argumentsObject.path, argumentsObject.old_text, argumentsObject.new_text)
    };
}

function createBackgroundRunTool({ getRuntimeAdapters }) {
    const descriptionConfig = getToolDescriptionConfig('background_run');
    return {
        subagentEnabled: true,
        definition: {
            type: 'function',
            function: {
                name: 'background_run',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        command: {
                            type: 'string',
                            description: descriptionConfig.parameters?.command?.description || ''
                        }
                    },
                    required: ['command']
                }
            }
        },
        execute: async (argumentsObject = {}) => {
            const adapters = getRuntimeAdapters();
            if (typeof adapters.backgroundRun !== 'function') {
                throw new Error('backgroundRun adapter is not configured');
            }
            return adapters.backgroundRun(argumentsObject);
        }
    };
}

function createCheckBackgroundTool({ getRuntimeAdapters }) {
    const descriptionConfig = getToolDescriptionConfig('check_background');
    return {
        subagentEnabled: true,
        definition: {
            type: 'function',
            function: {
                name: 'check_background',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        task_id: {
                            type: 'string',
                            description: descriptionConfig.parameters?.task_id?.description || ''
                        }
                    },
                    required: []
                }
            }
        },
        execute: async (argumentsObject = {}) => {
            const adapters = getRuntimeAdapters();
            if (typeof adapters.checkBackground !== 'function') {
                throw new Error('checkBackground adapter is not configured');
            }
            return adapters.checkBackground(argumentsObject);
        }
    };
}

function createSystemTools(dependencies) {
    return [
        createBashTool(dependencies),
        createBackgroundRunTool(dependencies),
        createCheckBackgroundTool(dependencies),
        createReadFileTool(dependencies),
        createWriteFileTool(dependencies),
        createEditFileTool(dependencies),
        createGetCurrentTime(dependencies),
        createGetLive2DModelInfo(dependencies)
    ];
}

module.exports = {
    createSystemTools
};
