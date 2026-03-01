import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from './api';
import { useAppStore } from '@/store';

interface User {
  userId: string;
  email: string;
  username: string | null;
  avatarUrl: string | null;
  role?: 'super_admin' | 'admin';
}

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  isHydrated: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => void;
  fetchUser: () => Promise<void>;
  setIsHydrated: (hydrated: boolean) => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isLoading: false,
      isHydrated: false,

      setIsHydrated: (hydrated: boolean) => set({ isHydrated: hydrated }),

      login: async (email: string, password: string) => {
        set({ isLoading: true });
        try {
          const res = await api.login(email, password);
          if (res.success && res.data) {
            api.setToken(res.data.token);
            set({ token: res.data.token });
            await get().fetchUser();
            return true;
          }
          return false;
        } finally {
          set({ isLoading: false });
        }
      },

      logout: () => {
        api.setToken(null);
        set({ user: null, token: null });
        useAppStore.getState().setCurrentUser(null);
      },

      fetchUser: async () => {
        const token = get().token;
        if (!token) return;

        api.setToken(token);
        const res = await api.getMe();
        if (res.success && res.data) {
          set({ user: res.data });
          // Sync to app store for role-based UI
          useAppStore.getState().setCurrentUser(res.data);
        } else {
          get().logout();
        }
      },
    }),
    {
      name: 'druvia-auth',
      partialize: (state) => ({ token: state.token }),
      onRehydrateStorage: () => (state, _error) => {
        // Initialize token on api client after rehydration from localStorage
        if (state?.token) {
          api.setToken(state.token);
        }
        // Mark hydration as complete
        state?.setIsHydrated(true);
      },
    }
  )
);
