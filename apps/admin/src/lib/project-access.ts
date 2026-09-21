import type { ProjectAccess, ProjectCapability } from '@druvia/shared';
import type { NavItem } from '@/components/sidebar-nav';

export function hasProjectCapability(
  access: ProjectAccess | null | undefined,
  capability: ProjectCapability,
): boolean {
  return access?.capabilities.includes(capability) ?? false;
}

const NAV_CAPABILITIES: Partial<Record<NavItem['label'], ProjectCapability>> = {
  '概览': 'project:read',
  '数据表': 'database:read',
  '数据库': 'database:read',
  '存储': 'storage:manage',
  '认证': 'auth:manage',
  '实时': 'realtime:manage',
  'Functions': 'functions:manage',
  'API': 'database:read',
  '项目设置': 'project:read',
};

export function filterProjectNavigation(
  items: NavItem[],
  access: ProjectAccess | null | undefined,
): NavItem[] {
  return items.filter((item) => {
    const capability = NAV_CAPABILITIES[item.label];
    return capability ? hasProjectCapability(access, capability) : true;
  });
}

export function requiredProjectCapability(pathname: string): ProjectCapability | null {
  const match = pathname.match(/^\/t\/[^/]+\/p\/[^/]+(?:\/(.*))?$/);
  const path = match?.[1] ?? '';
  if (path === 'auth' || path.startsWith('auth/')) return 'auth:manage';
  if (path === 'storage' || path.startsWith('storage/')) return 'storage:manage';
  if (path === 'functions' || path.startsWith('functions/')) return 'functions:manage';
  if (path === 'realtime' || path.startsWith('realtime/')) return 'realtime:manage';
  if (path === 'api' || path.startsWith('api/')) return 'database:read';
  if (path.startsWith('settings/api-keys')) return 'api_keys:manage';
  if (path.startsWith('settings/environments')) return 'environments:manage';
  if (path.startsWith('settings/runtime-context')) return 'runtime_context:manage';
  if (path.startsWith('settings/data-access')) return 'data_access:manage';
  if (path.startsWith('settings/rate-limits')) return 'project:update';
  if (path.startsWith('settings/members')) return 'members:read';
  if (path === 'database' || path.startsWith('database/')) return 'database:read';
  if (path === 'tables' || path.startsWith('tables/')) return 'database:read';
  return match ? 'project:read' : null;
}
