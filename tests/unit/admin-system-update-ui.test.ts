import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('admin system update UI contract', () => {
  it('uses shared update status types and exposes system update API client methods', () => {
    const packageJson = read('apps/admin/package.json');
    const apiClient = read('apps/admin/src/lib/api.ts');

    expect(packageJson).toContain('"@druvia/shared": "workspace:*"');
    expect(apiClient).toContain("import type { DruviaUpdateStatus } from '@druvia/shared'");
    expect(apiClient).toContain('/api/v1/system/update/status');
    expect(apiClient).toContain('/api/v1/system/update/check');
    expect(apiClient).toContain('/api/v1/system/update/download');
    expect(apiClient).toContain('/api/v1/system/update/apply');
    expect(apiClient).toContain('/api/v1/system/update/rollback');
    expect(apiClient).toContain('/api/v1/system/restart');
  });

  it('mounts the passive update notice in the global dashboard layout', () => {
    const layout = read('apps/admin/src/components/DashboardLayout.tsx');

    expect(layout).toContain("import { SystemUpdateNotice } from '@/components/system-update/SystemUpdateNotice'");
    expect(layout).toContain('<SystemUpdateNotice />');
  });

  it('mounts a super-admin update operation panel on the system settings page', () => {
    const page = read('apps/admin/src/app/settings/page.tsx');
    const panel = read('apps/admin/src/components/system-update/SystemUpdatePanel.tsx');

    expect(page).toContain("import { SystemUpdatePanel } from '@/components/system-update/SystemUpdatePanel'");
    expect(page).toContain('<SystemUpdatePanel />');
    expect(panel).toContain('检查更新');
    expect(panel).toContain('更新');
    expect(panel).toContain('重启并应用');
    expect(panel).toContain('重启服务');
    expect(panel).toContain('AlertDialog');
    expect(panel).toContain('RefreshCw');
    expect(panel).toContain('Download');
    expect(panel).toContain('RotateCw');
    expect(panel).toContain('Power');
  });

  it('polls update status while a background update operation is running', () => {
    const panel = read('apps/admin/src/components/system-update/SystemUpdatePanel.tsx');

    expect(panel).toContain('async function pollStatus()');
    expect(panel).toContain('busyPhases.has(status.phase)');
    expect(panel).toContain('window.setInterval(pollStatus, 2 * 1000)');
  });
});
