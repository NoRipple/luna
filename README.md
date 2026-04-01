# Luna - Desktop AI Companion

Luna 是一个基于 Electron + Live2D 的智能桌面伴侣。她不仅是一个可爱的桌面摆件，更是一位能够"看见"你屏幕、"理解"你行为并与你进行语音交流的知性温柔少女。

## ✨ 核心特性

*   **知性温柔的陪伴**: 设定为知性温柔的少女，使用"你"来称呼用户，能够进行自然流畅的中文对话。
*   **全透明交互窗口**:
    *   模型背景全透明，无缝融入桌面。
    *   支持鼠标拖拽移动位置，滚轮缩放大小。
    *   智能鼠标穿透：仅在模型区域响应点击，不影响后方窗口操作。
*   **智能感知 (Perception)**:
    *   每 **1分钟** 自动捕获屏幕内容。
    *   分析用户当前的屏幕活动（工作、游戏、浏览等）。
*   **多模态思考 (Thinking)**:
    *   集成 **DashScope (通义千问)** 大模型，具备多模态（文本+视觉）理解能力。
    *   根据屏幕内容主动发起对话，或响应用户的交流。
*   **生动表达 (Output)**:
    *   **流式语音**: 集成 **MiniMax TTS**，提供自然逼真的语音回复。
    *   **本地 TTS 兼容层**: 内置与 `MiniMax /v1/t2a_v2` 兼容的本地接口，可无缝切换到 Genie-TTS（日语预设模型）。
    *   **Live2D 动作**: 根据对话内容自动触发相应的动作和表情。
    *   **气泡交互**: 头部显示文字气泡，辅助展示对话内容。

## 🏗️ 项目架构

项目采用模块化架构设计，模拟人类的认知流程：

```
src/
├── core/               # 核心系统
│   ├── main.js         # 主进程 (窗口管理、IPC枢纽、流程编排)
│   └── preload.js      # 预加载脚本 (安全接口暴露)
├── modules/            # 认知模块
│   ├── perception/     # 感知模块 (屏幕捕获)
│   │   └── ScreenSensor.js
│   ├── recognition/    # 识别模块 (视觉分析)
│   │   └── VisionService.js
│   ├── thinking/       # 思考模块 (LLM交互)
│   │   └── LLMService.js
│   ├── memory/         # 记忆模块 (状态存储)
│   │   └── MemoryService.js
│   └── output/         # 表达模块 (TTS语音)
│       └── TTSService.js
└── renderer/           # 渲染层 (Live2D展示)
    └── index.html
```

## 🧠 System Prompt 组装 Pipeline

当前陪伴主流程（`chatWithCompanion`）使用的 `system` 消息由以下流水线组装：

1. 基础素材读取（`CompanionPromptBuilder`）
   - 目录：`workspace/CompanionAgent/`
   - 文件：`AGENTS.md`、`IDENTITY.md`、`USER.md`
   - 代码：`src/modules/thinking/CompanionPromptBuilder.js`

2. 生成基础 System Prompt
   - 将上述三份素材按固定结构拼接
   - 追加“全局一致性要求”与 JSON 输出示例

3. 动态注入 Live2D 约束
   - 来源：`live2dModelService.buildCompanionMotionPromptSuffix()`
   - 若基础提示词包含 `{{LIVE2D_CONSTRAINTS}}` 占位符则替换
   - 若无占位符则把约束文本追加到末尾

4. 注入工具与技能描述（占位符优先）
   - 在 `AGENTS.md` 中使用占位符：
     - `{{toolDescription}}`
     - `{{skillDescription}}`
   - 运行时动态替换为：
     - 工具摘要（来自 `CompanionToolRegistry.getToolsSnapshot()`）
     - 技能摘要（来自 `CompanionToolRegistry.getSkillDescriptions()`）
   - 若占位符缺失，则自动追加 fallback 段落，避免提示词丢信息。

5. 缓存与会话写入
   - `LLMService` 会缓存最终 system 文本（`cachedCompanionSystemPrompt`）
   - `companionSessionMessages` 为空时，将其作为第一条 `system` 消息写入

6. 刷新机制（失效重建）
   - `refreshCompanionPromptContext()` 会清缓存并重建 system
   - 触发场景：
     - Live2D 模型切换（IPC：`live2d-switch-model`）
     - Skill 开关变更成功（`setSkillEnabled`）

关键代码位置：
- `src/modules/thinking/LLMService.js`
- `src/modules/thinking/CompanionPromptBuilder.js`
- `src/modules/tools/CompanionToolRegistry.js`
- `src/core/ipcHandlers.js`

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 API Key

目前 API Key 配置在以下文件中，请根据需要替换为你自己的 Key：

*   **LLM (DashScope)**: `src/modules/thinking/LLMService.js`
*   **TTS (MiniMax)**: `src/modules/output/TTSService.js`

### 3. 启动应用

```bash
npm start
```

### 4. 使用本地 Genie-TTS（无需改主程序代码）

项目已支持在内置 API Server 上挂载 `MiniMax` 兼容接口：

* `POST http://127.0.0.1:3101/v1/t2a_v2`（或你的 `CONTROL_API_PORT` 对应端口）
* 返回格式：`SSE data: {"data":{"audio":"<hex mp3>"}}`

只需确保以下条件满足：

1. 已存在 `GenieTTS` conda 环境，且可执行 `genie_tts`（本仓库默认使用 `D:\WorkSpace\Live2d\Genie-TTS`）。
2. `.env` 中启用本地代理：
   `TTS_LOCAL_PROXY_ENABLED=true`
3. `.env` 中将 `TTS_BASE_URL` 指向本地：
   `TTS_BASE_URL=http://127.0.0.1:3101/v1/t2a_v2`

满足后主程序 TTS 调用链无需改动，仍然通过原 `TTSService` 工作。

### 5. 命令行流式 TTS 测试脚本

可直接在仓库内运行：

```bash
npm run tts:test
```

进入交互后输入文本回车即可播放（`/exit` 退出）。

单次模式：

```bash
npm run tts:test -- --text "こんにちは、テストです。"
```

## 🛠️ 技术栈

*   **Runtime**: [Electron](https://www.electronjs.org/)
*   **Rendering**: [PixiJS v5](https://pixijs.com/) + [Cubism 4 SDK](https://live2d.github.io/)
*   **AI/LLM**: DashScope (OpenAI Compatible Interface)
*   **TTS**: MiniMax API
*   **Tools**: ffmpeg-static (屏幕捕获)

## 📝 开发说明

*   **模型资源**: Live2D 模型文件位于 `assets/Murasame` 目录。
*   **调试**: 可以在 `src/core/main.js` 中取消注释 `mainWindow.webContents.openDevTools()` 以开启开发者工具。
*   **语音去重**: 系统内置了 TTS 中断机制，新的对话会自动打断旧的语音播放，防止声音重叠。

## 🤝 贡献

欢迎提交 Issue 和 Pull Request 来改进 Luna！
