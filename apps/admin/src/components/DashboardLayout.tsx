'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { useAuth } from '@/lib/auth';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { GitBranch, ChevronDown } from 'lucide-react';
import { SystemUpdateNotice } from '@/components/system-update/SystemUpdateNotice';

interface Environment {
  id: number;
  projectId: string;
  envName: string;
  schemaName: string;
  createdAt: string;
}

interface EnvironmentSwitcherProps {
  disabled?: boolean;
}

function EnvironmentSwitcher({ disabled = false }: EnvironmentSwitcherProps) {
  const params = useParams();
  const projectId = params.projectId as string | undefined;
  const { currentProject, currentEnv, setCurrentEnv } = useAppStore();
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectId || !currentProject) return;

    async function loadEnvironments() {
      setLoading(true);
      const res = await api.listEnvironments(projectId!);
      // Always include prod environment using project's base schema
      const prodEnv: Environment = {
        id: 0,
        projectId: projectId!,
        envName: 'prod',
        schemaName: currentProject!.schemaName ?? '',
        createdAt: '',
      };

      if (res.success && res.data) {
        // Add prod if not already in the list
        const hasProd = res.data.some((e) => e.envName === 'prod');
        const allEnvs = hasProd ? res.data : [prodEnv, ...res.data];
        setEnvironments(allEnvs);

        // Set default env if not set
        if (!currentEnv) {
          setCurrentEnv({
            envName: 'prod',
            schemaName: currentProject!.schemaName ?? '',
          });
        }
      } else {
        // Even if API fails, show prod environment
        setEnvironments([prodEnv]);
        if (!currentEnv) {
          setCurrentEnv({
            envName: 'prod',
            schemaName: currentProject!.schemaName ?? '',
          });
        }
      }
      setLoading(false);
    }
    loadEnvironments();
    // Note: currentEnv and setCurrentEnv intentionally excluded to prevent infinite loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, currentProject?.schemaName]);

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
        onClick={() => !disabled && setIsOpen(!isOpen)}
        className={`flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md transition-colors ${
          disabled
            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
            : 'bg-white hover:bg-gray-50'
        }`}
        disabled={loading || disabled}
        title={disabled ? '此页面为项目级别，不支持环境切换' : undefined}
      >
        <GitBranch className={`h-4 w-4 ${disabled ? 'text-gray-300' : 'text-gray-500'}`} />
        <span className="font-medium">{currentEnv?.envName || 'prod'}</span>
        <ChevronDown className={`h-4 w-4 ${disabled ? 'text-gray-300' : 'text-gray-400'}`} />
      </button>

      {isOpen && environments.length > 0 && !disabled && (
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

export function DashboardLayout({
  children,
  isProjectLevel = false,
}: {
  children: React.ReactNode;
  isProjectLevel?: boolean;
}) {
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
            <EnvironmentSwitcher disabled={isProjectLevel} />
          </div>
        )}
        <SystemUpdateNotice />
        <div className="p-8 pt-4">{children}</div>
      </main>
    </div>
  );
}
