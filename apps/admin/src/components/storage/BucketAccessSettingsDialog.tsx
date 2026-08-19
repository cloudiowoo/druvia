'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

export type BucketProjectUserAccess = 'admin_only' | 'owner_only' | 'authenticated_read';

export interface BucketSettingsValue {
  name: string;
  public: boolean;
  projectUserAccess: BucketProjectUserAccess;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[] | null;
}

interface BucketSettingsPatch {
  public?: boolean;
  projectUserAccess?: BucketProjectUserAccess;
  fileSizeLimit?: number | null;
  allowedMimeTypes?: string[] | null;
}

interface Props {
  projectId: string;
  bucket: BucketSettingsValue | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSaved(bucket: BucketSettingsValue): void;
}

function mimeText(types: string[] | null): string {
  return types?.join(', ') ?? '';
}

function parseMimeTypes(value: string): string[] | null {
  const values = [...new Set(value.split(/[,\n]/).map((item) => item.trim().toLowerCase()).filter(Boolean))];
  return values.length > 0 ? values : null;
}

export function BucketAccessSettingsDialog({ projectId, bucket, open, onOpenChange, onSaved }: Props) {
  const [access, setAccess] = useState<BucketProjectUserAccess>('admin_only');
  const [isPublic, setIsPublic] = useState(false);
  const [sizeMb, setSizeMb] = useState('');
  const [mimeTypes, setMimeTypes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!bucket || !open) return;
    setAccess(bucket.projectUserAccess);
    setIsPublic(bucket.public);
    setSizeMb(bucket.fileSizeLimit == null ? '' : String(bucket.fileSizeLimit / 1024 / 1024));
    setMimeTypes(mimeText(bucket.allowedMimeTypes));
  }, [bucket, open]);

  const normalizedSize = sizeMb.trim() === '' ? null : Math.round(Number(sizeMb) * 1024 * 1024);
  const isSizeValid = normalizedSize === null
    || (Number.isSafeInteger(normalizedSize) && normalizedSize > 0 && normalizedSize <= 50 * 1024 * 1024);
  const normalizedMimes = parseMimeTypes(mimeTypes);
  const isDirty = useMemo(() => Boolean(bucket) && (
    access !== bucket!.projectUserAccess
    || isPublic !== bucket!.public
    || normalizedSize !== bucket!.fileSizeLimit
    || JSON.stringify(normalizedMimes) !== JSON.stringify(bucket!.allowedMimeTypes)
  ), [access, bucket, isPublic, normalizedMimes, normalizedSize]);

  const handleSave = async () => {
    if (!bucket || !isSizeValid) return;
    const patch: BucketSettingsPatch = {};
    if (access !== bucket.projectUserAccess) patch.projectUserAccess = access;
    if (isPublic !== bucket.public) patch.public = isPublic;
    if (normalizedSize !== bucket.fileSizeLimit) patch.fileSizeLimit = normalizedSize;
    if (JSON.stringify(normalizedMimes) !== JSON.stringify(bucket.allowedMimeTypes)) {
      patch.allowedMimeTypes = normalizedMimes;
    }
    if (Object.keys(patch).length === 0) return;

    setSubmitting(true);
    const result = await api.updateBucket(projectId, bucket.name, patch);
    setSubmitting(false);
    if (!result.success || !result.data) {
      toast({ title: '保存失败', description: result.error?.message, variant: 'destructive' });
      return;
    }
    onSaved({ ...bucket, ...result.data });
    onOpenChange(false);
    toast({ title: '存储桶设置已更新' });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>存储桶设置</DialogTitle></DialogHeader>
        <div className="space-y-5 py-2">
          <div className="space-y-2">
            <Label>项目用户访问</Label>
            <Select value={access} onValueChange={(value) => setAccess(value as BucketProjectUserAccess)}>
              <SelectTrigger aria-label="项目用户访问"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="admin_only">仅管理员</SelectItem>
                <SelectItem value="owner_only">仅本人</SelectItem>
                <SelectItem value="authenticated_read">登录可读，个人可写</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div><Label htmlFor="bucket-public-setting">公开访问</Label></div>
            <Switch id="bucket-public-setting" checked={isPublic} onCheckedChange={setIsPublic} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bucket-size-limit">单文件上限（MB）</Label>
            <Input id="bucket-size-limit" inputMode="decimal" value={sizeMb} onChange={(event) => setSizeMb(event.target.value)} placeholder="不限制" />
            {!isSizeValid && (
              <p className="text-sm text-destructive">单文件上限必须大于 0 且不超过 50 MB</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="bucket-mime-types">允许的文件类型</Label>
            <Input id="bucket-mime-types" value={mimeTypes} onChange={(event) => setMimeTypes(event.target.value)} placeholder="image/png, image/jpeg" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSave} disabled={!isDirty || !isSizeValid || submitting}>{submitting ? '保存中...' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
