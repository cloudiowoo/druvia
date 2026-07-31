'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { DatabaseBackup, KeyRound, Loader2, Save, Server, Settings2, UserRound } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { SystemUpdatePanel } from '@/components/system-update/SystemUpdatePanel';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getPublicApiBaseUrl, getPublicHasuraBaseUrl } from '@/lib/public-env';
import { isMultiTenantEnabled } from '@/lib/tenant-config';

const API_URL = getPublicApiBaseUrl();
const HASURA_URL = getPublicHasuraBaseUrl();
const GB = 1024 * 1024 * 1024;

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

  const handleSaveProfile = async (e: FormEvent) => {
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

  const handleChangePassword = async (e: FormEvent) => {
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

  const systemInfoRows = [
    { label: 'API 地址', value: API_URL },
    { label: 'Hasura 地址', value: HASURA_URL },
    { label: '版本', value: '0.1.0' },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">设置</h1>
          <p className="mt-1 text-sm text-muted-foreground">系统配置与个人资料</p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <form onSubmit={handleSaveProfile}>
              <CardHeader className="border-b bg-muted/20">
                <CardTitle className="flex items-center gap-2 text-base">
                  <UserRound className="h-4 w-4 text-muted-foreground" />
                  个人资料
                </CardTitle>
                <CardDescription>登录身份与后台显示信息</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 pt-6">
                <div className="grid gap-2">
                  <Label htmlFor="settings-email">邮箱</Label>
                  <Input
                    id="settings-email"
                    type="email"
                    value={profileData.email}
                    onChange={(e) => setProfileData({ ...profileData, email: e.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="settings-username">用户名</Label>
                  <Input
                    id="settings-username"
                    type="text"
                    value={profileData.username}
                    onChange={(e) => setProfileData({ ...profileData, username: e.target.value })}
                  />
                </div>
              </CardContent>
              <CardFooter className="justify-end border-t bg-muted/20 px-6 py-4">
                <Button type="submit" disabled={savingProfile}>
                  {savingProfile ? <Loader2 className="animate-spin" /> : <Save />}
                  保存资料
                </Button>
              </CardFooter>
            </form>
          </Card>

          <Card>
            <form onSubmit={handleChangePassword}>
              <CardHeader className="border-b bg-muted/20">
                <CardTitle className="flex items-center gap-2 text-base">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  修改密码
                </CardTitle>
                <CardDescription>更新当前账号密码</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 pt-6">
                <div className="grid gap-2">
                  <Label htmlFor="settings-current-password">当前密码</Label>
                  <Input
                    id="settings-current-password"
                    type="password"
                    required
                    value={passwordData.currentPassword}
                    onChange={(e) => setPasswordData({ ...passwordData, currentPassword: e.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="settings-new-password">新密码</Label>
                  <Input
                    id="settings-new-password"
                    type="password"
                    required
                    minLength={6}
                    value={passwordData.newPassword}
                    onChange={(e) => setPasswordData({ ...passwordData, newPassword: e.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="settings-confirm-password">确认新密码</Label>
                  <Input
                    id="settings-confirm-password"
                    type="password"
                    required
                    minLength={6}
                    value={passwordData.confirmPassword}
                    onChange={(e) => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
                  />
                </div>
              </CardContent>
              <CardFooter className="justify-end border-t bg-muted/20 px-6 py-4">
                <Button type="submit" disabled={savingPassword}>
                  {savingPassword ? <Loader2 className="animate-spin" /> : <KeyRound />}
                  修改密码
                </Button>
              </CardFooter>
            </form>
          </Card>

          <Card>
            <CardHeader className="border-b bg-muted/20">
              <CardTitle className="flex items-center gap-2 text-base">
                <Server className="h-4 w-4 text-muted-foreground" />
                系统信息
              </CardTitle>
              <CardDescription>当前管理后台连接信息</CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="divide-y rounded-md border">
                {systemInfoRows.map((item) => (
                  <div key={item.label} className="grid gap-1 px-4 py-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
                    <span className="text-sm text-muted-foreground">{item.label}</span>
                    <span className="min-w-0 break-all font-mono text-sm">{item.value}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {isSuperAdmin && (
            <>
              <SystemUpdatePanel />

              <Card className="lg:col-span-2">
                <CardHeader className="border-b bg-muted/20">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Settings2 className="h-4 w-4 text-muted-foreground" />
                    {multiTenant ? '平台设置' : '系统设置'}
                  </CardTitle>
                  <CardDescription>默认资源配额与备份策略</CardDescription>
                </CardHeader>
                {loading ? (
                  <CardContent className="py-10 text-center text-sm text-muted-foreground">加载中...</CardContent>
                ) : settings ? (
                  <>
                    <CardContent className="grid gap-4 pt-6 md:grid-cols-2 lg:grid-cols-3">
                      {multiTenant && (
                        <div className="grid gap-2">
                          <Label htmlFor="settings-default-plan">默认套餐</Label>
                          <Select
                            value={settings.defaultPlan}
                            onValueChange={(value) => setSettings({ ...settings, defaultPlan: value })}
                          >
                            <SelectTrigger id="settings-default-plan">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="free">免费版</SelectItem>
                              <SelectItem value="pro">专业版</SelectItem>
                              <SelectItem value="enterprise">企业版</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      <div className="grid gap-2">
                        <Label htmlFor="settings-storage-limit">{multiTenant ? '默认存储限制' : '存储限制'}</Label>
                        <div className="flex items-center gap-2">
                          <Input
                            id="settings-storage-limit"
                            type="number"
                            min={0}
                            step={1}
                            value={settings.defaultStorageLimit / GB}
                            onChange={(e) => setSettings({ ...settings, defaultStorageLimit: Number(e.target.value) * GB })}
                          />
                          <span className="rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground">GB</span>
                        </div>
                      </div>
                      {multiTenant && (
                        <>
                          <div className="grid gap-2">
                            <Label htmlFor="settings-project-limit">默认项目数限制</Label>
                            <Input
                              id="settings-project-limit"
                              type="number"
                              min={0}
                              value={settings.defaultProjectLimit}
                              onChange={(e) => setSettings({ ...settings, defaultProjectLimit: Number(e.target.value) })}
                            />
                          </div>
                          <div className="grid gap-2">
                            <Label htmlFor="settings-user-limit">默认用户数限制</Label>
                            <Input
                              id="settings-user-limit"
                              type="number"
                              min={0}
                              value={settings.defaultUserLimit}
                              onChange={(e) => setSettings({ ...settings, defaultUserLimit: Number(e.target.value) })}
                            />
                          </div>
                        </>
                      )}
                      <div className="grid gap-2">
                        <Label htmlFor="settings-backup-retention">备份保留天数</Label>
                        <Input
                          id="settings-backup-retention"
                          type="number"
                          min={0}
                          value={settings.backupRetentionDays}
                          onChange={(e) => setSettings({ ...settings, backupRetentionDays: Number(e.target.value) })}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="settings-backup-max-count">最大备份数量</Label>
                        <Input
                          id="settings-backup-max-count"
                          type="number"
                          min={0}
                          value={settings.backupMaxCount}
                          onChange={(e) => setSettings({ ...settings, backupMaxCount: Number(e.target.value) })}
                        />
                      </div>
                    </CardContent>
                    <CardFooter className="justify-end border-t bg-muted/20 px-6 py-4">
                      <Button onClick={handleSaveSettings} disabled={saving}>
                        {saving ? <Loader2 className="animate-spin" /> : <DatabaseBackup />}
                        {multiTenant ? '保存平台设置' : '保存系统设置'}
                      </Button>
                    </CardFooter>
                  </>
                ) : (
                  <CardContent className="py-10 text-center text-sm text-muted-foreground">暂无设置</CardContent>
                )}
              </Card>
            </>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
