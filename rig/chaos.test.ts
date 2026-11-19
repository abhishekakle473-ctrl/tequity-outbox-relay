import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionCommands, findContainer, run } from './chaos.ts';
import type { Docker } from './chaos.ts';
import type { ModeLine, RelayStep } from './types.ts';

test('restart is one docker restart giving the relay 130 s to stop', () => {
  assert.deepEqual(actionCommands('restart', 'abc'), [['restart', '-t', '130', 'abc']]);
});

test('kill is a docker kill followed by a docker start', () => {
  assert.deepEqual(actionCommands('kill', 'abc'), [['kill', 'abc'], ['start', 'abc']]);
});

test('findContainer asks by compose service label and skips the rig project', async () => {
  const seen: string[][] = [];
  const docker: Docker = async (args) => {
    seen.push(args);
    return 'aaa rig\nbbb second\n';
  };
  const id = await findContainer(docker, 'worker');
  assert.equal(id, 'bbb');
  assert.ok(seen[0]?.includes('label=com.docker.compose.service=worker'));
});

test('findContainer returns null when only the rig has that service', async () => {
  assert.equal(await findContainer(async () => 'aaa rig\n', 'api'), null);
  assert.equal(await findContainer(async () => '', 'api'), null);
});

function harness(steps: RelayStep[]): { calls: string[][]; log: () => ModeLine[]; go: () => Promise<boolean> } {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-'));
  const calls: string[][] = [];
  const docker: Docker = async (args) => {
    calls.push(args);
    return args[0] === 'ps' ? 'cid second\n' : '';
  };
  const log = (): ModeLine[] =>
    readFileSync(join(dir, 'modes.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ModeLine);
  return { calls, log, go: () => run({ relay: steps, dataDir: dir, docker, now: Date.now, sleep: async () => {}, ready: async () => {} }) };
}

test('each step brackets its docker commands with relay_stopped and relay_running lines', async () => {
  const h = harness([{ at_s: 1, action: 'kill', service: 'worker' }]);
  assert.equal(await h.go(), true);
  assert.deepEqual(h.calls.map((c) => c[0]), ['ps', 'kill', 'start']);
  const lines = h.log();
  assert.deepEqual(lines.map((l) => [l.mode, l.users]), [['relay_stopped', null], ['relay_running', null]]);
  assert.ok((lines[0]?.t ?? 1) <= (lines[1]?.t ?? 0));
});

test('steps run in at_s order whatever the file order', async () => {
  const h = harness([
    { at_s: 9, action: 'restart', service: 'api' },
    { at_s: 2, action: 'restart', service: 'worker' },
  ]);
  await h.go();
  const restarts = h.calls.filter((c) => c[0] === 'restart').map((c) => c[3]);
  assert.equal(restarts.length, 2);
  assert.equal(h.log().length, 4);
});

test('a missing container fails the run and writes no stopped line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-'));
  const ok = await run({
    relay: [{ at_s: 0, action: 'kill', service: 'api' }],
    dataDir: dir,
    docker: async () => '',
    now: Date.now,
    sleep: async () => {},
    ready: async () => {},
  });
  assert.equal(ok, false);
  assert.throws(() => readFileSync(join(dir, 'modes.ndjson')));
});

test('a step waits until its at_s after the start', async () => {
  const waits: number[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'chaos-'));
  await run({
    relay: [{ at_s: 3, action: 'restart', service: 'api' }],
    dataDir: dir,
    docker: async (a) => (a[0] === 'ps' ? 'c second' : ''),
    now: () => 1000,
    sleep: async (ms) => void waits.push(ms),
    ready: async () => {},
  });
  assert.deepEqual(waits, [3000]);
});

test('relay_running is written only once the restarted service is ready again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-'));
  const order: string[] = [];
  const docker: Docker = async (args) => {
    order.push(args[0] ?? '');
    return args[0] === 'ps' ? 'cid second' : '';
  };
  const ready = async (service: string): Promise<void> => {
    const before = readFileSync(join(dir, 'modes.ndjson'), 'utf8');
    order.push(`ready ${service}, running written: ${before.includes('relay_running')}`);
  };
  await run({ relay: [{ at_s: 0, action: 'restart', service: 'postgres' }], dataDir: dir, docker, now: Date.now, sleep: async () => {}, ready });
  assert.deepEqual(order, ['ps', 'restart', 'ready postgres, running written: false']);
  assert.match(readFileSync(join(dir, 'modes.ndjson'), 'utf8'), /relay_running/);
});
