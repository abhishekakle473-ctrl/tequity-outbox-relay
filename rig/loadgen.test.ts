import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, run } from './loadgen.ts';
import type { Post } from './loadgen.ts';
import type { LoadgenLine, Scenario } from './types.ts';

function scenario(load: Partial<Scenario['load']>, seed = 1, duration_s = 30): Scenario {
  return {
    seed,
    duration_s,
    drain_s: 0,
    load: { rate: 100, users: 20, heavy_users: 2, heavy_share: 0.5, ...load },
    steps: [],
  };
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// What the brief's intake would accept; names the kind of bad body otherwise.
function badKind(body: Buffer): string | null {
  let v: unknown;
  try {
    v = JSON.parse(body.toString());
  } catch {
    return 'not_json';
  }
  if (Array.isArray(v)) return 'array';
  if (!isRecord(v)) return 'not_object';
  if (typeof v['user_id'] !== 'string') return 'missing_user_id';
  if (v['event_id'] === '') return 'empty_event_id';
  if (typeof v['event_id'] !== 'string') return 'missing_event_id';
  if (typeof v['created_at'] !== 'string' || Number.isNaN(Date.parse(v['created_at']))) return 'bad_created_at';
  return null;
}

// First send of each valid event, in send order.
function firstSends(posts: Post[]): Post[] {
  const seen = new Set<string | null>();
  return posts.filter((p) => p.valid && !seen.has(p.event_id) && seen.add(p.event_id));
}

test('the same seed gives an identical plan, another seed a different one', () => {
  const s = scenario({ extras: { repeat: 0.05, diff_body: 0.05, out_of_order: 0.05, invalid: 0.05 } }, 7, 5);
  const a = plan(s);
  assert.deepEqual(a, plan(s));
  assert.notDeepEqual(a, plan({ ...s, seed: 8 }));
});

test('valid bodies follow the brief and carry the post fields', () => {
  for (const p of plan(scenario({}, 3, 2))) {
    const body: unknown = JSON.parse(p.body.toString());
    assert.ok(isRecord(body));
    assert.deepEqual(Object.keys(body), ['event_id', 'user_id', 'created_at', 'type', 'data']);
    assert.equal(body['event_id'], p.event_id);
    assert.equal(body['user_id'], p.user_id);
    assert.equal(body['created_at'], p.created_at);
    assert.equal(body['type'], 'user.updated');
    assert.match(p.event_id ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.match(p.user_id ?? '', /^u\d{4}$/);
    assert.match(p.created_at ?? '', /^2026-11-19T\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(p.valid, true);
  }
});

test("each user's created_at strictly increases in send order without out_of_order, and never repeats with it", () => {
  const byUser = (posts: Post[]): Map<string | null, number[]> => {
    const m = new Map<string | null, number[]>();
    for (const p of firstSends(posts)) m.set(p.user_id, [...(m.get(p.user_id) ?? []), Date.parse(p.created_at ?? '')]);
    return m;
  };
  for (const times of byUser(plan(scenario({ users: 3, heavy_users: 1 }))).values()) {
    for (let i = 1; i < times.length; i++) assert.ok(times[i]! > times[i - 1]!);
  }
  const mixed = plan(scenario({ extras: { repeat: 0.1, diff_body: 0.1, out_of_order: 0.2, invalid: 0.1 } }));
  for (const times of byUser(mixed).values()) assert.equal(new Set(times).size, times.length);
});

test('no 1-second window of at_ms has more than rate posts', () => {
  for (const rate of [100, 37, 1]) {
    const posts = plan(scenario({ rate, extras: { repeat: 0.1, diff_body: 0.1, out_of_order: 0.1, invalid: 0.1 } }, 2, 10));
    assert.equal(posts.length, rate * 10);
    const at = posts.map((p) => p.at_ms);
    for (let i = 1; i < at.length; i++) assert.ok(at[i]! >= at[i - 1]!, 'send order is time order');
    for (let i = 0; i < at.length; i++) {
      assert.ok(at.filter((t) => t >= at[i]! && t < at[i]! + 1000).length <= rate);
    }
  }
});

test('the heavy users get heavy_share of posts, within 0.03 (about 5 standard deviations at 6000 posts)', () => {
  const posts = plan(scenario({ users: 50, heavy_users: 2, heavy_share: 0.5 }, 5, 60));
  const heavy = posts.filter((p) => p.user_id === 'u0001' || p.user_id === 'u0002').length;
  assert.ok(Math.abs(heavy / posts.length - 0.5) < 0.03, `heavy share ${heavy / posts.length}`);
  assert.ok(posts.some((p) => p.user_id === 'u0050'));
});

test('extras mix in repeats, different bodies, out-of-order events and invalid bodies, with valid set to match', () => {
  const posts = plan(scenario({ extras: { repeat: 0.05, diff_body: 0.05, out_of_order: 0.05, invalid: 0.05 } }, 11));
  const byId = new Map<string | null, Post>();
  const seenBytes = new Set<string>();
  let repeats = 0;
  let diffBodies = 0;
  const kinds = new Set<string>();
  for (const p of posts) {
    const kind = badKind(p.body);
    assert.equal(p.valid, kind === null, `valid flag for ${p.body.toString()}`);
    if (kind !== null) kinds.add(kind);
    if (!p.valid) continue;
    const first = byId.get(p.event_id);
    if (first && seenBytes.has(sha(p.body))) repeats++;
    else if (first) {
      diffBodies++;
      const a: unknown = JSON.parse(first.body.toString());
      const b: unknown = JSON.parse(p.body.toString());
      assert.ok(isRecord(a) && isRecord(b));
      assert.deepEqual({ ...a, data: null }, { ...b, data: null }, 'only data differs');
      assert.notDeepEqual(a['data'], b['data']);
    } else byId.set(p.event_id, p);
    seenBytes.add(sha(p.body));
  }
  assert.ok(repeats > 50 && repeats < 250, `repeats ${repeats}`);
  assert.ok(diffBodies > 50 && diffBodies < 250, `diff_body ${diffBodies}`);
  assert.deepEqual([...kinds].sort(), ['array', 'bad_created_at', 'empty_event_id', 'missing_user_id', 'not_json']);
  assert.equal(posts.filter((p) => !p.valid).length > 50, true);

  // An inversion: a user's event sent before that user's earlier-created event.
  const firsts = firstSends(posts);
  let inversions = 0;
  for (let i = 0; i < firsts.length; i++) {
    for (let j = i + 1; j < firsts.length; j++) {
      const a = firsts[i]!;
      const b = firsts[j]!;
      if (a.user_id === b.user_id && (a.created_at ?? '') > (b.created_at ?? '')) {
        inversions++;
        assert.ok(b.at_ms - a.at_ms <= 1000, `gap ${b.at_ms - a.at_ms}`);
      }
    }
  }
  assert.ok(inversions > 50, `out_of_order ${inversions}`);
});

function readLines(dir: string): LoadgenLine[] {
  return readFileSync(join(dir, 'loadgen.ndjson'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LoadgenLine);
}

test('run posts the plan on schedule and logs one line per post with its status and hash', async () => {
  const s = scenario({ rate: 20, extras: { repeat: 0.2, invalid: 0.3 } }, 4, 1);
  const received: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push(sha(body));
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/events');
      assert.equal(req.headers['content-type'], 'application/json');
      res.statusCode = badKind(body) === null ? 200 : 400;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const dataDir = mkdtempSync(join(tmpdir(), 'loadgen-test-'));
  try {
    const t0 = Date.now();
    await run({ scenario: s, dataDir, url: `http://127.0.0.1:${port}/events` });
    const posts = plan(s);
    const lines = readLines(dataDir);
    const key = (x: Omit<LoadgenLine, 't_send' | 't_done'>): string =>
      JSON.stringify([x.body_sha256, x.event_id, x.user_id, x.created_at, x.valid, x.status, x.err]);
    assert.deepEqual(
      lines.map(key).sort(),
      posts
        .map((p) => key({ body_sha256: sha(p.body), event_id: p.event_id, user_id: p.user_id, created_at: p.created_at, valid: p.valid, status: p.valid ? 200 : 400 }))
        .sort(),
    );
    assert.deepEqual(received.sort(), posts.map((p) => sha(p.body)).sort());
    assert.ok(posts.some((p) => !p.valid));
    for (const l of lines) {
      assert.ok(l.t_send >= t0 && l.t_done >= l.t_send);
      assert.equal('err' in l, false);
    }
    const sends = lines.map((l) => l.t_send).sort((a, b) => a - b);
    assert.ok(sends.at(-1)! - sends[0]! >= 500, 'posts spread over the second');
  } finally {
    server.close();
  }
});

test('run logs err with a null status when the connection is refused', async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  const dataDir = mkdtempSync(join(tmpdir(), 'loadgen-test-'));
  const s = scenario({ rate: 3 }, 9, 1);
  await run({ scenario: s, dataDir, url: `http://127.0.0.1:${port}/events` });
  const lines = readLines(dataDir);
  assert.equal(lines.length, 3);
  for (const l of lines) {
    assert.equal(l.status, null);
    assert.equal(l.err, 'ECONNREFUSED');
  }
});

// Review fixes, R2.
test('a repeat or a different-body copy is never sent before its original', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const posts = plan(scenario({ rate: 50, extras: { repeat: 0.2, diff_body: 0.2, out_of_order: 0.3 } }, seed, 30));
    const seen = new Set<string>();
    for (const p of [...posts].sort((a, b) => a.at_ms - b.at_ms)) {
      if (!p.valid || p.event_id === null) continue;
      if (!seen.has(p.event_id)) {
        assert.ok(!p.body.toString().includes('.changed@'), `seed ${seed}: event ${p.event_id} first sent with a changed body`);
        seen.add(p.event_id);
      }
    }
  }
});

test('run keeps to the schedule while earlier answers are still slow', async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => setTimeout(() => res.end(), 1500));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const dataDir = mkdtempSync(join(tmpdir(), 'loadgen-test-'));
  try {
    await run({ scenario: scenario({ rate: 10 }, 5, 1), dataDir, url: `http://127.0.0.1:${port}/events` });
    const sends = readLines(dataDir).map((l) => l.t_send).sort((a, b) => a - b);
    assert.equal(sends.length, 10);
    assert.ok(sends.at(-1)! - sends[0]! < 1300, `10 posts over 0.9 s took ${sends.at(-1)! - sends[0]!} ms to send`);
  } finally {
    server.close();
  }
});

test('run keeps a 200 status line when the body is cut off after it', async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('partial');
      setTimeout(() => res.socket?.destroy(), 50);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const dataDir = mkdtempSync(join(tmpdir(), 'loadgen-test-'));
  try {
    await run({ scenario: scenario({ rate: 1 }, 6, 1), dataDir, url: `http://127.0.0.1:${port}/events` });
    const [line] = readLines(dataDir);
    assert.ok(line !== undefined);
    assert.equal(line.status, 200);
    assert.equal(typeof line.err, 'string');
  } finally {
    server.close();
  }
});

test('run logs every post, with an err, when the url cannot be used', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'loadgen-test-'));
  await run({ scenario: scenario({ rate: 2 }, 7, 1), dataDir, url: 'http://127.0.0.1:99999/events' });
  const lines = readLines(dataDir);
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.equal(l.status, null);
    assert.equal(typeof l.err, 'string');
  }
});
