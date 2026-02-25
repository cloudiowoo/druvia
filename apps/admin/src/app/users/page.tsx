'use client';

import { useEffect, useState } from 'react';
import { DashboardLayout } from '@/components/DashboardLayout';

interface User {
  id: number;
  userId: string;
  email: string;
  username: string | null;
  status: string;
  createdAt: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // TODO: Add users list API
    setLoading(false);
  }, []);

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('zh-CN');
  };

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">用户管理</h1>
          <p className="text-gray-500">管理平台用户</p>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="p-8 text-center text-gray-500">加载中...</div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            暂无用户数据
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>用户名</th>
                <th>邮箱</th>
                <th>状态</th>
                <th>注册时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.userId}>
                  <td className="font-medium">{user.username || '-'}</td>
                  <td className="text-gray-500">{user.email}</td>
                  <td>
                    <span
                      className={`px-2 py-1 rounded text-xs ${
                        user.status === 'active'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {user.status === 'active' ? '活跃' : user.status}
                    </span>
                  </td>
                  <td className="text-gray-500">{formatDate(user.createdAt)}</td>
                  <td>
                    <button className="text-sm text-primary-600 hover:underline">
                      详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </DashboardLayout>
  );
}
