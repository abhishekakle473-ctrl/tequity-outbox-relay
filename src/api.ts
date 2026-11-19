// Intake: store each event in Postgres, then answer (docs/decisions.md, "Intake answers 200 only after the commit").
import http from 'node:http';
import type pg from 'pg';
import { createPool, waitForDb } from './db.ts';
import { insert, MAX_BYTES, validate } from './intake.ts';

const log = (level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void =>
  console.error(JSON.stringify({ level, msg, ...extra }));

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Resolves null past MAX_BYTES, dropping the rest unbuffered, and 'gone' if the client hangs up mid-body.
function readBody(req: http.IncomingMessage): Promise<Buffer | null | 'gone'> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BYTES) chunks.push(c);
      else resolve(null);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    // The hang-up itself is logged by the request's error listener.
    req.on('close', () => resolve('gone'));
  });
}

// The status to answer, or null when the client is gone and nobody is left to answer.
async function handle(pool: pg.Pool, req: http.IncomingMessage): Promise<number | null> {
  if (req.method !== 'POST' || req.url !== '/events') return 404;

  const body = await readBody(req);
  if (body === 'gone') return null;
  if (body === null) {
    log('warn', 'rejected with 413', { reason: `body over ${MAX_BYTES} bytes` });
    return 413;
  }
  const v = validate(body);
  if (!v.ok) {
    log('warn', `rejected with ${v.status}`, { reason: v.reason });
    return v.status;
  }
  return insert(pool, body, v);
}

export function createApi(pool: pg.Pool): http.Server {
  const server = http.createServer((req, res) => {
    // An 'error' with no listener crashes Node; these stay attached for the whole request.
    req.on('error', (e) => log('warn', 'request error', { err: message(e) }));
    res.on('error', (e) => log('warn', 'response error', { err: message(e) }));
    const answer = (status: number | null): void => {
      if (status === null || res.headersSent) return;
      // After a 413 the rest of the body is never read. After close(), a keep-alive socket left open would hold the stop for 65 s.
      if (status === 413 || !server.listening) res.setHeader('Connection', 'close');
      res.statusCode = status;
      // No answer body; end() with no data sends Content-Length: 0.
      res.end();
    };
    // catch after then: a throw inside answer would otherwise be an unhandled rejection, which ends the process.
    handle(pool, req)
      .then(answer)
      .catch((e: unknown) => {
        log('error', 'request failed; answering 503', { err: message(e) });
        try {
          answer(503);
        } catch (e2) {
          log('error', 'answering 503 failed', { err: message(e2) });
        }
      });
  });
  // Longer than any client's idle timeout, so Node never closes a connection the load generator is about to reuse.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}

if (import.meta.main) {
  const pool = createPool(30);
  const server = createApi(pool);
  // Listen at once, on every address: until Postgres answers, inserts fail and are answered 503.
  server.listen(8080, () => log('info', 'listening on :8080'));
  void waitForDb(pool);
  // Node as process 1 ignores SIGTERM without a handler. close() stops new connections and lets requests in progress commit and answer.
  process.on('SIGTERM', () => {
    log('info', 'SIGTERM: finishing requests in progress');
    server.close(() => {
      pool
        .end()
        .catch((e: unknown) => log('error', 'closing the pool failed', { err: message(e) }))
        .finally(() => {
          log('info', 'stopped');
          process.exit(0);
        });
    });
  });
}
