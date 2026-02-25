'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { useAuth } from '@/lib/auth';

const navItems = [
  { href: '/dashboard', label: '仪表板', icon: '📊' },
  { href: '/tenants', label: '租户管理', icon: '🏢' },
  { href: '/users', label: '用户管理', icon: '👥' },
  { href: '/backups', label: '备份管理', icon: '💾' },
  { href: '/settings', label: '设置', icon: '⚙️' },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();

  return (
    <aside className="sidebar">
      <div className="p-4 border-b border-gray-800">
        <h1 className="text-xl font-bold">Druvia</h1>
        <p className="text-sm text-gray-400">Admin Console</p>
      </div>

      <nav className="mt-4">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={clsx('sidebar-link', pathname === item.href && 'active')}
          >
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>

      <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-gray-800">
        {user && (
          <div className="flex items-center justify-between">
            <div className="truncate">
              <p className="text-sm font-medium">{user.username || user.email}</p>
              <p className="text-xs text-gray-400 truncate">{user.email}</p>
            </div>
            <button
              onClick={logout}
              className="text-gray-400 hover:text-white text-sm"
            >
              退出
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
