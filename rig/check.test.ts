import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from './check.ts';
import type { CheckName, CheckResult, EndpointLine, LoadgenLine, ModeLine } from './types.ts';

const T0 = 1_700_000_000_000;

function post(event_id: string, user_id: string, created_at: string, t: number, extra: Partial<LoadgenLine> = {}): LoadgenLine {
  return { t_send: t, t_done: t + 5, event_id, user_id, created_at, body_sha256: `sha-${event_id}`, valid: true, status: 200, ...extra };
}

function save(event_id: string, user_id: string, created_at: string, t: number, extra: Partial<EndpointLine> = {}): EndpointLine {
  return { t, event_id, user_id, created_at, body_sha256: `sha-${event_id}`, mode: 'healthy', status: 200, saved: true, ...extra };
}

function run(loadgen: unknown[], endpoint: unknown[], modes: unknown[]): CheckResult[] {
  const dir = mkdtempSync(join(tmpdir(), 'check-'));
  const files: [string, unknown[]][] = [['loadgen.ndjson', loadgen], ['endpoint.ndjson', endpoint], ['modes.ndjson', modes]];
  for (const [name, lines] of files) writeFileSync(join(dir, name), lines.map((l) => JSON.stringify(l) + '\n').join(''));
  return check(dir);
}

function result(results: CheckResult[], name: CheckName): CheckResult {
  const r = results.find((x) => x.check === name);
  assert.ok(r, `no result for ${name}`);
  return r;
}

// Asserts that only `name` fails, and that its detail mentions `mention`.
function failsOnly(results: CheckResult[], name: CheckName, mention: string): void {
  for (const r of results) assert.equal(r.pass, r.check !== name, `${r.check}: ${r.detail}`);
  assert.match(result(results, name).detail, new RegExp(mention));
}

// A clean run: two users, three promised events, one invalid post, all saved on time.
function clean(): { loadgen: LoadgenLine[]; endpoint: EndpointLine[]; modes: ModeLine[] } {
  return {
    loadgen: [
      post('e1', 'u1', '2026-11-17T10:00:00.000Z', T0),
      post('bad', 'u1', '', T0 + 200, { event_id: null, user_id: null, created_at: null, valid: false, status: 400 }),
      post('e3', 'u2', '2026-11-17T10:00:00.500Z', T0 + 500),
      post('e2', 'u1', '2026-11-17T10:00:01.000Z', T0 + 1000),
    ],
    endpoint: [
      save('e1', 'u1', '2026-11-17T10:00:00.000Z', T0 + 100),
      save('e3', 'u2', '2026-11-17T10:00:00.500Z', T0 + 600),
      save('e2', 'u1', '2026-11-17T10:00:01.000Z', T0 + 1100),
    ],
    modes: [{ t: T0 - 1000, mode: 'healthy', users: null }],
  };
}

test('a clean run passes all five, in order', () => {
  const { loadgen, endpoint, modes } = clean();
  const results = run(loadgen, endpoint, modes);
  assert.deepEqual(results.map((r) => r.check), ['exactly_once', 'order', 'timing', 'intake_up', 'bytes']);
  for (const r of results) assert.ok(r.pass, `${r.check}: ${r.detail}`);
});

test('empty logs fail all five with nothing to judge', () => {
  const results = run([], [], []);
  assert.equal(results.length, 5);
  for (const r of results) {
    assert.equal(r.pass, false);
    assert.match(r.detail, /^nothing to judge/);
  }
});

test('exactly_once fails on a saved event that was never promised', () => {
  const { loadgen, endpoint, modes } = clean();
  endpoint.push(save('e9', 'u3', '2026-11-17T10:00:00.000Z', T0 + 1200));
  failsOnly(run(loadgen, endpoint, modes), 'exactly_once', 'e9');
});

test('exactly_once fails on an event saved twice', () => {
  const { loadgen, endpoint, modes } = clean();
  endpoint.splice(1, 0, save('e1', 'u1', '2026-11-17T10:00:00.000Z', T0 + 150));
  const r = result(run(loadgen, endpoint, modes), 'exactly_once');
  assert.equal(r.pass, false);
  assert.match(r.detail, /e1/);
});

test('order fails when a user is saved out of created_at order', () => {
  const { loadgen, endpoint, modes } = clean();
  for (const line of [...loadgen, ...endpoint]) if (line.event_id === 'e2') line.created_at = '2026-11-17T09:59:59.000Z';
  failsOnly(run(loadgen, endpoint, modes), 'order', 'e2');
});

test('order compares mixed offsets as true instants', () => {
  const { loadgen, endpoint, modes } = clean();
  for (const line of [...loadgen, ...endpoint]) {
    if (line.event_id === 'e1') line.created_at = '2026-11-17T15:29:59.999999+05:30';
    if (line.event_id === 'e2') line.created_at = '2026-11-17T10:00:00.000001+00:00';
  }
  assert.ok(result(run(loadgen, endpoint, modes), 'order').pass);
});

test('order sees a one-microsecond reversal', () => {
  const { loadgen, endpoint, modes } = clean();
  for (const line of [...loadgen, ...endpoint]) {
    if (line.event_id === 'e1') line.created_at = '2026-11-17T10:00:00.000002Z';
    if (line.event_id === 'e2') line.created_at = '2026-11-17T10:00:00.000001Z';
  }
  failsOnly(run(loadgen, endpoint, modes), 'order', 'e2');
});

test('timing fails an event saved 1 s late while healthy', () => {
  const { loadgen, endpoint, modes } = clean();
  endpoint[2] = save('e2', 'u1', '2026-11-17T10:00:01.000Z', T0 + 1005 + 31_000);
  failsOnly(run(loadgen, endpoint, modes), 'timing', 'e2.*1000 ms late');
});

test('timing fails an event that was never saved', () => {
  const { loadgen, endpoint, modes } = clean();
  endpoint.pop();
  const r = result(run(loadgen, endpoint, modes), 'timing');
  assert.equal(r.pass, false);
  assert.match(r.detail, /e2.*never saved/);
});

// Down from T0+2s to T0+60s; e4 is promised during the outage.
function outage(saveAt: number, modes: ModeLine[]): CheckResult {
  const { loadgen, endpoint } = clean();
  loadgen.push(post('e4', 'u1', '2026-11-17T10:00:03.000Z', T0 + 3000));
  endpoint.push(save('e4', 'u1', '2026-11-17T10:00:03.000Z', saveAt));
  return result(run(loadgen, endpoint, modes), 'timing');
}

const downThenUp: ModeLine[] = [
  { t: T0 - 1000, mode: 'healthy', users: null },
  { t: T0 + 2000, mode: 'down', users: null },
  { t: T0 + 60_000, mode: 'healthy', users: null },
];

test('timing gives an event promised while down recovery + 300 s', () => {
  assert.ok(outage(T0 + 60_000 + 299_000, downThenUp).pass);
  const late = outage(T0 + 60_000 + 301_000, downThenUp);
  assert.equal(late.pass, false);
  assert.match(late.detail, /e4.*1000 ms late/);
});

test('timing does not count a flapping endpoint as recovered', () => {
  const flap: ModeLine[] = [
    { t: T0 - 1000, mode: 'healthy', users: null },
    { t: T0 + 2000, mode: 'down', users: null },
    { t: T0 + 60_000, mode: 'healthy', users: null },
    { t: T0 + 63_000, mode: 'down', users: null },
    { t: T0 + 66_000, mode: 'healthy', users: null },
    { t: T0 + 69_000, mode: 'down', users: null },
    { t: T0 + 72_000, mode: 'healthy', users: null },
  ];
  // Would be 1 s late if the 3-second healthy period at T0+60s counted as a recovery.
  assert.ok(outage(T0 + 361_000, flap).pass);
  assert.equal(outage(T0 + 373_000, flap).pass, false);
});

test('timing applies a user-limited slow step only to those users', () => {
  const { loadgen, endpoint } = clean();
  const modes: ModeLine[] = [
    { t: T0 - 1000, mode: 'healthy', users: null },
    { t: T0 + 2000, mode: 'slow', users: ['u1'] },
    { t: T0 + 40_000, mode: 'healthy', users: ['u1'] },
  ];
  loadgen.push(post('e4', 'u1', '2026-11-17T10:00:03.000Z', T0 + 3000));
  loadgen.push(post('e5', 'u2', '2026-11-17T10:00:03.000Z', T0 + 3000));
  endpoint.push(save('e4', 'u1', '2026-11-17T10:00:03.000Z', T0 + 140_000));
  endpoint.push(save('e5', 'u2', '2026-11-17T10:00:03.000Z', T0 + 140_000));
  const r = result(run(loadgen, endpoint, modes), 'timing');
  assert.equal(r.pass, false);
  assert.match(r.detail, /e5/);
  assert.doesNotMatch(r.detail, /e4/);
});

test('timing gives a healthy-time event recovery + 300 s when an earlier one was still unsaved', () => {
  const { loadgen, endpoint } = clean();
  loadgen.push(post('e4', 'u1', '2026-11-17T10:00:03.000Z', T0 + 3000));
  loadgen.push(post('e5', 'u1', '2026-11-17T10:01:40.000Z', T0 + 100_000));
  endpoint.push(save('e4', 'u1', '2026-11-17T10:00:03.000Z', T0 + 200_000));
  endpoint.push(save('e5', 'u1', '2026-11-17T10:01:40.000Z', T0 + 200_001));
  assert.ok(result(run(loadgen, endpoint, downThenUp), 'timing').pass);
});

test('intake_up fails a valid post answered after more than 1 s', () => {
  const { loadgen, endpoint, modes } = clean();
  loadgen[2] = post('e3', 'u2', '2026-11-17T10:00:00.500Z', T0 - 1000, { t_done: T0 + 500 });
  failsOnly(run(loadgen, endpoint, modes), 'intake_up', 'e3');
});

test('intake_up fails an invalid post that did not get a 400', () => {
  const { loadgen, endpoint, modes } = clean();
  loadgen.push(post('x7', 'u1', 'garbage', T0 + 1500, { valid: false, status: 200 }));
  failsOnly(run(loadgen, endpoint, modes), 'intake_up', 'x7');
});

test('intake_up ignores posts inside a relay_stopped window', () => {
  const { loadgen, endpoint, modes } = clean();
  modes.push({ t: T0 + 2000, mode: 'relay_stopped', users: null }, { t: T0 + 10_000, mode: 'relay_running', users: null });
  loadgen.push(post('e8', 'u2', '2026-11-17T10:00:05.000Z', T0 + 3000, { status: null, err: 'ECONNREFUSED' }));
  const results = run(loadgen, endpoint, modes);
  for (const r of results) assert.ok(r.pass, `${r.check}: ${r.detail}`);
  // The same post outside the window fails.
  loadgen[loadgen.length - 1] = post('e8', 'u2', '2026-11-17T10:00:05.000Z', T0 + 11_000, { status: null, err: 'ECONNREFUSED' });
  failsOnly(run(loadgen, endpoint, modes), 'intake_up', 'e8');
});

test('bytes fails when a saved body differs from the promised one', () => {
  const { loadgen, endpoint, modes } = clean();
  endpoint[1] = save('e3', 'u2', '2026-11-17T10:00:00.500Z', T0 + 600, { body_sha256: 'other' });
  failsOnly(run(loadgen, endpoint, modes), 'bytes', 'e3');
});

test('bytes compares with the first 2xx post of a resent event', () => {
  const { loadgen, endpoint, modes } = clean();
  loadgen.push(post('e3', 'u2', '2026-11-17T10:00:00.500Z', T0 + 800, { body_sha256: 'resent' }));
  endpoint[1] = save('e3', 'u2', '2026-11-17T10:00:00.500Z', T0 + 900, { body_sha256: 'resent' });
  failsOnly(run(loadgen, endpoint, modes), 'bytes', 'e3');
});

test('a malformed line makes check throw', () => {
  const { loadgen, modes } = clean();
  assert.throws(() => run(loadgen, [{ t: 'soon' }], modes), /endpoint\.ndjson:1/);
  const dir = mkdtempSync(join(tmpdir(), 'check-bad-'));
  writeFileSync(join(dir, 'modes.ndjson'), '{"t": 1, "mode": "healthy", "users": null}\nnot json\n');
  assert.throws(() => check(dir), /modes\.ndjson:2/);
});

// Review fixes, R3: no deadline extension from a backlog that was already cleared, or from a later outage.
test('timing gives no extension once the earlier backlog is cleared', () => {
  const R = T0 + 60_000;
  const loadgen = [post('f', 'u1', '2026-11-17T10:00:00.000Z', T0 + 10_000), post('e', 'u1', '2026-11-17T10:00:01.000Z', R + 100_000)];
  const endpoint = [save('f', 'u1', '2026-11-17T10:00:00.000Z', R + 10_000), save('e', 'u1', '2026-11-17T10:00:01.000Z', R + 200_000)];
  const modes: ModeLine[] = [
    { t: T0, mode: 'down', users: null },
    { t: R, mode: 'healthy', users: null },
  ];
  failsOnly(run(loadgen, endpoint, modes), 'timing', 'event e of u1');
});

test('timing: an outage after an event was already late does not excuse it', () => {
  const loadgen = [post('f', 'u1', '2026-11-17T10:00:00.000Z', T0 - 1_000), post('e', 'u1', '2026-11-17T10:00:01.000Z', T0)];
  const endpoint = [save('f', 'u1', '2026-11-17T10:00:00.000Z', T0 + 1_000_000), save('e', 'u1', '2026-11-17T10:00:01.000Z', T0 + 1_000_001)];
  const modes: ModeLine[] = [
    { t: T0 - 2_000, mode: 'healthy', users: null },
    { t: T0 + 500_000, mode: 'down', users: null },
    { t: T0 + 900_000, mode: 'healthy', users: null },
  ];
  const r = result(run(loadgen, endpoint, modes), 'timing');
  assert.equal(r.pass, false);
  assert.match(r.detail, /^2 of 2 /);
});

test('intake_up has nothing to judge when every post is inside a relay_stopped window', () => {
  const { loadgen, endpoint } = clean();
  const modes: ModeLine[] = [{ t: T0 - 1_000, mode: 'relay_stopped', users: null }];
  const r = result(run(loadgen, endpoint, modes), 'intake_up');
  assert.equal(r.pass, false);
  assert.match(r.detail, /^nothing to judge/);
});

test('bytes has nothing to judge when no saved event was promised', () => {
  const { loadgen, modes } = clean();
  const endpoint = [save('x1', 'u9', '2026-11-17T10:00:00.000Z', T0 + 100)];
  const r = result(run(loadgen, endpoint, modes), 'bytes');
  assert.equal(r.pass, false);
  assert.match(r.detail, /^nothing to judge/);
});

test('order refuses an impossible created_at, never rolling it over', () => {
  const loadgen = [post('e1', 'u1', '2026-13-45T10:00:00Z', T0)];
  const endpoint = [save('e1', 'u1', '2026-13-45T10:00:00Z', T0 + 100)];
  failsOnly(run(loadgen, endpoint, clean().modes), 'order', 'unreadable created_at');
});

test('a missing modes.ndjson makes check throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-nomodes-'));
  writeFileSync(join(dir, 'loadgen.ndjson'), JSON.stringify(post('e1', 'u1', '2026-11-17T10:00:00Z', T0)) + '\n');
  assert.throws(() => check(dir), /modes\.ndjson/);
});
