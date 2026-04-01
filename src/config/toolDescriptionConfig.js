/* 主要职责：集中维护工具描述（函数描述与参数描述），供工具定义直接引用。 */

const toolDescriptionConfig = {
    detect: {
        description: '获取当前环境状态摘要。该工具优先读取最近一次缓存状态，若缓存过期再执行截图与分析，适合常规状态感知。'
    },
    look: {
        description: '立即确认用户的最新屏幕状态。该工具会立刻截图并分析（绕过缓存），适合在关键时刻做实时复核。'
    },
    speak: {
        description: '与用户交互，包含文字播报、语音播放和 Live2D 动作表达，请确保 text 字段不为空。',
        parameters: {
            text: { description: '要说的话。' },
            motion: { description: '动作名。' },
            expression: { description: '表情名。' }
        }
    },
    sleep: {
        description: '安排下一次自主苏醒时间。',
        parameters: {
            seconds: { description: '希望休眠的秒数。建议在 5 到 60 之间。' }
        }
    },
    listen: {
        description: '监听系统音频与麦克风',
        parameters: {
            seconds: { description: '监听时长（秒）。建议 2-10，超过 10 会自动截断为 10。' }
        }
    },
    memory_search: {
        description: '在记忆库中查找记忆（快速查找）',
        parameters: {
            query: { description: '检索查询语句。' },
            max_results: { description: '返回最大结果数，默认 5。' }
        }
    },
    memory_get: {
        description: '读取记忆文件片段',
        parameters: {
            path: { description: '相对路径，如 MEMORY.md 或 memory/2026-03-29.md。' },
            start_line: { description: '起始行号（1-based）。' },
            limit_lines: { description: '返回行数上限。' }
        }
    },
    memory_append_log: {
        description: '写入日常笔记到日志',
        parameters: {
            content: { description: '日志内容。' },
            source: { description: '可选来源标识。' }
        }
    },
    memory_store: {
        description: '记录长期记忆，用于决策、偏好和持久性事实',
        parameters: {
            content: { description: '记忆内容。' },
            source: { description: '可选来源标识。' }
        }
    },
    bash: {
        description: 'Run a shell command in the Windows workspace using PowerShell.',
        parameters: {
            command: { description: 'PowerShell command to execute.' }
        }
    },
    background_run: {
        description: 'Run a shell command in background and return immediately with task id.',
        parameters: {
            command: { description: 'PowerShell command to execute asynchronously.' }
        }
    },
    check_background: {
        description: '查询后台任务状态。可传 task_id 查询单个，不传则返回近期任务列表。',
        parameters: {
            task_id: { description: '后台任务 ID（可选）。' }
        }
    },
    read_file: {
        description: 'Read file contents from workspace path.',
        parameters: {
            path: { description: 'Path relative to workspace root.' },
            limit: { description: 'Optional max lines to return.' }
        }
    },
    write_file: {
        description: 'Write full content to a file under workspace path.',
        parameters: {
            path: { description: 'Path relative to workspace root.' },
            content: { description: 'File content to write.' }
        }
    },
    edit_file: {
        description: 'Replace exact text once in a file under workspace path.',
        parameters: {
            path: { description: 'Path relative to workspace root.' },
            old_text: { description: 'Exact text to find.' },
            new_text: { description: 'Replacement text.' }
        }
    },
    get_current_time: {
        description: '当你需要知道当前日期、时间、星期或时区时使用。',
        parameters: {
            timezone: { description: 'IANA 时区名称，例如 Asia/Hong_Kong。留空时使用系统本地时区。' }
        }
    },
    get_live2d_model_info: {
        description: '查询当前 Live2D 模型的路径、可用动作、表情和默认回退动作。',
        parameters: {
            include_motions: { description: '是否返回完整动作列表。默认 true。' },
            include_expressions: { description: '是否返回完整表情列表。默认 true。' }
        }
    },
    todo: {
        description: '更新当前执行计划。适合多步命令任务，状态仅允许 pending、in_progress、completed。',
        parameters: {
            items: {
                description: '完整的待办列表。',
                items: {
                    properties: {
                        id: { description: '待办项标识符。' },
                        text: { description: '待办项描述。' },
                        status: { description: '待办项状态。' }
                    }
                }
            }
        }
    },
    task: {
        description: '创建子 Agent 子任务。可选择 wait=false 让任务后台执行。',
        parameters: {
            prompt: { description: '子任务目标描述。' },
            description: { description: '可选简述，用于时间线显示。' },
            wait: { description: '是否等待子任务完成后再继续。默认 true。' }
        }
    },
    load_skill: {
        description: '按名称加载技能全文。技能内容会以 <skill ...>...</skill> 返回。',
        parameters: {
            name: { description: '技能名。' }
        }
    },
    task_create: {
        description: '创建持久化任务节点。',
        parameters: {
            subject: { description: '任务主题。' },
            description: { description: '任务说明。' }
        }
    },
    task_update: {
        description: '更新任务状态/内容/依赖关系。',
        parameters: {
            task_id: { description: '任务 ID。' },
            status: { description: '任务状态。' },
            subject: { description: '任务标题（可选）。' },
            description: { description: '任务描述（可选）。' },
            owner: { description: '任务负责人（可选）。' },
            add_blocked_by: { description: '新增前置依赖任务 ID 列表。' },
            add_blocks: { description: '新增后置依赖任务 ID 列表。' }
        }
    },
    task_list: {
        description: '列出全部任务与依赖摘要。'
    },
    task_get: {
        description: '获取单个任务详情。',
        parameters: {
            task_id: { description: '任务 ID。' }
        }
    },
    compact: {
        description: '请求执行上下文压缩。manual compact 固定使用 summary 模式。',
        parameters: {
            focus: { description: '可选压缩重点。' }
        }
    }
};

function getToolDescriptionConfig(toolName) {
    return toolDescriptionConfig[String(toolName || '').trim()] || { description: '', parameters: {} };
}

module.exports = {
    toolDescriptionConfig,
    getToolDescriptionConfig
};
