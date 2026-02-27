'use client';

import { useEffect, useState } from 'react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { api } from '@/lib/api';

interface User {
  userId: string;
  email: string | null;
  username: string | null;
  status: string;
  createdAt: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchUsers() {
      try {
        const res = await api.listUsers();
        if (res.success && res.data) {
          setUsers(res.data);
        }
      } finally {
        setLoading(false);
      }
    }
    fetchUsers();
  }, []);

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('zh-CN');
  };

  const handleStatusChange = async (userId: string, newStatus: string) => {
    const res = await api.updateUserStatus(userId, newStatus);
    if (res.success) {
      setUsers(users.map(u =>
        u.userId === userId ? { ...u, status: newStatus } : u
      ));
    }
  };

  const handleDelete = async (userId: string) => {
    if (!confirm('确定要删除此用户吗？此操作不可恢复。')) return;

    const res = await api.deleteUser(userId);
    if (res.success) {
      setUsers(users.filter(u => u.userId !== userId));
    }
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      active: 'bg-green-100 text-green-700',
      inactive: 'bg-gray-100 text-gray-700',
      suspended: 'bg-red-100 text-red-700',
    };
    const labels: Record<string, string> = {
      active: '活跃',
      inactive: '未激活',
      suspended: '已禁用',
    };
    return (
      <span className={`px-2 py-1 rounded text-xs ${styles[status] || 'bg-gray-100'}`}>
        {labels[status] || status}
      </span>
    );
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
                  <td className="text-gray-500">{user.email || '-'}</td>
                  <td>{getStatusBadge(user.status)}</td>
                  <td className="text-gray-500">{formatDate(user.createdAt)}</td>
                  <td>
                    <div className="flex gap-2">
                      {user.status === 'active' ? (
                        <button
                          onClick={() => handleStatusChange(user.userId, 'suspended')}
                          className="text-sm text-orange-600 hover:underline"
                        >
                          禁用
                        </button>
                      ) : (
                        <button
                          onClick={() => handleStatusChange(user.userId, 'active')}
                          className="text-sm text-green-600 hover:underline"
                        >
                          启用
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(user.userId)}
                        className="text-sm text-red-600 hover:underline"
                      >
                        删除
                      </button>
                    </div>
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
