'use client';

import { useEffect, useState, useCallback } from 'react';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
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
} from 'lucide-react';

interface TableSubscription {
  tableName: string;
  schemaName: string;
  enabled: boolean;
  operations: ('INSERT' | 'UPDATE' | 'DELETE')[];
  hasSelectPermission: boolean;
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
  const { currentProject, currentTenant } = useAppStore();

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

  // Test connection state
  const [testTable, setTestTable] = useState<string>('');
  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);

  // Fetch subscriptions
  const fetchSubscriptions = useCallback(async () => {
    const res = await api.listRealtimeSubscriptions(projectId);
    if (res.success && res.data) {
      setSubscriptions(res.data.subscriptions);
      setStats(res.data.stats);
    }
    setLoading(false);
  }, [projectId]);

  // Fetch config
  const fetchConfig = useCallback(async () => {
    const res = await api.getRealtimeConfig(projectId);
    if (res.success && res.data) {
      setConfig(res.data);
    }
    setConfigLoading(false);
  }, [projectId]);

  useEffect(() => {
    fetchSubscriptions();
    fetchConfig();
  }, [fetchSubscriptions, fetchConfig]);

  // Toggle subscription
  const handleToggleSubscription = async (tableName: string, enabled: boolean) => {
    setUpdatingTable(tableName);
    const res = await api.configureRealtimeSubscription(projectId, tableName, { enabled });
    if (res.success) {
      setSubscriptions((prev) =>
        prev.map((s) => (s.tableName === tableName ? { ...s, enabled } : s))
      );
      toast({ title: enabled ? '订阅已启用' : '订阅已禁用' });
    } else {
      toast({ title: '操作失败', description: res.error?.message, variant: 'destructive' });
    }
    setUpdatingTable(null);
  };

  // Get code example
  const handleGetExample = async (tableName: string) => {
    setSelectedTable(tableName);
    setExampleLoading(true);
    const res = await api.getSubscriptionExample(projectId, tableName);
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

  // Simulate test connection (actual WebSocket would require more setup)
  const handleTestConnect = () => {
    if (!testTable) {
      toast({ title: '请选择一个表', variant: 'destructive' });
      return;
    }
    setIsConnected(true);
    setMessages((prev) => [...prev, `[${new Date().toLocaleTimeString()}] 连接到 ${testTable} 订阅...`]);
    setMessages((prev) => [...prev, `[${new Date().toLocaleTimeString()}] 等待数据变更...`]);
  };

  const handleTestDisconnect = () => {
    setIsConnected(false);
    setMessages((prev) => [...prev, `[${new Date().toLocaleTimeString()}] 已断开连接`]);
  };

  const clearMessages = () => {
    setMessages([]);
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
          <h1 className="text-2xl font-bold">Realtime</h1>
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
              <CardTitle>表订阅配置</CardTitle>
              <CardDescription>
                启用订阅后，客户端可以通过 GraphQL Subscriptions 实时接收表数据变更
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
                      <TableHead>状态</TableHead>
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
                            {sub.enabled ? (
                              <span className="text-green-600 text-sm flex items-center gap-1">
                                <CheckCircle className="h-3 w-3" /> 已启用
                              </span>
                            ) : (
                              <span className="text-gray-400 text-sm flex items-center gap-1">
                                <XCircle className="h-3 w-3" /> 未启用
                              </span>
                            )}
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
                      {config.hasuraConnected ? (
                        <>
                          <CheckCircle className="h-5 w-5 text-green-500" />
                          <span className="text-green-600">Hasura 已连接</span>
                        </>
                      ) : (
                        <>
                          <WifiOff className="h-5 w-5 text-red-500" />
                          <span className="text-red-600">Hasura 未连接</span>
                        </>
                      )}
                    </div>
                    <div className="space-y-2 text-sm">
                      <div>
                        <span className="text-muted-foreground">Schema:</span>{' '}
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
              <CardTitle>订阅测试</CardTitle>
              <CardDescription>
                测试订阅连接（注意：这是模拟测试，实际订阅需要在客户端应用中实现）
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <Select value={testTable} onValueChange={setTestTable}>
                    <SelectTrigger className="w-[200px]">
                      <SelectValue placeholder="选择表" />
                    </SelectTrigger>
                    <SelectContent>
                      {subscriptions
                        .filter((s) => s.enabled)
                        .map((s) => (
                          <SelectItem key={s.tableName} value={s.tableName}>
                            {s.tableName}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>

                  {isConnected ? (
                    <Button variant="destructive" onClick={handleTestDisconnect}>
                      <Square className="h-4 w-4 mr-2" />
                      断开连接
                    </Button>
                  ) : (
                    <Button onClick={handleTestConnect} disabled={!testTable}>
                      <Play className="h-4 w-4 mr-2" />
                      连接
                    </Button>
                  )}

                  <Button variant="outline" onClick={clearMessages}>
                    清除日志
                  </Button>
                </div>

                <div className="bg-gray-900 text-green-400 font-mono text-sm p-4 rounded-lg h-[300px] overflow-y-auto">
                  {messages.length === 0 ? (
                    <p className="text-gray-500">选择一个已启用订阅的表，然后点击连接...</p>
                  ) : (
                    messages.map((msg, i) => (
                      <div key={i}>{msg}</div>
                    ))
                  )}
                </div>

                <div className="bg-muted/50 p-4 rounded-lg">
                  <h4 className="font-medium mb-2">使用说明</h4>
                  <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1">
                    <li>确保目标表已启用订阅</li>
                    <li>在客户端应用中使用 graphql-ws 库连接到 WebSocket 端点</li>
                    <li>发送 GraphQL subscription 查询</li>
                    <li>当表数据变更时，会实时收到更新</li>
                  </ol>
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
