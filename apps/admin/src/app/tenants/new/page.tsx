'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { api } from '@/lib/api';

export default function NewTenantPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    alias: '',
    name: '',
    plan: 'free',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await api.createTenant(form);
      if (res.success && res.data) {
        router.push(`/tenants/${res.data.tenantId}`);
      } else {
        setError(res.error?.message || '创建失败');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">创建租户</h1>
        <p className="text-gray-500">创建新的平台租户</p>
      </div>

      <div className="card max-w-xl">
        <div className="card-body">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-red-50 text-red-600 px-4 py-2 rounded-md text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="label">租户名称</label>
              <input
                type="text"
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="我的公司"
                required
              />
            </div>

            <div>
              <label className="label">别名 (用于 URL)</label>
              <input
                type="text"
                className="input"
                value={form.alias}
                onChange={(e) =>
                  setForm({ ...form, alias: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '') })
                }
                placeholder="acme"
                pattern="[a-z0-9]{3,16}"
                minLength={3}
                maxLength={16}
                required
              />
              <p className="text-xs text-gray-500 mt-1">
                3-16 个字符，仅限小写字母和数字
              </p>
            </div>

            <div>
              <label className="label">套餐</label>
              <select
                className="input"
                value={form.plan}
                onChange={(e) => setForm({ ...form, plan: e.target.value })}
              >
                <option value="free">免费版</option>
                <option value="pro">专业版</option>
                <option value="enterprise">企业版</option>
              </select>
            </div>

            <div className="flex gap-3 pt-4">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading}
              >
                {loading ? '创建中...' : '创建租户'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => router.back()}
              >
                取消
              </button>
            </div>
          </form>
        </div>
      </div>
    </DashboardLayout>
  );
}
