# Live2D Desktop Pet (Murasame)

这是一个基于 Electron 和 PixiJS 的 Live2D 桌面宠物应用。它可以在你的桌面上展示一个可爱的 Live2D 模型（丛雨），并支持鼠标交互、拖拽移动、缩放以及通过 HTTP 接口进行控制。

## 目录结构

```
Live2d/
├── assets/              # 资源文件
│   └── Murasame/        # Live2D 模型文件 (原"丛雨 Live2d")
├── src/                 # 源代码
│   ├── main.js          # Electron 主进程
│   ├── preload.js       # 预加载脚本 (API 暴露)
│   └── index.html       # 渲染进程 (UI 和模型逻辑)
├── package.json         # 项目配置
└── README.md            # 说明文档
```

## 功能特性

- **透明背景**: 模型直接显示在桌面上，无矩形边框。
- **鼠标穿透**: 
  - 鼠标在模型背景区域时，可穿透操作后方窗口。
  - 鼠标移入模型时，自动捕获鼠标进行交互。
- **交互控制**:
  - **拖拽**: 按住鼠标左键拖拽模型。
  - **缩放**: 使用鼠标滚轮调整模型大小。
  - **点击**: 点击模型触发动作（如 Tap）。
- **外部控制**: 内置 HTTP 服务器 (默认端口 3001)，可通过 API 控制模型动作。

## 安装与运行

1. **安装依赖**
   ```bash
   npm install
   ```

2. **启动应用**
   ```bash
   npm start
   # 或者
   npx electron .
   ```

## HTTP API 控制

应用启动后会监听 3001 端口。

### 触发动作
- **URL**: `http://localhost:3001/action?name={动作组名}`
- **示例**:
  - `http://localhost:3001/action?name=Tap` (点击动作)
  - `http://localhost:3001/action?name=Idle` (待机动作)

### 设置表情
- **URL**: `http://localhost:3001/expression?name={表情名}`
- **示例**:
  - `http://localhost:3001/expression?name=exp1`

### 设置参数
- **URL**: `http://localhost:3001/parameter?id={参数ID}&value={数值}`
- **示例**:
  - `http://localhost:3001/parameter?id=ParamCheek&value=1` (红晕)

### LLM 对话 (新)

- **文本对话**:
  - **URL**: `http://localhost:3001/chat?prompt={你的问题}`
  - **示例**: `http://localhost:3001/chat?prompt=你是谁`
  - **返回**: JSON 格式的回复内容

## 开发说明

- **主进程 (`src/main.js`)**: 负责窗口创建、透明设置、IPC 事件处理（拖拽/缩放/穿透）以及 HTTP 服务器。
- **预加载 (`src/preload.js`)**: 使用 `contextBridge` 安全地暴露 Electron API 给渲染进程。
- **渲染进程 (`src/index.html`)**: 使用 `pixi-live2d-display` 加载模型，处理鼠标事件并调用 Electron API。

## 依赖库

- [electron](https://www.electronjs.org/)
- [pixi.js](https://pixijs.com/) (v6.x)
- [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) (Cubism 4 支持)
