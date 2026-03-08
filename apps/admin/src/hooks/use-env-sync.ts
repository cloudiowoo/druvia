// apps/admin/src/hooks/use-env-sync.ts
import { useEffect } from 'react';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';

/**
 * Hook to sync environment state when project changes.
 * Automatically loads environments and sets default to 'prod'.
 */
export function useEnvSync(projectId: string | null) {
  const { currentEnv, currentProject, setCurrentEnv } = useAppStore();

  useEffect(() => {
    if (!projectId || !currentProject?.schemaName) {
      return;
    }

    // If no env selected or project changed, load environments and set default
    if (!currentEnv || currentEnv.schemaName !== currentProject.schemaName) {
      async function loadDefaultEnv() {
        const res = await api.listEnvironments(projectId!);
        if (res.success && res.data && res.data.length > 0) {
          // Find prod environment or use first one
          const prodEnv = res.data.find((e) => e.envName === 'prod');
          const defaultEnv = prodEnv || res.data[0];
          setCurrentEnv({
            envName: defaultEnv.envName,
            schemaName: defaultEnv.schemaName,
          });
        } else if (currentProject?.schemaName) {
          // Fallback to project schema as prod
          setCurrentEnv({
            envName: 'prod',
            schemaName: currentProject.schemaName,
          });
        }
      }
      loadDefaultEnv();
    }
  // Note: currentEnv and setCurrentEnv intentionally excluded to prevent infinite loop
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, currentProject?.schemaName]);

  return currentEnv;
}
