import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createApi } from '../src/api.ts';
import { freshDb } from './pg.ts';

const connection = { host: '127.0.0.1', port: 54329, user: 'postgres', password: 'relay', database: 'api_test' };

let pool: pg.Pool;
let server: http.Server;
let port: number;

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      resolve(typeof a === 'object' && a !== null ? a.port : 0);
    });
  });
}

function close(s: http.Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

type Answer = { status: number; body: string; connection: string | undefined };

// A fresh TCP connection per request unless an agent is given, so concurrent posts really run side by side.
function send(p: number, body: Buffer | string, path = '/events', method = 'POST', agent: http.Agent | false = false): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: p, path, method, agent, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), connection: res.headers.connection })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

const event = (event_id: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ event_id, user_id: 'u1', created_at: '2026-11-17T10:42:07.318123Z', type: 't', data: {}, ...extra });

async function withClient<T>(f: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client(connection);
  await c.connect();
  try {
    return await f(c);
  } finally {
    await c.end();
  }
}

const rows = (id: string): Promise<{ body: Buffer }[]> =>
  withClient(async (c) => (await c.query<{ body: Buffer }>('SELECT body FROM events WHERE event_id = $1', [id])).rows);

const logged = (calls: readonly { arguments: unknown[] }[]): Record<string, unknown>[] =>
  calls.map((c) => JSON.parse(String(c.arguments[0])) as Record<string, unknown>);

before(async () => {
  pool = await freshDb('api_test');
  // pg_terminate_backend below kills this pool's idle clients; with no listener that error would crash the test process.
  pool.on('error', () => {});
  server = createApi(pool);
  port = await listen(server);
});

after(async () => {
  await close(server);
  await pool.end();
});

test('the row is committed before the 200, with the body bytes as sent and an empty answer', async () => {
  const body = event('commit-1');
  const a = await send(port, body);
  assert.equal(a.status, 200);
  assert.equal(a.body, '');
  const r = await rows('commit-1');
  assert.equal(r.length, 1);
  assert.deepEqual(r[0]?.body, Buffer.from(body));
});

test('two concurrent posts of one event_id give one row and two 200s', async () => {
  const body = event('twice-1');
  const answers = await Promise.all([send(port, body), send(port, body)]);
  assert.deepEqual(
    answers.map((a) => a.status),
    [200, 200]
  );
  assert.equal((await rows('twice-1')).length, 1);
});

test('a repeat with a different body keeps the first body and logs a warn line with event_id and user_id', async (t) => {
  const first = event('diff-1', { data: { v: 1 } });
  assert.equal((await send(port, first)).status, 200);
  const err = t.mock.method(console, 'error');
  assert.equal((await send(port, event('diff-1', { data: { v: 2 } }))).status, 200);
  assert.deepEqual((await rows('diff-1'))[0]?.body, Buffer.from(first));
  const warn = logged(err.mock.calls).find((l) => l['level'] === 'warn');
  assert.ok(warn, 'a warn line is logged');
  assert.equal(warn['event_id'], 'diff-1');
  assert.equal(warn['user_id'], 'u1');
});

test('a repeat with the same body gives 200 and logs nothing', async (t) => {
  const body = event('same-1');
  assert.equal((await send(port, body)).status, 200);
  const err = t.mock.method(console, 'error');
  assert.equal((await send(port, body)).status, 200);
  assert.equal(err.mock.callCount(), 0);
});

test('created_at with month 13 gives 400, stores nothing and logs the reason', async (t) => {
  const err = t.mock.method(console, 'error');
  assert.equal((await send(port, event('month-13', { created_at: '2026-13-01T00:00:00Z' }))).status, 400);
  assert.equal((await rows('month-13')).length, 0);
  const line = logged(err.mock.calls).find((l) => l['event_id'] === 'month-13');
  assert.ok(line, 'the 400 is logged with its event_id');
  assert.equal(line['user_id'], 'u1');
  assert.equal(typeof line['reason'], 'string');
});

test('created_at with offset +99:99 gives 400', async () => {
  assert.equal((await send(port, event('offset-99', { created_at: '2026-11-17T10:42:07+99:99' }))).status, 400);
  assert.equal((await rows('offset-99')).length, 0);
});

test('a body that fails validation gives 400 and is logged with its reason', async (t) => {
  const err = t.mock.method(console, 'error');
  assert.equal((await send(port, '{"event_id":')).status, 400);
  const line = logged(err.mock.calls).find((l) => typeof l['reason'] === 'string');
  assert.ok(line, 'the 400 is logged with a reason');
});

test('another path gives 404, and so does GET /events', async () => {
  assert.equal((await send(port, event('path-1'), '/other')).status, 404);
  assert.equal((await send(port, '', '/events', 'GET')).status, 404);
  assert.equal((await rows('path-1')).length, 0);
});

test('a pool on a dead port gives 503, logged with event_id and user_id, and the server keeps answering', async (t) => {
  const dead = new pg.Pool({ ...connection, port: 1 });
  const s = createApi(dead);
  const p = await listen(s);
  const err = t.mock.method(console, 'error');
  try {
    assert.equal((await send(p, event('dead-1'))).status, 503);
    assert.equal((await send(p, event('dead-2'))).status, 503);
    const line = logged(err.mock.calls).find((l) => l['event_id'] === 'dead-1');
    assert.ok(line, 'the 503 is logged');
    assert.equal(line['level'], 'error');
    assert.equal(line['user_id'], 'u1');
  } finally {
    await close(s);
    await dead.end();
  }
});

test("after pg_terminate_backend ends the API pool's connections, the next post gives 200", async () => {
  assert.equal((await send(port, event('kill-1'))).status, 200);
  assert.ok(pool.idleCount > 0, 'the pool holds an idle connection to kill');
  const killed = await withClient(
    async (c) =>
      (
        await c.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'api_test' AND pid <> pg_backend_pid()"
        )
      ).rowCount
  );
  assert.ok((killed ?? 0) > 0);
  // The kill reaches the pool's idle clients a moment later; wait until the pool has dropped them.
  for (let i = 0; i < 100 && pool.idleCount > 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(pool.idleCount, 0, 'the pool dropped the killed connections');
  assert.equal((await send(port, event('kill-2'))).status, 200);
  assert.equal((await rows('kill-2')).length, 1);
});

test('keepAliveTimeout is 65000 and headersTimeout 66000', () => {
  assert.equal(server.keepAliveTimeout, 65000);
  assert.equal(server.headersTimeout, 66000);
});

test('a body of 1,048,577 bytes gives 413 and closes the connection', async () => {
  const a = await send(port, Buffer.alloc(1_048_577, 'a'));
  assert.equal(a.status, 413);
  assert.equal(a.connection, 'close');
});

test('a valid body of exactly 1,048,576 bytes gives 200', async () => {
  const short = event('max-1', { pad: '' });
  const body = event('max-1', { pad: 'x'.repeat(1_048_576 - Buffer.byteLength(short)) });
  assert.equal(Buffer.byteLength(body), 1_048_576);
  assert.equal((await send(port, body)).status, 200);
});

test('a client that hangs up mid-body is logged and the server keeps answering', async (t) => {
  const err = t.mock.method(console, 'error');
  await new Promise<void>((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('POST /events HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{"event_id"');
      setTimeout(() => {
        s.destroy();
        resolve();
      }, 50);
    });
  });
  for (let i = 0; i < 50 && err.mock.callCount() === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(err.mock.callCount() > 0, 'the hang-up is logged');
  assert.equal((await send(port, event('after-hangup'))).status, 200);
});

test('after server.close() a request already in progress on a keep-alive connection still gets its 200, its row is committed, and the server finishes closing at once', async () => {
  const s = createApi(pool);
  const p = await listen(s);
  const agent = new http.Agent({ keepAlive: true });
  // An uncommitted insert of the same event_id makes the API's insert wait on its row lock.
  const blocker = new pg.Client(connection);
  await blocker.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(
      "INSERT INTO events (event_id, user_id, created_at, body) VALUES ('stop-1', 'u1', now(), '\\x00')"
    );
    const inFlight = send(p, event('stop-1'), '/events', 'POST', agent);
    // Wait until the API's insert is blocked on the lock, so it is truly in progress.
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const w = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = 'api_test' AND wait_event_type = 'Lock'");
      waiting = (w.rowCount ?? 0) > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(waiting, "the API's insert is waiting on the lock")
    const closed = close(s);
    await assert.rejects(send(p, event('stop-2')), /ECONNREFUSED/);
    await blocker.query('ROLLBACK');
    assert.equal((await inFlight).status, 200);
    // A keep-alive socket left open after its answer would hold close() for the 65 s keepAliveTimeout.
    const late = new Promise((r) => setTimeout(r, 2000, 'still open'));
    assert.equal(await Promise.race([closed.then(() => 'closed'), late]), 'closed');
    assert.deepEqual((await rows('stop-1'))[0]?.body, Buffer.from(event('stop-1')));
    assert.equal((await rows('stop-2')).length, 0);
  } finally {
    agent.destroy();
    await blocker.end();
  }
});

// Review fixes, U3.
test('a throw while answering is logged and answered 503, and the server keeps answering', { timeout: 5000 }, async (t) => {
  const err = t.mock.method(console, 'error');
  const realEnd = http.ServerResponse.prototype.end;
  let thrown = false;
  t.mock.method(http.ServerResponse.prototype, 'end', function (this: http.ServerResponse, ...args: unknown[]) {
    if (!thrown) {
      thrown = true;
      throw new Error('end failed');
    }
    return (realEnd as (...a: unknown[]) => http.ServerResponse).apply(this, args);
  });
  assert.equal((await send(port, event('throw-1'))).status, 503);
  assert.ok(logged(err.mock.calls).some((l) => l['level'] === 'error' && String(l['err']).includes('end failed')));
  t.mock.restoreAll();
  assert.equal((await send(port, event('throw-2'))).status, 200);
});

test('a POST with no body gives 400', async () => {
  assert.equal((await send(port, '')).status, 400);
});
