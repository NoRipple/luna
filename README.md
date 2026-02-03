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
