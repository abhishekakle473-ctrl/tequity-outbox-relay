import assert from 'node:assert/strict'
import { test } from 'node:test'
import pg from 'pg'
import { createPool, waitForDb } from '../src/db.ts'
import { freshDb } from './pg.ts'

const columns = [
  'body',
  'created_at',
  'delivered_at',
  'event_id',
  'received_at',
  'seq',
  'user_id',
]

test('freshDb gives an empty events table with the contract columns, twice in a row', async () => {
  for (let run = 0; run < 2; run++) {
    const pool = await freshDb('db_test')
    try {
      const count = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM events')
      assert.equal(count.rows[0]?.n, 0)
      const cols = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'events' ORDER BY column_name`,
      )
      assert.deepEqual(cols.rows.map((r) => r.column_name), columns)
      // a row left behind must not reach the next call
      await pool.query(
        `INSERT INTO events (event_id, user_id, created_at, body)
         VALUES ('e1', 'u1', now(), $1)`,
        [Buffer.from('x')],
      )
    } finally {
      await pool.end()
    }
  }
})

test('freshDb creates the events_pending partial index on unsent rows', async () => {
  const pool = await freshDb('db_test')
  try {
    const idx = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'events_pending'`,
    )
    assert.equal(idx.rows.length, 1)
    assert.match(idx.rows[0]?.indexdef ?? '', /WHERE \(delivered_at IS NULL\)/)
  } finally {
    await pool.end()
  }
})

test('the events columns have the contract types, nullability and identity', async () => {
  const pool = await freshDb('db_test')
  try {
    const cols = await pool.query<{ column_name: string; data_type: string; is_nullable: string; is_identity: string }>(
      `SELECT column_name, data_type, is_nullable, is_identity FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'events' ORDER BY column_name`,
    )
    assert.deepEqual(
      cols.rows.map((r) => [r.column_name, r.data_type, r.is_nullable, r.is_identity]),
      [
        ['body', 'bytea', 'NO', 'NO'],
        ['created_at', 'timestamp with time zone', 'NO', 'NO'],
        ['delivered_at', 'timestamp with time zone', 'YES', 'NO'],
        ['event_id', 'text', 'NO', 'NO'],
        ['received_at', 'timestamp with time zone', 'NO', 'NO'],
        ['seq', 'bigint', 'NO', 'YES'],
        ['user_id', 'text', 'NO', 'NO'],
      ],
    )
  } finally {
    await pool.end()
  }
})

test('a second insert of the same event_id is skipped by ON CONFLICT DO NOTHING', async () => {
  const pool = await freshDb('db_test')
  try {
    const insert = `INSERT INTO events (event_id, user_id, created_at, body)
                    VALUES ('e1', 'u1', now(), $1) ON CONFLICT (event_id) DO NOTHING`
    assert.equal((await pool.query(insert, [Buffer.from('first')])).rowCount, 1)
    assert.equal((await pool.query(insert, [Buffer.from('second')])).rowCount, 0)
    const body = await pool.query<{ body: Buffer }>(`SELECT body FROM events WHERE event_id = 'e1'`)
    assert.deepEqual(body.rows[0]?.body, Buffer.from('first'))
  } finally {
    await pool.end()
  }
})

test('freshDb refuses a database name that is not a plain identifier', async () => {
  await assert.rejects(freshDb('bad"name'), /database name/)
})

test('freshDb can create several databases at the same moment', async () => {
  const pools = await Promise.all(['db_par_a', 'db_par_b', 'db_par_c', 'db_par_d'].map((n) => freshDb(n)))
  try {
    for (const pool of pools) {
      assert.equal((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM events')).rows[0]?.n, 0)
    }
  } finally {
    await Promise.all(pools.map((p) => p.end()))
  }
})

const lines = (calls: readonly { arguments: unknown[] }[]): Record<string, unknown>[] =>
  calls.map((c) => JSON.parse(String(c.arguments[0])) as Record<string, unknown>)

test('an idle pool connection ended by Postgres is logged as one JSON line, and the pool keeps working', async (t) => {
  const err = t.mock.method(console, 'error')
  const pool = createPool(1)
  try {
    const pid = (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
    const admin = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'relay', database: 'postgres' })
    await admin.connect()
    try {
      await admin.query('SELECT pg_terminate_backend($1)', [pid])
    } finally {
      await admin.end()
    }
    for (let i = 0; i < 100 && err.mock.callCount() === 0; i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(lines(err.mock.calls)[0]?.['level'], 'error')
    assert.equal((await pool.query<{ n: number }>('SELECT 1 AS n')).rows[0]?.n, 1)
  } finally {
    await pool.end()
  }
})

test('waitForDb logs each failed try as one JSON line, waits 1 s, and returns once Postgres answers', async (t) => {
  const pool = createPool(1)
  try {
    const real = pool.query.bind(pool)
    let tries = 0
    t.mock.method(pool, 'query', (sql: string) => (++tries === 1 ? Promise.reject(new Error('connect ECONNREFUSED')) : real(sql)))
    const err = t.mock.method(console, 'error')
    const start = Date.now()
    await waitForDb(pool)
    assert.equal(tries, 2)
    assert.ok(Date.now() - start >= 950, 'waits about 1 s between tries')
    const failed = lines(err.mock.calls).filter((l) => l['level'] === 'error')
    assert.equal(failed.length, 1)
    assert.match(String(failed[0]?.['err']), /ECONNREFUSED/)
  } finally {
    await pool.end()
  }
})

test('a statement running past 10 seconds is cancelled with an error, never left hanging', { timeout: 15000 }, async () => {
  const pool = createPool(1)
  try {
    await assert.rejects(pool.query('SELECT pg_sleep(11)'), /statement timeout/)
  } finally {
    await pool.end()
  }
})

test('the pool gives up on a connection attempt after 5 seconds', async () => {
  const pool = createPool(1)
  try {
    assert.equal(pool.options.connectionTimeoutMillis, 5000)
  } finally {
    await pool.end()
  }
})
