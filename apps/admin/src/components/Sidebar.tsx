'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { useAppStore } from '@/store';
import { isMultiTenantEnabled, getDefaultTenantId } from '@/lib/tenant-config';
import { buildGlobalNav, buildProjectNav, buildTenantNav, type NavIconKey } from './sidebar-nav';
import {
  LayoutDashboard,
  Building2,
  Users,
  User,
  HardDrive,
  Settings,
  FolderKanban,
  Table2,
  Database,
  Key,
  ChevronLeft,
  LogOut,
  Shield,
  Radio,
  Code,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

const navIcons: Record<NavIconKey, React.ReactNode> = {
  dashboard: <LayoutDashboard className="h-4 w-4" />,
  tenant: <Building2 className="h-4 w-4" />,
  users: <Users className="h-4 w-4" />,
  profile: <User className="h-4 w-4" />,
  storage: <HardDrive className="h-4 w-4" />,
  settings: <Settings className="h-4 w-4" />,
  project: <FolderKanban className="h-4 w-4" />,
  table: <Table2 className="h-4 w-4" />,
  database: <Database className="h-4 w-4" />,
  key: <Key className="h-4 w-4" />,
  shield: <Shield className="h-4 w-4" />,
  realtime: <Radio className="h-4 w-4" />,
  functions: <Code className="h-4 w-4" />,
};

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
  // Determine which nav to show
  let navItems: ReturnType<typeof buildGlobalNav>;
  let contextTitle: string | null = null;
  let contextSubtitle: string | null = null;
  let backHref: string | null = null;

  const multiTenant = isMultiTenantEnabled();
  const defaultTenant = getDefaultTenantId();

  if (projectId && tenantId) {
    navItems = buildProjectNav(tenantId, projectId);
    contextTitle = currentProject?.name || '项目';
    contextSubtitle = multiTenant ? (currentTenant?.name ?? null) : null;
    backHref = `/t/${tenantId}`;
  } else if (tenantId) {
    navItems = buildTenantNav(tenantId, multiTenant);
    contextTitle = multiTenant ? (currentTenant?.name || '租户') : 'Druvia';
    contextSubtitle = multiTenant ? (currentTenant?.alias ?? null) : null;
    // In single-tenant mode, don't show back button from tenant view
    backHref = multiTenant ? '/tenants' : null;
  } else if (!multiTenant) {
    // 单租户模式下，全局页面也使用租户导航菜单
    navItems = buildTenantNav(defaultTenant, multiTenant);
    contextTitle = 'Druvia';
    contextSubtitle = null;
    backHref = null;
  } else {
    navItems = buildGlobalNav(multiTenant, defaultTenant);
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
            {navIcons[item.icon]}
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
