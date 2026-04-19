import { describe, expect, it } from 'vitest';
import { canResetUserPassword } from '../../../apps/admin/src/app/users/permissions';

describe('admin users page permissions', () => {
  it('allows a super_admin to reset another user password', () => {
    expect(
      canResetUserPassword(
        { userId: 'usr_admin', role: 'super_admin' },
        { userId: 'usr_ops', role: 'admin' }
      )
    ).toBe(true);
  });

  it('does not allow a super_admin to reset their own password from the users page', () => {
    expect(
      canResetUserPassword(
        { userId: 'usr_admin', role: 'super_admin' },
        { userId: 'usr_admin', role: 'super_admin' }
      )
    ).toBe(false);
  });

  it('does not allow a regular admin to reset another user password', () => {
    expect(
      canResetUserPassword(
        { userId: 'usr_ops', role: 'admin' },
        { userId: 'usr_admin', role: 'super_admin' }
      )
    ).toBe(false);
  });
});
