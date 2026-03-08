'use client';

import { useEffect, useState } from 'react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { isMultiTenantEnabled } from '@/lib/tenant-config';
import { toast } from '@/hooks/use-toast';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const HASURA_URL = process.env.NEXT_PUBLIC_HASURA_URL || 'http://localhost:8080';

interface PlatformSettings {
  defaultPlan: string;
  defaultStorageLimit: number;
  defaultProjectLimit: number;
  defaultUserLimit: number;
  backupRetentionDays: number;
  backupMaxCount: number;
}

export default function SettingsPage() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const multiTenant = isMultiTenantEnabled();

  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [profileData, setProfileData] = useState({ username: '', email: '' });
  const [passwordData, setPasswordData] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    if (user) {
      setProfileData({ username: user.username || '', email: user.email || '' });
    }
  }, [user]);

  useEffect(() => {
    if (isSuperAdmin) {
      fetchSettings();
    } else {
      setLoading(false);
    }
  }, [isSuperAdmin]);

  async function fetchSettings() {
    try {
      const res = await api.getSettings();
      if (res.success && res.data) {
        setSettings(res.data);
      }
    } finally {
      setLoading(false);
    }
  }

  const handleSaveSettings = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await api.updateSettings(settings);
      if (res.success && res.data) {
        setSettings(res.data);
        toast({ title: '设置已保存' });
      } else {
        toast({ title: '保存失败', description: res.error?.message, variant: 'destructive' });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const res = await api.updateProfile(profileData);
      if (res.success) {
        toast({ title: '个人资料已更新' });
      } else {
        toast({ title: '更新失败', description: res.error?.message, variant: 'destructive' });
      }
    } finally {
      setSavingProfile(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordData.newPassword !== passwordData.confirmPassword) {
      toast({ title: '两次输入的密码不一致', variant: 'destructive' });
      return;
    }
    setSavingPassword(true);
    try {
      const res = await api.changePassword({
        currentPassword: passwordData.currentPassword,
        newPassword: passwordData.newPassword,
      });
      if (res.success) {
        toast({ title: '密码已修改' });
        setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' });
      } else {
        toast({ title: '修改失败', description: res.error?.message, variant: 'destructive' });
      }
    } finally {
      setSavingPassword(false);
    }
  };

  const formatBytes = (bytes: number) => {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(1)} GB`;
  };

  return (
    <DashboardLayout>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">设置</h1>
        <p className="text-gray-500">系统配置与个人资料</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Profile Card */}
        <div className="card">
          <div className="card-header">
            <h2 className="font-semibold">个人资料</h2>
          </div>
          <form onSubmit={handleSaveProfile} className="card-body space-y-4">
            <div>
              <label className="label">邮箱</label>
              <input
                type="email"
                className="input w-full"
                value={profileData.email}
                onChange={(e) => setProfileData({ ...profileData, email: e.target.value })}
              />
            </div>
            <div>
              <label className="label">用户名</label>
              <input
                type="text"
                className="input w-full"
                value={profileData.username}
                onChange={(e) => setProfileData({ ...profileData, username: e.target.value })}
              />
            </div>
            <button type="submit" disabled={savingProfile} className="btn btn-primary">
              {savingProfile ? '保存中...' : '保存资料'}
            </button>
          </form>
        </div>

        {/* Password Card */}
        <div className="card">
          <div className="card-header">
            <h2 className="font-semibold">修改密码</h2>
          </div>
          <form onSubmit={handleChangePassword} className="card-body space-y-4">
            <div>
              <label className="label">当前密码</label>
              <input
                type="password"
                required
                className="input w-full"
                value={passwordData.currentPassword}
                onChange={(e) => setPasswordData({ ...passwordData, currentPassword: e.target.value })}
              />
            </div>
            <div>
              <label className="label">新密码</label>
              <input
                type="password"
                required
                minLength={6}
                className="input w-full"
                value={passwordData.newPassword}
                onChange={(e) => setPasswordData({ ...passwordData, newPassword: e.target.value })}
              />
            </div>
            <div>
              <label className="label">确认新密码</label>
              <input
                type="password"
                required
                minLength={6}
                className="input w-full"
                value={passwordData.confirmPassword}
                onChange={(e) => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
              />
            </div>
            <button type="submit" disabled={savingPassword} className="btn btn-primary">
              {savingPassword ? '修改中...' : '修改密码'}
            </button>
          </form>
        </div>

        {/* System Info Card */}
        <div className="card">
          <div className="card-header">
            <h2 className="font-semibold">系统信息</h2>
          </div>
          <div className="card-body">
            <div className="space-y-3">
              <div className="flex justify-between py-2 border-b">
                <span className="text-gray-500">API 地址</span>
                <span className="font-mono text-sm">{API_URL}</span>
              </div>
              <div className="flex justify-between py-2 border-b">
                <span className="text-gray-500">Hasura 地址</span>
                <span className="font-mono text-sm">{HASURA_URL}</span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-gray-500">版本</span>
                <span className="font-mono text-sm">0.1.0</span>
              </div>
            </div>
          </div>
        </div>

        {/* Platform Settings Card (Super Admin Only) */}
        {isSuperAdmin && (
          <div className="card lg:col-span-2">
            <div className="card-header">
              <h2 className="font-semibold">{multiTenant ? '平台设置' : '系统设置'}</h2>
            </div>
            {loading ? (
              <div className="card-body text-center text-gray-500">加载中...</div>
            ) : settings ? (
              <div className="card-body">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {multiTenant && (
                    <div>
                      <label className="label">默认套餐</label>
                      <select
                        className="input w-full"
                        value={settings.defaultPlan}
                        onChange={(e) => setSettings({ ...settings, defaultPlan: e.target.value })}
                      >
                        <option value="free">免费版</option>
                        <option value="pro">专业版</option>
                        <option value="enterprise">企业版</option>
                      </select>
                    </div>
                  )}
                  <div>
                    <label className="label">{multiTenant ? '默认存储限制' : '存储限制'}</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        className="input w-full"
                        value={settings.defaultStorageLimit / (1024 * 1024 * 1024)}
                        onChange={(e) => setSettings({ ...settings, defaultStorageLimit: Number(e.target.value) * 1024 * 1024 * 1024 })}
                      />
                      <span className="text-gray-500">GB</span>
                    </div>
                  </div>
                  {multiTenant && (
                    <>
                      <div>
                        <label className="label">默认项目数限制</label>
                        <input
                          type="number"
                          className="input w-full"
                          value={settings.defaultProjectLimit}
                          onChange={(e) => setSettings({ ...settings, defaultProjectLimit: Number(e.target.value) })}
                        />
                      </div>
                      <div>
                        <label className="label">默认用户数限制</label>
                        <input
                          type="number"
                          className="input w-full"
                          value={settings.defaultUserLimit}
                          onChange={(e) => setSettings({ ...settings, defaultUserLimit: Number(e.target.value) })}
                        />
                      </div>
                    </>
                  )}
                  <div>
                    <label className="label">备份保留天数</label>
                    <input
                      type="number"
                      className="input w-full"
                      value={settings.backupRetentionDays}
                      onChange={(e) => setSettings({ ...settings, backupRetentionDays: Number(e.target.value) })}
                    />
                  </div>
                  <div>
                    <label className="label">最大备份数量</label>
                    <input
                      type="number"
                      className="input w-full"
                      value={settings.backupMaxCount}
                      onChange={(e) => setSettings({ ...settings, backupMaxCount: Number(e.target.value) })}
                    />
                  </div>
                </div>
                <div className="mt-6">
                  <button onClick={handleSaveSettings} disabled={saving} className="btn btn-primary">
                    {saving ? '保存中...' : multiTenant ? '保存平台设置' : '保存系统设置'}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
