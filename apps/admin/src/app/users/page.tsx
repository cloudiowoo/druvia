'use client';

import { useEffect, useState } from 'react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { api } from '@/lib/api';
import { useAppStore } from '@/store';

interface User {
  userId: string;
  email: string | null;
  username: string | null;
  role: 'super_admin' | 'admin';
  status: string;
  createdAt: string;
}

interface UserFormData {
  email: string;
  username: string;
  password: string;
  role: 'super_admin' | 'admin';
}

interface EditUserFormData {
  email: string;
  username: string;
  role: 'super_admin' | 'admin';
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [formData, setFormData] = useState<UserFormData>({
    email: '',
    username: '',
    password: '',
    role: 'admin',
  });
  const [editFormData, setEditFormData] = useState<EditUserFormData>({
    email: '',
    username: '',
    role: 'admin',
  });
  const [submitting, setSubmitting] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const currentUser = useAppStore((state) => state.currentUser);
  const isSuperAdmin = currentUser?.role === 'super_admin';

  useEffect(() => {
    fetchUsers();
  }, []);

  async function fetchUsers() {
    try {
      const res = await api.listUsers();
      if (res.success && res.data) {
        setUsers(res.data as User[]);
      }
    } finally {
      setLoading(false);
    }
  }

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

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await api.createUser(formData);
      if (res.success && res.data) {
        setUsers([...users, { ...res.data, status: 'active', createdAt: new Date().toISOString() } as User]);
        setShowAddDialog(false);
        setFormData({ email: '', username: '', password: '', role: 'admin' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setSubmitting(true);
    try {
      const res = await api.updateUser(editingUser.userId, editFormData);
      if (res.success && res.data) {
        setUsers(users.map(u =>
          u.userId === editingUser.userId ? { ...u, ...res.data } as User : u
        ));
        setShowEditDialog(false);
        setEditingUser(null);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetPassword = async (userId: string) => {
    if (!confirm('确定要重置此用户的密码吗？')) return;
    const res = await api.resetUserPassword(userId);
    if (res.success && res.data) {
      setTempPassword(res.data.tempPassword);
    }
  };

  const openEditDialog = (user: User) => {
    setEditingUser(user);
    setEditFormData({
      email: user.email || '',
      username: user.username || '',
      role: user.role,
    });
    setShowEditDialog(true);
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

  const getRoleBadge = (role: string) => {
    const styles: Record<string, string> = {
      super_admin: 'bg-purple-100 text-purple-700',
      admin: 'bg-blue-100 text-blue-700',
    };
    const labels: Record<string, string> = {
      super_admin: '超级管理员',
      admin: '管理员',
    };
    return (
      <span className={`px-2 py-1 rounded text-xs ${styles[role] || 'bg-gray-100'}`}>
        {labels[role] || role}
      </span>
    );
  };

  const isSelf = (userId: string) => currentUser?.userId === userId;

  // 检查是否可以操作目标用户（禁用/删除）
  const canOperateUser = (targetUser: User) => {
    // 不能操作自己
    if (isSelf(targetUser.userId)) return false;
    // 普通管理员不能操作超级管理员
    if (!isSuperAdmin && targetUser.role === 'super_admin') return false;
    return true;
  };

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">用户管理</h1>
          <p className="text-gray-500">管理平台用户</p>
        </div>
        {isSuperAdmin && (
          <button
            onClick={() => setShowAddDialog(true)}
            className="btn btn-primary"
          >
            添加用户
          </button>
        )}
      </div>

      {/* Temp Password Modal */}
      {tempPassword && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">密码已重置</h3>
            <p className="text-gray-600 mb-2">临时密码：</p>
            <code className="block bg-gray-100 p-3 rounded text-lg font-mono mb-4">
              {tempPassword}
            </code>
            <p className="text-sm text-gray-500 mb-4">
              请将此密码发送给用户，用户登录后应立即修改密码。
            </p>
            <button
              onClick={() => setTempPassword(null)}
              className="btn btn-primary w-full"
            >
              确定
            </button>
          </div>
        </div>
      )}

      {/* Add User Dialog */}
      {showAddDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">添加用户</h3>
            <form onSubmit={handleAddUser}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">邮箱</label>
                  <input
                    type="email"
                    required
                    className="input w-full"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">用户名</label>
                  <input
                    type="text"
                    required
                    className="input w-full"
                    value={formData.username}
                    onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">密码</label>
                  <input
                    type="password"
                    required
                    minLength={6}
                    className="input w-full"
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">角色</label>
                  <select
                    className="input w-full"
                    value={formData.role}
                    onChange={(e) => setFormData({ ...formData, role: e.target.value as 'super_admin' | 'admin' })}
                  >
                    <option value="admin">管理员</option>
                    <option value="super_admin">超级管理员</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setShowAddDialog(false)}
                  className="btn flex-1"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="btn btn-primary flex-1"
                >
                  {submitting ? '创建中...' : '创建'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit User Dialog */}
      {showEditDialog && editingUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">编辑用户</h3>
            <form onSubmit={handleEditUser}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">邮箱</label>
                  <input
                    type="email"
                    required
                    className="input w-full"
                    value={editFormData.email}
                    onChange={(e) => setEditFormData({ ...editFormData, email: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">用户名</label>
                  <input
                    type="text"
                    required
                    className="input w-full"
                    value={editFormData.username}
                    onChange={(e) => setEditFormData({ ...editFormData, username: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">角色</label>
                  <select
                    className="input w-full"
                    value={editFormData.role}
                    onChange={(e) => setEditFormData({ ...editFormData, role: e.target.value as 'super_admin' | 'admin' })}
                  >
                    <option value="admin">管理员</option>
                    <option value="super_admin">超级管理员</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => { setShowEditDialog(false); setEditingUser(null); }}
                  className="btn flex-1"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="btn btn-primary flex-1"
                >
                  {submitting ? '保存中...' : '保存'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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
                <th>角色</th>
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
                  <td>{getRoleBadge(user.role)}</td>
                  <td>{getStatusBadge(user.status)}</td>
                  <td className="text-gray-500">{formatDate(user.createdAt)}</td>
                  <td>
                    <div className="flex gap-2">
                      {isSuperAdmin && (
                        <>
                          <button
                            onClick={() => openEditDialog(user)}
                            className="text-sm text-blue-600 hover:underline"
                          >
                            编辑
                          </button>
                          <button
                            onClick={() => handleResetPassword(user.userId)}
                            className="text-sm text-purple-600 hover:underline"
                          >
                            重置密码
                          </button>
                        </>
                      )}
                      {canOperateUser(user) && (
                        <>
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
                        </>
                      )}
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
