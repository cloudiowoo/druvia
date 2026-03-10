'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Copy, Check, Eye, EyeOff, Database, RefreshCw, Trash2, Plus } from 'lucide-react';

// Dynamic imports to avoid SSR issues with these components
const GraphQLPlayground = dynamic(
  () => import('./components/GraphQLPlayground').then(mod => ({ default: mod.GraphQLPlayground })),
  { ssr: false, loading: () => <div className="flex items-center justify-center h-96">加载中...</div> }
);

const RestClient = dynamic(
  () => import('./components/RestClient').then(mod => ({ default: mod.RestClient })),
  { ssr: false, loading: () => <div className="flex items-center justify-center h-96">加载中...</div> }
);

const ApiDocumentation = dynamic(
  () => import('./components/ApiDocumentation').then(mod => ({ default: mod.ApiDocumentation })),
  { ssr: false, loading: () => <div className="flex items-center justify-center h-96">加载中...</div> }
);

const HASURA_URL = process.env.NEXT_PUBLIC_HASURA_URL || 'http://localhost:8080';
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface DbInfo {
  username: string | null;
  host: string;
  port: number;
  database: string;
  schemaName: string | null;
  hasCredentials: boolean;
  createdAt: string | null;
}

interface DbCredentials {
  username: string;
  password: string;
  host: string;
  port: number;
  database: string;
  schemaName: string;
}

export default function ProjectApiPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentTenant, currentProject, currentEnv } = useAppStore();

  // 获取当前有效的 schema（优先使用环境 schema，否则使用项目 schema）
  const effectiveSchema = currentEnv?.schemaName || currentProject?.schemaName;

  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [showDbPassword, setShowDbPassword] = useState(false);

  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null);
  const [dbCredentials, setDbCredentials] = useState<DbCredentials | null>(null);
  const [creatingUser, setCreatingUser] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [deletingUser, setDeletingUser] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const graphqlEndpoint = `${HASURA_URL}/v1/graphql`;
  const restEndpoint = effectiveSchema
    ? `${API_URL}/api/v1/schemas/${effectiveSchema}`
    : `${API_URL}/api/v1/schemas/<schema>`;

  // Hasura URL for GraphQL playground (credentials handled server-side via proxy)
  const hasuraUrl = HASURA_URL;

  useEffect(() => {
    const loadDbInfo = async () => {
      try {
        const res = await api.getProjectDbInfo(projectId);
        if (res.success && res.data) {
          setDbInfo(res.data);
        }
      } catch {
        // 静默处理初始加载错误
      }
    };
    loadDbInfo();
  }, [projectId]);

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      setError('复制失败，请手动复制');
    }
  };

  const CopyButton = ({ text, field }: { text: string; field: string }) => (
    <button
      onClick={() => copyToClipboard(text, field)}
      className="p-2 hover:bg-gray-100 rounded transition-colors"
      title="复制"
    >
      {copiedField === field ? (
        <Check className="h-4 w-4 text-green-600" />
      ) : (
        <Copy className="h-4 w-4 text-gray-500" />
      )}
    </button>
  );

  const handleCreateDbUser = async () => {
    setCreatingUser(true);
    setError(null);
    try {
      const res = await api.createProjectDbUser(projectId);
      if (res.success && res.data) {
        setDbCredentials(res.data);
        setDbInfo(prev => prev ? { ...prev, hasCredentials: true, username: res.data!.username } : null);
        setShowDbPassword(true);
      } else {
        setError(res.error?.message || '创建失败');
      }
    } catch {
      setError('创建数据库用户失败');
    } finally {
      setCreatingUser(false);
    }
  };

  const handleResetPassword = async () => {
    if (!confirm('确定要重置数据库密码吗？旧密码将立即失效。')) return;
    setResettingPassword(true);
    setError(null);
    try {
      const res = await api.resetProjectDbPassword(projectId);
      if (res.success && res.data) {
        setDbCredentials(res.data);
        setShowDbPassword(true);
      } else {
        setError(res.error?.message || '重置失败');
      }
    } catch {
      setError('重置密码失败');
    } finally {
      setResettingPassword(false);
    }
  };

  const handleDeleteDbUser = async () => {
    if (!confirm('确定要删除数据库用户吗？所有使用此凭证的连接将断开。')) return;
    setDeletingUser(true);
    setError(null);
    try {
      const res = await api.deleteProjectDbUser(projectId);
      if (res.success) {
        setDbCredentials(null);
        setDbInfo(prev => prev ? { ...prev, hasCredentials: false, username: null } : null);
      } else {
        setError(res.error?.message || '删除失败');
      }
    } catch {
      setError('删除数据库用户失败');
    } finally {
      setDeletingUser(false);
    }
  };

  const isLoading = creatingUser || resettingPassword || deletingUser;

  const connectionString = dbCredentials
    ? `postgresql://${dbCredentials.username}:${dbCredentials.password}@${dbCredentials.host}:${dbCredentials.port}/${dbCredentials.database}?options=-c%20search_path%3D${dbCredentials.schemaName}`
    : dbInfo?.hasCredentials && dbInfo.username
    ? `postgresql://${dbInfo.username}:<password>@${dbInfo.host}:${dbInfo.port}/${dbInfo.database}?options=-c%20search_path%3D${dbInfo.schemaName}`
    : null;

  return (
    <DashboardLayout>
      {/* 面包屑 */}
      <nav className="mb-6 text-sm text-gray-500">
        <Link href="/t" className="hover:text-gray-700">租户</Link>
        <span className="mx-2">/</span>
        <Link href={`/t/${tenantId}`} className="hover:text-gray-700">{currentTenant?.name || tenantId}</Link>
        <span className="mx-2">/</span>
        <Link href={`/t/${tenantId}/p/${projectId}`} className="hover:text-gray-700">{currentProject?.name || projectId}</Link>
        <span className="mx-2">/</span>
        <span className="text-gray-900">API</span>
      </nav>

      <h1 className="text-2xl font-bold mb-6">API</h1>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {error}
        </div>
      )}

      <Tabs defaultValue="config" className="space-y-4">
        <TabsList>
          <TabsTrigger value="config">配置</TabsTrigger>
          <TabsTrigger value="graphql">GraphQL</TabsTrigger>
          <TabsTrigger value="rest">REST</TabsTrigger>
          <TabsTrigger value="docs">文档</TabsTrigger>
        </TabsList>

        {/* 配置 Tab - 原有内容 */}
        <TabsContent value="config" className="space-y-6">
          {/* GraphQL 端点 */}
          <div className="bg-white rounded-lg border p-6">
            <h2 className="text-lg font-semibold mb-4">GraphQL 端点</h2>
            <div className="flex items-center gap-2 bg-gray-50 p-3 rounded font-mono text-sm">
              <span className="flex-1 truncate">{graphqlEndpoint}</span>
              <CopyButton text={graphqlEndpoint} field="graphql" />
            </div>
          </div>

          {/* REST API 端点 */}
          <div className="bg-white rounded-lg border p-6">
            <h2 className="text-lg font-semibold mb-4">REST API 端点</h2>
            <div className="flex items-center gap-2 bg-gray-50 p-3 rounded font-mono text-sm">
              <span className="flex-1 truncate">{restEndpoint}</span>
              <CopyButton text={restEndpoint} field="rest" />
            </div>
          </div>

          {/* 数据库直连 */}
          <div className="bg-white rounded-lg border p-6">
            <div className="flex items-center gap-2 mb-4">
              <Database className="h-5 w-5 text-blue-600" />
              <h2 className="text-lg font-semibold">数据库直连</h2>
            </div>

            {!dbInfo?.hasCredentials ? (
              <div className="text-center py-8">
                <Database className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                <p className="text-gray-500 mb-4">尚未创建数据库用户</p>
                <p className="text-sm text-gray-400 mb-6">
                  创建数据库用户后，可使用 DBeaver、Navicat 等工具直接连接数据库
                </p>
                <button
                  onClick={handleCreateDbUser}
                  disabled={isLoading}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" />
                  {creatingUser ? '创建中...' : '创建数据库用户'}
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {connectionString && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">连接字符串</label>
                    <div className="flex items-center gap-2 bg-gray-50 p-3 rounded font-mono text-xs break-all">
                      <span className="flex-1">{connectionString}</span>
                      <CopyButton text={connectionString} field="connStr" />
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">主机</label>
                    <div className="flex items-center gap-2 bg-gray-50 p-2 rounded font-mono text-sm">
                      <span className="flex-1">{dbInfo?.host || dbCredentials?.host}</span>
                      <CopyButton text={dbInfo?.host || dbCredentials?.host || ''} field="host" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">端口</label>
                    <div className="flex items-center gap-2 bg-gray-50 p-2 rounded font-mono text-sm">
                      <span className="flex-1">{dbInfo?.port || dbCredentials?.port}</span>
                      <CopyButton text={String(dbInfo?.port || dbCredentials?.port || '')} field="port" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">数据库</label>
                    <div className="flex items-center gap-2 bg-gray-50 p-2 rounded font-mono text-sm">
                      <span className="flex-1">{dbInfo?.database || dbCredentials?.database}</span>
                      <CopyButton text={dbInfo?.database || dbCredentials?.database || ''} field="database" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Schema</label>
                    <div className="flex items-center gap-2 bg-gray-50 p-2 rounded font-mono text-sm">
                      <span className="flex-1">{dbInfo?.schemaName || dbCredentials?.schemaName}</span>
                      <CopyButton text={dbInfo?.schemaName || dbCredentials?.schemaName || ''} field="schema" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">用户名</label>
                    <div className="flex items-center gap-2 bg-gray-50 p-2 rounded font-mono text-sm">
                      <span className="flex-1">{dbInfo?.username || dbCredentials?.username}</span>
                      <CopyButton text={dbInfo?.username || dbCredentials?.username || ''} field="username" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
                    <div className="flex items-center gap-2 bg-gray-50 p-2 rounded font-mono text-sm">
                      {dbCredentials?.password ? (
                        <>
                          <span className="flex-1">
                            {showDbPassword ? dbCredentials.password : '••••••••••••••••'}
                          </span>
                          <button
                            onClick={() => setShowDbPassword(!showDbPassword)}
                            className="p-1 hover:bg-gray-100 rounded"
                          >
                            {showDbPassword ? <EyeOff className="h-4 w-4 text-gray-500" /> : <Eye className="h-4 w-4 text-gray-500" />}
                          </button>
                          <CopyButton text={dbCredentials.password} field="password" />
                        </>
                      ) : (
                        <span className="flex-1 text-gray-400">密码仅在创建或重置时显示一次</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-4 border-t">
                  <button
                    onClick={handleResetPassword}
                    disabled={isLoading}
                    className="inline-flex items-center gap-2 px-3 py-2 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-4 w-4 ${resettingPassword ? 'animate-spin' : ''}`} />
                    {resettingPassword ? '重置中...' : '重置密码'}
                  </button>
                  <button
                    onClick={handleDeleteDbUser}
                    disabled={isLoading}
                    className="inline-flex items-center gap-2 px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                    {deletingUser ? '删除中...' : '删除用户'}
                  </button>
                </div>

                <div className="mt-4 p-4 bg-blue-50 rounded-lg text-sm">
                  <h4 className="font-medium text-blue-900 mb-2">连接说明</h4>
                  <ul className="text-blue-800 space-y-1 list-disc list-inside">
                    <li>使用 DBeaver、Navicat、pgAdmin 等工具连接</li>
                    <li>数据库用户仅能访问当前项目的 Schema</li>
                    <li>支持完整的 DDL/DML 操作权限</li>
                    <li>密码仅在创建或重置时显示一次，请妥善保存</li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        {/* GraphQL Tab */}
        <TabsContent value="graphql" className="h-[calc(100vh-220px)] min-h-[500px]">
          <GraphQLPlayground hasuraUrl={hasuraUrl} projectId={projectId} />
        </TabsContent>

        {/* REST Tab */}
        <TabsContent value="rest" className="h-[calc(100vh-220px)] min-h-[500px]">
          <RestClient projectId={projectId} />
        </TabsContent>

        {/* 文档 Tab */}
        <TabsContent value="docs" className="h-[calc(100vh-220px)] min-h-[500px]">
          <ApiDocumentation projectId={projectId} />
        </TabsContent>
      </Tabs>
    </DashboardLayout>
  );
}
