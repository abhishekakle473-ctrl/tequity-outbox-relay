import assert from 'node:assert/strict'
import { test } from 'node:test'
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
