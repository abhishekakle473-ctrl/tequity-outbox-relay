// The worker: poll for ready users, run one loop per user that sends its events in order (docs/decisions.md).
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPool, waitForDb } from './db.ts';
import { post } from './send.ts';
import type { Ids, SendResult } from './send.ts';
import { markDelivered, oldestUnsent, readyUsers, unsentCount } from './sql.ts';
import type { Pending } from './sql.ts';

type Level = 'info' | 'warn' | 'error';

// Everything the worker touches outside itself, so tests pass fakes.
export interface WorkerDeps {
  readyUsers(excluded: readonly string[], limit: number): Promise<string[]>;
  oldestUnsent(userId: string, lastDelivered: string | null): Promise<Pending | null>;
  markDelivered(eventId: string): Promise<boolean>;
  unsentCount(): Promise<number>;
  send(body: Buffer, ids: Ids): Promise<SendResult>;
  log(level: Level, msg: string, extra?: Record<string, unknown>): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const MAX_LOOPS = 1000;
const POLL_MS = 200;
const SLOW_SEND_MS = 60_000;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The wait after the given number of failures in a row: 20 ms, doubling, at most 5 s.
export function nextWait(failures: number): number {
  return Math.min(5000, 20 * 2 ** Math.max(0, failures - 1));
}

export function startWorker(deps: WorkerDeps): { stop(): Promise<void> } {
  const loops = new Map<string, Promise<void>>();
  const pausedUntil = new Map<string, number>();
  // The created_at of the last event delivered per user, to spot one that arrived late; lost on restart (docs/decisions.md).
  const lastDelivered = new Map<string, string>();
  let stopping = false;

  // A thrown error is a failed attempt like any other: the event is retried, never skipped.
  async function sendWatched(p: Pending, ids: Ids): Promise<SendResult> {
    const started = deps.now();
    const timer = setInterval(() => {
      deps.log('warn', 'send still in flight', { ...ids, seconds: Math.round((deps.now() - started) / 1000) });
    }, SLOW_SEND_MS);
    try {
      return await deps.send(p.body, ids);
    } catch (e) {
      return { kind: 'retry', why: message(e) };
    } finally {
      clearInterval(timer);
    }
  }

  // Retries only the write, never the send: the endpoint already saved it (docs/decisions.md, delivered_at entry).
  async function commit(ids: Ids): Promise<void> {
    for (let failures = 1; ; failures++) {
      try {
        if (!(await deps.markDelivered(ids.event_id))) {
          deps.log('error', 'delivered_at was already set or the row is gone; moving on', { ...ids });
        }
        return;
      } catch (e) {
        deps.log('error', 'writing delivered_at failed; retrying the write only', { ...ids, err: message(e), failures });
        await deps.sleep(nextWait(failures));
      }
    }
  }

  async function userLoop(userId: string): Promise<void> {
    let failures = 0;
    while (!stopping) {
      let p: Pending | null;
      try {
        p = await deps.oldestUnsent(userId, lastDelivered.get(userId) ?? null);
      } catch (e) {
        failures++;
        deps.log('error', 'reading the next event failed', { user_id: userId, err: message(e), failures });
        await deps.sleep(nextWait(failures));
        continue;
      }
      if (p === null) return;
      const ids: Ids = { event_id: p.event_id, user_id: userId };
      if (p.late) deps.log('warn', 'event created before one of this user already delivered; sending it now', { ...ids });
      const r = await sendWatched(p, ids);
      if (r.kind === 'pause') {
        pausedUntil.set(userId, deps.now() + r.seconds * 1000);
        deps.log('warn', 'rate limited; pausing this user', { ...ids, seconds: r.seconds });
        return;
      }
      if (r.kind === 'retry') {
        failures++;
        deps.log('error', 'send failed; will retry', { ...ids, why: r.why, failures });
        await deps.sleep(nextWait(failures));
        continue;
      }
      await commit(ids);
      lastDelivered.set(userId, p.created_at);
      failures = 0;
    }
  }

  function startLoop(userId: string): void {
    const loop = userLoop(userId)
      .catch((e: unknown) => deps.log('error', 'user loop failed', { user_id: userId, err: message(e) }))
      .finally(() => loops.delete(userId));
    loops.set(userId, loop);
  }

  async function poll(): Promise<void> {
    try {
      deps.log('info', 'worker started', { unsent: await deps.unsentCount() });
    } catch (e) {
      deps.log('error', 'counting unsent events failed', { err: message(e) });
    }
    while (!stopping) {
      try {
        const now = deps.now();
        for (const [u, until] of pausedUntil) if (until <= now) pausedUntil.delete(u);
        const free = MAX_LOOPS - loops.size;
        if (free > 0) {
          const users = await deps.readyUsers([...loops.keys(), ...pausedUntil.keys()], free);
          for (const u of users) if (!stopping && !loops.has(u) && !pausedUntil.has(u)) startLoop(u);
        }
      } catch (e) {
        deps.log('error', 'poll failed', { err: message(e) });
      }
      await deps.sleep(POLL_MS);
    }
  }

  const polling = poll();
  return {
    async stop() {
      stopping = true;
      await polling;
      await Promise.all(loops.values());
    },
  };
}

if (import.meta.main) {
  const log = (level: Level, msg: string, extra: Record<string, unknown> = {}): void =>
    console.error(JSON.stringify({ level, msg, ...extra }));
  const pool = createPool(20);
  const agent = new http.Agent({ keepAlive: true });
  const url = 'http://localhost:9000/events';
  await waitForDb(pool);
  const worker = startWorker({
    readyUsers: (excluded, limit) => readyUsers(pool, excluded, limit),
    oldestUnsent: (userId, last) => oldestUnsent(pool, userId, last),
    markDelivered: (eventId) => markDelivered(pool, eventId),
    unsentCount: () => unsentCount(pool),
    send: (body, ids) => post(agent, url, body, ids),
    log,
    sleep: (ms) => sleep(ms),
    now: () => Date.now(),
  });
  // Without a handler SIGTERM, passed on by init, ends Node mid-send. Sends in flight and their writes finish; compose allows 120 s.
  process.on('SIGTERM', () => {
    log('info', 'SIGTERM: finishing sends in flight');
    worker
      .stop()
      .then(() => pool.end())
      .catch((e: unknown) => log('error', 'stopping failed', { err: message(e) }))
      .finally(() => {
        log('info', 'stopped');
        process.exit(0);
      });
  });
}
