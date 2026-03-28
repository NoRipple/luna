/* 主要职责：集中注册主进程与渲染进程之间的 IPC 协议，收口窗口控制、聊天和模型切换入口。 */
const config = require('../config/runtimeConfig');

function registerIpcHandlers(deps) {
    const {
        ipcMain,
        BrowserWindow,
        createPanelWindow,
        getOverlayWindow,
        getPanelWindow,
        onTtsPlaybackEnded,
        buildUiPanelState,
        enqueueOrMergeCommandTask,
        live2dModelService,
        live2dModelCatalogService,
        buildSerializedLive2DCapabilities,
        getLive2DConfigFallback,
        llmService,
        enqueueTtsJob
    } = deps;

    let dragStartPos = { x: 0, y: 0 };
    let winStartPos = { x: 0, y: 0 };
    let dragStartSize = { width: 0, height: 0 };

    ipcMain.on('window-drag-start', (_event, pos) => {
        const overlayWindow = getOverlayWindow();
        if (!overlayWindow) return;
        const bounds = overlayWindow.getBounds();
        winStartPos = { x: bounds.x, y: bounds.y };
        dragStartSize = { width: bounds.width, height: bounds.height };
        dragStartPos = pos; // screen coordinates from renderer
    });

    ipcMain.on('window-drag', (_event, pos) => {
        const overlayWindow = getOverlayWindow();
        if (!overlayWindow) return;
        const deltaX = pos.x - dragStartPos.x;
        const deltaY = pos.y - dragStartPos.y;

        // Force fixed size while dragging to prevent DPI/OS side effects from drifting bounds.
        overlayWindow.setBounds(
            {
                x: Math.round(winStartPos.x + deltaX),
                y: Math.round(winStartPos.y + deltaY),
                width: dragStartSize.width,
                height: dragStartSize.height
            },
            false
        );
    });

    ipcMain.on('window-resize', (_event, factor) => {
        const overlayWindow = getOverlayWindow();
        if (!overlayWindow) return;
        const bounds = overlayWindow.getBounds();
        const newWidth = Math.round(bounds.width * factor);
        const newHeight = Math.round(bounds.height * factor);

        // 最小尺寸限制
        if (newWidth < 100 || newHeight < 100) return;

        overlayWindow.setSize(newWidth, newHeight);
    });

    ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        win.setIgnoreMouseEvents(ignore, options);
    });

    ipcMain.on('open-chat-panel', () => {
        createPanelWindow();
    });

    ipcMain.on('toggle-chat-panel', () => {
        const panelWindow = getPanelWindow();
        if (!panelWindow || panelWindow.isDestroyed()) {
            createPanelWindow();
            return;
        }
        if (panelWindow.isVisible()) {
            panelWindow.hide();
            return;
        }
        panelWindow.show();
        panelWindow.focus();
    });

    ipcMain.on('tts-playback-ended', (_event, payload) => {
        onTtsPlaybackEnded(payload?.jobId);
    });

    ipcMain.handle('ui-history-snapshot', async () => {
        return buildUiPanelState();
    });

    ipcMain.handle('debug-flags', async () => {
        return {
            uiPerf: Boolean(config.debug?.uiPerf),
            uiPerfSlowMs: Number(config.debug?.uiPerfSlowMs) || 32
        };
    });

    ipcMain.on('ui-perf-log', (_event, payload) => {
        if (!config.debug?.uiPerf) return;
        try {
            const type = String(payload?.type || 'event');
            const json = JSON.stringify(payload || {});
            console.log(`[UI PERF][renderer] type=${type} payload=${json}`);
        } catch (error) {
            console.log('[UI PERF][renderer] failed_to_serialize_payload');
        }
    });

    ipcMain.handle('ui-send-command', async (_event, text) => {
        return enqueueOrMergeCommandTask(text);
    });

    ipcMain.handle('get-live2d-config', async () => {
        try {
            const capabilities = live2dModelService.getCapabilities();
            return buildSerializedLive2DCapabilities(capabilities);
        } catch (error) {
            return getLive2DConfigFallback();
        }
    });

    ipcMain.handle('live2d-list-models', async () => {
        try {
            const capabilities = live2dModelService.getCapabilities();
            return {
                ok: true,
                activeModelPath: capabilities.modelJsonAbsolutePath,
                models: live2dModelCatalogService.listAvailableModels()
            };
        } catch (error) {
            return {
                ok: false,
                message: error?.message || String(error),
                activeModelPath: '',
                models: live2dModelCatalogService.listAvailableModels()
            };
        }
    });

    ipcMain.handle('live2d-get-active-model-info', async () => {
        try {
            const capabilities = live2dModelService.getCapabilities();
            return {
                ok: true,
                model: live2dModelCatalogService.buildDescriptor(capabilities.modelJsonAbsolutePath),
                capabilities: buildSerializedLive2DCapabilities(capabilities)
            };
        } catch (error) {
            return {
                ok: false,
                message: error?.message || String(error),
                model: null,
                capabilities: getLive2DConfigFallback()
            };
        }
    });

    ipcMain.handle('live2d-switch-model', async (_event, targetModel) => {
        try {
            const resolvedModel = live2dModelCatalogService.resolveModel(targetModel);
            live2dModelService.setRuntimeModelJsonPath(resolvedModel.modelJsonAbsolutePath);
            llmService.refreshCompanionPromptContext();
            const capabilities = live2dModelService.getCapabilities();
            const payload = buildSerializedLive2DCapabilities(capabilities);

            const overlayWindow = getOverlayWindow();
            if (overlayWindow && !overlayWindow.isDestroyed()) {
                overlayWindow.webContents.send('live2d-model-switched', payload);
            }

            const panelWindow = getPanelWindow();
            if (panelWindow && !panelWindow.isDestroyed()) {
                panelWindow.webContents.send('live2d-model-switched', payload);
            }

            return {
                ok: true,
                model: resolvedModel,
                capabilities: payload
            };
        } catch (error) {
            return {
                ok: false,
                message: error?.message || String(error)
            };
        }
    });

    // LLM IPC Handlers (Direct interactions)
    ipcMain.handle('llm-text', async (_event, prompt) => {
        return await llmService.chatWithText(prompt, (chunk) => {
            const panelWindow = getPanelWindow();
            if (panelWindow && !panelWindow.isDestroyed()) {
                panelWindow.webContents.send('llm-chunk', chunk);
                return;
            }
            const overlayWindow = getOverlayWindow();
            if (overlayWindow && !overlayWindow.isDestroyed()) {
                overlayWindow.webContents.send('llm-chunk', chunk);
            }
        });
    });

    ipcMain.handle('llm-image', async (_event, imageUrl, prompt) => {
        return await llmService.chatWithImage(imageUrl, prompt, (chunk) => {
            const panelWindow = getPanelWindow();
            if (panelWindow && !panelWindow.isDestroyed()) {
                panelWindow.webContents.send('llm-chunk', chunk);
                return;
            }
            const overlayWindow = getOverlayWindow();
            if (overlayWindow && !overlayWindow.isDestroyed()) {
                overlayWindow.webContents.send('llm-chunk', chunk);
            }
        });
    });

    ipcMain.handle('tts-speak', async (_event, text) => {
        // Manual speak: also enqueue to avoid interruption.
        await enqueueTtsJob({ text });
        return { status: 'ok' };
    });
}

module.exports = {
    registerIpcHandlers
};

