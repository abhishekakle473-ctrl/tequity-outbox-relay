// One POST of a stored event to Tequity's endpoint. The status line alone decides the outcome (docs/decisions.md).
import http from 'node:http';

export type SendResult = { kind: 'saved' } | { kind: 'pause'; seconds: number } | { kind: 'retry'; why: string };

// Used only to tie log lines to the event; the body is sent as stored.
export interface Ids {
  event_id: string;
  user_id: string;
}

// setTimeout fires at once beyond 2^31 - 1 ms, which would turn a huge Retry-After into a tight loop.
const LONGEST_PAUSE_S = Math.floor((2 ** 31 - 1) / 1000);

function log(level: 'warn' | 'error', msg: string, ids: Ids, extra: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level, msg, ...ids, ...extra }));
}

// Retry-After is a whole number of seconds; a missing, zero or unusable value still pauses 1 second, never a tight loop.
function pauseSeconds(header: string | undefined, ids: Ids): number {
  if (header === undefined) return 1;
  if (!/^\d+$/.test(header)) {
    log('warn', 'Retry-After is not a whole number of seconds; pausing 1 second', ids, { retry_after: header });
    return 1;
  }
  return Math.min(Math.max(1, Number(header)), LONGEST_PAUSE_S);
}

function classify(status: number | undefined, retryAfter: string | undefined, ids: Ids): SendResult {
  if (status === undefined) return { kind: 'retry', why: 'no status code' };
  if (status >= 200 && status < 300) return { kind: 'saved' };
  if (status === 429) return { kind: 'pause', seconds: pauseSeconds(retryAfter, ids) };
  return { kind: 'retry', why: `status ${status}` };
}

const reason = (e: NodeJS.ErrnoException): string => (e.code === undefined ? e.message : `${e.code}: ${e.message}`);

// No timeout and no retry here: a slow answer is waited for, and the worker decides what a retry means.
export function post(agent: http.Agent, url: string, body: Buffer, ids: Ids): Promise<SendResult> {
  return new Promise((resolve) => {
    let settled = false;
    let req: http.ClientRequest;
    try {
      req = http.request(
        url,
        { method: 'POST', agent, headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
        (res) => {
          settled = true;
          // Draining hands the socket back to the agent; an error in the rest of the answer cannot undo the status.
          res.on('error', (e) => log('warn', 'error in the answer after its status line', ids, { err: reason(e) }));
          res.resume();
          resolve(classify(res.statusCode, res.headers['retry-after'], ids));
        }
      );
    } catch (e) {
      // A URL or header http.request cannot use throws at once; it is still an outcome, never a rejection.
      resolve({ kind: 'retry', why: reason(e as NodeJS.ErrnoException) });
      return;
    }
    // A request error before the status line is the brief's "No connection: not saved": the worker sends again.
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) log('warn', 'request error after the status line', ids, { err: reason(e) });
      else resolve({ kind: 'retry', why: reason(e) });
    });
    req.end(body);
  });
}
