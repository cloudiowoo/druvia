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
  FolderPlus,
  File,
  Image as ImageIcon,
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

function isImageMime(mimeType: string | null): boolean {
  return !!mimeType && mimeType.startsWith('image/');
}

function groupByDirectory(objects: StorageObject[], prefix: string) {
  const dirs = new Set<string>();
  const files: StorageObject[] = [];
  for (const obj of objects) {
    const relative = obj.name.slice(prefix.length);
    const slashIndex = relative.indexOf('/');
    if (slashIndex >= 0) {
      dirs.add(relative.substring(0, slashIndex + 1));
    } else if (relative !== '.keep') {
      files.push(obj);
    }
  }
  return { dirs: Array.from(dirs).sort(), files };
}

function ObjectThumbnail({ projectId, bucket, obj }: { projectId: string; bucket: Bucket; obj: StorageObject }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!isImageMime(obj.mimeType)) return;

    let revoked = false;
    if (bucket.public) {
      // 公开 bucket 直接用公开 URL
      const url = `${process.env.NEXT_PUBLIC_API_URL ?? ''}/api/v1/storage/public/${projectId}/${bucket.name}/${obj.name}`;
      setSrc(url);
    } else {
      // 私有 bucket 通过 fetch + blob URL
      (async () => {
        try {
          const blob = await api.downloadObject(projectId, bucket.name, obj.name);
          if (!revoked) setSrc(URL.createObjectURL(blob));
        } catch { /* ignore */ }
      })();
    }
    return () => {
      revoked = true;
      if (src && !bucket.public) URL.revokeObjectURL(src);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obj.objectId]);

  if (!isImageMime(obj.mimeType)) {
    return <File className="h-4 w-4 text-muted-foreground" />;
  }

  if (!src) {
    return <ImageIcon className="h-4 w-4 text-muted-foreground" />;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={obj.name}
      className="h-8 w-8 rounded object-cover border"
    />
  );
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
  const [currentPrefix, setCurrentPrefix] = useState('');

  // Dialog states
  const [createBucketOpen, setCreateBucketOpen] = useState(false);
  const [newBucketName, setNewBucketName] = useState('');
  const [newBucketPublic, setNewBucketPublic] = useState(false);

  // Delete confirmation states
  const [deleteBucketTarget, setDeleteBucketTarget] = useState<Bucket | null>(null);
  const [deleteObjectTarget, setDeleteObjectTarget] = useState<StorageObject | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<string | null>(null);

  // Create folder states
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchBuckets = useCallback(async () => {
    const res = await api.listBuckets(projectId);
    if (res.success && res.data) {
      setBuckets(res.data);
    }
    setLoading(false);
  }, [projectId]);

  const fetchObjects = useCallback(async (bucket: Bucket, prefix: string) => {
    setObjectsLoading(true);
    const res = await api.listObjects(projectId, bucket.name, { prefix });
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
      fetchObjects(selectedBucket, currentPrefix);
    }
  }, [selectedBucket, currentPrefix, fetchObjects]);

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
        setCurrentPrefix('');
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
      // 在当前目录下上传：给文件名加上 prefix
      const fileName = currentPrefix ? currentPrefix + file.name : undefined;
      const res = await api.uploadObject(projectId, selectedBucket.name, file, fileName);
      if (res.success) successCount++;
    }
    setUploading(false);
    fetchObjects(selectedBucket, currentPrefix);
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
      const message = res.data.expiresIn === null
        ? '公开链接已复制到剪贴板'
        : '签名链接已复制到剪贴板';
      toast({ title: message });
    } else {
      toast({ title: '获取链接失败', variant: 'destructive' });
    }
  };

  const handleConfirmDeleteObject = async () => {
    if (!selectedBucket || !deleteObjectTarget) return;
    const res = await api.deleteObject(projectId, selectedBucket.name, deleteObjectTarget.name);
    if (res.success) {
      fetchObjects(selectedBucket, currentPrefix);
      toast({ title: '文件已删除' });
    } else {
      toast({ title: '删除失败', variant: 'destructive' });
    }
    setDeleteObjectTarget(null);
  };

  const handleCreateFolder = async () => {
    if (!selectedBucket || !newFolderName.trim()) return;
    const folderPath = currentPrefix + newFolderName.trim() + '/.keep';
    const blob = new Blob([], { type: 'application/octet-stream' });
    const res = await api.uploadObject(projectId, selectedBucket.name, blob as unknown as globalThis.File, folderPath);
    if (res.success) {
      setCreateFolderOpen(false);
      setNewFolderName('');
      fetchObjects(selectedBucket, currentPrefix);
      toast({ title: '文件夹已创建' });
    } else {
      toast({ title: '创建失败', variant: 'destructive' });
    }
  };

  const handleConfirmDeleteFolder = async () => {
    if (!selectedBucket || !deleteFolderTarget) return;
    const folderPrefix = currentPrefix + deleteFolderTarget;
    // 列出该目录下所有文件
    const res = await api.listObjects(projectId, selectedBucket.name, { prefix: folderPrefix });
    if (res.success && res.data) {
      for (const obj of res.data) {
        await api.deleteObject(projectId, selectedBucket.name, obj.name);
      }
      fetchObjects(selectedBucket, currentPrefix);
      toast({ title: '文件夹已删除' });
    } else {
      toast({ title: '删除失败', variant: 'destructive' });
    }
    setDeleteFolderTarget(null);
  };

  return (
    <DashboardLayout isProjectLevel={true}>
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
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">文件存储</h1>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-1 rounded-md">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              项目级别
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            存储桶在所有环境中共享
          </p>
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

      {/* Delete Folder Confirmation */}
      <AlertDialog open={!!deleteFolderTarget} onOpenChange={() => setDeleteFolderTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除文件夹</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除文件夹 &quot;{deleteFolderTarget}&quot; 及其所有内容吗？此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDeleteFolder} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create Folder Dialog */}
      <Dialog open={createFolderOpen} onOpenChange={setCreateFolderOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label htmlFor="folder-name" className="text-sm font-medium">
                文件夹名称
              </label>
              <Input
                id="folder-name"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="my-folder"
                onKeyDown={(e) => { if (e.key === 'Enter' && newFolderName.trim()) handleCreateFolder(); }}
              />
              {currentPrefix && (
                <p className="text-xs text-muted-foreground">
                  将创建在 {currentPrefix} 下
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateFolderOpen(false)}>
              取消
            </Button>
            <Button onClick={handleCreateFolder} disabled={!newFolderName.trim()}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                    onClick={() => { setSelectedBucket(bucket); setCurrentPrefix(''); }}
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
                    onClick={() => {
                      if (currentPrefix) {
                        // 返回上级目录
                        const parts = currentPrefix.slice(0, -1).split('/');
                        parts.pop();
                        setCurrentPrefix(parts.length > 0 ? parts.join('/') + '/' : '');
                      } else {
                        setSelectedBucket(null);
                      }
                    }}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                )}
                {selectedBucket ? (
                  <div className="flex items-center gap-1 text-sm">
                    <button
                      className="font-medium hover:underline"
                      onClick={() => setCurrentPrefix('')}
                    >
                      {selectedBucket.name}
                    </button>
                    {currentPrefix && currentPrefix.split('/').filter(Boolean).map((segment, i, arr) => {
                      const path = arr.slice(0, i + 1).join('/') + '/';
                      return (
                        <span key={path} className="flex items-center gap-1">
                          <span className="text-muted-foreground">/</span>
                          {i === arr.length - 1 ? (
                            <span className="font-medium">{segment}</span>
                          ) : (
                            <button
                              className="hover:underline"
                              onClick={() => setCurrentPrefix(path)}
                            >
                              {segment}
                            </button>
                          )}
                        </span>
                      );
                    })}
                  </div>
                ) : (
                  <h3 className="font-medium text-sm">选择一个存储桶</h3>
                )}
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
                    onClick={() => setCreateFolderOpen(true)}
                  >
                    <FolderPlus className="h-4 w-4 mr-2" />
                    新建文件夹
                  </Button>
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
            ) : objects.length === 0 && !currentPrefix ? (
              <div className="p-12 text-center">
                <p className="text-muted-foreground mb-4">存储桶为空</p>
                <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
                  <Upload className="h-4 w-4 mr-2" />
                  上传第一个文件
                </Button>
              </div>
            ) : (() => {
              const { dirs, files } = groupByDirectory(objects, currentPrefix);
              return dirs.length === 0 && files.length === 0 ? (
                <div className="p-12 text-center">
                  <p className="text-muted-foreground mb-4">当前目录为空</p>
                  <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
                    <Upload className="h-4 w-4 mr-2" />
                    上传文件
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
                  {dirs.map((dir) => (
                    <TableRow
                      key={`dir-${dir}`}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => setCurrentPrefix(currentPrefix + dir)}
                    >
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <FolderOpen className="h-4 w-4 text-blue-500" />
                          <span className="font-mono text-sm">{dir}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">—</TableCell>
                      <TableCell className="text-right text-muted-foreground">目录</TableCell>
                      <TableCell className="text-right text-muted-foreground">—</TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
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
                                setDeleteFolderTarget(dir);
                              }}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              删除文件夹
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                  {files.map((obj) => (
                    <TableRow key={obj.objectId}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <ObjectThumbnail projectId={projectId} bucket={selectedBucket} obj={obj} />
                          <span className="font-mono text-sm">{obj.name.slice(currentPrefix.length)}</span>
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
              );
            })()}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
