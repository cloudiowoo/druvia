export type NavIconKey =
  | 'dashboard'
  | 'tenant'
  | 'users'
  | 'profile'
  | 'storage'
  | 'settings'
  | 'project'
  | 'table'
  | 'database'
  | 'key'
  | 'shield'
  | 'realtime'
  | 'functions';

export interface NavItem {
  href: string;
  label: string;
  icon: NavIconKey;
}

export function buildGlobalNav(multiTenant: boolean, defaultTenant: string): NavItem[] {
  const nav: NavItem[] = [
    {
      href: multiTenant ? '/dashboard' : `/t/${defaultTenant}`,
      label: multiTenant ? '仪表板' : '首页',
      icon: 'dashboard',
    },
  ];

  if (multiTenant) {
    nav.push({ href: '/tenants', label: '租户管理', icon: 'tenant' });
  }

  nav.push(
    { href: '/users', label: '用户管理', icon: 'users' },
    { href: '/backups', label: '备份管理', icon: 'storage' },
    { href: '/settings', label: '个人设置', icon: 'profile' }
  );

  return nav;
}

export function buildTenantNav(tenantId: string, multiTenant: boolean): NavItem[] {
  const nav: NavItem[] = [
    { href: `/t/${tenantId}`, label: '概览', icon: 'dashboard' },
    { href: `/t/${tenantId}/projects`, label: '项目', icon: 'project' },
  ];

  if (!multiTenant) {
    nav.push({ href: '/users', label: '用户管理', icon: 'users' });
  }

  nav.push(
    { href: `/t/${tenantId}/backups`, label: '备份', icon: 'storage' },
    { href: '/settings', label: '个人设置', icon: 'profile' },
    {
      href: `/t/${tenantId}/settings`,
      label: multiTenant ? '租户设置' : '工作区设置',
      icon: 'settings',
    }
  );

  return nav;
}

export function buildProjectNav(tenantId: string, projectId: string): NavItem[] {
  return [
    { href: `/t/${tenantId}/p/${projectId}`, label: '概览', icon: 'dashboard' },
    { href: `/t/${tenantId}/p/${projectId}/tables`, label: '数据表', icon: 'table' },
    { href: `/t/${tenantId}/p/${projectId}/database`, label: '数据库', icon: 'database' },
    { href: `/t/${tenantId}/p/${projectId}/storage`, label: '存储', icon: 'storage' },
    { href: `/t/${tenantId}/p/${projectId}/auth`, label: '认证', icon: 'shield' },
    { href: `/t/${tenantId}/p/${projectId}/realtime`, label: '实时', icon: 'realtime' },
    { href: `/t/${tenantId}/p/${projectId}/functions`, label: 'Functions', icon: 'functions' },
    { href: `/t/${tenantId}/p/${projectId}/api`, label: 'API', icon: 'key' },
    { href: '/settings', label: '个人设置', icon: 'profile' },
    { href: `/t/${tenantId}/p/${projectId}/settings`, label: '项目设置', icon: 'settings' },
  ];
}
