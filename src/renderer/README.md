<!-- 主要职责：说明渲染层目录的用途与结构，帮助维护者快速理解前端入口文件。 -->
# Renderer Development Guide

## Current Structure

- `src/renderer/index.html`: Renderer shell (loads CSS, third-party scripts, and `app.js`).
- `src/renderer/styles.css`: Renderer styles.
- `src/renderer/app.js`: Live2D render logic, window drag behavior, IPC event handling, and TTS audio streaming playback.

## How It Connects to Electron

- Main process entry: `src/core/main.js`
- Preload bridge: `src/core/preload.js` (exposes `window.electronAPI`)
- Renderer listens to:
  - `onCommand` (`live2d-command`)
  - `onCompanionMessage` (`companion-message`)
  - `onTTSChunk` (`tts-chunk`)
  - `onTTSEnd` (`tts-ended`)

## Start App

```bash
npm install
npm start
```

## Suggested Frontend Iteration Order

1. Split `app.js` into feature modules (model, window-control, tts-player, ipc-handlers).
2. Add a small in-renderer debug panel (toggle by query param or key shortcut).
3. Move hardcoded model path into a single config object.
4. Add defensive checks for asset-loading failures and fallback UI.

## Notes

- Model file is currently hardcoded in `app.js`:
  - `../../assets/Jellyfish/星月水母 试用版.model3.json`
- `styles.css` currently keeps a visible debug border and oversized body (`1000vh/1000vw`) inherited from existing behavior.

