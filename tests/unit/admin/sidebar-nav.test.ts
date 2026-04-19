import { describe, expect, it } from 'vitest';
import { buildProjectNav, buildTenantNav } from '../../../apps/admin/src/components/sidebar-nav';

describe('sidebar navigation', () => {
  it('includes personal settings in single-tenant tenant navigation', () => {
    const nav = buildTenantNav('default', false);

    expect(nav).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ href: '/settings', label: '个人设置', icon: 'profile' }),
        expect.objectContaining({ href: '/t/default/settings', label: '工作区设置' }),
      ])
    );
  });

  it('includes personal settings in project navigation', () => {
    const nav = buildProjectNav('default', 'proj_123');

    expect(nav).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ href: '/settings', label: '个人设置', icon: 'profile' }),
        expect.objectContaining({ href: '/t/default/p/proj_123/settings', label: '项目设置', icon: 'settings' }),
      ])
    );
  });
});
