'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileJson, Loader2, RotateCcw, ShieldCheck, Upload } from 'lucide-react'
import { api } from '@/lib/api'
import { useToast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type {
  AuthorizationProjectionContract,
  AuthorizationProjectionOperation,
} from '@/lib/data-access-authorization-projection'

interface Props {
  projectId: string
  projectAlias: string
  dependencyInvalid: boolean
  onChanged: () => void
}

export function AuthorizationProjectionPanel({
  projectId,
  projectAlias,
  dependencyInvalid,
  onChanged,
}: Props) {
  const { toast } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [contractText, setContractText] = useState('')
  const [preview, setPreview] = useState<AuthorizationProjectionOperation | null>(null)
  const [active, setActive] = useState<AuthorizationProjectionOperation | null>(null)
  const [alias, setAlias] = useState('')
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false)
  const [recoveryAlias, setRecoveryAlias] = useState('')
  const [busy, setBusy] = useState(false)

  const loadActive = useCallback(async () => {
    const response = await api.getActiveAuthorizationProjection(projectId)
    if (response.success) setActive(response.data ?? null)
  }, [projectId])

  useEffect(() => { void loadActive() }, [loadActive])

  const importFile = async (file: File | undefined) => {
    if (!file) return
    const text = await file.text()
    setContractText(text)
    setPreview(null)
    setDialogOpen(true)
    if (fileRef.current) fileRef.current.value = ''
  }

  const createPreview = async () => {
    let contract: AuthorizationProjectionContract
    try {
      contract = JSON.parse(contractText) as AuthorizationProjectionContract
    } catch {
      toast({ title: '合同 JSON 无效', variant: 'destructive' })
      return
    }
    setBusy(true)
    const response = await api.previewAuthorizationProjection(projectId, contract)
    setBusy(false)
    if (!response.success || !response.data) {
      toast({ title: '授权投影预检失败', description: response.error?.message, variant: 'destructive' })
      return
    }
    setPreview(response.data)
    setActive(response.data)
    setAlias('')
  }

  const apply = async () => {
    if (!preview) return
    setBusy(true)
    setActive({ ...preview, status: 'applying' })
    const response = await api.applyAuthorizationProjection(projectId, preview.operationId, {
      projectAlias: alias,
      sourceDigest: preview.sourceDigest,
      targetDigest: preview.targetDigest,
      dependencyDigest: preview.dependencyDigest,
      baselineRevisions: preview.baselineRevisions,
    })
    setBusy(false)
    if (!response.success || !response.data) {
      await loadActive()
      toast({ title: '授权投影未完成', description: response.error?.message, variant: 'destructive' })
      return
    }
    setActive(response.data)
    setPreview(null)
    setContractText('')
    setDialogOpen(false)
    onChanged()
    toast({ title: '授权投影已应用' })
  }

  const recover = async () => {
    if (!active) return
    setBusy(true)
    const response = await api.recoverAuthorizationProjection(
      projectId, active.operationId, { projectAlias }
    )
    setBusy(false)
    if (!response.success || !response.data) {
      await loadActive()
      toast({ title: '授权投影恢复未完成', description: response.error?.message, variant: 'destructive' })
      return
    }
    setActive(response.data)
    setRecoveryDialogOpen(false)
    setRecoveryAlias('')
    onChanged()
    toast({ title: response.data.status === 'completed' ? '授权投影已恢复完成' : '授权投影已安全关闭' })
  }

  const running = active?.status === 'applying' || active?.status === 'recovering'
  const recoverable = active?.status === 'recovery_required'
    || running
    || (active?.status === 'completed' && dependencyInvalid)

  return (
    <>
      <section className="mb-6 flex flex-col gap-4 border-y bg-muted/20 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {running
            ? <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-primary" aria-hidden="true" />
            : <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" aria-hidden="true" />}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">授权投影</h2>
              <Badge variant="outline">
                {dependencyInvalid && active?.status === 'completed'
                  ? '授权依赖异常'
                  : projectionStatus(active?.status)}
              </Badge>
            </div>
            {active?.tables.length ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {active.tables.length} 张数据表 · {active.tables[0]?.relationship}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="选择授权投影合同"
            onChange={(event) => void importFile(event.target.files?.[0])}
          />
          {recoverable ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setRecoveryAlias('')
                setRecoveryDialogOpen(true)
              }}
            >
              {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              {dependencyInvalid && active?.status === 'completed' ? '安全关闭' : '恢复'}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload />导入合同
            </Button>
          )}
        </div>
      </section>

      <Dialog open={dialogOpen} onOpenChange={(open) => !busy && setDialogOpen(open)}>
        <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>授权投影合同</DialogTitle>
            <DialogDescription>{preview ? '预检结果' : 'JSON 合同'}</DialogDescription>
          </DialogHeader>
          {preview ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 border sm:grid-cols-4">
                <Metric label="目标表" value={preview.tables.length} />
                <Metric label="策略版本" value="v2" />
                <Metric label="读取条件" value="Owner + Projection" />
                <Metric label="写权限" value="保持不变" />
              </div>
              <div className="max-h-64 overflow-y-auto border">
                {preview.tables.map((table) => (
                  <div key={table.table} className="grid gap-1 border-b px-4 py-3 last:border-b-0 sm:grid-cols-2">
                    <span className="font-mono text-sm">{table.table}</span>
                    <span className="text-sm text-muted-foreground sm:text-right">
                      {table.ownerColumn} · {table.allowColumn}
                    </span>
                  </div>
                ))}
              </div>
              <div className="space-y-2 border-t pt-4">
                <Label htmlFor="projection-project-alias">输入项目别名确认</Label>
                <Input
                  id="projection-project-alias"
                  value={alias}
                  onChange={(event) => setAlias(event.target.value)}
                  autoComplete="off"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="projection-contract"><FileJson className="mr-2 inline h-4 w-4" />JSON</Label>
              <Textarea
                id="projection-contract"
                value={contractText}
                onChange={(event) => setContractText(event.target.value)}
                className="min-h-80 font-mono text-xs"
                spellCheck={false}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDialogOpen(false)}>取消</Button>
            {preview ? (
              <Button disabled={busy || alias !== projectAlias} onClick={() => void apply()}>
                {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                应用
              </Button>
            ) : (
              <Button disabled={busy || !contractText.trim()} onClick={() => void createPreview()}>
                {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                预检
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={recoveryDialogOpen}
        onOpenChange={(open) => !busy && setRecoveryDialogOpen(open)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>恢复授权投影</DialogTitle>
            <DialogDescription>
              系统将核对已应用状态；无法确认一致时会关闭相关表的登录用户读取权限。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="projection-recovery-project-alias">输入项目别名确认</Label>
            <Input
              id="projection-recovery-project-alias"
              value={recoveryAlias}
              onChange={(event) => setRecoveryAlias(event.target.value)}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setRecoveryDialogOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy || recoveryAlias !== projectAlias}
              onClick={() => void recover()}
            >
              {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              确认恢复
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border-b px-3 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
    </div>
  )
}

function projectionStatus(status: AuthorizationProjectionOperation['status'] | undefined): string {
  return {
    preview_ready: '等待应用', applying: '正在应用', recovering: '正在恢复',
    completed: '已启用', failed: '未启用', recovery_required: '需要恢复', superseded: '已失效',
  }[status ?? 'failed']
}
