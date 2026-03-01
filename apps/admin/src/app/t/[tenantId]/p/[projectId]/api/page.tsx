'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { Copy, Check, Eye, EyeOff } from 'lucide-react';

const HASURA_URL = process.env.NEXT_PUBLIC_HASURA_URL || 'http://localhost:8080';
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export default function ProjectApiPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentTenant, currentProject } = useAppStore();

  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);

  const graphqlEndpoint = `${HASURA_URL}/v1/graphql`;
  const restEndpoint = `${API_URL}/api/v1/schemas/${currentProject?.schemaName}`;
  // TODO: 从后端获取真实 API Key
  const apiKey = currentProject ? `sk_${currentProject.projectId.slice(0, 32)}` : '';

  const copyToClipboard = async (text: string, field: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
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

  return (
    <DashboardLayout>
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link href={`/t/${tenantId}`} className="hover:text-foreground">
            {currentTenant?.name}
          </Link>
          <span>/</span>
          <Link href={`/t/${tenantId}/p/${projectId}`} className="hover:text-foreground">
            {currentProject?.name}
          </Link>
          <span>/</span>
          <span>API</span>
        </div>
        <h1 className="text-2xl font-bold">API 配置</h1>
        <p className="text-gray-500">查看 API 端点和密钥</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* GraphQL 端点 */}
        <div className="card">
          <div className="card-header">
            <h2 className="font-semibold">GraphQL 端点</h2>
          </div>
          <div className="card-body space-y-4">
            <div>
              <label className="label">端点 URL</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  className="input w-full font-mono text-sm bg-gray-50"
                  value={graphqlEndpoint}
                  readOnly
                />
                <CopyButton text={graphqlEndpoint} field="graphql" />
              </div>
            </div>
            <div className="text-sm text-gray-600">
              <p className="mb-2">使用 GraphQL 查询数据：</p>
              <pre className="bg-gray-100 p-3 rounded text-xs overflow-x-auto">
{`query {
  ${currentProject?.schemaName?.replace(/-/g, '_') || 'your_table'}(limit: 10) {
    id
    created_at
  }
}`}
              </pre>
            </div>
          </div>
        </div>

        {/* REST 端点 */}
        <div className="card">
          <div className="card-header">
            <h2 className="font-semibold">REST API 端点</h2>
          </div>
          <div className="card-body space-y-4">
            <div>
              <label className="label">基础 URL</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  className="input w-full font-mono text-sm bg-gray-50"
                  value={restEndpoint}
                  readOnly
                />
                <CopyButton text={restEndpoint} field="rest" />
              </div>
            </div>
            <div className="text-sm text-gray-600">
              <p className="mb-2">可用端点：</p>
              <ul className="space-y-1 text-xs font-mono">
                <li>GET /tables - 列出所有表</li>
                <li>GET /tables/:name - 获取表结构</li>
                <li>GET /tables/:name/rows - 查询数据</li>
                <li>POST /tables/:name/rows - 插入数据</li>
              </ul>
            </div>
          </div>
        </div>

        {/* API 密钥 */}
        <div className="card lg:col-span-2">
          <div className="card-header">
            <h2 className="font-semibold">API 密钥</h2>
          </div>
          <div className="card-body space-y-4">
            <div>
              <label className="label">当前密钥</label>
              <div className="flex items-center gap-2">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  className="input w-full font-mono text-sm bg-gray-50"
                  value={apiKey}
                  readOnly
                />
                <button
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="p-2 hover:bg-gray-100 rounded transition-colors"
                  title={showApiKey ? '隐藏' : '显示'}
                >
                  {showApiKey ? (
                    <EyeOff className="h-4 w-4 text-gray-500" />
                  ) : (
                    <Eye className="h-4 w-4 text-gray-500" />
                  )}
                </button>
                <CopyButton text={apiKey} field="apikey" />
              </div>
              <p className="text-xs text-gray-500 mt-1">
                请妥善保管 API 密钥，不要在客户端代码中暴露
              </p>
            </div>
            <div className="flex gap-3">
              <button className="btn btn-primary" disabled>
                生成新密钥
              </button>
              <button className="btn" disabled>
                撤销密钥
              </button>
            </div>
            <p className="text-xs text-gray-500">
              API 密钥管理功能即将上线
            </p>
          </div>
        </div>

        {/* 使用说明 */}
        <div className="card lg:col-span-2">
          <div className="card-header">
            <h2 className="font-semibold">使用说明</h2>
          </div>
          <div className="card-body">
            <div className="prose prose-sm max-w-none">
              <h4>认证方式</h4>
              <p>在请求头中添加 Authorization：</p>
              <pre className="bg-gray-100 p-3 rounded text-xs">
{`curl -H "Authorization: Bearer YOUR_API_KEY" \\
  ${graphqlEndpoint}`}
              </pre>

              <h4 className="mt-4">GraphQL 示例</h4>
              <pre className="bg-gray-100 p-3 rounded text-xs">
{`curl -X POST ${graphqlEndpoint} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{"query": "{ your_table(limit: 10) { id } }"}'`}
              </pre>

              <h4 className="mt-4">REST API 示例</h4>
              <pre className="bg-gray-100 p-3 rounded text-xs">
{`curl ${restEndpoint}/tables/your_table/rows \\
  -H "Authorization: Bearer YOUR_API_KEY"`}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
