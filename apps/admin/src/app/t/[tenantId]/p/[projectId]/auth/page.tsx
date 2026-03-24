'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/hooks/use-toast';
import {
  Settings,
  Users,
  Shield,
  MoreHorizontal,
  Trash2,
  Ban,
  CheckCircle2,
  Search,
} from 'lucide-react';

// Provider icons
const providerIcons: Record<string, string> = {
  email: '📧',
  google: '🔷',
  github: '🐙',
  microsoft: '🪟',
  discord: '💬',
  wechat: '🌐',
  dingtalk: '💬',
  feishu: '🐦',
};

interface AuthProvider {
  id: string;
  name: string;
  type: 'builtin' | 'oauth';
  enabled: boolean;
  configured: boolean;
  hasCredentials: boolean;
}

interface AuthProviderDetail {
  id: number;
  projectId: string;
  provider: string;
  enabled: boolean;
  clientId: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ProjectUser {
  id: string;
  email: string;
  username: string | null;
  avatarUrl: string | null;
  provider: string;
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
  createdAt: string;
}

interface AuthConfig {
  projectId: string;
  jwtExpiresIn: number;
  refreshTokenExpiresIn: number;
  passwordMinLength: number;
  requireEmailVerification: boolean;
  allowSignup: boolean;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('zh-CN');
}

export default function AuthPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentProject, currentTenant } = useAppStore();

  // Providers state
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<AuthProvider | null>(null);
  const [selectedProviderDetail, setSelectedProviderDetail] = useState<AuthProviderDetail | null>(null);
  const [providerConfig, setProviderConfig] = useState({
    clientId: '',
    clientSecret: '',
    enabled: true,
  });
  const [savingProvider, setSavingProvider] = useState(false);
  const [providerConfigLoading, setProviderConfigLoading] = useState(false);

  // Users state
  const [users, setUsers] = useState<ProjectUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersTotal, setUsersTotal] = useState(0);
  const [usersPage, setUsersPage] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteUserTarget, setDeleteUserTarget] = useState<ProjectUser | null>(null);

  // Config state
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [editedConfig, setEditedConfig] = useState<Partial<AuthConfig>>({});
  const [savingConfig, setSavingConfig] = useState(false);

  // Fetch providers
  const fetchProviders = useCallback(async () => {
    const res = await api.listAuthProviders(projectId);
    if (res.success && res.data) {
      setProviders(res.data);
    }
    setProvidersLoading(false);
  }, [projectId]);

  // Fetch users
  const fetchUsers = useCallback(async () => {
    setUsersLoading(true);
    const res = await api.listProjectUsers(projectId, {
      limit: 20,
      offset: usersPage * 20,
      search: searchQuery || undefined,
    });
    if (res.success && res.data) {
      setUsers(res.data);
      setUsersTotal(res.pagination?.total ?? 0);
    }
    setUsersLoading(false);
  }, [projectId, usersPage, searchQuery]);

  // Fetch config
  const fetchConfig = useCallback(async () => {
    const res = await api.getAuthConfig(projectId);
    if (res.success && res.data) {
      setConfig(res.data);
      setEditedConfig(res.data);
    }
    setConfigLoading(false);
  }, [projectId]);

  useEffect(() => {
    fetchProviders();
    fetchConfig();
  }, [fetchProviders, fetchConfig]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  // Provider handlers
  const resetProviderConfig = (provider: AuthProvider) => {
    setProviderConfig({
      clientId: '',
      clientSecret: '',
      enabled: provider.enabled,
    });
    setSelectedProviderDetail(null);
  };

  const handleProviderClick = async (provider: AuthProvider) => {
    if (provider.type === 'builtin') {
      // Toggle builtin provider (email)
      handleToggleProvider(provider);
    } else {
      // Open config dialog for OAuth providers
      setSelectedProvider(provider);
      resetProviderConfig(provider);
      setConfigDialogOpen(true);

      if (!provider.configured) {
        return;
      }

      setProviderConfigLoading(true);
      const res = await api.getAuthProvider(projectId, provider.id);
      setProviderConfigLoading(false);

      if (res.success && res.data) {
        setSelectedProviderDetail(res.data);
        setProviderConfig({
          clientId: res.data.clientId || '',
          clientSecret: '',
          enabled: res.data.enabled,
        });
        return;
      }

      toast({ title: '读取配置失败', description: res.error?.message, variant: 'destructive' });
    }
  };

  const handleToggleProvider = async (provider: AuthProvider) => {
    if (provider.type === 'oauth' && !provider.configured && !provider.enabled) {
      // Need to configure first
      handleProviderClick(provider);
      return;
    }

    let res;
    if (!provider.configured) {
      // 内置提供商（如 email）未配置时，先创建记录
      res = await api.createAuthProvider(projectId, {
        provider: provider.id,
        enabled: !provider.enabled,
      });
    } else {
      res = await api.updateAuthProvider(projectId, provider.id, {
        enabled: !provider.enabled,
      });
    }

    if (res.success) {
      fetchProviders();
      toast({ title: provider.enabled ? '已禁用' : '已启用' });
    } else {
      toast({ title: '操作失败', variant: 'destructive' });
    }
  };

  const handleSaveProvider = async () => {
    if (!selectedProvider) return;
    setSavingProvider(true);

    const data: {
      enabled?: boolean;
      clientId?: string;
      clientSecret?: string;
      config?: Record<string, unknown>;
    } = {
      enabled: providerConfig.enabled,
    };
    if (providerConfig.clientId) {
      data.clientId = providerConfig.clientId;
    }
    if (providerConfig.clientSecret) {
      data.clientSecret = providerConfig.clientSecret;
    }
    if (selectedProvider.id === 'wechat') {
      data.config = {
        ...(selectedProviderDetail?.config || {}),
        type: 'miniprogram',
      };
    }

    let res;
    if (selectedProvider.configured) {
      res = await api.updateAuthProvider(projectId, selectedProvider.id, data);
    } else {
      res = await api.createAuthProvider(projectId, {
        provider: selectedProvider.id,
        ...data,
      });
    }

    setSavingProvider(false);
    if (res.success) {
      setConfigDialogOpen(false);
      fetchProviders();
      toast({ title: '配置已保存' });
    } else {
      toast({ title: '保存失败', description: res.error?.message, variant: 'destructive' });
    }
  };

  // User handlers
  const handleToggleUserStatus = async (user: ProjectUser) => {
    const newStatus = user.status === 'active' ? 'disabled' : 'active';
    const res = await api.updateProjectUser(projectId, user.id, { status: newStatus });
    if (res.success) {
      fetchUsers();
      toast({ title: newStatus === 'active' ? '用户已启用' : '用户已禁用' });
    } else {
      toast({ title: '操作失败', variant: 'destructive' });
    }
  };

  const handleConfirmDeleteUser = async () => {
    if (!deleteUserTarget) return;
    const res = await api.deleteProjectUser(projectId, deleteUserTarget.id);
    if (res.success) {
      fetchUsers();
      toast({ title: '用户已删除' });
    } else {
      toast({ title: '删除失败', variant: 'destructive' });
    }
    setDeleteUserTarget(null);
  };

  // Config handlers
  const handleSaveConfig = async () => {
    setSavingConfig(true);
    const res = await api.updateAuthConfig(projectId, editedConfig);
    setSavingConfig(false);
    if (res.success && res.data) {
      setConfig(res.data);
      toast({ title: '配置已保存' });
    } else {
      toast({ title: '保存失败', description: res.error?.message, variant: 'destructive' });
    }
  };

  const hasConfigChanges = config && (
    editedConfig.jwtExpiresIn !== config.jwtExpiresIn ||
    editedConfig.refreshTokenExpiresIn !== config.refreshTokenExpiresIn ||
    editedConfig.passwordMinLength !== config.passwordMinLength ||
    editedConfig.requireEmailVerification !== config.requireEmailVerification ||
    editedConfig.allowSignup !== config.allowSignup
  );

  const isWechatProvider = selectedProvider?.id === 'wechat';
  const providerIdLabel = isWechatProvider ? '微信 AppID' : 'Client ID';
  const providerIdPlaceholder = isWechatProvider ? '输入微信小程序 AppID' : '输入 Client ID';
  const providerSecretLabel = isWechatProvider ? '微信 AppSecret' : 'Client Secret';
  const providerSecretPlaceholder = selectedProvider?.configured
    ? '留空保持不变'
    : isWechatProvider
      ? '输入微信小程序 AppSecret'
      : '输入 Client Secret';

  return (
    <DashboardLayout isProjectLevel={true}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
            <Link href={`/t/${tenantId}`} className="hover:text-foreground">
              {currentTenant?.name}
            </Link>
            <span>/</span>
            <Link href={`/t/${tenantId}/p/${projectId}`} className="hover:text-foreground">
              {currentProject?.name}
            </Link>
            <span>/</span>
            <span>认证</span>
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">用户认证</h1>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-1 rounded-md">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              项目级别
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            认证配置在所有环境中共享
          </p>
        </div>
      </div>

      {/* Provider Config Dialog */}
      <Dialog
        open={configDialogOpen}
        onOpenChange={(open) => {
          setConfigDialogOpen(open);
          if (!open) {
            setSelectedProvider(null);
            setSelectedProviderDetail(null);
            setProviderConfigLoading(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              配置 {selectedProvider?.name}
            </DialogTitle>
          </DialogHeader>
          {providerConfigLoading ? (
            <div className="space-y-4 py-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            <div className="space-y-4 py-4">
              {isWechatProvider && (
                <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
                  <div className="text-sm font-medium">微信小程序登录</div>
                  <p className="text-sm text-muted-foreground">
                    这里配置的 AppID 和 AppSecret 会用于项目级 `project-auth` 登录接口。
                  </p>
                  <p className="text-xs text-muted-foreground">
                    当前接入类型固定为微信小程序，登录时会按 `miniprogram` 模式调用微信 `jscode2session`。
                  </p>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="client-id">{providerIdLabel}</Label>
                <Input
                  id="client-id"
                  value={providerConfig.clientId}
                  onChange={(e) => setProviderConfig({ ...providerConfig, clientId: e.target.value })}
                  placeholder={providerIdPlaceholder}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="client-secret">{providerSecretLabel}</Label>
                <Input
                  id="client-secret"
                  type="password"
                  value={providerConfig.clientSecret}
                  onChange={(e) => setProviderConfig({ ...providerConfig, clientSecret: e.target.value })}
                  placeholder={providerSecretPlaceholder}
                />
                {isWechatProvider && (
                  <p className="text-xs text-muted-foreground">
                    对应 taro-app 中的 `WX_APP_SECRET`。编辑已有配置时，留空会保持服务端已保存的密钥不变。
                  </p>
                )}
              </div>
              {isWechatProvider && (
                <div className="space-y-2">
                  <Label>接入类型</Label>
                  <div className="h-9 rounded-md border bg-muted/30 px-3 text-sm flex items-center text-muted-foreground">
                    微信小程序（miniprogram）
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="provider-enabled">启用此提供商</Label>
                  {isWechatProvider && (
                    <p className="text-xs text-muted-foreground mt-1">
                      启用后，客户端可通过 `/api/v1/projects/:projectId/auth/wechat/login` 发起登录。
                    </p>
                  )}
                </div>
                <Switch
                  id="provider-enabled"
                  checked={providerConfig.enabled}
                  onCheckedChange={(checked: boolean) => setProviderConfig({ ...providerConfig, enabled: checked })}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfigDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSaveProvider} disabled={savingProvider || providerConfigLoading}>
              {savingProvider ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete User Confirmation */}
      <AlertDialog open={!!deleteUserTarget} onOpenChange={() => setDeleteUserTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除用户</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除用户 &quot;{deleteUserTarget?.email}&quot; 吗？此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDeleteUser}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Tabs defaultValue="providers" className="space-y-4">
        <TabsList>
          <TabsTrigger value="providers" className="flex items-center gap-2">
            <Shield className="h-4 w-4" />
            认证方式
          </TabsTrigger>
          <TabsTrigger value="users" className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            用户列表
          </TabsTrigger>
          <TabsTrigger value="config" className="flex items-center gap-2">
            <Settings className="h-4 w-4" />
            配置
          </TabsTrigger>
        </TabsList>

        {/* Providers Tab */}
        <TabsContent value="providers">
          <div className="border rounded-lg">
            <div className="p-4 border-b bg-muted/50">
              <h3 className="font-medium">认证提供商</h3>
              <p className="text-sm text-muted-foreground">配置项目支持的用户登录方式</p>
            </div>
            {providersLoading ? (
              <div className="p-4 space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : (
              <div className="divide-y">
                {providers.map((provider) => (
                  <div
                    key={provider.id}
                    className="p-4 flex items-center justify-between hover:bg-muted/50"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{providerIcons[provider.id] || '🔐'}</span>
                      <div>
                        <div className="font-medium">{provider.name}</div>
                        <div className="text-sm text-muted-foreground">
                          {provider.id === 'wechat'
                            ? '微信小程序项目登录'
                            : provider.type === 'builtin'
                              ? '内置'
                              : 'OAuth 2.0'}
                          {provider.configured && provider.hasCredentials && (
                            <span className="ml-2 text-green-600">已配置</span>
                          )}
                          {provider.id === 'wechat' && !provider.configured && (
                            <span className="ml-2">待配置 AppID/AppSecret</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {provider.type === 'oauth' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleProviderClick(provider)}
                        >
                          配置
                        </Button>
                      )}
                      <Switch
                        checked={provider.enabled}
                        onCheckedChange={() => handleToggleProvider(provider)}
                        disabled={provider.type === 'oauth' && !provider.configured}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {/* Users Tab */}
        <TabsContent value="users">
          <div className="border rounded-lg">
            <div className="p-4 border-b bg-muted/50 flex items-center justify-between">
              <div>
                <h3 className="font-medium">项目用户</h3>
                <p className="text-sm text-muted-foreground">
                  共 {usersTotal} 个用户
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="搜索用户..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setUsersPage(0);
                    }}
                    className="pl-9 w-[200px]"
                  />
                </div>
              </div>
            </div>
            {usersLoading ? (
              <div className="p-4 space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : users.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">
                暂无用户
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>用户</TableHead>
                      <TableHead>认证方式</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className="text-right">最后登录</TableHead>
                      <TableHead className="text-right w-[100px]">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((user) => (
                      <TableRow key={user.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            {user.avatarUrl ? (
                              <img
                                src={user.avatarUrl}
                                alt=""
                                className="h-8 w-8 rounded-full"
                              />
                            ) : (
                              <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium">
                                {(user.username || user.email).charAt(0).toUpperCase()}
                              </div>
                            )}
                            <div>
                              <div className="font-medium">{user.username || user.email}</div>
                              {user.username && (
                                <div className="text-sm text-muted-foreground">{user.email}</div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-1">
                            {providerIcons[user.provider] || '🔐'}
                            <span className="capitalize">{user.provider}</span>
                          </span>
                        </TableCell>
                        <TableCell>
                          {user.status === 'active' ? (
                            <span className="inline-flex items-center gap-1 text-green-600">
                              <CheckCircle2 className="h-4 w-4" />
                              活跃
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-muted-foreground">
                              <Ban className="h-4 w-4" />
                              已禁用
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {formatDate(user.lastLoginAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleToggleUserStatus(user)}>
                                {user.status === 'active' ? (
                                  <>
                                    <Ban className="h-4 w-4 mr-2" />
                                    禁用
                                  </>
                                ) : (
                                  <>
                                    <CheckCircle2 className="h-4 w-4 mr-2" />
                                    启用
                                  </>
                                )}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => setDeleteUserTarget(user)}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                删除
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {usersTotal > 20 && (
                  <div className="p-4 border-t flex items-center justify-between">
                    <div className="text-sm text-muted-foreground">
                      第 {usersPage * 20 + 1}-{Math.min((usersPage + 1) * 20, usersTotal)} 条，共 {usersTotal} 条
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={usersPage === 0}
                        onClick={() => setUsersPage(usersPage - 1)}
                      >
                        上一页
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={(usersPage + 1) * 20 >= usersTotal}
                        onClick={() => setUsersPage(usersPage + 1)}
                      >
                        下一页
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </TabsContent>

        {/* Config Tab */}
        <TabsContent value="config">
          <div className="border rounded-lg">
            <div className="p-4 border-b bg-muted/50 flex items-center justify-between">
              <div>
                <h3 className="font-medium">认证配置</h3>
                <p className="text-sm text-muted-foreground">配置 JWT、密码策略等参数</p>
              </div>
              {hasConfigChanges && (
                <Button onClick={handleSaveConfig} disabled={savingConfig}>
                  {savingConfig ? '保存中...' : '保存更改'}
                </Button>
              )}
            </div>
            {configLoading ? (
              <div className="p-4 space-y-4">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : config ? (
              <div className="p-4 space-y-6">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="jwt-expires">JWT 过期时间（秒）</Label>
                    <Input
                      id="jwt-expires"
                      type="number"
                      value={editedConfig.jwtExpiresIn || ''}
                      onChange={(e) => setEditedConfig({
                        ...editedConfig,
                        jwtExpiresIn: parseInt(e.target.value) || 0,
                      })}
                    />
                    <p className="text-xs text-muted-foreground">
                      建议范围: 300-86400（5分钟到24小时）
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="refresh-expires">Refresh Token 过期时间（秒）</Label>
                    <Input
                      id="refresh-expires"
                      type="number"
                      value={editedConfig.refreshTokenExpiresIn || ''}
                      onChange={(e) => setEditedConfig({
                        ...editedConfig,
                        refreshTokenExpiresIn: parseInt(e.target.value) || 0,
                      })}
                    />
                    <p className="text-xs text-muted-foreground">
                      建议范围: 3600-2592000（1小时到30天）
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password-min">密码最小长度</Label>
                  <Input
                    id="password-min"
                    type="number"
                    value={editedConfig.passwordMinLength || ''}
                    onChange={(e) => setEditedConfig({
                      ...editedConfig,
                      passwordMinLength: parseInt(e.target.value) || 0,
                    })}
                    className="w-[200px]"
                  />
                  <p className="text-xs text-muted-foreground">
                    建议范围: 6-128
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label>要求邮箱验证</Label>
                      <p className="text-sm text-muted-foreground">
                        用户注册后需要验证邮箱才能登录
                      </p>
                    </div>
                    <Switch
                      checked={editedConfig.requireEmailVerification ?? false}
                      onCheckedChange={(checked: boolean) => setEditedConfig({
                        ...editedConfig,
                        requireEmailVerification: checked,
                      })}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <Label>允许用户注册</Label>
                      <p className="text-sm text-muted-foreground">
                        关闭后新用户无法自行注册
                      </p>
                    </div>
                    <Switch
                      checked={editedConfig.allowSignup ?? true}
                      onCheckedChange={(checked: boolean) => setEditedConfig({
                        ...editedConfig,
                        allowSignup: checked,
                      })}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-12 text-center text-muted-foreground">
                加载配置失败
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </DashboardLayout>
  );
}
