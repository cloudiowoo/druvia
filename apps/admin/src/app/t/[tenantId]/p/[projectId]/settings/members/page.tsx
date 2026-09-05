'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ProjectMemberRole, ProjectMemberView } from '@druvia/shared';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { useProjectAccess } from '@/hooks/use-project-access';
import { useToast } from '@/hooks/use-toast';
import { Plus, Search, Trash2, Users } from 'lucide-react';

const ROLE_LABELS: Record<ProjectMemberView['role'], string> = {
  owner: '所有者',
  project_admin: '项目管理员',
  database_admin: '数据库管理员',
  viewer: '只读成员',
};

const ASSIGNABLE_ROLES: ProjectMemberRole[] = ['project_admin', 'database_admin', 'viewer'];

export default function ProjectMembersPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { can } = useProjectAccess();
  const { toast } = useToast();
  const canManage = can('members:manage');
  const [members, setMembers] = useState<ProjectMemberView[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<ProjectMemberView[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedRole, setSelectedRole] = useState<ProjectMemberRole>('viewer');
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingRole, setPendingRole] = useState<{ member: ProjectMemberView; role: ProjectMemberRole } | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<ProjectMemberView | null>(null);

  const selectedCandidate = useMemo(
    () => candidates.find((candidate) => candidate.userId === selectedUserId),
    [candidates, selectedUserId],
  );

  async function loadMembers() {
    const result = await api.listProjectMembers(projectId);
    if (result.success && result.data) setMembers(result.data);
    else toast({ title: '读取成员失败', description: result.error?.message, variant: 'destructive' });
    setLoading(false);
  }

  useEffect(() => {
    void loadMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (!addOpen || query.trim().length < 2) {
      setCandidates([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(async () => {
      const result = await api.searchProjectMemberCandidates(projectId, query.trim());
      setCandidates(result.success && result.data ? result.data : []);
      if (!result.success) {
        toast({ title: '搜索失败', description: result.error?.message, variant: 'destructive' });
      }
      setSearching(false);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [addOpen, projectId, query, toast]);

  async function addMember() {
    if (!selectedUserId) return;
    setSubmitting(true);
    const result = await api.createProjectMember(projectId, selectedUserId, selectedRole);
    setSubmitting(false);
    if (!result.success) {
      toast({ title: '添加成员失败', description: result.error?.message, variant: 'destructive' });
      return;
    }
    toast({ title: '项目成员已添加' });
    setAddOpen(false);
    setQuery('');
    setSelectedUserId('');
    setSelectedRole('viewer');
    await loadMembers();
  }

  async function confirmRoleChange() {
    if (!pendingRole) return;
    setSubmitting(true);
    const result = await api.updateProjectMember(projectId, pendingRole.member.userId, pendingRole.role);
    setSubmitting(false);
    if (result.success) {
      toast({ title: '成员角色已更新' });
      setPendingRole(null);
      await loadMembers();
    } else {
      toast({ title: '更新角色失败', description: result.error?.message, variant: 'destructive' });
    }
  }

  async function confirmRemoval() {
    if (!pendingRemoval) return;
    setSubmitting(true);
    const result = await api.deleteProjectMember(projectId, pendingRemoval.userId);
    setSubmitting(false);
    if (result.success) {
      toast({ title: '项目成员已移除' });
      setPendingRemoval(null);
      await loadMembers();
    } else {
      toast({ title: '移除成员失败', description: result.error?.message, variant: 'destructive' });
    }
  }

  return (
    <DashboardLayout isProjectLevel>
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 text-sm text-muted-foreground">
              <Link href={`/t/${tenantId}/p/${projectId}/settings`} className="hover:text-foreground">项目设置</Link>
              <span className="px-2">/</span>
              <span>项目成员</span>
            </div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <Users className="h-6 w-6" />项目成员
            </h1>
          </div>
          {canManage && (
            <Button onClick={() => setAddOpen(true)}><Plus />添加成员</Button>
          )}
        </div>

        <section className="overflow-hidden rounded-md border bg-white">
          <div className="grid min-h-12 grid-cols-[minmax(0,1fr)_180px_100px] items-center border-b bg-gray-50 px-5 text-sm font-medium text-gray-600">
            <span>用户</span><span>项目角色</span><span className="text-right">操作</span>
          </div>
          {loading ? (
            <div className="flex h-28 items-center justify-center text-sm text-gray-500">加载中...</div>
          ) : members.length === 0 ? (
            <div className="flex h-28 items-center justify-center text-sm text-gray-500">暂无成员</div>
          ) : members.map((member) => (
            <div key={member.userId} className="grid min-h-16 grid-cols-[minmax(0,1fr)_180px_100px] items-center border-b px-5 last:border-b-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{member.username || member.email}</span>
                  {member.isWorkspaceOwner && <Badge variant="secondary">所有者</Badge>}
                </div>
                <div className="truncate text-sm text-gray-500">{member.email}</div>
              </div>
              <div>
                {canManage && !member.isWorkspaceOwner ? (
                  <Select value={member.role} onValueChange={(role) => setPendingRole({ member, role: role as ProjectMemberRole })}>
                    <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>{ASSIGNABLE_ROLES.map((role) => <SelectItem key={role} value={role}>{ROLE_LABELS[role]}</SelectItem>)}</SelectContent>
                  </Select>
                ) : <span className="text-sm">{ROLE_LABELS[member.role]}</span>}
              </div>
              <div className="text-right">
                {canManage && !member.isWorkspaceOwner && (
                  <Button variant="ghost" size="icon" title="移除成员" onClick={() => setPendingRemoval(member)}>
                    <Trash2 className="text-red-600" /><span className="sr-only">移除成员</span>
                  </Button>
                )}
              </div>
            </div>
          ))}
        </section>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>添加项目成员</DialogTitle><DialogDescription>选择现有平台用户并分配项目角色。</DialogDescription></DialogHeader>
          <div className="space-y-4">
            <div className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" /><Input className="pl-9" value={query} onChange={(event) => { setQuery(event.target.value); setSelectedUserId(''); }} placeholder="搜索邮箱或用户名" /></div>
            <div className="min-h-24 rounded-md border">
              {searching ? <div className="p-4 text-sm text-gray-500">搜索中...</div> : candidates.map((candidate) => (
                <button key={candidate.userId} type="button" onClick={() => setSelectedUserId(candidate.userId)} className={`block w-full border-b px-4 py-3 text-left last:border-b-0 ${selectedUserId === candidate.userId ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                  <div className="font-medium">{candidate.username || candidate.email}</div><div className="text-sm text-gray-500">{candidate.email}</div>
                </button>
              ))}
            </div>
            <Select value={selectedRole} onValueChange={(role) => setSelectedRole(role as ProjectMemberRole)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{ASSIGNABLE_ROLES.map((role) => <SelectItem key={role} value={role}>{ROLE_LABELS[role]}</SelectItem>)}</SelectContent></Select>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setAddOpen(false)}>取消</Button><Button disabled={!selectedCandidate || submitting} onClick={addMember}>{submitting ? '添加中...' : '添加'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pendingRole} onOpenChange={(open) => !open && setPendingRole(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认修改角色</AlertDialogTitle><AlertDialogDescription>将 {pendingRole?.member.email} 的角色修改为 {pendingRole ? ROLE_LABELS[pendingRole.role] : ''}。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction disabled={submitting} onClick={confirmRoleChange}>确认修改</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      <AlertDialog open={!!pendingRemoval} onOpenChange={(open) => !open && setPendingRemoval(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认移除成员</AlertDialogTitle><AlertDialogDescription>移除后，{pendingRemoval?.email} 将立即失去该项目的管理权限。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction disabled={submitting} className="bg-red-600 hover:bg-red-700" onClick={confirmRemoval}>确认移除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </DashboardLayout>
  );
}
