import { query, queryOne } from '../../db/index.js';
import { generateUserId } from '@druvia/shared';
import type { User, UserRole } from '@druvia/shared';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

const SALT_ROUNDS = 12;

// Database row type (snake_case)
interface UserRow {
  id: number;
  user_id: string;
  email: string | null;
  username: string | null;
  password_hash: string | null;
  avatar_url: string | null;
  status: string;
  role: string;
  created_at: Date;
  updated_at: Date;
}

// Convert database row to User interface
function toUser(row: UserRow): User {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    username: row.username,
    avatarUrl: row.avatar_url,
    status: row.status as User['status'],
    role: row.role as UserRole,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RegisterInput {
  email: string;
  password: string;
  username?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export async function register(input: RegisterInput): Promise<User> {
  const userId = generateUserId();
  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const row = await queryOne<UserRow>(
    `INSERT INTO druvia_users (user_id, email, username, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userId, input.email, input.username || null, passwordHash]
  );

  if (!row) {
    throw new Error('Failed to create user');
  }

  return toUser(row);
}

export async function login(input: LoginInput): Promise<User | null> {
  const row = await queryOne<UserRow>(
    'SELECT * FROM druvia_users WHERE email = $1 AND status = $2',
    [input.email, 'active']
  );

  if (!row || !row.password_hash) {
    return null;
  }

  const valid = await bcrypt.compare(input.password, row.password_hash);
  if (!valid) {
    return null;
  }

  return toUser(row);
}

export async function getUserById(userId: string): Promise<User | null> {
  const row = await queryOne<UserRow>(
    'SELECT * FROM druvia_users WHERE user_id = $1',
    [userId]
  );
  return row ? toUser(row) : null;
}

export async function getUserByUid(uid: number): Promise<User | null> {
  const row = await queryOne<UserRow>(
    'SELECT * FROM druvia_users WHERE id = $1',
    [uid]
  );
  return row ? toUser(row) : null;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const row = await queryOne<UserRow>(
    'SELECT * FROM druvia_users WHERE email = $1',
    [email]
  );
  return row ? toUser(row) : null;
}

export async function updateUser(
  userId: string,
  input: { username?: string; avatarUrl?: string }
): Promise<User | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (input.username !== undefined) {
    updates.push(`username = $${paramIndex++}`);
    values.push(input.username);
  }
  if (input.avatarUrl !== undefined) {
    updates.push(`avatar_url = $${paramIndex++}`);
    values.push(input.avatarUrl);
  }

  if (updates.length === 0) {
    return getUserById(userId);
  }

  values.push(userId);
  const row = await queryOne<UserRow>(
    `UPDATE druvia_users SET ${updates.join(', ')} WHERE user_id = $${paramIndex} RETURNING *`,
    values
  );

  return row ? toUser(row) : null;
}

export async function changePassword(userId: string, newPassword: string): Promise<boolean> {
  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  const rows = await query<{ user_id: string }>(
    'UPDATE druvia_users SET password_hash = $1 WHERE user_id = $2 RETURNING user_id',
    [passwordHash, userId]
  );
  return rows.length > 0;
}

export async function listUsers(
  limit = 50,
  offset = 0
): Promise<{ users: User[]; total: number }> {
  const rows = await query<UserRow>(
    `SELECT * FROM druvia_users
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  const countResult = await queryOne<{ count: string }>(
    'SELECT COUNT(*) as count FROM druvia_users'
  );
  const total = parseInt(countResult?.count || '0', 10);

  return {
    users: rows.map(toUser),
    total,
  };
}

export async function deleteUser(userId: string): Promise<boolean> {
  const rows = await query<{ user_id: string }>(
    'DELETE FROM druvia_users WHERE user_id = $1 RETURNING user_id',
    [userId]
  );
  return rows.length > 0;
}

export async function updateUserStatus(
  userId: string,
  status: 'active' | 'inactive' | 'suspended'
): Promise<User | null> {
  const row = await queryOne<UserRow>(
    'UPDATE druvia_users SET status = $1 WHERE user_id = $2 RETURNING *',
    [status, userId]
  );
  return row ? toUser(row) : null;
}

// Admin user management functions

export interface CreateUserInput {
  email: string;
  username: string;
  password: string;
  role: UserRole;
}

export async function createUser(input: CreateUserInput): Promise<User> {
  const userId = generateUserId();
  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const row = await queryOne<UserRow>(
    `INSERT INTO druvia_users (user_id, email, username, password_hash, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, input.email, input.username, passwordHash, input.role]
  );

  if (!row) {
    throw new Error('Failed to create user');
  }

  return toUser(row);
}

export interface UpdateUserFullInput {
  username?: string;
  email?: string;
  role?: UserRole;
}

export async function updateUserFull(
  userId: string,
  input: UpdateUserFullInput
): Promise<User | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (input.username !== undefined) {
    updates.push(`username = $${paramIndex++}`);
    values.push(input.username);
  }
  if (input.email !== undefined) {
    updates.push(`email = $${paramIndex++}`);
    values.push(input.email);
  }
  if (input.role !== undefined) {
    updates.push(`role = $${paramIndex++}`);
    values.push(input.role);
  }

  if (updates.length === 0) {
    return getUserById(userId);
  }

  values.push(userId);
  const row = await queryOne<UserRow>(
    `UPDATE druvia_users SET ${updates.join(', ')} WHERE user_id = $${paramIndex} RETURNING *`,
    values
  );

  return row ? toUser(row) : null;
}

export async function resetPassword(userId: string): Promise<string> {
  // Generate random 12-char password
  const tempPassword = crypto.randomBytes(9).toString('base64').slice(0, 12);
  const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

  await query(
    'UPDATE druvia_users SET password_hash = $1 WHERE user_id = $2',
    [passwordHash, userId]
  );

  return tempPassword;
}
