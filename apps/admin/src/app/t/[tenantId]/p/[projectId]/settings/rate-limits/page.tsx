'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';

interface RateLimitFormData {
  perUser: string;
  perProject: string;
}

interface ProjectSettingsResponse {
  settings?: Record<string, unknown>;
}

export default function RateLimitsPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentTenant, currentProject } = useAppStore();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState<RateLimitFormData>({
    perUser: '',
    perProject: '',
  });

  useEffect(() => {
    async function fetchProject() {
      const res = await api.getProject(projectId);
      if (res.success && res.data) {
        const graphql = ((res.data.settings as Record<string, unknown> | undefined)?.rateLimits as Record<string, unknown> | undefined)
          ?.graphql as Record<string, number> | undefined;

        setFormData({
          perUser: graphql?.perUser?.toString() ?? '',
          perProject: graphql?.perProject?.toString() ?? '',
        });
      } else {
        setError(res.error?.message || '加载项目配置失败');
      }
      setLoading(false);
    }

    void fetchProject();
  }, [projectId]);

  const validate = (): string | null => {
    if (formData.perUser !== '') {
      const value = Number(formData.perUser);
      if (!Number.isInteger(value) || value < 1 || value > 10000) {
        return '每项目内单用户限额必须是 1-10000 的整数';
      }
    }

    if (formData.perProject !== '') {
      const value = Number(formData.perProject);
      if (!Number.isInteger(value) || value < 0 || value > 100000) {
        return '项目总限额必须是 0-100000 的整数';
      }
    }

    return null;
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError('');
    setSaveSuccess(false);

    try {
      const projectRes = await api.getProject(projectId);
      if (!projectRes.success || !projectRes.data) {
        throw new Error(projectRes.error?.message || '加载项目配置失败');
      }

      const currentSettings = ((projectRes.data as ProjectSettingsResponse).settings || {}) as Record<string, unknown>;
      const currentRateLimits = (currentSettings.rateLimits || {}) as Record<string, unknown>;
      const graphqlConfig: Record<string, number> = {};

      if (formData.perUser !== '') {
        graphqlConfig.perUser = Number(formData.perUser);
      }
      if (formData.perProject !== '') {
        graphqlConfig.perProject = Number(formData.perProject);
      }

      const res = await api.updateProject(projectId, {
        settings: {
          rateLimits: {
            ...currentRateLimits,
            graphql: graphqlConfig,
          },
        },
      });

      if (!res.success) {
        throw new Error(res.error?.message || '保存失败，请重试');
      }

      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : '保存失败，请重试';
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <DashboardLayout isProjectLevel={true}>
        <div className="p-8 text-center text-gray-500">加载中...</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout isProjectLevel={true}>
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
          <Link href={`/t/${tenantId}/p/${projectId}/settings`} className="hover:text-foreground">
            设置
          </Link>
          <span>/</span>
          <span>限流配置</span>
        </div>
        <h1 className="text-2xl font-bold">限流配置</h1>
        <p className="text-sm text-muted-foreground mt-1">
          配置 GraphQL API 的请求频率限制
        </p>
      </div>

      <div className="card max-w-2xl">
        <div className="card-header">
          <h2 className="font-semibold">GraphQL 限流</h2>
        </div>
        <form onSubmit={handleSave} className="card-body space-y-6">
          <div>
            <label className="label">每项目内单用户每分钟请求数</label>
            <input
              type="number"
              className="input w-full max-w-xs"
              placeholder="60（默认）"
              min={1}
              max={10000}
              value={formData.perUser}
              onChange={(event) => setFormData({ ...formData, perUser: event.target.value })}
            />
            <p className="text-xs text-gray-500 mt-1">
              单个平台用户、项目终端用户或匿名来源 IP 的最大请求频率。留空使用默认值 60。
            </p>
          </div>

          <div>
            <label className="label">项目总计每分钟请求数</label>
            <input
              type="number"
              className="input w-full max-w-xs"
              placeholder="不限制（默认）"
              min={0}
              max={100000}
              value={formData.perProject}
              onChange={(event) => setFormData({ ...formData, perProject: event.target.value })}
            />
            <p className="text-xs text-gray-500 mt-1">
              项目所有用户的总请求频率。0 或留空表示不限制。
            </p>
          </div>

          <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
            保存时会保留当前 `rateLimits` 下的其他子配置，只更新 `graphql` 项。
          </div>

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <div className="flex items-center gap-3">
            <button type="submit" disabled={saving} className="btn btn-primary">
              {saving ? '保存中...' : '保存'}
            </button>
            {saveSuccess && (
              <span className="text-green-600 text-sm">保存成功</span>
            )}
          </div>
        </form>
      </div>
    </DashboardLayout>
  );
}
