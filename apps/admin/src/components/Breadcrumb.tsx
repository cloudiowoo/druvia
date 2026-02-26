'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAppStore } from '@/store';
import { ChevronRight, Home } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BreadcrumbItem {
  label: string;
  href?: string;
}

export function Breadcrumb() {
  const pathname = usePathname();
  const { currentTenant, currentProject } = useAppStore();

  const items: BreadcrumbItem[] = [];

  // Parse URL segments
  const segments = pathname.split('/').filter(Boolean);

  // Build breadcrumb based on URL structure
  if (segments[0] === 't' && segments[1]) {
    const tenantId = segments[1];
    items.push({
      label: currentTenant?.name || '租户',
      href: `/t/${tenantId}`,
    });

    if (segments[2] === 'projects') {
      items.push({ label: '项目列表' });
    } else if (segments[2] === 'p' && segments[3]) {
      const projectId = segments[3];
      items.push({
        label: currentProject?.name || '项目',
        href: `/t/${tenantId}/p/${projectId}`,
      });

      if (segments[4] === 'tables') {
        if (segments[5]) {
          items.push({
            label: '数据表',
            href: `/t/${tenantId}/p/${projectId}/tables`,
          });
          items.push({ label: segments[5] });
        } else {
          items.push({ label: '数据表' });
        }
      } else if (segments[4] === 'database') {
        items.push({ label: '数据库' });
      } else if (segments[4] === 'api') {
        items.push({ label: 'API' });
      } else if (segments[4] === 'settings') {
        items.push({ label: '设置' });
      }
    } else if (segments[2] === 'backups') {
      items.push({ label: '备份' });
    } else if (segments[2] === 'settings') {
      items.push({ label: '设置' });
    }
  }

  if (items.length === 0) return null;

  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-4">
      <Link
        href="/tenants"
        className="hover:text-foreground transition-colors"
      >
        <Home className="h-4 w-4" />
      </Link>
      {items.map((item, index) => (
        <span key={index} className="flex items-center gap-1">
          <ChevronRight className="h-4 w-4" />
          {item.href && index < items.length - 1 ? (
            <Link
              href={item.href}
              className="hover:text-foreground transition-colors"
            >
              {item.label}
            </Link>
          ) : (
            <span className={cn(index === items.length - 1 && 'text-foreground')}>
              {item.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
