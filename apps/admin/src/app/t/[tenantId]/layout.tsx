'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAppStore } from '@/store';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';

export default function TenantLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const router = useRouter();
  const { token, isHydrated } = useAuth();
  const tenantId = params.tenantId as string;
  const { currentTenant, setCurrentTenant } = useAppStore();

  useEffect(() => {
    // Wait for auth hydration before checking token
    if (!isHydrated) return;

    // Redirect to login if not authenticated
    if (!token) {
      router.push('/login');
      return;
    }

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
  }, [tenantId, currentTenant?.tenantId, setCurrentTenant, router, token, isHydrated]);

  // Show loading during hydration or initial load
  if (!isHydrated || (currentTenant?.tenantId !== tenantId && token)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">加载中...</div>
      </div>
    );
  }

  return <>{children}</>;
}
