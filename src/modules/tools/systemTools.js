/* 主要职责：集中定义 system 类工具并导出 createSystemTools。 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../../config/runtimeConfig');

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
    return {
        definition: {
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
    return {
        definition: {
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
    return {
        definition: {
            type: 'function',
            function: {
                name: 'bash',
                description: 'Run a shell command in the Windows workspace using PowerShell.',
                parameters: {
                    type: 'object',
                    properties: {
                        command: {
                            type: 'string',
                            description: 'PowerShell command to execute.'
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
    return {
        definition: {
            type: 'function',
            function: {
                name: 'read_file',
                description: 'Read file contents from workspace path.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'Path relative to workspace root.'
                        },
                        limit: {
                            type: 'integer',
                            description: 'Optional max lines to return.'
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
    return {
        definition: {
            type: 'function',
            function: {
                name: 'write_file',
                description: 'Write full content to a file under workspace path.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'Path relative to workspace root.'
                        },
                        content: {
                            type: 'string',
                            description: 'File content to write.'
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
    return {
        definition: {
            type: 'function',
            function: {
                name: 'edit_file',
                description: 'Replace exact text once in a file under workspace path.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'Path relative to workspace root.'
                        },
                        old_text: {
                            type: 'string',
                            description: 'Exact text to find.'
                        },
                        new_text: {
                            type: 'string',
                            description: 'Replacement text.'
                        }
                    },
                    required: ['path', 'old_text', 'new_text']
                }
            }
        },
        execute: (argumentsObject = {}) => runEdit(argumentsObject.path, argumentsObject.old_text, argumentsObject.new_text)
    };
}

function createSystemTools(dependencies) {
    return [
        createBashTool(dependencies),
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
