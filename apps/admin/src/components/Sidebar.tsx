'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { useAppStore } from '@/store';
import {
  LayoutDashboard,
  Building2,
  Users,
  HardDrive,
  Settings,
  FolderKanban,
  Table2,
  Database,
  Key,
  ChevronLeft,
  LogOut,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

// Global navigation (no tenant context)
const globalNav: NavItem[] = [
  { href: '/dashboard', label: '仪表板', icon: <LayoutDashboard className="h-4 w-4" /> },
  { href: '/tenants', label: '租户管理', icon: <Building2 className="h-4 w-4" /> },
  { href: '/users', label: '用户管理', icon: <Users className="h-4 w-4" /> },
  { href: '/backups', label: '备份管理', icon: <HardDrive className="h-4 w-4" /> },
  { href: '/settings', label: '设置', icon: <Settings className="h-4 w-4" /> },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const { currentTenant, currentProject, setCurrentTenant, setCurrentProject } = useAppStore();

  // Parse current context from URL
  const tenantMatch = pathname.match(/^\/t\/([^/]+)/);
  const projectMatch = pathname.match(/^\/t\/([^/]+)\/p\/([^/]+)/);
  const tenantId = tenantMatch?.[1];
  const projectId = projectMatch?.[2];

  // Build navigation based on context
  const getTenantNav = (tid: string): NavItem[] => [
    { href: `/t/${tid}`, label: '概览', icon: <LayoutDashboard className="h-4 w-4" /> },
    { href: `/t/${tid}/projects`, label: '项目', icon: <FolderKanban className="h-4 w-4" /> },
    { href: `/t/${tid}/backups`, label: '备份', icon: <HardDrive className="h-4 w-4" /> },
    { href: `/t/${tid}/settings`, label: '设置', icon: <Settings className="h-4 w-4" /> },
  ];

  const getProjectNav = (tid: string, pid: string): NavItem[] => [
    { href: `/t/${tid}/p/${pid}`, label: '概览', icon: <LayoutDashboard className="h-4 w-4" /> },
    { href: `/t/${tid}/p/${pid}/tables`, label: '数据表', icon: <Table2 className="h-4 w-4" /> },
    { href: `/t/${tid}/p/${pid}/database`, label: '数据库', icon: <Database className="h-4 w-4" /> },
    { href: `/t/${tid}/p/${pid}/storage`, label: '存储', icon: <HardDrive className="h-4 w-4" /> },
    { href: `/t/${tid}/p/${pid}/api`, label: 'API', icon: <Key className="h-4 w-4" /> },
    { href: `/t/${tid}/p/${pid}/settings`, label: '设置', icon: <Settings className="h-4 w-4" /> },
  ];

  // Determine which nav to show
  let navItems: NavItem[];
  let contextTitle: string | null = null;
  let contextSubtitle: string | null = null;
  let backHref: string | null = null;

  if (projectId && tenantId) {
    navItems = getProjectNav(tenantId, projectId);
    contextTitle = currentProject?.name || '项目';
    contextSubtitle = currentTenant?.name ?? null;
    backHref = `/t/${tenantId}`;
  } else if (tenantId) {
    navItems = getTenantNav(tenantId);
    contextTitle = currentTenant?.name || '租户';
    contextSubtitle = currentTenant?.alias ?? null;
    backHref = '/tenants';
  } else {
    navItems = globalNav;
  }

  const handleBack = () => {
    if (projectId) {
      setCurrentProject(null);
    } else if (tenantId) {
      setCurrentTenant(null);
    }
  };

  const isActive = (href: string) => {
    if (href === pathname) return true;
    // For overview pages, only exact match
    if (href.endsWith('/p/' + projectId) || href.endsWith('/t/' + tenantId)) {
      return href === pathname;
    }
    // For other pages, check if pathname starts with href
    return pathname.startsWith(href + '/');
  };

  return (
    <aside className="fixed left-0 top-0 bottom-0 w-64 bg-white border-r border-gray-200 flex flex-col">
      <div className="p-4 border-b border-gray-200">
        {backHref ? (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-gray-500 hover:text-gray-900 hover:bg-gray-100"
              asChild
              onClick={handleBack}
            >
              <Link href={backHref}>
                <ChevronLeft className="h-4 w-4" />
              </Link>
            </Button>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-gray-900 truncate">{contextTitle}</p>
              {contextSubtitle && (
                <p className="text-xs text-gray-500 truncate">{contextSubtitle}</p>
              )}
            </div>
          </div>
        ) : (
          <>
            <h1 className="text-xl font-bold text-blue-600">Druvia</h1>
            <p className="text-sm text-gray-500">Admin Console</p>
          </>
        )}
      </div>

      <nav className="flex-1 py-4 overflow-y-auto">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-3 px-4 py-2 mx-2 rounded-md text-sm transition-colors',
              isActive(item.href)
                ? 'bg-blue-50 text-blue-600'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
            )}
          >
            {item.icon}
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>

      <div className="p-4 border-t border-gray-200">
        {user && (
          <div className="flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900 truncate">
                {user.username || user.email}
              </p>
              <p className="text-xs text-gray-500 truncate">{user.email}</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-gray-500 hover:text-gray-900 hover:bg-gray-100"
              onClick={logout}
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
}
