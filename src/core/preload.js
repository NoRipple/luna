/* 主要职责：通过 preload 向渲染进程暴露受控 API，隔离 Electron 主进程能力。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    onCommand: (callback) => ipcRenderer.on('live2d-command', (_event, value) => callback(value)),
    getLive2DConfig: () => ipcRenderer.invoke('get-live2d-config'),
    startDrag: (pos) => ipcRenderer.send('window-drag-start', pos),
    drag: (pos) => ipcRenderer.send('window-drag', pos),
    resize: (factor) => ipcRenderer.send('window-resize', factor),
    setIgnoreMouseEvents: (ignore, options) => ipcRenderer.send('set-ignore-mouse-events', ignore, options),
    openChatPanel: () => ipcRenderer.send('open-chat-panel'),
    toggleChatPanel: () => ipcRenderer.send('toggle-chat-panel'),
    
    // LLM APIs
    chatWithText: (prompt) => ipcRenderer.invoke('llm-text', prompt),
    chatWithImage: (imageUrl, prompt) => ipcRenderer.invoke('llm-image', imageUrl, prompt),
    speak: (text) => ipcRenderer.invoke('tts-speak', text),
    onLLMChunk: (callback) => ipcRenderer.on('llm-chunk', (_event, chunk) => callback(chunk)),
    onCompanionMessage: (callback) => ipcRenderer.on('companion-message', (_event, msg) => callback(msg)),
    onGlobalMouseMove: (callback) => ipcRenderer.on('global-mouse-position', (_event, payload) => callback(payload)),
    onPanelVisibilityChanged: (callback) => ipcRenderer.on('panel-visibility-changed', (_event, payload) => callback(payload)),
    onLive2DModelSwitched: (callback) => ipcRenderer.on('live2d-model-switched', (_event, payload) => callback(payload)),
    getDebugFlags: () => ipcRenderer.invoke('debug-flags'),
    sendUIPerfLog: (payload) => ipcRenderer.send('ui-perf-log', payload),
    getUIHistorySnapshot: () => ipcRenderer.invoke('ui-history-snapshot'),
    sendUICommand: (text) => ipcRenderer.invoke('ui-send-command', text),
    voiceAsrStart: (options) => ipcRenderer.invoke('voice-asr-start', options),
    voiceAsrSendAudioFrame: (frame) => ipcRenderer.send('voice-asr-audio-frame', { frame }),
    voiceAsrStop: () => ipcRenderer.invoke('voice-asr-stop'),
    voiceAsrAbort: () => ipcRenderer.invoke('voice-asr-abort'),
    onVoiceAsrEvent: (callback) => ipcRenderer.on('voice-asr-event', (_event, payload) => callback(payload)),
    getPanelExtensionsSnapshot: () => ipcRenderer.invoke('panel-get-extensions-snapshot'),
    setPanelSkillEnabled: (name, enabled) => ipcRenderer.invoke('panel-set-skill-enabled', { name, enabled }),
    getPanelTaskGraph: () => ipcRenderer.invoke('panel-get-task-graph'),
    getPanelMemoryGraph: (payload) => ipcRenderer.invoke('panel-get-memory-graph', payload),
    getPanelMemoryRecallPreview: (payload) => ipcRenderer.invoke('panel-get-memory-recall-preview', payload),
    getPanelMemoryNodeDetail: (payload) => ipcRenderer.invoke('panel-get-memory-node-detail', payload),
    listLive2DModels: () => ipcRenderer.invoke('live2d-list-models'),
    getActiveLive2DModelInfo: () => ipcRenderer.invoke('live2d-get-active-model-info'),
    switchLive2DModel: (targetModel) => ipcRenderer.invoke('live2d-switch-model', targetModel),
    onTTSChunk: (callback) => ipcRenderer.on('tts-chunk', (_event, chunk) => callback(chunk)),
    onTTSEnd: (callback) => ipcRenderer.on('tts-ended', (_event, value) => callback(value)),
    notifyTTSPlaybackEnded: (jobId) => ipcRenderer.send('tts-playback-ended', { jobId })
});

