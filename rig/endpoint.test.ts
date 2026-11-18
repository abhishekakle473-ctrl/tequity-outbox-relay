import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { start } from './endpoint.ts';
import type { StartOptions } from './endpoint.ts';
import type { EndpointLine, ModeLine } from './types.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readLines<T>(dir: string, name: string): T[] {
  return fs
    .readFileSync(path.join(dir, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

interface Answer {
  status: number | undefined;
  headers: http.IncomingHttpHeaders;
}

// A fresh connection per request (agent: false), so `down` is seen as a refused connect.
function post(port: number, body: string, { method = 'POST', urlPath = '/events' } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { port, method, path: urlPath, agent: false, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

const ev = (i: number, user = 'u0001'): string =>
  JSON.stringify({ event_id: `e${i}`, user_id: user, created_at: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z` });

interface Logs {
  endpoint: EndpointLine[];
  modes: ModeLine[];
}

// Runs one endpoint in a temp dir, returns its two logs, and removes the dir.
async function run(scenario: StartOptions['scenario'], fn: (port: number) => Promise<void>): Promise<Logs> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'endpoint-test-'));
  try {
    const ep = await start({ scenario, dataDir, port: 0 });
    try {
      await fn(ep.port);
    } finally {
      await ep.close();
    }
    return { endpoint: readLines<EndpointLine>(dataDir, 'endpoint.ndjson'), modes: readLines<ModeLine>(dataDir, 'modes.ndjson') };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('the same seed gives the same answer sequence', async () => {
  const scenario: StartOptions['scenario'] = { seed: 42, steps: [{ from_s: 0, to_s: 60, mode: 'fail', p: 0.5 }] };
  const answers = async (): Promise<Array<number | undefined>> => {
    const out: Array<number | undefined> = [];
    await run(scenario, async (port) => {
      for (let i = 0; i < 20; i++) out.push((await post(port, ev(i))).status);
    });
    return out;
  };
  const a = await answers();
  const b = await answers();
  assert.deepEqual(a, b);
  assert.ok(a.includes(200) && a.includes(500), `expected a mix, got ${a.join(',')}`);
});

test('down refuses connections during its window and accepts after', async () => {
  const logs = await run({ seed: 1, steps: [{ from_s: 0.3, to_s: 1.0, mode: 'down', users: ['u0009'] }] }, async (port) => {
    assert.equal((await post(port, ev(1))).status, 200);
    await sleep(600);
    // down ignores its users list: everyone is refused
    await assert.rejects(post(port, ev(2)), { code: 'ECONNREFUSED' });
    await sleep(700);
    assert.equal((await post(port, ev(3))).status, 200);
  });
  assert.deepEqual(
    logs.modes.map((m) => [m.mode, m.users]),
    [
      ['healthy', null],
      ['down', null],
      ['healthy', null],
    ]
  );
});

test('slow delays by about latency_ms', async () => {
  await run({ seed: 1, steps: [{ from_s: 0, to_s: 60, mode: 'slow', latency_ms: 300 }] }, async (port) => {
    const t0 = Date.now();
    assert.equal((await post(port, ev(1))).status, 200);
    const took = Date.now() - t0;
    assert.ok(took >= 290 && took < 1000, `took ${took} ms`);
  });
});

test('limit answers 429 with the Retry-After header', async () => {
  await run({ seed: 1, steps: [{ from_s: 0, to_s: 60, mode: 'limit', retry_after: 7 }] }, async (port) => {
    const res = await post(port, ev(1));
    assert.equal(res.status, 429);
    assert.equal(res.headers['retry-after'], '7');
  });
});

test('a users-limited step affects only those users', async () => {
  await run({ seed: 1, steps: [{ from_s: 0, to_s: 60, mode: 'fail', users: ['u0001'] }] }, async (port) => {
    assert.equal((await post(port, ev(1, 'u0001'))).status, 500);
    assert.equal((await post(port, ev(2, 'u0002'))).status, 200);
  });
});

test('the same body posted twice is logged twice with saved true', async () => {
  const body = ev(1);
  const lines = (
    await run({ seed: 1, steps: [] }, async (port) => {
      await post(port, body);
      await post(port, body);
    })
  ).endpoint;
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.deepEqual(
      { event_id: l.event_id, user_id: l.user_id, body_sha256: l.body_sha256, mode: l.mode, status: l.status, saved: l.saved },
      { event_id: 'e1', user_id: 'u0001', body_sha256: sha, mode: 'healthy', status: 200, saved: true }
    );
    assert.equal(l.created_at, '2026-01-01T00:00:01Z');
    assert.equal(typeof l.t, 'number');
  }
});

test('each request is one endpoint line and each boundary one modes line', async () => {
  const logs = await run({ seed: 1, steps: [{ from_s: 0.5, to_s: 1.0, mode: 'fail', users: ['u0001'] }] }, async (port) => {
    await post(port, ev(1));
    await post(port, 'not json');
    await sleep(700);
    await post(port, ev(2));
    await sleep(500); // past the step end, with no traffic
  });
  const reqs = logs.endpoint;
  assert.deepEqual(
    reqs.map((l) => [l.status, l.mode, l.saved]),
    [
      [200, 'healthy', true],
      [200, 'healthy', true],
      [500, 'fail', false],
    ]
  );
  const unparsed = reqs[1];
  assert.ok(unparsed !== undefined);
  assert.deepEqual([unparsed.event_id, unparsed.user_id, unparsed.created_at], [null, null, null]);
  const modes = logs.modes;
  assert.deepEqual(
    modes.map((m) => [m.mode, m.users]),
    [
      ['healthy', null],
      ['fail', ['u0001']],
      ['healthy', ['u0001']],
    ]
  );
  const [m0, m1, m2] = modes;
  assert.ok(m0 !== undefined && m1 !== undefined && m2 !== undefined);
  assert.ok(m0.t <= m1.t && m1.t <= m2.t);
  assert.ok(m2.t - m1.t >= 450, 'step end written at the boundary');
});

test('a path other than POST /events gets 404 and is not logged', async () => {
  const logs = await run({ seed: 1, steps: [] }, async (port) => {
    assert.equal((await post(port, ev(1), { urlPath: '/other' })).status, 404);
    assert.equal((await post(port, '', { method: 'GET' })).status, 404);
  });
  assert.equal(logs.endpoint.length, 0);
});

test('limit with p answers 429 only sometimes, and sends a string Retry-After as given', async () => {
  const statuses: Array<number | undefined> = [];
  let header: string | string[] | undefined;
  await run({ seed: 3, steps: [{ from_s: 0, to_s: 60, mode: 'limit', p: 0.5, retry_after: 'abc' }] }, async (port) => {
    for (let i = 0; i < 20; i++) {
      const res = await post(port, ev(i));
      statuses.push(res.status);
      if (res.status === 429) header = res.headers['retry-after'];
    }
  });
  assert.ok(statuses.includes(200) && statuses.includes(429), `expected a mix, got ${statuses.join(',')}`);
  assert.equal(header, 'abc');
});

test('close() during a down window and with a slow answer pending resolves', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'endpoint-test-'));
  try {
    const ep = await start({
      scenario: { seed: 1, steps: [{ from_s: 0.3, to_s: 5, mode: 'down' }] },
      dataDir,
      port: 0,
    });
    await sleep(500);
    await ep.close();
    const slow = await start({
      scenario: { seed: 1, steps: [{ from_s: 0, to_s: 60, mode: 'slow', latency_ms: 5000 }] },
      dataDir,
      port: 0,
    });
    const pending = post(slow.port, ev(1)).catch(() => undefined);
    await sleep(100);
    await slow.close();
    await pending;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
