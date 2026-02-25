'use client';

import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/lib/auth';

export default function SettingsPage() {
  const { user } = useAuth();

  return (
    <DashboardLayout>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">设置</h1>
        <p className="text-gray-500">系统配置</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <div className="card-header">
            <h2 className="font-semibold">账户信息</h2>
          </div>
          <div className="card-body space-y-4">
            <div>
              <label className="label">邮箱</label>
              <input
                type="email"
                className="input"
                value={user?.email || ''}
                disabled
              />
            </div>
            <div>
              <label className="label">用户名</label>
              <input
                type="text"
                className="input"
                value={user?.username || ''}
                disabled
              />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="font-semibold">系统信息</h2>
          </div>
          <div className="card-body">
            <div className="space-y-3">
              <div className="flex justify-between py-2 border-b">
                <span className="text-gray-500">API 地址</span>
                <span className="font-mono text-sm">{process.env.API_URL}</span>
              </div>
              <div className="flex justify-between py-2 border-b">
                <span className="text-gray-500">Hasura 地址</span>
                <span className="font-mono text-sm">{process.env.HASURA_URL}</span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-gray-500">版本</span>
                <span className="font-mono text-sm">0.1.0</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
