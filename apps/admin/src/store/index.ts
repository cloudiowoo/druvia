import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Simplified types for admin context (subset of full types)
export interface TenantContext {
  tenantId: string;
  alias: string;
  name: string;
  plan: 'free' | 'pro' | 'enterprise';
  status: 'active' | 'suspended' | 'deleted';
}

export interface ProjectContext {
  projectId: string;
  tenantId: string;
  alias: string;
  name: string;
  schemaName: string | null;
  status: 'active' | 'suspended' | 'deleted';
}

export interface UserContext {
  userId: string;
  email: string | null;
  username: string | null;
  avatarUrl: string | null;
}

interface AppState {
  // Current context
  currentTenant: TenantContext | null;
  currentProject: ProjectContext | null;
  currentUser: UserContext | null;

  // Actions
  setCurrentTenant: (tenant: TenantContext | null) => void;
  setCurrentProject: (project: ProjectContext | null) => void;
  setCurrentUser: (user: UserContext | null) => void;
  clearContext: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      currentTenant: null,
      currentProject: null,
      currentUser: null,

      setCurrentTenant: (tenant) =>
        set({ currentTenant: tenant, currentProject: null }),

      setCurrentProject: (project) =>
        set({ currentProject: project }),

      setCurrentUser: (user) =>
        set({ currentUser: user }),

      clearContext: () =>
        set({ currentTenant: null, currentProject: null, currentUser: null }),
    }),
    {
      name: 'druvia-admin-store',
      partialize: (state) => ({
        currentTenant: state.currentTenant,
        currentProject: state.currentProject,
      }),
    }
  )
);
