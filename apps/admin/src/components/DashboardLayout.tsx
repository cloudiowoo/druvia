'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { useAuth } from '@/lib/auth';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { GitBranch, ChevronDown } from 'lucide-react';

interface Environment {
  id: number;
  projectId: string;
  envName: string;
  schemaName: string;
  createdAt: string;
}

function EnvironmentSwitcher() {
  const params = useParams();
  const projectId = params.projectId as string | undefined;
  const { currentProject, currentEnv, setCurrentEnv } = useAppStore();
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectId) return;

    async function loadEnvironments() {
      setLoading(true);
      const res = await api.listEnvironments(projectId!);
      if (res.success && res.data) {
        setEnvironments(res.data);
        // Set default env if not set
        if (!currentEnv && res.data.length > 0) {
          const prodEnv = res.data.find((e) => e.envName === 'prod');
          const defaultEnv = prodEnv || res.data[0];
          setCurrentEnv({
            envName: defaultEnv.envName,
            schemaName: defaultEnv.schemaName,
          });
        }
      }
      setLoading(false);
    }
    loadEnvironments();
    // Note: currentEnv and setCurrentEnv intentionally excluded to prevent infinite loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (!projectId || !currentProject) {
    return null;
  }

  const handleSelect = (env: Environment) => {
    setCurrentEnv({
      envName: env.envName,
      schemaName: env.schemaName,
    });
    setIsOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 text-sm bg-white border rounded-md hover:bg-gray-50 transition-colors"
        disabled={loading}
      >
        <GitBranch className="h-4 w-4 text-gray-500" />
        <span className="font-medium">{currentEnv?.envName || 'prod'}</span>
        <ChevronDown className="h-4 w-4 text-gray-400" />
      </button>

      {isOpen && environments.length > 0 && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute right-0 mt-1 w-48 bg-white border rounded-md shadow-lg z-20">
            <div className="py-1">
              {environments.map((env) => (
                <button
                  key={env.id}
                  onClick={() => handleSelect(env)}
                  className={`w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center justify-between ${
                    currentEnv?.envName === env.envName ? 'bg-blue-50 text-blue-600' : ''
                  }`}
                >
                  <span>{env.envName}</span>
                  {env.envName === 'prod' && (
                    <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                      生产
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const params = useParams();
  const projectId = params.projectId as string | undefined;
  const { token, isHydrated, fetchUser } = useAuth();

  useEffect(() => {
    // Wait for hydration to complete before checking auth
    if (!isHydrated) return;

    if (!token) {
      router.push('/login');
    } else {
      fetchUser();
    }
  }, [token, isHydrated, router, fetchUser]);

  if (!isHydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">加载中...</div>
      </div>
    );
  }

  if (!token) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar />
      <main className="ml-64">
        {projectId && (
          <div className="flex justify-end px-8 pt-4">
            <EnvironmentSwitcher />
          </div>
        )}
        <div className="p-8 pt-4">{children}</div>
      </main>
    </div>
  );
}
