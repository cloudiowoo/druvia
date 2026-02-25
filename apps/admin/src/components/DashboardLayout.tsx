'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { useAuth } from '@/lib/auth';

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { token, fetchUser } = useAuth();

  useEffect(() => {
    if (!token) {
      router.push('/login');
    } else {
      fetchUser();
    }
  }, [token, router, fetchUser]);

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
