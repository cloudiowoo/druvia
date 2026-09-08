'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { api } from '@/lib/api';
import {
  cloneTableDataAccessPolicy,
  cloneTableDataAccessColumnGrants,
  getTableDataAccessValidationError,
  hasUnrestrictedWriteAccess,
  requiresOwnerColumn,
  type AuthenticatedDataOperation,
  type TableAccessMode,
  type TableDataAccessPolicy,
  type TableDataAccessState,
  type TableDataAccessColumnGrants,
  type DataAccessPolicyPreview,
} from '@/lib/table-data-access';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  grants?: TableDataAccessColumnGrants;
  onGrantsChange?: (grants: TableDataAccessColumnGrants) => void;
}

type TablePolicySaveRequest = TableDataAccessPolicy & {
  operationId: string;
  expectedBaselineRevision?: number;
  columnGrants: TableDataAccessColumnGrants;
};

export function TableDataAccessEditor({
  state,
  policy,
  saving,
  onPolicyChange,
  onSave,
  grants,
  onGrantsChange,
}: TableDataAccessEditorProps) {
  const validationError = getTableDataAccessValidationError(policy, state.columns);
  const readOnly = state.managedState !== 'managed';

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
      {state.managedState === 'custom' && (
        <div className="flex items-start gap-3 border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="text-sm font-medium">检测到自定义访问规则</p>
            <p className="mt-1 text-xs opacity-80">为避免覆盖已有规则，当前页面仅提供只读状态。</p>
          </div>
        </div>
      )}

      {state.managedState === 'adoption_required' && (
        <StateNotice title="现有规则需要接管" />
      )}
      {state.managedState === 'refresh_required' && (
        <StateNotice title="数据表结构已变化" />
      )}
      {state.managedState === 'recovery_required' && (
        <StateNotice title="访问规则需要恢复" destructive />
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
                disabled={readOnly}
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
              disabled={readOnly}
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

      {grants && onGrantsChange && !readOnly && (
        <ColumnGrantEditor
          state={state}
          policy={policy}
          grants={grants}
          onChange={onGrantsChange}
        />
      )}

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
            disabled={readOnly}
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
          disabled={saving || !!validationError || readOnly}
          aria-label="保存数据访问"
        >
          <Save className="mr-2 h-4 w-4" />
          {saving ? '保存中...' : '保存数据访问'}
        </Button>
      </div>
    </div>
  );
}

function StateNotice({ title, destructive = false }: { title: string; destructive?: boolean }) {
  return (
    <div className={`flex items-center gap-3 border p-4 ${destructive
      ? 'border-destructive/40 bg-destructive/5 text-destructive'
      : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100'}`}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <p className="text-sm font-medium">{title}</p>
    </div>
  );
}

function ColumnGrantEditor({
  state,
  policy,
  grants,
  onChange,
}: {
  state: TableDataAccessState;
  policy: TableDataAccessPolicy;
  grants: TableDataAccessColumnGrants;
  onChange: (grants: TableDataAccessColumnGrants) => void;
}) {
  const groups = [
    { actor: 'authenticated' as const, key: 'select' as const, label: '查询字段', enabled: policy.authenticated.select !== 'none', columns: state.capabilities.readable },
    { actor: 'authenticated' as const, key: 'insert' as const, label: '新增字段', enabled: policy.authenticated.insert !== 'none', columns: state.capabilities.insertable },
    { actor: 'authenticated' as const, key: 'update' as const, label: '修改字段', enabled: policy.authenticated.update !== 'none', columns: state.capabilities.updateable },
    { actor: 'anonymous' as const, key: 'select' as const, label: '匿名查询字段', enabled: policy.anonymous.select, columns: state.capabilities.readable },
  ];
  const toggle = (
    actor: 'authenticated' | 'anonymous',
    key: 'select' | 'insert' | 'update',
    column: string,
    checked: boolean
  ) => {
    const next = cloneTableDataAccessColumnGrants(grants);
    const selected = actor === 'authenticated'
      ? next.authenticated[key]
      : next.anonymous.select;
    const value = checked
      ? [...new Set([...selected, column])]
      : selected.filter((item) => item !== column);
    if (actor === 'authenticated') next.authenticated[key] = value;
    else next.anonymous.select = value;
    onChange(next);
  };
  return (
    <section className="border">
      <div className="border-b px-5 py-4">
        <h2 className="text-base font-semibold">字段权限</h2>
      </div>
      <div className="divide-y">
        {groups.filter((group) => group.enabled).map((group) => (
          <div key={`${group.actor}-${group.key}`} className="px-5 py-4">
            <p className="mb-3 text-sm font-medium">{group.label}</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {group.columns.map((column) => {
                const selected = group.actor === 'authenticated'
                  ? grants.authenticated[group.key]
                  : grants.anonymous.select;
                const ownerPreset = group.actor === 'authenticated'
                  && (group.key === 'insert' || group.key === 'update')
                  && policy.authenticated[group.key] === 'owner'
                  && policy.authenticated.ownerColumn === column;
                return (
                  <label key={column} className="flex min-h-9 items-center gap-2 border px-3 text-sm">
                    <input
                      type="checkbox"
                      checked={!ownerPreset && selected.includes(column)}
                      disabled={ownerPreset}
                      onChange={(event) => toggle(
                        group.actor, group.key, column, event.target.checked
                      )}
                    />
                    <span className="min-w-0 truncate font-mono">{column}</span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
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
  const [grants, setGrants] = useState<TableDataAccessColumnGrants | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DataAccessPolicyPreview | null>(null);
  const [confirmAlias, setConfirmAlias] = useState('');
  const [action, setAction] = useState<'adoption' | 'reconcile' | 'recovery' | null>(null);
  const pendingSave = useRef<{
    intentFingerprint: string;
    input: TablePolicySaveRequest;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const response = await api.getTableDataAccess(projectId, tableName);
    if (response.success && response.data) {
      setState(response.data);
      setPolicy(cloneTableDataAccessPolicy(response.data.policy));
      setGrants(cloneTableDataAccessColumnGrants(response.data.effective));
    } else {
      setError(response.error?.message ?? '数据访问配置加载失败');
    }
    setLoading(false);
  }, [projectId, tableName]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (state?.managedState === 'recovery_required'
      || !state?.activeOperation
      || !['applying', 'recovering'].includes(state.activeOperation.status)) return;
    const timer = window.setTimeout(() => void load(), 2000);
    return () => window.clearTimeout(timer);
  }, [load, state?.activeOperation, state?.managedState]);

  const save = async () => {
    if (!policy || !grants) return;
    setSaving(true);
    const payload = {
      ...policy,
      ...(state?.baselineRevision === null ? {} : { expectedBaselineRevision: state?.baselineRevision }),
      columnGrants: grants,
    };
    const intentFingerprint = JSON.stringify({ policy, columnGrants: grants });
    const input: TablePolicySaveRequest = pendingSave.current?.intentFingerprint === intentFingerprint
      ? pendingSave.current.input
      : { ...payload, operationId: crypto.randomUUID() };
    pendingSave.current = { intentFingerprint, input };
    const response = await api.updateTableDataAccess(projectId, tableName, input);
    if (response.success && response.data) {
      pendingSave.current = null;
      setState(response.data);
      setPolicy(cloneTableDataAccessPolicy(response.data.policy));
      setGrants(cloneTableDataAccessColumnGrants(response.data.effective));
      toast({ title: '数据访问已保存' });
    } else {
      if (!isUnknownPolicySaveResult(response.error?.code)) pendingSave.current = null;
      toast({
        title: '保存失败',
        description: response.error?.message,
        variant: 'destructive',
      });
      await load();
    }
    setSaving(false);
  };

  const openManagedAction = async (nextAction: 'adoption' | 'reconcile' | 'recovery') => {
    setSaving(true);
    setConfirmAlias('');
    if (nextAction === 'recovery') {
      setPreview(null);
      setAction(nextAction);
      setSaving(false);
      return;
    }
    const response = nextAction === 'adoption'
      ? await api.previewTableDataAccessAdoption(projectId, tableName)
      : await api.previewTableDataAccessReconcile(projectId, tableName);
    if (response.success && response.data) {
      setPreview(response.data);
      if (nextAction === 'reconcile') {
        setPolicy(cloneTableDataAccessPolicy(response.data.policy));
      }
      setGrants(cloneTableDataAccessColumnGrants(response.data.columnGrants));
      setAction(nextAction);
    } else {
      toast({ title: '操作失败', description: response.error?.message, variant: 'destructive' });
    }
    setSaving(false);
  };

  const applyManagedAction = async () => {
    if (!state || !action) return;
    setSaving(true);
    let response;
    if (action === 'adoption' && preview) {
      response = await api.applyTableDataAccessAdoption(projectId, tableName, {
        operationId: preview.operation.operationId,
        sourceDigest: preview.operation.sourceDigest,
        projectAlias: confirmAlias,
      });
    } else if (action === 'reconcile' && preview && grants) {
      if (!policy) {
        setSaving(false);
        return;
      }
      const refreshed = await api.previewTableDataAccessReconcile(projectId, tableName, {
        policy,
        columnGrants: grants,
      });
      if (!refreshed.success || !refreshed.data || refreshed.data.baselineRevision === null
        || !refreshed.data.operation.targetDigest) {
        toast({ title: '操作失败', description: refreshed.error?.message, variant: 'destructive' });
        setSaving(false);
        return;
      } else {
        response = await api.applyTableDataAccessReconcile(projectId, tableName, {
          operationId: refreshed.data.operation.operationId,
          sourceDigest: refreshed.data.operation.sourceDigest,
          targetDigest: refreshed.data.operation.targetDigest,
          baselineRevision: refreshed.data.baselineRevision,
          projectAlias: confirmAlias,
          columnGrants: refreshed.data.columnGrants,
          policy: refreshed.data.policy,
        });
      }
    } else if (action === 'recovery' && state.activeOperation) {
      response = await api.recoverTableDataAccessOperation(projectId, state.activeOperation.operationId, {
        sourceDigest: state.activeOperation.sourceDigest,
        projectAlias: confirmAlias,
      });
    }
    const recoveryCompleted = action !== 'recovery'
      || (!!response?.data && 'status' in response.data && response.data.status === 'failed');
    if (response?.success && recoveryCompleted) {
      setAction(null);
      toast({ title: action === 'adoption' ? '访问规则已接管' : action === 'reconcile' ? '字段权限已刷新' : '恢复操作已完成' });
    } else {
      toast({
        title: '操作失败',
        description: response?.error?.message ?? (action === 'recovery' ? '访问规则仍需恢复' : undefined),
        variant: 'destructive',
      });
    }
    await load();
    setSaving(false);
  };

  const closeManagedAction = () => {
    setAction(null);
    setPreview(null);
    setConfirmAlias('');
    if (state) {
      setPolicy(cloneTableDataAccessPolicy(state.policy));
      setGrants(cloneTableDataAccessColumnGrants(state.effective));
    }
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

  if (error || !state || !policy || !grants) {
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
    <div className="space-y-5">
      {state.managedState !== 'recovery_required'
        && state.activeOperation
        && ['applying', 'recovering'].includes(state.activeOperation.status) && (
        <div className="flex items-center gap-3 border bg-muted/30 px-4 py-3 text-sm">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span>{state.activeOperation.status === 'recovering' ? '正在恢复访问规则' : '正在应用访问规则'}</span>
        </div>
      )}
      {state.managedState === 'adoption_required' && (
        <Button onClick={() => void openManagedAction('adoption')} disabled={saving}>
          <CheckCircle2 className="mr-2 h-4 w-4" />接管为 Druvia 管理
        </Button>
      )}
      {state.managedState === 'refresh_required' && (
        <Button onClick={() => void openManagedAction('reconcile')} disabled={saving}>
          <RefreshCw className="mr-2 h-4 w-4" />刷新字段权限
        </Button>
      )}
      {state.managedState === 'recovery_required' && state.activeOperation && (
        <Button variant="destructive" onClick={() => void openManagedAction('recovery')} disabled={saving}>
          <RotateCcw className="mr-2 h-4 w-4" />恢复访问规则
        </Button>
      )}
      <TableDataAccessEditor
        state={state}
        policy={policy}
        grants={grants}
        saving={saving}
        onPolicyChange={setPolicy}
        onGrantsChange={setGrants}
        onSave={() => void save()}
      />
      <Dialog open={action !== null} onOpenChange={(open) => !open && closeManagedAction()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action === 'adoption' ? '确认接管访问规则' : action === 'reconcile' ? '确认刷新字段权限' : '确认恢复访问规则'}</DialogTitle>
            <DialogDescription>{tableName}</DialogDescription>
          </DialogHeader>
          {action === 'reconcile' && preview?.drift && (
            <div className="max-h-[50vh] space-y-4 overflow-y-auto border-y py-4 text-sm">
              <div className="space-y-1">
                <p>新增可读字段：{preview.drift.addedReadable.join(', ') || '无'}</p>
                <p>写能力变化：{preview.drift.removedOrRestricted.join(', ') || '无'}</p>
              </div>
              {policy && (
                <ReconcilePolicyEditor
                  baselinePolicy={state.policy}
                  policy={policy}
                  onChange={setPolicy}
                />
              )}
              {policy && getReconcilePolicyValidationError(policy, preview.capabilities) && (
                <p className="text-sm text-destructive">
                  {getReconcilePolicyValidationError(policy, preview.capabilities)}
                </p>
              )}
              {grants && policy && (
                <PreviewGrantEditor
                  preview={preview}
                  policy={policy}
                  grants={grants}
                  onChange={setGrants}
                />
              )}
            </div>
          )}
          <Input
            value={confirmAlias}
            onChange={(event) => setConfirmAlias(event.target.value)}
            placeholder="项目别名"
            aria-label="项目别名确认"
          />
          <DialogFooter>
            <Button variant="outline" onClick={closeManagedAction}>取消</Button>
            <Button
              onClick={() => void applyManagedAction()}
              disabled={!confirmAlias || saving || (action === 'reconcile'
                && !!policy
                && !!getReconcilePolicyValidationError(policy, preview?.capabilities))}
            >
              {saving ? '处理中...' : '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function isUnknownPolicySaveResult(code: string | undefined): boolean {
  return [
    'NETWORK_ERROR',
    'INVALID_RESPONSE',
    'DATA_ACCESS_POLICY_OPERATION_IN_PROGRESS',
    'DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED',
  ].includes(code ?? '');
}

function ReconcilePolicyEditor({
  baselinePolicy,
  policy,
  onChange,
}: {
  baselinePolicy: TableDataAccessPolicy;
  policy: TableDataAccessPolicy;
  onChange: (policy: TableDataAccessPolicy) => void;
}) {
  const setMode = (operation: AuthenticatedDataOperation, mode: TableAccessMode) => {
    const next = cloneTableDataAccessPolicy(policy);
    next.authenticated[operation] = mode;
    if (mode === 'owner') {
      next.authenticated.ownerColumn = baselinePolicy.authenticated.ownerColumn;
    }
    if (!requiresOwnerColumn(next)) next.authenticated.ownerColumn = null;
    onChange(next);
  };

  return (
    <section className="space-y-3 border p-3">
      <p className="font-medium">刷新后的记录范围</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {OPERATIONS.map((operation) => {
          const baselineMode = baselinePolicy.authenticated[operation.key];
          const allowedModes = baselineMode === 'none'
            ? ['none'] as TableAccessMode[]
            : ['none', baselineMode] as TableAccessMode[];
          return (
            <div key={operation.key} className="space-y-1">
              <span className="text-xs text-muted-foreground">{operation.label}</span>
              <Select
                value={policy.authenticated[operation.key]}
                onValueChange={(value) => setMode(operation.key, value as TableAccessMode)}
              >
                <SelectTrigger aria-label={`刷新${operation.label}范围`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCESS_MODES.filter((mode) => allowedModes.includes(mode.value)).map((mode) => (
                    <SelectItem key={mode.value} value={mode.value}>{mode.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
      {requiresOwnerColumn(policy) && (
        <div className="flex items-center justify-between gap-3 border px-3 py-2">
          <span className="text-xs text-muted-foreground">所有者字段</span>
          <span className="font-mono text-sm">{baselinePolicy.authenticated.ownerColumn}</span>
        </div>
      )}
    </section>
  );
}

function getReconcilePolicyValidationError(
  policy: TableDataAccessPolicy,
  capabilities: DataAccessPolicyPreview['capabilities'] | undefined
): string | null {
  if (!capabilities) return '字段能力不可用';
  const validation = getTableDataAccessValidationError(policy, capabilities.readable);
  if (validation) return validation;
  const ownerColumn = policy.authenticated.ownerColumn;
  if (policy.authenticated.insert === 'owner'
    && ownerColumn
    && !capabilities.insertable.includes(ownerColumn)) {
    return '所有者字段不可用于新增记录';
  }
  return null;
}

function PreviewGrantEditor({
  preview,
  policy,
  grants,
  onChange,
}: {
  preview: DataAccessPolicyPreview;
  policy: TableDataAccessPolicy;
  grants: TableDataAccessColumnGrants;
  onChange: (grants: TableDataAccessColumnGrants) => void;
}) {
  const groups = [
    { actor: 'authenticated' as const, key: 'select' as const, label: '查询字段', columns: preview.capabilities.readable, enabled: policy.authenticated.select !== 'none' },
    { actor: 'authenticated' as const, key: 'insert' as const, label: '新增字段', columns: preview.capabilities.insertable, enabled: policy.authenticated.insert !== 'none' },
    { actor: 'authenticated' as const, key: 'update' as const, label: '修改字段', columns: preview.capabilities.updateable, enabled: policy.authenticated.update !== 'none' },
    { actor: 'anonymous' as const, key: 'select' as const, label: '匿名查询字段', columns: preview.capabilities.readable, enabled: policy.anonymous.select },
  ];
  const toggle = (
    actor: 'authenticated' | 'anonymous',
    key: 'select' | 'insert' | 'update',
    column: string,
    checked: boolean
  ) => {
    const next = cloneTableDataAccessColumnGrants(grants);
    const selected = actor === 'authenticated'
      ? next.authenticated[key]
      : next.anonymous.select;
    const value = checked
      ? [...new Set([...selected, column])]
      : selected.filter((item) => item !== column);
    if (actor === 'authenticated') next.authenticated[key] = value;
    else next.anonymous.select = value;
    onChange(next);
  };
  return (
    <div className="space-y-4">
      {groups.filter((group) => group.enabled).map((group) => (
        <fieldset key={`${group.actor}-${group.key}`}>
          <legend className="mb-2 font-medium">{group.label}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {group.columns.map((column) => {
              const selected = group.actor === 'authenticated'
                ? grants.authenticated[group.key]
                : grants.anonymous.select;
              const ownerPreset = group.actor === 'authenticated'
                && (group.key === 'insert' || group.key === 'update')
                && policy.authenticated[group.key] === 'owner'
                && policy.authenticated.ownerColumn === column;
              return (
                <label key={column} className="flex min-h-9 items-center gap-2 border px-3">
                  <input
                    type="checkbox"
                    checked={!ownerPreset && selected.includes(column)}
                    disabled={ownerPreset}
                    onChange={(event) => toggle(
                      group.actor, group.key, column, event.target.checked
                    )}
                  />
                  <span className="min-w-0 truncate font-mono">{column}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
