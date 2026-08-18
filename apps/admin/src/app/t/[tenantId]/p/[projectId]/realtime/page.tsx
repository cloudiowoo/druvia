'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import {
  getRealtimeLabel,
  getRealtimeToggleMessage,
  type RealtimeAccessStatus,
} from '@/lib/data-interface-status';
import {
  startRealtimeConnectionTest,
  type RealtimeConnectionTestState,
} from '@/lib/realtime-connection-test';
import type { RealtimeTestCredential } from '@/lib/api';
import {
  Radio,
  Wifi,
  WifiOff,
  Code,
  Copy,
  CheckCircle,
  XCircle,
  Play,
  Square,
  RefreshCw,
  LoaderCircle,
} from 'lucide-react';

interface TableSubscription {
  tableName: string;
  schemaName: string;
  enabled: boolean;
  operations: ('INSERT' | 'UPDATE' | 'DELETE')[];
  hasAuthenticatedRead: boolean;
  hasAnonymousRead: boolean;
  hasSelectPermission: boolean;
  permissionStatus: 'known' | 'unknown';
  accessStatus: RealtimeAccessStatus;
}

interface SubscriptionStats {
  totalTables: number;
  enabledTables: number;
  disabledTables: number;
}

interface RealtimeConfig {
  schemaName: string;
  websocketEndpoint: string;
  graphqlEndpoint: string;
  runtimeAvailability: 'available' | 'environment_identity_required';
  hasuraConnected: boolean;
}

interface CodeExample {
  language: 'javascript' | 'graphql';
  code: string;
  description: string;
}

export default function RealtimePage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentProject, currentTenant, currentEnv } = useAppStore();

  // 获取当前环境名称
  const envName = currentEnv?.envName;

  // State
  const [subscriptions, setSubscriptions] = useState<TableSubscription[]>([]);
  const [stats, setStats] = useState<SubscriptionStats | null>(null);
  const [config, setConfig] = useState<RealtimeConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [configLoading, setConfigLoading] = useState(true);
  const [updatingTable, setUpdatingTable] = useState<string | null>(null);

  // Code example dialog
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [codeExamples, setCodeExamples] = useState<CodeExample[]>([]);
  const [exampleLoading, setExampleLoading] = useState(false);

  const [credentialKind, setCredentialKind] = useState<RealtimeTestCredential['kind']>('apikey');
  const [credential, setCredential] = useState('');
  const [connectionState, setConnectionState] = useState<RealtimeConnectionTestState>('disconnected');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const probeRef = useRef<{ dispose: () => void } | null>(null);
  const connectionAttemptRef = useRef(0);

  // Fetch subscriptions
  const fetchSubscriptions = useCallback(async () => {
    const res = await api.listRealtimeSubscriptions(projectId, envName);
    if (res.success && res.data) {
      setSubscriptions(res.data.subscriptions);
      setStats(res.data.stats);
    }
    setLoading(false);
  }, [projectId, envName]);

  // Fetch config
  const fetchConfig = useCallback(async () => {
    const res = await api.getRealtimeConfig(projectId, envName);
    if (res.success && res.data) {
      setConfig(res.data);
    }
    setConfigLoading(false);
  }, [projectId, envName]);

  useEffect(() => {
    fetchSubscriptions();
    fetchConfig();
  }, [fetchSubscriptions, fetchConfig]);

  useEffect(() => () => {
    connectionAttemptRef.current += 1;
    probeRef.current?.dispose();
    probeRef.current = null;
  }, []);

  // Toggle subscription
  const handleToggleSubscription = async (tableName: string, enabled: boolean) => {
    setUpdatingTable(tableName);
    const res = await api.configureRealtimeSubscription(projectId, tableName, { enabled }, envName);
    if (res.success && res.data) {
      const previous = subscriptions.find((subscription) => subscription.tableName === tableName);
      setSubscriptions((prev) =>
        prev.map((subscription) => (
          subscription.tableName === tableName ? res.data! : subscription
        ))
      );
      if (previous && previous.enabled !== enabled) {
        setStats((current) => current ? {
          ...current,
          enabledTables: current.enabledTables + (enabled ? 1 : -1),
          disabledTables: current.disabledTables + (enabled ? -1 : 1),
        } : current);
      }
      toast({ title: getRealtimeToggleMessage(enabled, res.data.accessStatus) });
    } else {
      toast({ title: '操作失败', description: res.error?.message, variant: 'destructive' });
    }
    setUpdatingTable(null);
  };

  // Get code example
  const handleGetExample = async (tableName: string) => {
    setSelectedTable(tableName);
    setExampleLoading(true);
    const res = await api.getSubscriptionExample(projectId, tableName, undefined, envName);
    if (res.success && res.data) {
      setCodeExamples(res.data);
    }
    setExampleLoading(false);
  };

  // Copy code to clipboard
  const copyCode = async (code: string) => {
    await navigator.clipboard.writeText(code);
    toast({ title: '代码已复制到剪贴板' });
  };

  const handleTestConnect = async () => {
    if (!credential.trim() || config?.runtimeAvailability !== 'available') {
      return;
    }
    const attempt = ++connectionAttemptRef.current;
    probeRef.current?.dispose();
    probeRef.current = null;
    setConnectionError(null);
    setConnectionState('connecting');

    const result = await api.issueRealtimeToken(projectId, {
      kind: credentialKind,
      value: credential.trim(),
    });
    if (attempt !== connectionAttemptRef.current) return;
    if (!result.success || !result.data) {
      setConnectionState('failed');
      setConnectionError(result.error?.message || '无法建立实时连接');
      return;
    }

    probeRef.current = startRealtimeConnectionTest({
      websocketUrl: result.data.websocketUrl,
      token: result.data.token,
      onState: (state, error) => {
        if (attempt !== connectionAttemptRef.current) return;
        setConnectionState(state);
        setConnectionError(error?.message ?? null);
      },
    });
  };

  const handleTestDisconnect = () => {
    connectionAttemptRef.current += 1;
    probeRef.current?.dispose();
    probeRef.current = null;
    setCredential('');
    setConnectionError(null);
    setConnectionState('disconnected');
  };

  const connectionUnavailable = envName !== undefined
    ? envName !== 'prod'
    : config?.runtimeAvailability === 'environment_identity_required';
  const connectionActive = connectionState === 'connecting' || connectionState === 'connected';
  const connectionLabels: Record<RealtimeConnectionTestState, string> = {
    connecting: '连接中',
    connected: '已连接',
    failed: '连接失败',
    disconnected: '未连接',
  };

  return (
    <DashboardLayout>
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
            <span>实时订阅</span>
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">实时更新</h1>
            {currentEnv && currentEnv.envName !== 'prod' && (
              <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">
                {currentEnv.envName}
              </span>
            )}
          </div>
        </div>
        <Button variant="outline" onClick={() => { fetchSubscriptions(); fetchConfig(); }}>
          <RefreshCw className="h-4 w-4 mr-2" />
          刷新
        </Button>
      </div>

      <Tabs defaultValue="subscriptions" className="space-y-6">
        <TabsList>
          <TabsTrigger value="subscriptions">订阅配置</TabsTrigger>
          <TabsTrigger value="config">连接信息</TabsTrigger>
          <TabsTrigger value="test">测试</TabsTrigger>
        </TabsList>

        {/* Subscriptions Tab */}
        <TabsContent value="subscriptions">
          {/* Stats Cards */}
          {stats && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    总表数
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{stats.totalTables}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    已启用
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-green-600">{stats.enabledTables}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    未启用
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-gray-400">{stats.disabledTables}</div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Table List */}
          <Card>
            <CardHeader>
              <CardTitle>实时数据表</CardTitle>
              <CardDescription>
                管理客户端需要实时接收变更的数据表
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : subscriptions.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Radio className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>暂无可订阅的表</p>
                  <p className="text-sm">请先在数据库中创建表</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>表名</TableHead>
                      <TableHead>操作类型</TableHead>
                      <TableHead>实时状态</TableHead>
                      <TableHead>读取权限</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {subscriptions.map((sub) => (
                      <TableRow key={sub.tableName}>
                        <TableCell className="font-mono">{sub.tableName}</TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {sub.operations.map((op) => (
                              <Badge key={op} variant="secondary" className="text-xs">
                                {op}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={sub.enabled}
                              disabled={updatingTable === sub.tableName}
                              onCheckedChange={(checked) =>
                                handleToggleSubscription(sub.tableName, checked)
                              }
                            />
                            {sub.accessStatus === 'ready' ? (
                              <span className="text-green-600 text-sm flex items-center gap-1">
                                <CheckCircle className="h-3 w-3" /> {getRealtimeLabel(sub.accessStatus)}
                              </span>
                            ) : sub.accessStatus === 'access_required' ? (
                              <span className="text-amber-600 text-sm flex items-center gap-1">
                                <XCircle className="h-3 w-3" /> {getRealtimeLabel(sub.accessStatus)}
                              </span>
                            ) : (
                              <span className="text-gray-400 text-sm flex items-center gap-1">
                                <XCircle className="h-3 w-3" /> {getRealtimeLabel(sub.accessStatus)}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Badge variant={sub.hasAuthenticatedRead ? 'default' : 'outline'}>
                              {sub.hasAuthenticatedRead ? '认证用户可读' : '认证用户不可读'}
                            </Badge>
                            <Badge variant={sub.hasAnonymousRead ? 'default' : 'outline'}>
                              {sub.hasAnonymousRead ? '匿名用户可读' : '匿名用户不可读'}
                            </Badge>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleGetExample(sub.tableName)}
                          >
                            <Code className="h-4 w-4 mr-1" />
                            示例代码
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Config Tab */}
        <TabsContent value="config">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Wifi className="h-5 w-5" />
                  连接状态
                </CardTitle>
              </CardHeader>
              <CardContent>
                {configLoading ? (
                  <Skeleton className="h-20 w-full" />
                ) : config ? (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      {connectionUnavailable ? (
                        <>
                          <WifiOff className="h-5 w-5 text-amber-500" />
                          <span className="text-amber-700">
                            当前环境暂不提供应用 Realtime 连接
                          </span>
                        </>
                      ) : config.hasuraConnected ? (
                        <>
                          <CheckCircle className="h-5 w-5 text-green-500" />
                          <span className="text-green-600">实时服务已连接</span>
                        </>
                      ) : (
                        <>
                          <WifiOff className="h-5 w-5 text-red-500" />
                          <span className="text-red-600">实时服务未连接</span>
                        </>
                      )}
                    </div>
                    <div className="space-y-2 text-sm">
                      <div>
                        <span className="text-muted-foreground">数据环境:</span>{' '}
                        <code className="bg-muted px-2 py-1 rounded">{config.schemaName}</code>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground">无法获取配置</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>连接端点</CardTitle>
                <CardDescription>使用以下端点连接到 GraphQL Subscriptions</CardDescription>
              </CardHeader>
              <CardContent>
                {configLoading ? (
                  <Skeleton className="h-20 w-full" />
                ) : config && connectionUnavailable ? (
                  <p className="text-sm text-muted-foreground">
                    当前环境没有可用的应用连接端点
                  </p>
                ) : config ? (
                  <div className="space-y-4">
                    <div>
                      <label className="text-sm text-muted-foreground">WebSocket 端点</label>
                      <div className="flex items-center gap-2 mt-1">
                        <code className="flex-1 bg-muted px-3 py-2 rounded text-sm break-all">
                          {config.websocketEndpoint}
                        </code>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => copyCode(config.websocketEndpoint)}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <div>
                      <label className="text-sm text-muted-foreground">GraphQL 端点</label>
                      <div className="flex items-center gap-2 mt-1">
                        <code className="flex-1 bg-muted px-3 py-2 rounded text-sm break-all">
                          {config.graphqlEndpoint}
                        </code>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => copyCode(config.graphqlEndpoint)}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Test Tab */}
        <TabsContent value="test">
          <Card>
            <CardHeader>
              <CardTitle>连接测试</CardTitle>
              <CardDescription>使用应用凭证验证短期 Realtime 连接</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-5">
                {connectionUnavailable && (
                  <div className="border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    当前环境暂不支持应用身份连接测试
                  </div>
                )}

                <div className="inline-flex h-9 items-center border bg-muted p-1">
                  <Button
                    type="button"
                    size="sm"
                    variant={credentialKind === 'apikey' ? 'default' : 'ghost'}
                    onClick={() => setCredentialKind('apikey')}
                    disabled={connectionActive}
                  >
                    API Key
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={credentialKind === 'project_token' ? 'default' : 'ghost'}
                    onClick={() => setCredentialKind('project_token')}
                    disabled={connectionActive}
                  >
                    Project Token
                  </Button>
                </div>

                <div className="max-w-xl space-y-2">
                  <label htmlFor="realtime-credential" className="text-sm font-medium">
                    应用凭证
                  </label>
                  <Input
                    id="realtime-credential"
                    type="password"
                    value={credential}
                    onChange={(event) => setCredential(event.target.value)}
                    disabled={connectionActive || connectionUnavailable}
                    autoComplete="off"
                  />
                </div>

                <div className="flex items-center gap-3">
                  {connectionActive ? (
                    <Button variant="destructive" onClick={handleTestDisconnect}>
                      <Square className="h-4 w-4 mr-2" />
                      断开连接
                    </Button>
                  ) : (
                    <Button
                      onClick={handleTestConnect}
                      disabled={!credential.trim() || connectionUnavailable || configLoading}
                    >
                      <Play className="h-4 w-4 mr-2" />
                      连接
                    </Button>
                  )}
                </div>

                <div className="border px-4 py-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {connectionState === 'connecting' ? (
                      <LoaderCircle className="h-4 w-4 animate-spin text-blue-600" />
                    ) : connectionState === 'connected' ? (
                      <CheckCircle className="h-4 w-4 text-green-600" />
                    ) : connectionState === 'failed' ? (
                      <XCircle className="h-4 w-4 text-red-600" />
                    ) : (
                      <WifiOff className="h-4 w-4 text-muted-foreground" />
                    )}
                    {connectionLabels[connectionState]}
                  </div>
                  {connectionError && (
                    <p className="mt-2 text-sm text-red-600">{connectionError}</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Code Example Dialog */}
      <Dialog open={!!selectedTable} onOpenChange={() => setSelectedTable(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>订阅代码示例 - {selectedTable}</DialogTitle>
            <DialogDescription>
              复制以下代码到你的应用中使用
            </DialogDescription>
          </DialogHeader>
          {exampleLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <div className="space-y-6">
              {codeExamples.map((example, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium">{example.description}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => copyCode(example.code)}
                    >
                      <Copy className="h-4 w-4 mr-1" />
                      复制
                    </Button>
                  </div>
                  <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm">
                    <code>{example.code}</code>
                  </pre>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
