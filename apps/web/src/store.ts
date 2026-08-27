import { create } from 'zustand';
import type { PermissionMode, ModelTier } from '@apolla/protocol';

interface UIState {
  workspaceId: string | null;
  setWorkspaceId: (id: string) => void;
  mode: PermissionMode;
  setMode: (m: PermissionMode) => void;
  modelTier: ModelTier;
  setModelTier: (t: ModelTier) => void;
  category: 'work' | 'code' | 'design';
  setCategory: (c: 'work' | 'code' | 'design') => void;
}

export const useUI = create<UIState>((set) => ({
  workspaceId: localStorage.getItem('apolla.ws') || null,
  setWorkspaceId: (id) => {
    localStorage.setItem('apolla.ws', id);
    set({ workspaceId: id });
  },
  mode: (localStorage.getItem('apolla.mode') as PermissionMode) || 'auto',
  setMode: (m) => {
    localStorage.setItem('apolla.mode', m);
    set({ mode: m });
  },
  modelTier: 'auto',
  setModelTier: (t) => set({ modelTier: t }),
  category: 'work',
  setCategory: (c) => set({ category: c }),
}));
