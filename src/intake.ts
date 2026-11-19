import pg from 'pg';

export type Valid = { ok: true; event_id: string; user_id: string; created_at: string };
export type Invalid = { ok: false; status: 400 | 413; reason: string };

export const MAX_BYTES = 1_048_576;
// Postgres's btree index refuses entries over about 2.7 KB, and that error would be a 503 the client retries forever.
const MAX_ID_BYTES = 1000;
// Fatal, so bytes that are not UTF-8 are refused, never quietly replaced with U+FFFD.
const utf8 = new TextDecoder('utf-8', { fatal: true });
// RFC 3339 date-time, plus no zone (read as UTC). Month and day ranges are left to Postgres's cast.
const CREATED_AT = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.(\d+))?(?:[Zz]|[+-]\d{2}:\d{2})?$/;

const bad = (reason: string): Invalid => ({ ok: false, status: 400, reason });

export function validate(body: Buffer): Valid | Invalid {
  // Checked before parsing so an oversized body costs nothing.
  if (body.length > MAX_BYTES) return { ok: false, status: 413, reason: 'body over 1 MB' };

  let text: string;
  try {
    text = utf8.decode(body);
  } catch {
    return bad('body is not valid UTF-8');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return bad('body is not valid JSON');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return bad('body must be a JSON object');

  const { event_id, user_id, created_at } = json as Record<string, unknown>;
  for (const [name, value] of [['event_id', event_id], ['user_id', user_id]] as const) {
    if (typeof value !== 'string' || value === '') return bad(`${name} must be a non-empty string`);
    // Postgres text cannot hold NUL, so it would fail at insert time as a 503.
    if (value.includes('\u0000')) return bad(`${name} must not contain a NUL character`);
    if (Buffer.byteLength(value) > MAX_ID_BYTES) return bad(`${name} must be at most ${MAX_ID_BYTES} bytes`);
  }
  if (typeof event_id !== 'string' || typeof user_id !== 'string') return bad('event_id and user_id must be strings');
  if (typeof created_at !== 'string' || created_at === '') return bad('created_at must be a non-empty string');

  const m = CREATED_AT.exec(created_at);
  if (!m) return bad('created_at must be an RFC 3339 date-time');

  const fraction = m[1];
  if (fraction === undefined || fraction.length <= 6) return { ok: true, event_id, user_id, created_at };

  // Cut the text, never round it or go through Date: Postgres keeps 6 decimals and Date keeps 3.
  console.error(JSON.stringify({ level: 'warn', msg: 'created_at cut to 6 decimals', event_id, user_id }));
  return { ok: true, event_id, user_id, created_at: created_at.replace(`.${fraction}`, `.${fraction.slice(0, 6)}`) };
}

const INSERT = `INSERT INTO events (event_id, user_id, created_at, body) VALUES ($1, $2, $3::timestamptz, $4)
ON CONFLICT (event_id) DO NOTHING`;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// pool.query autocommits, so once it resolves the event is committed and a 200 keeps the promise.
export async function insert(pool: pg.Pool, body: Buffer, fields: Valid): Promise<200 | 400 | 503> {
  const { event_id, user_id, created_at } = fields;
  try {
    const r = await pool.query(INSERT, [event_id, user_id, created_at, body]);
    if (r.rowCount === 0) await compareRepeat(pool, body, event_id, user_id);
    return 200;
  } catch (e) {
    // Class 22 is a data exception: Postgres refused the created_at cast, such as month 13 or offset +99:99.
    if (e instanceof pg.DatabaseError && e.code?.startsWith('22')) {
      console.error(JSON.stringify({ level: 'warn', msg: 'rejected with 400', reason: message(e), event_id, user_id }));
      return 400;
    }
    console.error(JSON.stringify({ level: 'error', msg: 'insert failed; answering 503', err: message(e), event_id, user_id }));
    return 503;
  }
}

// The first body stands. The row is already committed, so a failed lookup here is logged and still answered 200.
async function compareRepeat(pool: pg.Pool, body: Buffer, event_id: string, user_id: string): Promise<void> {
  try {
    const r = await pool.query<{ body: Buffer }>('SELECT body FROM events WHERE event_id = $1', [event_id]);
    if (r.rows[0]?.body.equals(body) === false) {
      console.error(JSON.stringify({ level: 'warn', msg: 'repeat event_id with a different body; the first body stands', event_id, user_id }));
    }
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'could not compare a repeat body', err: message(e), event_id, user_id }));
  }
}
