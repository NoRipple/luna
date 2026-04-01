import type {
  CommandResult,
  DebugFlags,
  ExtensionsSnapshot,
  TaskGraphSnapshot,
  UiPanelState,
  VoiceAsrEvent
} from './types';

declare global {
  interface Window {
    electronAPI?: {
      getDebugFlags?: () => Promise<DebugFlags>;
      sendUIPerfLog?: (payload: unknown) => void;
      getUIHistorySnapshot?: () => Promise<UiPanelState>;
      sendUICommand?: (text: string) => Promise<CommandResult>;
      voiceAsrStart?: (options: { format: string; sampleRate: number }) => Promise<CommandResult>;
      voiceAsrSendAudioFrame?: (frame: Uint8Array) => void;
      voiceAsrStop?: () => Promise<CommandResult>;
      voiceAsrAbort?: () => Promise<CommandResult>;
      onVoiceAsrEvent?: (cb: (payload: VoiceAsrEvent) => void) => void;
      getPanelExtensionsSnapshot?: () => Promise<
        { ok?: boolean; message?: string } & Partial<ExtensionsSnapshot>
      >;
      setPanelSkillEnabled?: (name: string, enabled: boolean) => Promise<CommandResult>;
      getPanelTaskGraph?: () => Promise<
        { ok?: boolean; message?: string; generatedAt?: number; hasCycle?: boolean; tasks?: unknown[] }
      >;
      getPanelMemoryGraph?: (payload?: {
        query?: string;
        layers?: string[];
        days?: number | null;
        maxNodes?: number;
      }) => Promise<{
        ok?: boolean;
        message?: string;
        mode?: string;
        query?: string;
        nodes?: unknown[];
        edges?: unknown[];
        communities?: unknown[];
        episodicTraces?: unknown[];
        stats?: unknown;
        generatedAt?: number;
      }>;
      getPanelMemoryRecallPreview?: (payload?: {
        query?: string;
        maxNodes?: number;
        depth?: number;
      }) => Promise<{
        ok?: boolean;
        message?: string;
        query?: string;
        nodes?: unknown[];
        edges?: unknown[];
        communities?: unknown[];
        episodicTraces?: unknown[];
        stats?: unknown;
        generatedAt?: number;
      }>;
      getPanelMemoryNodeDetail?: (payload?: { nodeId?: string }) => Promise<{
        ok?: boolean;
        message?: string;
        node?: unknown;
        edges?: unknown[];
        traces?: unknown[];
        generatedAt?: number;
      }>;
    };
  }
}

export {};
