'use client';

import { useAppStore } from '@/store';
import { hasProjectCapability } from '@/lib/project-access';
import type { ProjectCapability } from '@druvia/shared';

export function useProjectAccess() {
  const access = useAppStore((state) => state.currentProjectAccess);
  return {
    access,
    can: (capability: ProjectCapability) => hasProjectCapability(access, capability),
  };
}
