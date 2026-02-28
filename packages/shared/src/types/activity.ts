// packages/shared/src/types/activity.ts
export type ActivityAction =
  | 'user.login'
  | 'user.logout'
  | 'user.create'
  | 'user.update'
  | 'user.delete'
  | 'tenant.create'
  | 'tenant.update'
  | 'tenant.delete'
  | 'project.create'
  | 'project.delete'
  | 'backup.create'
  | 'backup.restore'
  | 'backup.delete'
  | 'settings.update';

export interface ActivityLog {
  id: string;
  userId: string | null;
  action: ActivityAction;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}
