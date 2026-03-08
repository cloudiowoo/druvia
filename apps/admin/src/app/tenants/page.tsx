'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { DashboardLayout } from '@/components/DashboardLayout';
import { api } from '@/lib/api';
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
import { toast } from '@/hooks/use-toast';

interface Tenant {
  tenantId: string;
  alias: string;
  name: string;
  plan: string;
  status: string;
}

export default function TenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTenants() {
      try {
        const res = await api.listTenants();
        if (res.success && res.data) {
          setTenants(res.data);
        }
      } finally {
        setLoading(false);
      }
    }
    fetchTenants();
  }, []);

  const handleDelete = async (tenantId: string) => {
    setDeleteConfirm(tenantId);
  };

  const handleConfirmDelete = async () => {
    if (!deleteConfirm) return;
    const res = await api.deleteTenant(deleteConfirm);
    if (res.success) {
      setTenants(tenants.filter((t) => t.tenantId !== deleteConfirm));
      toast({ title: '租户已删除' });
    } else {
      toast({ title: '删除失败', description: res.error?.message, variant: 'destructive' });
    }
    setDeleteConfirm(null);
  };

  return (
    <DashboardLayout>
      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除租户</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除此租户吗？此操作将删除该租户下的所有项目和数据，不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">租户管理</h1>
          <p className="text-gray-500">管理平台租户</p>
        </div>
        <Link href="/tenants/new" className="btn btn-primary">
          创建租户
        </Link>
      </div>

      <div className="card">
        {loading ? (
          <div className="p-8 text-center text-gray-500">加载中...</div>
        ) : tenants.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            暂无租户，点击上方按钮创建
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>别名</th>
                <th>套餐</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => (
                <tr key={tenant.tenantId}>
                  <td>
                    <Link
                      href={`/tenants/${tenant.tenantId}`}
                      className="text-primary-600 hover:underline font-medium"
                    >
                      {tenant.name}
                    </Link>
                  </td>
                  <td className="text-gray-500">{tenant.alias}</td>
                  <td>
                    <span className="px-2 py-1 bg-gray-100 rounded text-xs">
                      {tenant.plan}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`px-2 py-1 rounded text-xs ${
                        tenant.status === 'active'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {tenant.status === 'active' ? '活跃' : tenant.status}
                    </span>
                  </td>
                  <td>
                    <div className="flex gap-2">
                      <Link
                        href={`/tenants/${tenant.tenantId}`}
                        className="text-sm text-primary-600 hover:underline"
                      >
                        详情
                      </Link>
                      <button
                        onClick={() => handleDelete(tenant.tenantId)}
                        className="text-sm text-red-600 hover:underline"
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </DashboardLayout>
  );
}
