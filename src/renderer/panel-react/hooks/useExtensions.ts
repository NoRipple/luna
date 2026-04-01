import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import type { PanelAction } from '../state';
import type { ExtensionsSnapshot } from '../types';

export function useExtensions(dispatch: Dispatch<PanelAction>) {
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);

  const refreshExtensions = useCallback(async () => {
    if (!window.electronAPI?.getPanelExtensionsSnapshot || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const result = await window.electronAPI.getPanelExtensionsSnapshot();
      if (!result?.ok) {
        dispatch({ type: 'set_error', message: result?.message || '扩展能力数据加载失败' });
        return;
      }
      const snapshot: ExtensionsSnapshot = {
        skills: Array.isArray(result.skills) ? result.skills : [],
        tools: Array.isArray(result.tools) ? result.tools : [],
        mcp: result.mcp && typeof result.mcp === 'object' ? result.mcp : { status: 'placeholder' }
      };
      dispatch({ type: 'set_extensions', payload: snapshot });
    } catch (error) {
      dispatch({ type: 'set_error', message: `扩展能力数据加载失败: ${String((error as Error)?.message || error)}` });
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [dispatch]);

  const toggleSkill = useCallback(async (name: string, enabled: boolean) => {
    if (!window.electronAPI?.setPanelSkillEnabled) return;
    try {
      const result = await window.electronAPI.setPanelSkillEnabled(name, enabled);
      if (!result?.ok) {
        dispatch({ type: 'set_error', message: result?.message || `Skill 开关更新失败: ${name}` });
      }
    } catch (error) {
      dispatch({ type: 'set_error', message: `Skill 开关更新失败: ${String((error as Error)?.message || error)}` });
    } finally {
      await refreshExtensions();
    }
  }, [dispatch, refreshExtensions]);

  useEffect(() => {
    refreshExtensions().catch(() => {});
  }, [refreshExtensions]);

  return {
    loading,
    refreshExtensions,
    toggleSkill
  };
}
