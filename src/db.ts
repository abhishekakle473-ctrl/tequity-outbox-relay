import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

const log = (level: 'info' | 'error', msg: string, extra: Record<string, unknown> = {}): void =>
  console.error(JSON.stringify({ level, msg, ...extra }));

// 127.0.0.1, never localhost, which can mean ::1 first; Postgres listens on 127.0.0.1 only.
export function createPool(max: number): pg.Pool {
  const pool = new pg.Pool({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'relay', database: 'postgres', max,
    // A stalled Postgres must give a logged 503, not a request that never answers.
    connectionTimeoutMillis: 5000, statement_timeout: 10_000 });
  // An idle client's error with no listener crashes Node, for example when Postgres restarts.
  pool.on('error', (e) => log('error', 'idle Postgres connection failed', { err: e.message }));
  return pool;
}

export async function waitForDb(pool: pg.Pool): Promise<void> {
  for (;;) {
    try {
      await pool.query('SELECT 1');
      log('info', 'Postgres is reachable');
      return;
    } catch (e) {
      log('error', 'Postgres is not reachable; trying again in 1 s', { err: e instanceof Error ? e.message : String(e) });
    }
    await sleep(1000);
  }
}
