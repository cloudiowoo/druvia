'use client';

import { useEffect } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useAppStore } from '@/store';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { hasProjectCapability, requiredProjectCapability } from '@/lib/project-access';

export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const { token, isHydrated } = useAuth();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const {
    currentProject,
    currentProjectAccess,
    setCurrentProject,
    setCurrentProjectAccess,
    currentTenant,
  } = useAppStore();

  useEffect(() => {
    const handleForbidden = (event: Event) => {
      const forbiddenProjectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (!forbiddenProjectId || forbiddenProjectId === projectId) {
        setCurrentProjectAccess(null);
      }
    };
    window.addEventListener('druvia:project-forbidden', handleForbidden);
    return () => window.removeEventListener('druvia:project-forbidden', handleForbidden);
  }, [projectId, setCurrentProjectAccess]);

  useEffect(() => {
    // Wait for auth hydration before checking token
    if (!isHydrated) return;

    // Redirect to login if not authenticated
    if (!token) {
      router.push('/login');
      return;
    }

    // Skip if already loaded this project
    if (currentProject?.projectId === projectId && currentProjectAccess?.projectId === projectId) return;

    async function loadProject() {
      setCurrentProjectAccess(null);
      const [projectResult, accessResult] = await Promise.all([
        api.getProject(projectId),
        api.getProjectAccess(projectId),
      ]);
      if (projectResult.success && projectResult.data && accessResult.success && accessResult.data) {
        const project = projectResult.data;
        setCurrentProject({
          projectId: project.projectId,
          tenantId,
          alias: project.alias,
          name: project.name,
          schemaName: project.schemaName || '',
          status: project.status as 'active' | 'suspended' | 'deleted',
        });
        setCurrentProjectAccess(accessResult.data);
      } else {
        setCurrentProjectAccess(null);
        router.push(`/t/${tenantId}`);
      }
    }
    loadProject();
  }, [projectId, tenantId, currentProject?.projectId, currentProjectAccess?.projectId, currentTenant?.alias, setCurrentProject, setCurrentProjectAccess, router, token, isHydrated]);

  // Show loading during hydration or initial load
  if (!isHydrated || ((currentProject?.projectId !== projectId || currentProjectAccess?.projectId !== projectId) && token)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">加载中...</div>
      </div>
    );
  }

  const requiredCapability = requiredProjectCapability(pathname);
  if (requiredCapability && !hasProjectCapability(currentProjectAccess, requiredCapability)) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-8">
        <div className="text-center">
          <h1 className="text-lg font-semibold">无权访问</h1>
          <p className="mt-2 text-sm text-muted-foreground">当前项目角色不能访问此页面。</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
