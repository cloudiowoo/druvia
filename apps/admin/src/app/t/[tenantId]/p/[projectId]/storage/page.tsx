'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { toast } from '@/hooks/use-toast';
import {
  Plus,
  Upload,
  Trash2,
  Download,
  Link as LinkIcon,
  MoreHorizontal,
  FolderOpen,
  File,
  ArrowLeft,
} from 'lucide-react';

interface Bucket {
  bucketId: string;
  projectId: string;
  name: string;
  public: boolean;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[] | null;
  createdAt: string;
}

interface StorageObject {
  objectId: string;
  bucketId: string;
  name: string;
  size: number;
  mimeType: string | null;
  createdAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString('zh-CN');
}

export default function StoragePage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentProject, currentTenant } = useAppStore();

  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [selectedBucket, setSelectedBucket] = useState<Bucket | null>(null);
  const [objects, setObjects] = useState<StorageObject[]>([]);
  const [loading, setLoading] = useState(true);
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Dialog states
  const [createBucketOpen, setCreateBucketOpen] = useState(false);
  const [newBucketName, setNewBucketName] = useState('');
  const [newBucketPublic, setNewBucketPublic] = useState(false);

  // Delete confirmation states
  const [deleteBucketTarget, setDeleteBucketTarget] = useState<Bucket | null>(null);
  const [deleteObjectTarget, setDeleteObjectTarget] = useState<StorageObject | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchBuckets = useCallback(async () => {
    const res = await api.listBuckets(projectId);
    if (res.success && res.data) {
      setBuckets(res.data);
    }
    setLoading(false);
  }, [projectId]);

  const fetchObjects = useCallback(async (bucket: Bucket) => {
    setObjectsLoading(true);
    const res = await api.listObjects(projectId, bucket.name);
    if (res.success && res.data) {
      setObjects(res.data);
    }
    setObjectsLoading(false);
  }, [projectId]);

  useEffect(() => {
    fetchBuckets();
  }, [fetchBuckets]);

  useEffect(() => {
    if (selectedBucket) {
      fetchObjects(selectedBucket);
    }
  }, [selectedBucket, fetchObjects]);

  const handleCreateBucket = async () => {
    if (!newBucketName.trim()) return;
    const res = await api.createBucket(projectId, {
      name: newBucketName.trim(),
      public: newBucketPublic,
    });
    if (res.success) {
      setCreateBucketOpen(false);
      setNewBucketName('');
      setNewBucketPublic(false);
      fetchBuckets();
      toast({ title: '存储桶已创建' });
    } else {
      toast({ title: '创建失败', description: res.error?.message, variant: 'destructive' });
    }
  };

  const handleConfirmDeleteBucket = async () => {
    if (!deleteBucketTarget) return;
    const res = await api.deleteBucket(projectId, deleteBucketTarget.name);
    if (res.success) {
      if (selectedBucket?.bucketId === deleteBucketTarget.bucketId) {
        setSelectedBucket(null);
        setObjects([]);
      }
      fetchBuckets();
      toast({ title: '存储桶已删除' });
    } else {
      const errorMessage =
        res.error?.code === 'BUCKET_NOT_EMPTY'
          ? '存储桶不为空，请先删除所有文件'
          : res.error?.message || '未知错误';
      toast({ title: '删除失败', description: errorMessage, variant: 'destructive' });
    }
    setDeleteBucketTarget(null);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !selectedBucket) return;

    setUploading(true);
    let successCount = 0;
    for (const file of Array.from(files)) {
      const res = await api.uploadObject(projectId, selectedBucket.name, file);
      if (res.success) successCount++;
    }
    setUploading(false);
    fetchObjects(selectedBucket);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    toast({ title: `已上传 ${successCount} 个文件` });
  };

  const handleDownload = async (obj: StorageObject) => {
    if (!selectedBucket) return;
    try {
      const blob = await api.downloadObject(projectId, selectedBucket.name, obj.name);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = obj.name.split('/').pop() || 'file';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: '下载失败', variant: 'destructive' });
    }
  };

  const handleGetSignedUrl = async (obj: StorageObject) => {
    if (!selectedBucket) return;
    const res = await api.getObjectSignedUrl(projectId, selectedBucket.name, obj.name);
    if (res.success && res.data) {
      await navigator.clipboard.writeText(res.data.url);
      toast({ title: '签名 URL 已复制到剪贴板' });
    } else {
      toast({ title: '获取链接失败', variant: 'destructive' });
    }
  };

  const handleConfirmDeleteObject = async () => {
    if (!selectedBucket || !deleteObjectTarget) return;
    const res = await api.deleteObject(projectId, selectedBucket.name, deleteObjectTarget.name);
    if (res.success) {
      fetchObjects(selectedBucket);
      toast({ title: '文件已删除' });
    } else {
      toast({ title: '删除失败', variant: 'destructive' });
    }
    setDeleteObjectTarget(null);
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
            <span>存储</span>
          </div>
          <h1 className="text-2xl font-bold">文件存储</h1>
        </div>
        <Dialog open={createBucketOpen} onOpenChange={setCreateBucketOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              创建存储桶
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>创建存储桶</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <label htmlFor="bucket-name" className="text-sm font-medium">
                  存储桶名称
                </label>
                <Input
                  id="bucket-name"
                  value={newBucketName}
                  onChange={(e) => setNewBucketName(e.target.value)}
                  placeholder="my-bucket"
                />
                <p className="text-xs text-muted-foreground">
                  3-63 个字符，只允许小写字母、数字和连字符
                </p>
              </div>
              <div className="flex items-center justify-between">
                <label htmlFor="bucket-public" className="text-sm font-medium">
                  公开访问
                </label>
                <input
                  type="checkbox"
                  id="bucket-public"
                  checked={newBucketPublic}
                  onChange={(e) => setNewBucketPublic(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateBucketOpen(false)}>
                取消
              </Button>
              <Button onClick={handleCreateBucket} disabled={!newBucketName.trim()}>
                创建
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Delete Bucket Confirmation */}
      <AlertDialog open={!!deleteBucketTarget} onOpenChange={() => setDeleteBucketTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除存储桶</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除存储桶 &quot;{deleteBucketTarget?.name}&quot; 吗？此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDeleteBucket} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Object Confirmation */}
      <AlertDialog open={!!deleteObjectTarget} onOpenChange={() => setDeleteObjectTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除文件</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除文件 &quot;{deleteObjectTarget?.name}&quot; 吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDeleteObject} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Bucket List */}
        <div className="lg:col-span-1">
          <div className="border rounded-lg">
            <div className="p-3 border-b bg-muted/50">
              <h3 className="font-medium text-sm">存储桶</h3>
            </div>
            {loading ? (
              <div className="p-4 space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : buckets.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                暂无存储桶
              </div>
            ) : (
              <div className="divide-y">
                {buckets.map((bucket) => (
                  <div
                    key={bucket.bucketId}
                    className={`p-3 cursor-pointer hover:bg-muted/50 flex items-center justify-between group ${
                      selectedBucket?.bucketId === bucket.bucketId ? 'bg-muted' : ''
                    }`}
                    onClick={() => setSelectedBucket(bucket)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <FolderOpen className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span className="text-sm truncate">{bucket.name}</span>
                      {bucket.public && (
                        <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                          公开
                        </span>
                      )}
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 opacity-0 group-hover:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteBucketTarget(bucket);
                          }}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Object List */}
        <div className="lg:col-span-3">
          <div className="border rounded-lg">
            <div className="p-3 border-b bg-muted/50 flex items-center justify-between">
              <div className="flex items-center gap-2">
                {selectedBucket && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => setSelectedBucket(null)}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                )}
                <h3 className="font-medium text-sm">
                  {selectedBucket ? selectedBucket.name : '选择一个存储桶'}
                </h3>
              </div>
              {selectedBucket && (
                <div className="flex gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    {uploading ? '上传中...' : '上传文件'}
                  </Button>
                </div>
              )}
            </div>

            {!selectedBucket ? (
              <div className="p-12 text-center text-muted-foreground">
                请从左侧选择一个存储桶
              </div>
            ) : objectsLoading ? (
              <div className="p-4 space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : objects.length === 0 ? (
              <div className="p-12 text-center">
                <p className="text-muted-foreground mb-4">存储桶为空</p>
                <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
                  <Upload className="h-4 w-4 mr-2" />
                  上传第一个文件
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>文件名</TableHead>
                    <TableHead className="text-right">大小</TableHead>
                    <TableHead className="text-right">类型</TableHead>
                    <TableHead className="text-right">上传时间</TableHead>
                    <TableHead className="text-right w-[100px]">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {objects.map((obj) => (
                    <TableRow key={obj.objectId}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <File className="h-4 w-4 text-muted-foreground" />
                          <span className="font-mono text-sm">{obj.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatBytes(obj.size)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {obj.mimeType || '-'}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatDate(obj.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleDownload(obj)}>
                              <Download className="h-4 w-4 mr-2" />
                              下载
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleGetSignedUrl(obj)}>
                              <LinkIcon className="h-4 w-4 mr-2" />
                              获取链接
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => setDeleteObjectTarget(obj)}
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
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
