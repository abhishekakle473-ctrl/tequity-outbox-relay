// The worker's four queries. created_at is compared only in SQL, never read into a JavaScript Date (docs/decisions.md).
import type pg from 'pg';

export interface Pending {
  event_id: string;
  body: Buffer;
  // Opaque: passed back to oldestUnsent as lastDelivered, never compared in JavaScript.
  created_at: string;
  late: boolean;
}

// Picks each user's oldest unsent event first and only then applies the 1-second hold, so a held oldest event
// can never let a later one go first. Busy users are left out before the limit; the longest-waiting comes first.
export const READY_USERS = `
  SELECT user_id FROM (
    SELECT DISTINCT ON (user_id) user_id, received_at
    FROM events WHERE delivered_at IS NULL
    ORDER BY user_id, created_at, seq) o
  WHERE received_at < now() - interval '1 second' AND user_id <> ALL($1)
  ORDER BY received_at LIMIT $2`;

export async function readyUsers(pool: pg.Pool, excluded: readonly string[], limit: number): Promise<string[]> {
  const r = await pool.query<{ user_id: string }>(READY_USERS, [excluded, limit]);
  return r.rows.map((row) => row.user_id);
}

// The text copy has its own name: under the column's name, ORDER BY created_at would sort by the text, not the time.
export const OLDEST_UNSENT = `
  SELECT event_id, body, created_at::text AS created_text,
         received_at < now() - interval '1 second' AS ready,
         coalesce(created_at < $2::timestamptz, false) AS late
  FROM events WHERE user_id = $1 AND delivered_at IS NULL
  ORDER BY created_at, seq LIMIT 1`;

// The user's oldest unsent event, or null when none is left or it is still inside its 1-second hold.
// lastDelivered is the created_at of the last event this worker delivered for the user: an event created before it
// arrived late, after a later one went out. Checking that in SQL against every delivered row would scan the table.
export async function oldestUnsent(pool: pg.Pool, userId: string, lastDelivered: string | null): Promise<Pending | null> {
  const r = await pool.query<{ event_id: string; body: Buffer; created_text: string; ready: boolean; late: boolean }>(
    OLDEST_UNSENT,
    [userId, lastDelivered]
  );
  const row = r.rows[0];
  if (row === undefined || !row.ready) return null;
  return { event_id: row.event_id, body: row.body, created_at: row.created_text, late: row.late };
}

// False means the row was already marked or does not exist, which the worker logs: it should never happen.
export async function markDelivered(pool: pg.Pool, eventId: string): Promise<boolean> {
  const r = await pool.query('UPDATE events SET delivered_at = now() WHERE event_id = $1 AND delivered_at IS NULL', [eventId]);
  return r.rowCount === 1;
}

export async function unsentCount(pool: pg.Pool): Promise<number> {
  const r = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM events WHERE delivered_at IS NULL');
  return r.rows[0]?.n ?? 0;
}
