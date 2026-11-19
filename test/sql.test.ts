import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type pg from 'pg';
import { freshDb } from './pg.ts';
import { OLDEST_UNSENT, READY_USERS, markDelivered, oldestUnsent, readyUsers, unsentCount } from '../src/sql.ts';

let pool: pg.Pool;
before(async () => {
  pool = await freshDb('sql_test');
});
after(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE events RESTART IDENTITY');
});

// Every node of an EXPLAIN (FORMAT JSON) plan, so a test can ask for a node type without depending on key order.
function planNodes(plan: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object' && v !== null) {
      const node = v as Record<string, unknown>;
      if (typeof node['Node Type'] === 'string') out.push(node);
      Object.values(node).forEach(walk);
    }
  };
  walk(plan);
  return out;
}

interface Row {
  id: string;
  user: string;
  created: string;
  receivedAgoMs: number;
  delivered?: boolean;
}

// Rows go in the way intake writes them: created_at as text cast in SQL, received_at set back in time.
async function add(...rows: Row[]): Promise<void> {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO events (event_id, user_id, created_at, body, received_at, delivered_at)
       VALUES ($1, $2, $3::timestamptz, $4, now() - make_interval(secs => $5::float8 / 1000),
               CASE WHEN $6::boolean THEN now() END)`,
      [r.id, r.user, r.created, Buffer.from(`{"event_id":"${r.id}"}`), r.receivedAgoMs, r.delivered ?? false]
    );
  }
}

test('a user whose oldest event is still held is not ready, even with a ready later event', async () => {
  await add(
    { id: 'e1', user: 'u1', created: '2026-11-17T10:00:00Z', receivedAgoMs: 0 },
    { id: 'e2', user: 'u1', created: '2026-11-17T10:00:01Z', receivedAgoMs: 5000 }
  );
  assert.deepEqual(await readyUsers(pool, [], 10), []);
});

test('excluded users are left out before the limit is applied', async () => {
  await add(
    { id: 'a', user: 'u1', created: '2026-11-17T10:00:00Z', receivedAgoMs: 5000 },
    { id: 'b', user: 'u2', created: '2026-11-17T10:00:00Z', receivedAgoMs: 4000 },
    { id: 'c', user: 'u3', created: '2026-11-17T10:00:00Z', receivedAgoMs: 3000 }
  );
  assert.deepEqual(await readyUsers(pool, ['u1'], 2), ['u2', 'u3']);
});

test('ready users come longest-waiting first', async () => {
  await add(
    { id: 'c', user: 'u3', created: '2026-11-17T10:00:00Z', receivedAgoMs: 3000 },
    { id: 'a', user: 'u1', created: '2026-11-17T10:00:00Z', receivedAgoMs: 5000 },
    { id: 'b', user: 'u2', created: '2026-11-17T10:00:00Z', receivedAgoMs: 4000 }
  );
  assert.deepEqual(await readyUsers(pool, [], 10), ['u1', 'u2', 'u3']);
});

test("oldestUnsent returns the user's oldest event by true time across zones, with its stored bytes", async () => {
  // 15:29:59.999999+05:30 is 09:59:59.999999Z, one microsecond before 10:00:00Z, though it was inserted second.
  await add(
    { id: 'later', user: 'u1', created: '2026-11-17T10:00:00.000001Z', receivedAgoMs: 5000 },
    { id: 'earlier', user: 'u1', created: '2026-11-17T15:29:59.999999+05:30', receivedAgoMs: 5000 }
  );
  const p = await oldestUnsent(pool, 'u1', null);
  assert.equal(p?.event_id, 'earlier');
  assert.deepEqual(p?.body, Buffer.from('{"event_id":"earlier"}'));
  assert.equal(p?.late, false);
});

test('oldestUnsent gives null when the oldest event is still held, or none is left', async () => {
  await add({ id: 'held', user: 'u1', created: '2026-11-17T10:00:00Z', receivedAgoMs: 0 });
  assert.equal(await oldestUnsent(pool, 'u1', null), null);
  assert.equal(await oldestUnsent(pool, 'nobody', null), null);
});

test('oldestUnsent flags an event created before the last one delivered for that user', async () => {
  await add({ id: 'e2', user: 'u1', created: '2026-11-17T10:00:05Z', receivedAgoMs: 5000 });
  const second = await oldestUnsent(pool, 'u1', null);
  assert.ok(second !== null && second.late === false);
  assert.equal(await markDelivered(pool, 'e2'), true);
  await add({ id: 'e1', user: 'u1', created: '2026-11-17T10:00:00Z', receivedAgoMs: 5000 });
  const first = await oldestUnsent(pool, 'u1', second.created_at);
  assert.equal(first?.event_id, 'e1');
  assert.equal(first?.late, true);
  await add({ id: 'e3', user: 'u2', created: '2026-11-17T10:00:09Z', receivedAgoMs: 5000 });
  assert.equal((await oldestUnsent(pool, 'u2', second.created_at))?.late, false, 'created after the last delivered: not late');
});

test('markDelivered marks one unsent row, and reports false for a row already marked', async () => {
  await add(
    { id: 'e1', user: 'u1', created: '2026-11-17T10:00:00Z', receivedAgoMs: 5000 },
    { id: 'e2', user: 'u1', created: '2026-11-17T10:00:01Z', receivedAgoMs: 5000 }
  );
  assert.equal(await markDelivered(pool, 'e1'), true);
  assert.equal(await markDelivered(pool, 'e1'), false);
  const rows = await pool.query<{ event_id: string }>('SELECT event_id FROM events WHERE delivered_at IS NOT NULL');
  assert.deepEqual(rows.rows.map((r) => r.event_id), ['e1']);
});

test('unsentCount counts only events not yet delivered', async () => {
  await add(
    { id: 'e1', user: 'u1', created: '2026-11-17T10:00:00Z', receivedAgoMs: 5000, delivered: true },
    { id: 'e2', user: 'u1', created: '2026-11-17T10:00:01Z', receivedAgoMs: 5000 },
    { id: 'e3', user: 'u2', created: '2026-11-17T10:00:01Z', receivedAgoMs: 0 }
  );
  assert.equal(await unsentCount(pool), 2);
});

test('the poll query is an index-only scan on events_pending with 30,000 unsent events', async (t) => {
  await pool.query(`
    INSERT INTO events (event_id, user_id, created_at, body, received_at)
    SELECT 'e' || g, 'u' || (g % 1000), '2026-11-17T00:00:00Z'::timestamptz + g * interval '1 ms',
           '\\x7b7d'::bytea, now() - interval '5 seconds'
    FROM generate_series(1, 30000) g`);
  await pool.query('VACUUM ANALYZE events');
  // VACUUM sets the visibility map, as autovacuum does in a long run; without it the scan also visits the table.
  const plan = await pool.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${READY_USERS}`, [[], 200]);
  assert.ok(planNodes(plan.rows[0]?.['QUERY PLAN']).some((n) => n['Node Type'] === 'Index Only Scan' && n['Index Name'] === 'events_pending'));
  const t0 = Date.now();
  const users = await readyUsers(pool, [], 200);
  t.diagnostic(`readyUsers over 30,000 unsent events took ${Date.now() - t0} ms`);
  assert.equal(users.length, 200);
});

test("oldestUnsent takes the user's first unsent event in index order, with no sort of all of them", async () => {
  await pool.query(`
    INSERT INTO events (event_id, user_id, created_at, body, received_at)
    SELECT 'e' || g, 'heavy', '2026-11-17T00:00:00Z'::timestamptz + g * interval '1 ms', '\x7b7d'::bytea, now() - interval '5 seconds'
    FROM generate_series(1, 30000) g`);
  await pool.query('VACUUM ANALYZE events');
  const plan = await pool.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${OLDEST_UNSENT}`, ['heavy', null]);
  const nodes = planNodes(plan.rows[0]?.['QUERY PLAN']);
  assert.ok(!nodes.some((n) => n['Node Type'] === 'Sort'), JSON.stringify(nodes.map((n) => n['Node Type'])));
  assert.equal((await oldestUnsent(pool, 'heavy', null))?.event_id, 'e1');
});

test('two events of one user with the same created_at go in arrival order', async () => {
  await add(
    { id: 'first', user: 'u1', created: '2026-11-17T10:00:00Z', receivedAgoMs: 5000 },
    { id: 'second', user: 'u1', created: '2026-11-17T10:00:00Z', receivedAgoMs: 5000 }
  );
  assert.equal((await oldestUnsent(pool, 'u1', null))?.event_id, 'first');
  assert.equal(await markDelivered(pool, 'first'), true);
  assert.equal((await oldestUnsent(pool, 'u1', null))?.event_id, 'second');
});

test('an event created at the same instant as the last one delivered is not late', async () => {
  await add({ id: 'e1', user: 'u1', created: '2026-11-17T10:00:00Z', receivedAgoMs: 5000 });
  const p = await oldestUnsent(pool, 'u1', '2026-11-17 10:00:00+00');
  assert.equal(p?.late, false);
});
