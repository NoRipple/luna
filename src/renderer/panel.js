function logError(msg) {
    console.error(msg);
    const el = document.getElementById('error-log');
    if (!el) return;
    el.style.display = 'block';
    el.innerHTML += `${msg}<br>`;
}

function summarizeText(text, maxLength = 72) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

window.addEventListener('DOMContentLoaded', () => {
    const tabChat = document.getElementById('panel-tab-chat');
    const tabLive2D = document.getElementById('panel-tab-live2d');
    const chatView = document.getElementById('panel-view-chat');
    const live2dView = document.getElementById('panel-view-live2d');
    const historyEl = document.getElementById('chat-history');
    const statusEl = document.getElementById('chat-status');
    const panelSubstatusEl = document.getElementById('chat-panel-substatus');
    const inputEl = document.getElementById('chat-input');
    const sendButton = document.getElementById('chat-send');
    const modelSelectEl = document.getElementById('live2d-model-select');
    const modelSwitchButton = document.getElementById('live2d-switch');
    const modelSwitchStatusEl = document.getElementById('live2d-switch-status');
    const motionsEl = document.getElementById('live2d-motions');
    const expressionsEl = document.getElementById('live2d-expressions');
    const realtimeCardEl = document.getElementById('perception-live-card');
    const realtimeStatusEl = document.getElementById('perception-live-status');
    const realtimeTimeEl = document.getElementById('perception-live-time');
    const realtimeSummaryEl = document.getElementById('perception-live-summary');
    const realtimeDetailEl = document.getElementById('perception-live-detail');
    const realtimeTipEl = document.getElementById('perception-live-tip');
    const todoBoardTimeEl = document.getElementById('todo-board-time');
    const todoBoardSummaryEl = document.getElementById('todo-board-summary');
    const todoBoardListEl = document.getElementById('todo-board-list');

    if (
        !tabChat || !tabLive2D || !chatView || !live2dView ||
        !historyEl || !statusEl || !panelSubstatusEl || !inputEl || !sendButton ||
        !modelSelectEl || !modelSwitchButton || !modelSwitchStatusEl || !motionsEl || !expressionsEl ||
        !realtimeCardEl || !realtimeStatusEl || !realtimeTimeEl || !realtimeSummaryEl || !realtimeDetailEl || !realtimeTipEl ||
        !todoBoardTimeEl || !todoBoardSummaryEl || !todoBoardListEl
    ) {
        return;
    }

    let latestUiState = {
        status: { text: '空闲', activeType: null, queueLength: 0 },
        realtimePerception: { status: 'idle', summary: '暂无感知结果', detail: '', updatedAt: null },
        todoBoard: { items: [], updatedAt: null, summary: 'No todos.', hasOpenItems: false },
        chatRecords: []
    };
    let live2dModels = [];
    let activeModelAbsolutePath = '';
    let isRealtimeExpanded = false;

    const formatTime = (timestamp) => {
        if (!timestamp) return '--:--';
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const setActivePanelView = (viewName) => {
        const isChatView = viewName === 'chat';
        tabChat.classList.toggle('active', isChatView);
        tabLive2D.classList.toggle('active', !isChatView);
        chatView.classList.toggle('active', isChatView);
        live2dView.classList.toggle('active', !isChatView);
        if (isChatView) inputEl.focus();
    };

    const setSwitchStatus = (text) => {
        modelSwitchStatusEl.textContent = text || '';
    };

    const renderPills = (container, values, emptyText) => {
        container.innerHTML = '';
        const list = Array.isArray(values) ? values : [];
        if (!list.length) {
            const emptyPill = document.createElement('span');
            emptyPill.className = 'live2d-pill empty';
            emptyPill.textContent = emptyText;
            container.appendChild(emptyPill);
            return;
        }
        list.forEach((item) => {
            const pill = document.createElement('span');
            pill.className = 'live2d-pill';
            pill.textContent = String(item);
            container.appendChild(pill);
        });
    };

    const renderCapabilities = (capabilities) => {
        const motions = capabilities?.motions || [];
        const semanticMap = capabilities?.expressionSemanticMap || {};
        const semanticKeys = Object.keys(semanticMap);
        const expressions = semanticKeys.length
            ? semanticKeys.map((key) => `${key} -> ${semanticMap[key]}`)
            : (capabilities?.expressions || []);
        renderPills(motionsEl, motions, '无动作');
        renderPills(expressionsEl, expressions, '无表情');
    };

    const renderModelOptions = () => {
        modelSelectEl.innerHTML = '';
        if (!live2dModels.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '未发现可用模型';
            modelSelectEl.appendChild(option);
            modelSelectEl.disabled = true;
            modelSwitchButton.disabled = true;
            return;
        }

        modelSelectEl.disabled = false;
        modelSwitchButton.disabled = false;
        const nameCount = live2dModels.reduce((acc, item) => {
            const key = String(item.displayName || '');
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});

        live2dModels.forEach((modelItem) => {
            const option = document.createElement('option');
            option.value = modelItem.id;
            const sameName = (nameCount[String(modelItem.displayName || '')] || 0) > 1;
            option.textContent = sameName
                ? `${modelItem.displayName} (${modelItem.fileName})`
                : `${modelItem.displayName}`;
            option.title = modelItem.modelJsonRelativePath || modelItem.id;
            if (modelItem.modelJsonAbsolutePath === activeModelAbsolutePath) {
                option.selected = true;
            }
            modelSelectEl.appendChild(option);
        });
    };

    const refreshLive2DManager = async () => {
        if (!window.electronAPI) return;
        try {
            const listPayload = await window.electronAPI.listLive2DModels();
            live2dModels = Array.isArray(listPayload?.models) ? listPayload.models : [];
            activeModelAbsolutePath = String(listPayload?.activeModelPath || '');
            renderModelOptions();
        } catch (error) {
            setSwitchStatus(`模型列表读取失败: ${error.message}`);
        }

        try {
            const infoPayload = await window.electronAPI.getActiveLive2DModelInfo();
            if (infoPayload?.ok && infoPayload.capabilities) {
                activeModelAbsolutePath = infoPayload.capabilities.modelJsonAbsolutePath || activeModelAbsolutePath;
                renderModelOptions();
                renderCapabilities(infoPayload.capabilities);
            } else {
                renderCapabilities({});
            }
        } catch (error) {
            setSwitchStatus(`模型信息读取失败: ${error.message}`);
        }
    };

    const switchLive2DModel = async () => {
        const modelId = modelSelectEl.value;
        if (!modelId || !window.electronAPI || !window.electronAPI.switchLive2DModel) return;

        modelSwitchButton.disabled = true;
        setSwitchStatus('正在切换模型...');
        try {
            const result = await window.electronAPI.switchLive2DModel(modelId);
            if (!result?.ok) throw new Error(result?.message || '切换失败');
            const switchedPath = result?.capabilities?.modelJsonAbsolutePath || '';
            activeModelAbsolutePath = switchedPath || activeModelAbsolutePath;
            renderModelOptions();
            renderCapabilities(result?.capabilities || {});
            setSwitchStatus('切换完成');
        } catch (error) {
            setSwitchStatus(`切换失败: ${error.message}`);
        } finally {
            modelSwitchButton.disabled = false;
        }
    };

    const getStatusKey = (state) => {
        const activeType = state?.status?.activeType;
        if (activeType) return 'running';
        if ((state?.status?.queueLength || 0) > 0) return 'queued';
        if (state?.realtimePerception?.status === 'error') return 'error';
        return 'idle';
    };

    const buildRuntimeDetail = (state) => {
        const realtime = state?.realtimePerception || {};
        const records = Array.isArray(state?.chatRecords) ? state.chatRecords : [];
        const latestChat = records[records.length - 1];
        if (realtime?.status === 'running') {
            return `感知状态：进行中。${realtime.summary || ''}`;
        }
        if (latestChat?.responseSummary) {
            return `最近回复：${summarizeText(latestChat.responseSummary, 52)}`;
        }
        return '等待指令与感知任务。';
    };

    const renderRealtimePerception = (realtime) => {
        const status = realtime?.status || 'idle';
        const statusLabelMap = {
            queued: '等待中',
            running: '感知中',
            done: '已完成',
            error: '失败',
            idle: '空闲'
        };
        realtimeStatusEl.textContent = statusLabelMap[status] || status;
        realtimeStatusEl.dataset.state = status;
        realtimeSummaryEl.textContent = realtime?.summary || '暂无感知结果';
        realtimeTimeEl.textContent = formatTime(realtime?.updatedAt);
        realtimeDetailEl.textContent = realtime?.detail || '暂无详情';
        realtimeCardEl.classList.toggle('expanded', isRealtimeExpanded);
        realtimeTipEl.textContent = isRealtimeExpanded ? '点击收起详情' : '点击展开详情';
    };

    const renderTodoBoard = (todoBoard) => {
        const items = Array.isArray(todoBoard?.items) ? todoBoard.items : [];
        todoBoardTimeEl.textContent = formatTime(todoBoard?.updatedAt);
        todoBoardSummaryEl.textContent = items.length ? 'Agent 当前维护的执行计划' : '暂无执行计划';
        todoBoardListEl.innerHTML = '';

        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'todo-item empty';
            empty.textContent = '模型尚未创建 todo list。';
            todoBoardListEl.appendChild(empty);
            return;
        }

        items.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'todo-item';
            row.dataset.state = item.status || 'pending';

            const marker = document.createElement('span');
            marker.className = 'todo-item-marker';
            marker.textContent = item.status === 'completed' ? '[x]' : (item.status === 'in_progress' ? '[>]' : '[ ]');

            const text = document.createElement('span');
            text.className = 'todo-item-text';
            text.textContent = `#${item.id} ${item.text}`;

            row.appendChild(marker);
            row.appendChild(text);
            todoBoardListEl.appendChild(row);
        });
    };

    const renderChatRecords = (records) => {
        const list = Array.isArray(records) ? records.slice().reverse() : [];
        historyEl.innerHTML = '';
        if (!list.length) {
            const empty = document.createElement('div');
            empty.className = 'chat-item';
            empty.textContent = '暂无聊天记录';
            historyEl.appendChild(empty);
            return;
        }

        list.forEach((item) => {
            const card = document.createElement('article');
            card.className = `chat-item ${item.source === 'perception' ? 'perception' : 'command'} ${item.status === 'error' ? 'error' : ''}`;
            card.dataset.state = item.status || 'done';

            const header = document.createElement('div');
            header.className = 'chat-item-header';
            const headerTitle = document.createElement('div');
            headerTitle.className = 'chat-item-title';
            const marker = document.createElement('span');
            marker.className = 'chat-item-marker';
            marker.textContent = item.source === 'perception' ? 'Perception Reply' : 'Command Chat';
            const label = document.createElement('span');
            label.className = 'chat-item-label';
            label.textContent = item.source === 'perception' ? '后台感知回复' : '用户命令回复';
            headerTitle.appendChild(marker);
            headerTitle.appendChild(label);

            const time = document.createElement('span');
            time.className = 'chat-item-time';
            time.textContent = formatTime(item.updatedAt);
            header.appendChild(headerTitle);
            header.appendChild(time);

            const statusLine = document.createElement('div');
            statusLine.className = 'chat-item-status';
            const statusLabelMap = {
                queued: '等待中',
                running: '执行中',
                done: '已完成',
                error: '失败'
            };
            statusLine.textContent = statusLabelMap[item.status] || '已完成';

            const body = document.createElement('div');
            body.className = 'chat-item-body';
            const inputText = item.inputSummary || summarizeText(item.inputText || '', 72);
            const aiText = item.responseText || item.responseSummary || '（无回复）';
            body.textContent = [
                `输入：${inputText || '（空）'}`,
                `AI：${aiText}`
            ].join('\n');

            card.appendChild(header);
            card.appendChild(statusLine);
            card.appendChild(body);
            historyEl.appendChild(card);
        });
    };

    const renderPanelState = (state) => {
        latestUiState = state || latestUiState;
        const statusText = latestUiState?.status?.text || '空闲';
        const statusKey = getStatusKey(latestUiState);
        const detailText = buildRuntimeDetail(latestUiState);

        statusEl.textContent = statusText;
        statusEl.dataset.state = statusKey;
        panelSubstatusEl.textContent = detailText;
        renderRealtimePerception(latestUiState?.realtimePerception || {});
        renderTodoBoard(latestUiState?.todoBoard || {});
        renderChatRecords(latestUiState?.chatRecords || []);
    };

    const sendCommand = async () => {
        const text = inputEl.value.trim();
        if (!text || !window.electronAPI || !window.electronAPI.sendUICommand) return;
        sendButton.disabled = true;
        try {
            const result = await window.electronAPI.sendUICommand(text);
            if (!result || !result.ok) {
                logError((result && result.message) || '命令发送失败');
                return;
            }
            inputEl.value = '';
        } catch (error) {
            logError(`命令发送失败: ${error.message}`);
        } finally {
            sendButton.disabled = false;
        }
    };

    realtimeCardEl.addEventListener('click', () => {
        isRealtimeExpanded = !isRealtimeExpanded;
        renderRealtimePerception(latestUiState?.realtimePerception || {});
    });

    tabChat.addEventListener('click', () => setActivePanelView('chat'));
    tabLive2D.addEventListener('click', () => setActivePanelView('live2d'));
    sendButton.addEventListener('click', () => sendCommand().catch(() => {}));
    modelSwitchButton.addEventListener('click', () => switchLive2DModel().catch(() => {}));
    modelSelectEl.addEventListener('change', () => {
        setSwitchStatus('点击“切换形象”以应用新模型');
    });

    inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendCommand().catch(() => {});
        }
    });

    if (window.electronAPI && window.electronAPI.onUIHistoryUpdated) {
        window.electronAPI.onUIHistoryUpdated((state) => {
            renderPanelState(state);
        });
    }

    if (window.electronAPI && window.electronAPI.onLive2DModelSwitched) {
        window.electronAPI.onLive2DModelSwitched((payload) => {
            activeModelAbsolutePath = payload?.modelJsonAbsolutePath || activeModelAbsolutePath;
            renderModelOptions();
            renderCapabilities(payload || {});
            setSwitchStatus('模型已切换');
        });
    }

    if (window.electronAPI && window.electronAPI.getUIHistorySnapshot) {
        window.electronAPI.getUIHistorySnapshot()
            .then((state) => renderPanelState(state))
            .catch((error) => logError(`状态加载失败: ${error.message}`));
    }

    setActivePanelView('chat');
    renderPanelState(latestUiState);
    refreshLive2DManager().catch(() => {});
});
