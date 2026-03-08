'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { isMultiTenantEnabled, getDefaultTenantId } from '@/lib/tenant-config';

export default function LoginPage() {
  const router = useRouter();
  const { login, isLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const success = await login(email, password);
    if (success) {
      // In single-tenant mode, go directly to default tenant dashboard
      // In multi-tenant mode, go to tenant selection page
      if (isMultiTenantEnabled()) {
        router.push('/tenants');
      } else {
        router.push(`/t/${getDefaultTenantId()}`);
      }
    } else {
      setError('邮箱或密码错误');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="card w-full max-w-md">
        <div className="card-header">
          <h1 className="text-2xl font-bold text-center">Druvia Admin</h1>
          <p className="text-gray-500 text-center mt-1">登录管理控制台</p>
        </div>
        <div className="card-body">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-red-50 text-red-600 px-4 py-2 rounded-md text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="label">邮箱</label>
              <input
                type="email"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@example.com"
                required
              />
            </div>

            <div>
              <label className="label">密码</label>
              <input
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>

            <button
              type="submit"
              className="btn btn-primary w-full"
              disabled={isLoading}
            >
              {isLoading ? '登录中...' : '登录'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
