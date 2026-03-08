'use client';

import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { projectNameSchema } from '@/lib/schemas';

// 项目别名验证 schema
const projectAliasSchema = z.string()
  .min(3, '别名至少 3 个字符')
  .max(16, '别名最长 16 个字符')
  .regex(/^[a-z0-9]+$/, '别名只能包含小写字母和数字');

// 创建项目表单 schema
const createProjectFormSchema = z.object({
  name: projectNameSchema,
  alias: projectAliasSchema,
});

type CreateProjectFormData = z.infer<typeof createProjectFormSchema>;

export default function NewProjectPage() {
  const params = useParams();
  const router = useRouter();
  const tenantId = params.tenantId as string;
  const { currentTenant } = useAppStore();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<CreateProjectFormData>({
    resolver: zodResolver(createProjectFormSchema),
    defaultValues: {
      name: '',
      alias: '',
    },
  });

  const onSubmit = async (data: CreateProjectFormData) => {
    try {
      const res = await api.createProject(tenantId, data);
      if (res.success && res.data) {
        router.push(`/t/${tenantId}/p/${res.data.projectId}`);
      } else {
        setError('root', { message: res.error?.message || '创建失败' });
      }
    } catch {
      setError('root', { message: '创建失败，请重试' });
    }
  };

  return (
    <DashboardLayout>
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link href={`/t/${tenantId}`} className="hover:text-foreground">
            {currentTenant?.name || '租户'}
          </Link>
          <span>/</span>
          <Link href={`/t/${tenantId}/projects`} className="hover:text-foreground">
            项目
          </Link>
          <span>/</span>
          <span>新建</span>
        </div>
        <h1 className="text-2xl font-bold">创建项目</h1>
        <p className="text-muted-foreground">为租户创建新项目</p>
      </div>

      <div className="border rounded-lg max-w-xl">
        <div className="p-6">
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {errors.root && (
              <div className="bg-destructive/10 text-destructive px-4 py-2 rounded-md text-sm">
                {errors.root.message}
              </div>
            )}

            <div className="space-y-2">
              <label htmlFor="name" className="text-sm font-medium">
                项目名称
              </label>
              <Input
                id="name"
                {...register('name')}
                placeholder="我的项目"
                className={errors.name ? 'border-destructive' : ''}
              />
              {errors.name && (
                <p className="text-xs text-destructive">{errors.name.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="alias" className="text-sm font-medium">
                别名 (用于 URL)
              </label>
              <Input
                id="alias"
                {...register('alias', {
                  onChange: (e) => {
                    e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '');
                  },
                })}
                placeholder="main"
                className={errors.alias ? 'border-destructive' : ''}
              />
              {errors.alias ? (
                <p className="text-xs text-destructive">{errors.alias.message}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  3-16 个字符，仅限小写字母和数字
                </p>
              )}
            </div>

            <div className="flex gap-3 pt-4">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? '创建中...' : '创建项目'}
              </Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>
                取消
              </Button>
            </div>
          </form>
        </div>
      </div>
    </DashboardLayout>
  );
}
