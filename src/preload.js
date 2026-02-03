const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    onCommand: (callback) => ipcRenderer.on('live2d-command', (_event, value) => callback(value)),
    startDrag: (pos) => ipcRenderer.send('window-drag-start', pos),
    drag: (pos) => ipcRenderer.send('window-drag', pos),
    stopDrag: () => ipcRenderer.send('window-drag-stop'),
    resize: (factor) => ipcRenderer.send('window-resize', factor),
    setIgnoreMouseEvents: (ignore, options) => ipcRenderer.send('set-ignore-mouse-events', ignore, options),
    
    // LLM APIs
    chatWithText: (prompt) => ipcRenderer.invoke('llm-text', prompt),
    chatWithImage: (imageUrl, prompt) => ipcRenderer.invoke('llm-image', imageUrl, prompt),
    speak: (text) => ipcRenderer.invoke('tts-speak', text),
    onLLMChunk: (callback) => ipcRenderer.on('llm-chunk', (_event, chunk) => callback(chunk)),
    onCompanionMessage: (callback) => ipcRenderer.on('companion-message', (_event, msg) => callback(msg)),
    onTTSChunk: (callback) => ipcRenderer.on('tts-chunk', (_event, chunk) => callback(chunk))
});
