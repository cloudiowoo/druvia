'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { useAuth } from '@/lib/auth';

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
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
      <main className="ml-64 p-8">{children}</main>
    </div>
  );
}
