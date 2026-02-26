'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';

export default function TenantLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const router = useRouter();
  const tenantId = params.tenantId as string;
  const { currentTenant, setCurrentTenant } = useAppStore();

  useEffect(() => {
    // Skip if already loaded this tenant
    if (currentTenant?.tenantId === tenantId) return;

    async function loadTenant() {
      const res = await api.getTenant(tenantId);
      if (res.success && res.data) {
        setCurrentTenant({
          tenantId: res.data.tenantId,
          alias: res.data.alias,
          name: res.data.name,
          plan: res.data.plan as 'free' | 'pro' | 'enterprise',
          status: res.data.status as 'active' | 'suspended' | 'deleted',
        });
      } else {
        router.push('/tenants');
      }
    }
    loadTenant();
  }, [tenantId, currentTenant?.tenantId, setCurrentTenant, router]);

  return <>{children}</>;
}
