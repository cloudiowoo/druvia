export interface PasswordResetActor {
  userId: string;
  role?: 'super_admin' | 'admin';
}

export interface PasswordResetTarget {
  userId: string;
  role: 'super_admin' | 'admin';
}

export function canResetUserPassword(
  currentUser: PasswordResetActor | null | undefined,
  targetUser: PasswordResetTarget
): boolean {
  return currentUser?.role === 'super_admin' && currentUser.userId !== targetUser.userId;
}
