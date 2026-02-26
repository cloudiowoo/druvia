'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';

export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const router = useRouter();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentProject, setCurrentProject, currentTenant } = useAppStore();

  useEffect(() => {
    // Skip if already loaded this project
    if (currentProject?.projectId === projectId) return;

    async function loadProject() {
      const res = await api.listProjects(tenantId);
      if (res.success && res.data) {
        const project = res.data.find((p) => p.projectId === projectId);
        if (project) {
          setCurrentProject({
            projectId: project.projectId,
            tenantId,
            alias: project.alias,
            name: project.name,
            schemaName: `tenant_${currentTenant?.alias || tenantId}`,
            status: project.status as 'active' | 'suspended' | 'deleted',
          });
        } else {
          router.push(`/t/${tenantId}`);
        }
      }
    }
    loadProject();
  }, [projectId, tenantId, currentProject?.projectId, currentTenant?.alias, setCurrentProject, router]);

  return <>{children}</>;
}
