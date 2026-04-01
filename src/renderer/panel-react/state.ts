import type {
  ChatViewMode,
  ExtensionsSnapshot,
  MemoryGraphSnapshot,
  RouteKey,
  TaskGraphSnapshot,
  UiPanelState
} from './types';

export interface PanelUiState {
  route: RouteKey;
  chatViewMode: ChatViewMode;
  uiState: UiPanelState;
  extensions: ExtensionsSnapshot;
  taskGraph: TaskGraphSnapshot | null;
  memoryGraph: MemoryGraphSnapshot | null;
  errorText: string;
}

export type PanelAction =
  | { type: 'set_route'; route: RouteKey }
  | { type: 'toggle_view' }
  | { type: 'set_ui_state'; payload: UiPanelState }
  | { type: 'set_extensions'; payload: ExtensionsSnapshot }
  | { type: 'set_task_graph'; payload: TaskGraphSnapshot | null }
  | { type: 'set_memory_graph'; payload: MemoryGraphSnapshot | null }
  | { type: 'set_error'; message: string }
  | { type: 'clear_error' };

export const initialUiState: UiPanelState = {
  status: { text: '空闲', activeType: null, queueLength: 0 },
  realtimePerception: { status: 'idle', summary: '暂无感知结果', detail: '', updatedAt: null },
  recentPerceptions: [],
  panelNote: '',
  autonomousWakeAt: null,
  subagent: { limit: 0, running: 0, queued: 0, channelCount: 0 },
  timelineChannels: [{ id: 'main', name: '主线程', type: 'main' }],
  chatRecords: [],
  rawMessages: [],
  timeline: []
};

export const initialExtensions: ExtensionsSnapshot = {
  skills: [],
  tools: [],
  mcp: { status: 'placeholder' }
};

export function panelReducer(state: PanelUiState, action: PanelAction): PanelUiState {
  switch (action.type) {
    case 'set_route':
      return { ...state, route: action.route };
    case 'toggle_view':
      return { ...state, chatViewMode: state.chatViewMode === 'raw' ? 'user' : 'raw' };
    case 'set_ui_state':
      return { ...state, uiState: action.payload };
    case 'set_extensions':
      return { ...state, extensions: action.payload };
    case 'set_task_graph':
      return { ...state, taskGraph: action.payload };
    case 'set_memory_graph':
      return { ...state, memoryGraph: action.payload };
    case 'set_error':
      return { ...state, errorText: action.message };
    case 'clear_error':
      return { ...state, errorText: '' };
    default:
      return state;
  }
}
