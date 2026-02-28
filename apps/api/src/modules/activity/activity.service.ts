// apps/api/src/modules/activity/activity.service.ts
import { query, queryOne } from '../../db/index.js';
import type { ActivityLog, ActivityAction } from '@druvia/shared';

interface ActivityRow {
  id: string;
  user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown> | null;
  created_at: Date;
}

function toActivityLog(row: ActivityRow): ActivityLog {
  return {
    id: row.id,
    userId: row.user_id,
    action: row.action as ActivityAction,
    targetType: row.target_type,
    targetId: row.target_id,
    details: row.details,
    createdAt: row.created_at,
  };
}

export async function logActivity(
  userId: string | null,
  action: ActivityAction,
  targetType?: string,
  targetId?: string,
  details?: Record<string, unknown>
): Promise<ActivityLog> {
  const row = await queryOne<ActivityRow>(
    `INSERT INTO druvia_activity_logs (user_id, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, action, targetType || null, targetId || null, details ? JSON.stringify(details) : null]
  );

  if (!row) throw new Error('Failed to create activity log');
  return toActivityLog(row);
}

export async function listActivities(
  limit = 20,
  offset = 0
): Promise<{ activities: ActivityLog[]; total: number }> {
  const rows = await query<ActivityRow>(
    `SELECT * FROM druvia_activity_logs
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  const countResult = await queryOne<{ count: string }>(
    'SELECT COUNT(*) as count FROM druvia_activity_logs'
  );
  const total = parseInt(countResult?.count || '0', 10);

  return {
    activities: rows.map(toActivityLog),
    total,
  };
}
