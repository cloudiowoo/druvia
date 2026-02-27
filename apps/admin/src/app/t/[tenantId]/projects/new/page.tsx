'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function NewProjectPage() {
  const params = useParams();
  const router = useRouter();
  const tenantId = params.tenantId as string;
  const { currentTenant } = useAppStore();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    alias: '',
    name: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await api.createProject(tenantId, form);
      if (res.success && res.data) {
        router.push(`/t/${tenantId}/p/${res.data.projectId}`);
      } else {
        setError(res.error?.message || '创建失败');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link href={`/t/${tenantId}`} className="hover:text-foreground">
            {currentTenant?.name || '租户'}
          </Link>
          <span>/</span>
          <Link href={`/t/${tenantId}/projects`} className="hover:text-foreground">
            项目
          </Link>
          <span>/</span>
          <span>新建</span>
        </div>
        <h1 className="text-2xl font-bold">创建项目</h1>
        <p className="text-muted-foreground">为租户创建新项目</p>
      </div>

      <div className="border rounded-lg max-w-xl">
        <div className="p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-destructive/10 text-destructive px-4 py-2 rounded-md text-sm">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <label htmlFor="name" className="text-sm font-medium">
                项目名称
              </label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="我的项目"
                required
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="alias" className="text-sm font-medium">
                别名 (用于 URL)
              </label>
              <Input
                id="alias"
                value={form.alias}
                onChange={(e) =>
                  setForm({
                    ...form,
                    alias: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''),
                  })
                }
                placeholder="main"
                pattern="[a-z0-9]{3,16}"
                minLength={3}
                maxLength={16}
                required
              />
              <p className="text-xs text-muted-foreground">
                3-16 个字符，仅限小写字母和数字
              </p>
            </div>

            <div className="flex gap-3 pt-4">
              <Button type="submit" disabled={loading}>
                {loading ? '创建中...' : '创建项目'}
              </Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>
                取消
              </Button>
            </div>
          </form>
        </div>
      </div>
    </DashboardLayout>
  );
}
