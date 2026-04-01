import { useEffect, useRef } from 'react';
import type { Dispatch } from 'react';
import type { PanelAction } from '../state';
import type { UiPanelState } from '../types';

const SNAPSHOT_POLL_MS = 1000;

export function useUiSnapshot(dispatch: Dispatch<PanelAction>) {
  const lastVersionRef = useRef<number>(0);

  useEffect(() => {
    let pollingInFlight = false;
    let disposed = false;

    const applySnapshot = (state: UiPanelState | null | undefined) => {
      const nextState = state || ({} as UiPanelState);
      const version = Number(nextState?.meta?.version || 0);
      if (version > 0 && version === lastVersionRef.current) return;
      if (version > 0) lastVersionRef.current = version;
      dispatch({ type: 'set_ui_state', payload: nextState });
    };

    const pollSnapshot = async () => {
      if (disposed || pollingInFlight || !window.electronAPI?.getUIHistorySnapshot) return;
      pollingInFlight = true;
      try {
        const snapshot = await window.electronAPI.getUIHistorySnapshot();
        if (!disposed) {
          applySnapshot(snapshot);
        }
      } catch (error) {
        if (!disposed) {
          dispatch({ type: 'set_error', message: `状态轮询失败: ${String((error as Error)?.message || error)}` });
        }
      } finally {
        pollingInFlight = false;
      }
    };

    pollSnapshot().catch(() => {});
    const timer = window.setInterval(() => {
      pollSnapshot().catch(() => {});
    }, SNAPSHOT_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [dispatch]);
}
