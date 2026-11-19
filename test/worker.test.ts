import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ids, SendResult } from '../src/send.ts';
import type { Pending } from '../src/sql.ts';
import { nextWait, startWorker } from '../src/worker.ts';
import type { WorkerDeps } from '../src/worker.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await tick();
  assert.ok(cond(), 'condition never became true');
}

interface Line {
  level: string;
  msg: string;
  extra: Record<string, unknown>;
}

// An in-memory stand-in for the four queries: each user's events in created_at order, none held.
function fakes(events: Record<string, string[]>) {
  const pending = new Map(Object.entries(events).map(([u, ids]) => [u, [...ids]]));
  const sent: string[] = [];
  const marked: string[] = [];
  const sleeps: number[] = [];
  const excludedSeen: string[][] = [];
  const logs: Line[] = [];
  let clock = 1_000_000;
  const deps: WorkerDeps = {
    readyUsers: async (excluded, limit) => {
      excludedSeen.push([...excluded]);
      return [...pending.entries()].filter(([u, ids]) => ids.length > 0 && !excluded.includes(u)).map(([u]) => u).slice(0, limit);
    },
    oldestUnsent: async (userId): Promise<Pending | null> => {
      const id = pending.get(userId)?.[0];
      return id === undefined ? null : { event_id: id, body: Buffer.from(id), created_at: id, late: false };
    },
    markDelivered: async (eventId) => {
      marked.push(eventId);
      for (const ids of pending.values()) {
        const i = ids.indexOf(eventId);
        if (i >= 0) {
          ids.splice(i, 1);
          return true;
        }
      }
      return false;
    },
    unsentCount: async () => [...pending.values()].reduce((n, ids) => n + ids.length, 0),
    send: async (_body: Buffer, ids: Ids): Promise<SendResult> => {
      sent.push(ids.event_id);
      return { kind: 'saved' };
    },
    log: (level, msg, extra = {}) => logs.push({ level, msg, extra }),
    sleep: async (ms) => {
      sleeps.push(ms);
      await tick();
    },
    now: () => clock,
  };
  return { deps, pending, sent, marked, sleeps, excludedSeen, logs, advance: (ms: number) => (clock += ms) };
}

const POLL_MS = 200;
const waits = (sleeps: number[]): number[] => sleeps.filter((ms) => ms !== POLL_MS);

test('retry waits double from 20 ms and stop at 5000 ms', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(nextWait), [20, 40, 80, 160, 320, 640, 1280, 2560, 5000, 5000]);
});

test('a user that several polls return still has one loop', async () => {
  const f = fakes({ u1: ['e1'] });
  const answer = deferred<SendResult>();
  f.deps.send = async (_b, ids) => {
    f.sent.push(ids.event_id);
    return answer.promise;
  };
  const w = startWorker(f.deps);
  await until(() => f.excludedSeen.length >= 5);
  assert.deepEqual(f.sent, ['e1']);
  assert.ok(f.excludedSeen.slice(2).every((ex) => ex.includes('u1')), 'a user in flight is excluded from the poll');
  answer.resolve({ kind: 'saved' });
  await w.stop();
});

test('a poll starts only after the last one finished, 200 ms later', async () => {
  const f = fakes({});
  let running = 0;
  let most = 0;
  const real = f.deps.readyUsers;
  f.deps.readyUsers = async (ex, limit) => {
    most = Math.max(most, ++running);
    await tick();
    await tick();
    running--;
    return real(ex, limit);
  };
  const w = startWorker(f.deps);
  await until(() => f.excludedSeen.length >= 5);
  await w.stop();
  assert.equal(most, 1);
  assert.ok(f.sleeps.filter((ms) => ms === POLL_MS).length >= 4);
});

test('retry waits run 20, 40, 80 and go back to 20 after a success', async () => {
  const f = fakes({ u1: ['e1', 'e2'] });
  const answers: SendResult[] = [
    { kind: 'retry', why: '500' },
    { kind: 'retry', why: '500' },
    { kind: 'retry', why: '500' },
    { kind: 'saved' },
    { kind: 'retry', why: '500' },
    { kind: 'saved' },
  ];
  f.deps.send = async (_b, ids) => {
    f.sent.push(ids.event_id);
    return answers.shift() ?? { kind: 'saved' };
  };
  const w = startWorker(f.deps);
  await until(() => f.marked.length === 2);
  await w.stop();
  assert.deepEqual(waits(f.sleeps), [20, 40, 80, 20]);
  assert.deepEqual(f.sent, ['e1', 'e1', 'e1', 'e1', 'e2', 'e2']);
  const failed = f.logs.filter((l) => l.level === 'error' && l.extra['event_id'] === 'e1');
  assert.deepEqual(failed.map((l) => l.extra['failures']), [1, 2, 3]);
  assert.ok(failed.every((l) => l.extra['user_id'] === 'u1' && l.extra['why'] === '500'));
});

test('a 429 ends the loop and leaves the user out of polls for Retry-After seconds, then it is sent again', async () => {
  const f = fakes({ u1: ['e1'] });
  const answers: SendResult[] = [{ kind: 'pause', seconds: 7 }];
  f.deps.send = async (_b, ids) => {
    f.sent.push(ids.event_id);
    return answers.shift() ?? { kind: 'saved' };
  };
  const w = startWorker(f.deps);
  await until(() => f.sent.length === 1);
  const before = f.excludedSeen.length;
  await until(() => f.excludedSeen.length >= before + 3);
  assert.ok(f.excludedSeen.slice(before + 1).every((ex) => ex.includes('u1')), 'paused user is excluded');
  assert.deepEqual(f.sent, ['e1']);
  assert.deepEqual(waits(f.sleeps), [], 'a 429 is no retry wait');
  f.advance(6999);
  const held = f.excludedSeen.length;
  await until(() => f.excludedSeen.length >= held + 3);
  assert.deepEqual(f.sent, ['e1'], 'still paused 1 ms before 7 s');
  f.advance(1);
  await until(() => f.marked.length === 1);
  await w.stop();
  assert.deepEqual(f.sent, ['e1', 'e1']);
});

test('a failed delivered_at write is retried until it commits, and the event is never sent again', async () => {
  const f = fakes({ u1: ['e1'] });
  const real = f.deps.markDelivered;
  let tries = 0;
  f.deps.markDelivered = async (id) => {
    if (++tries <= 2) throw new Error('connection terminated');
    return real(id);
  };
  const w = startWorker(f.deps);
  await until(() => f.marked.length === 1);
  await w.stop();
  assert.deepEqual(f.sent, ['e1']);
  assert.equal(tries, 3);
  assert.equal(f.logs.filter((l) => l.level === 'error' && l.extra['event_id'] === 'e1').length, 2);
});

test('markDelivered returning false is logged with the event and the loop moves on, never retried', async () => {
  const f = fakes({ u1: ['e1', 'e2'] });
  const real = f.deps.markDelivered;
  f.deps.markDelivered = async (id) => {
    if (id === 'e1') {
      f.marked.push(id);
      f.pending.get('u1')?.shift();
      return false;
    }
    return real(id);
  };
  const w = startWorker(f.deps);
  await until(() => f.marked.length === 2);
  await w.stop();
  assert.deepEqual(f.marked, ['e1', 'e2']);
  assert.ok(f.logs.some((l) => l.level === 'error' && l.extra['event_id'] === 'e1' && l.extra['user_id'] === 'u1'));
});

test('a thrown error counts as a failed attempt: logged, waited on, and tried again', async () => {
  const f = fakes({ u1: ['e1'] });
  let first = true;
  f.deps.send = async (_b, ids) => {
    f.sent.push(ids.event_id);
    if (first) {
      first = false;
      throw new Error('boom');
    }
    return { kind: 'saved' };
  };
  const w = startWorker(f.deps);
  await until(() => f.marked.length === 1);
  await w.stop();
  assert.deepEqual(waits(f.sleeps), [20]);
  assert.ok(f.logs.some((l) => l.level === 'error' && String(l.extra['why']).includes('boom') && l.extra['event_id'] === 'e1'));
});

test('stop lets the send in flight and its delivered_at write finish, and starts nothing new', async () => {
  const f = fakes({ u1: ['e1', 'e2'], u2: [] });
  const answer = deferred<SendResult>();
  f.deps.send = async (_b, ids) => {
    f.sent.push(ids.event_id);
    return answer.promise;
  };
  const w = startWorker(f.deps);
  await until(() => f.sent.length === 1);
  let stopped = false;
  const stopping = w.stop().then(() => (stopped = true));
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(stopped, false, 'stop waits for the send in flight');
  answer.resolve({ kind: 'saved' });
  await stopping;
  assert.deepEqual(f.marked, ['e1']);
  assert.deepEqual(f.sent, ['e1']);
});

test("a user's next send starts only after the previous delivered_at commit", async () => {
  const f = fakes({ u1: ['e1', 'e2'] });
  const commit = deferred<void>();
  const real = f.deps.markDelivered;
  f.deps.markDelivered = async (id) => {
    if (id === 'e1') await commit.promise;
    return real(id);
  };
  const w = startWorker(f.deps);
  await until(() => f.sent.length === 1);
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(f.sent, ['e1']);
  commit.resolve();
  await until(() => f.marked.length === 2);
  await w.stop();
  assert.deepEqual(f.sent, ['e1', 'e2']);
});

test('the startup log gives the unsent count, and a send in flight over 60 s logs a warning with its event_id', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fakes({ u1: ['e1'], u2: ['e2', 'e3'] });
  const answer = deferred<SendResult>();
  f.deps.send = async (_b, ids) => {
    f.sent.push(ids.event_id);
    if (ids.event_id === 'e1') return answer.promise;
    return { kind: 'saved' };
  };
  const w = startWorker(f.deps);
  await until(() => f.logs.some((l) => l.extra['unsent'] === 3));
  await until(() => f.sent.includes('e1'));
  t.mock.timers.tick(60_000);
  assert.ok(f.logs.some((l) => l.level === 'warn' && l.extra['event_id'] === 'e1' && l.extra['user_id'] === 'u1'));
  answer.resolve({ kind: 'saved' });
  await w.stop();
});

test('an event flagged late is logged with its ids and still sent', async () => {
  const f = fakes({ u1: ['e1'] });
  const real = f.deps.oldestUnsent;
  f.deps.oldestUnsent = async (u, last) => {
    const p = await real(u, last);
    return p === null ? null : { ...p, late: true };
  };
  const w = startWorker(f.deps);
  await until(() => f.marked.length === 1);
  await w.stop();
  assert.ok(f.logs.some((l) => l.level === 'warn' && l.extra['event_id'] === 'e1' && l.extra['user_id'] === 'u1'));
});

test('a failed poll is logged and the next poll still runs', async () => {
  const f = fakes({ u1: ['e1'] });
  const real = f.deps.readyUsers;
  let first = true;
  f.deps.readyUsers = async (ex, limit) => {
    if (first) {
      first = false;
      throw new Error('poll failed');
    }
    return real(ex, limit);
  };
  const w = startWorker(f.deps);
  await until(() => f.marked.length === 1);
  await w.stop();
  assert.ok(f.logs.some((l) => l.level === 'error' && String(l.extra['err']).includes('poll failed')));
});

test('a poll that returns a user already in flight starts no second loop for it', async () => {
  const f = fakes({ u1: ['e1'] });
  // A stale poll result: the user comes back even though it is excluded.
  f.deps.readyUsers = async (ex) => {
    f.excludedSeen.push([...ex]);
    return ['u1'];
  };
  const answer = deferred<SendResult>();
  f.deps.send = async (_b, ids) => {
    f.sent.push(ids.event_id);
    return answer.promise;
  };
  const w = startWorker(f.deps);
  await until(() => f.excludedSeen.length >= 5);
  assert.deepEqual(f.sent, ['e1']);
  answer.resolve({ kind: 'saved' });
  await w.stop();
});

test("each lookup passes the created_at of the user's last delivered event", async () => {
  const f = fakes({ u1: ['e1', 'e2'] });
  const real = f.deps.oldestUnsent;
  const lasts: (string | null)[] = [];
  f.deps.oldestUnsent = async (u, last) => {
    lasts.push(last);
    return real(u, last);
  };
  const w = startWorker(f.deps);
  await until(() => f.marked.length === 2);
  await w.stop();
  assert.deepEqual(lasts.slice(0, 3), [null, 'e1', 'e2']);
});
