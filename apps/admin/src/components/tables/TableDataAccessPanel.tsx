'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, Save, ShieldCheck, UserRound } from 'lucide-react';
import { api } from '@/lib/api';
import {
  cloneTableDataAccessPolicy,
  getTableDataAccessValidationError,
  hasUnrestrictedWriteAccess,
  requiresOwnerColumn,
  type AuthenticatedDataOperation,
  type TableAccessMode,
  type TableDataAccessPolicy,
  type TableDataAccessState,
} from '@/lib/table-data-access';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';

const OPERATIONS: Array<{ key: AuthenticatedDataOperation; label: string }> = [
  { key: 'select', label: '查询' },
  { key: 'insert', label: '新增' },
  { key: 'update', label: '修改' },
  { key: 'delete', label: '删除' },
];

const ACCESS_MODES: Array<{ value: TableAccessMode; label: string }> = [
  { value: 'none', label: '关闭' },
  { value: 'owner', label: '仅自己的记录' },
  { value: 'all', label: '全部记录' },
];

interface TableDataAccessEditorProps {
  state: TableDataAccessState;
  policy: TableDataAccessPolicy;
  saving: boolean;
  onPolicyChange: (policy: TableDataAccessPolicy) => void;
  onSave: () => void;
}

export function TableDataAccessEditor({
  state,
  policy,
  saving,
  onPolicyChange,
  onSave,
}: TableDataAccessEditorProps) {
  const validationError = getTableDataAccessValidationError(policy, state.columns);
  const customRules = state.managedState === 'custom';

  const setOperationMode = (
    operation: AuthenticatedDataOperation,
    mode: TableAccessMode
  ) => {
    const next = cloneTableDataAccessPolicy(policy);
    next.authenticated[operation] = mode;
    if (!requiresOwnerColumn(next)) next.authenticated.ownerColumn = null;
    onPolicyChange(next);
  };

  const setOwnerColumn = (ownerColumn: string) => {
    const next = cloneTableDataAccessPolicy(policy);
    next.authenticated.ownerColumn = ownerColumn;
    onPolicyChange(next);
  };

  const setAnonymousRead = (select: boolean) => {
    const next = cloneTableDataAccessPolicy(policy);
    next.anonymous.select = select;
    onPolicyChange(next);
  };

  return (
    <div className="space-y-6">
      {customRules && (
        <div className="flex items-start gap-3 border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="text-sm font-medium">检测到自定义访问规则</p>
            <p className="mt-1 text-xs opacity-80">为避免覆盖已有规则，当前页面仅提供只读状态。</p>
          </div>
        </div>
      )}

      {state.legacyRoles.length > 0 && (
        <div className="flex items-start gap-3 border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-sm">检测到旧版访问规则，本次保存不会修改这些规则。</p>
        </div>
      )}

      <section className="border">
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <UserRound className="h-5 w-5 text-muted-foreground" />
          <div>
            <h2 className="text-base font-semibold">认证用户</h2>
            <p className="text-sm text-muted-foreground">设置登录用户可以访问的记录范围</p>
          </div>
        </div>
        <div className="divide-y">
          {OPERATIONS.map((operation) => (
            <div
              key={operation.key}
              className="grid min-h-16 grid-cols-1 items-center gap-3 px-5 py-3 sm:grid-cols-[minmax(100px,1fr)_minmax(180px,240px)] sm:gap-4"
            >
              <span className="text-sm font-medium">{operation.label}</span>
              <Select
                value={policy.authenticated[operation.key]}
                onValueChange={(value) => setOperationMode(operation.key, value as TableAccessMode)}
                disabled={customRules}
              >
                <SelectTrigger aria-label={`${operation.label}范围`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCESS_MODES.map((mode) => (
                    <SelectItem key={mode.value} value={mode.value}>{mode.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>

        {requiresOwnerColumn(policy) && (
          <div className="grid grid-cols-1 items-center gap-3 border-t bg-muted/30 px-5 py-4 sm:grid-cols-[minmax(100px,1fr)_minmax(180px,240px)] sm:gap-4">
            <div>
              <p className="text-sm font-medium">所有者字段</p>
              <p className="mt-1 text-xs text-muted-foreground">用于识别记录所属用户</p>
            </div>
            <Select
              value={policy.authenticated.ownerColumn ?? undefined}
              onValueChange={setOwnerColumn}
              disabled={customRules}
            >
              <SelectTrigger aria-label="所有者字段">
                <SelectValue placeholder="选择字段" />
              </SelectTrigger>
              <SelectContent>
                {state.columns.map((column) => (
                  <SelectItem key={column} value={column} className="font-mono">
                    {column}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </section>

      <section className="border">
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            <div>
              <h2 className="text-base font-semibold">匿名读取</h2>
              <p className="text-sm text-muted-foreground">允许未登录客户端查询全部记录</p>
            </div>
          </div>
          <Switch
            checked={policy.anonymous.select}
            onCheckedChange={setAnonymousRead}
            disabled={customRules}
            aria-label="匿名读取"
          />
        </div>
      </section>

      {hasUnrestrictedWriteAccess(policy) && (
        <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4" />
          <span>存在不受记录范围限制的写入权限</span>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 border-t pt-4">
        <p className="text-sm text-destructive">{validationError}</p>
        <Button
          onClick={onSave}
          disabled={saving || !!validationError || customRules}
          aria-label="保存数据访问"
        >
          <Save className="mr-2 h-4 w-4" />
          {saving ? '保存中...' : '保存数据访问'}
        </Button>
      </div>
    </div>
  );
}

export function TableDataAccessPanel({
  projectId,
  tableName,
}: {
  projectId: string;
  tableName: string;
}) {
  const { toast } = useToast();
  const [state, setState] = useState<TableDataAccessState | null>(null);
  const [policy, setPolicy] = useState<TableDataAccessPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const response = await api.getTableDataAccess(projectId, tableName);
    if (response.success && response.data) {
      setState(response.data);
      setPolicy(cloneTableDataAccessPolicy(response.data.policy));
    } else {
      setError(response.error?.message ?? '数据访问配置加载失败');
    }
    setLoading(false);
  }, [projectId, tableName]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!policy) return;
    setSaving(true);
    const response = await api.updateTableDataAccess(projectId, tableName, policy);
    if (response.success && response.data) {
      setState(response.data);
      setPolicy(cloneTableDataAccessPolicy(response.data.policy));
      toast({ title: '数据访问已保存' });
    } else {
      toast({
        title: '保存失败',
        description: response.error?.message,
        variant: 'destructive',
      });
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (error || !state || !policy) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-4 border">
        <p className="text-sm text-destructive">{error ?? '数据访问配置不可用'}</p>
        <Button variant="outline" onClick={() => void load()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          重试
        </Button>
      </div>
    );
  }

  return (
    <TableDataAccessEditor
      state={state}
      policy={policy}
      saving={saving}
      onPolicyChange={setPolicy}
      onSave={() => void save()}
    />
  );
}
