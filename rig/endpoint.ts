// Fake Tequity endpoint: answers POST /events as the scenario's steps say, and logs every request and mode change.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { rng } from './rng.ts';
import { parseScenario } from './types.ts';
import type { EndpointLine, Mode, ModeLine, Scenario, Step } from './types.ts';

export interface Endpoint {
  port: number;
  close: () => Promise<void>;
}

export interface StartOptions {
  scenario: Pick<Scenario, 'seed' | 'steps'>;
  dataDir: string;
  port: number;
}

interface EventFields {
  event_id: string | null;
  user_id: string | null;
  created_at: string | null;
}

// Takes the three fields the log needs from the body; anything that is not a JSON object with string fields gives nulls.
function eventFields(raw: Buffer): EventFields {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    body = null;
  }
  const field = (name: string): string | null => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const value: unknown = (body as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : null;
  };
  return { event_id: field('event_id'), user_id: field('user_id'), created_at: field('created_at') };
}

export function start({ scenario, dataDir, port }: StartOptions): Promise<Endpoint> {
  const steps = scenario.steps;
  const next = rng(scenario.seed);
  const endpointLog = path.join(dataDir, 'endpoint.ndjson');
  const modesLog = path.join(dataDir, 'modes.ndjson');
  const append = (file: string, line: EndpointLine | ModeLine): void => {
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
  };

  const timers = new Set<NodeJS.Timeout>();
  const at = (seconds: number, fn: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, seconds * 1000);
    timers.add(timer);
  };
  let t0 = Date.now();

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/events') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const fields = eventFields(raw);
      const s = (Date.now() - t0) / 1000;
      const healthy: Step = { from_s: 0, to_s: 0, mode: 'healthy' };
      const step =
        steps.find(
          (st) =>
            st.mode !== 'down' &&
            s >= st.from_s &&
            s < st.to_s &&
            (st.users === undefined || (fields.user_id !== null && st.users.includes(fields.user_id)))
        ) ?? healthy;
      const hit = next() < (step.p ?? 1); // one draw per request, whatever the mode
      let status = 200;
      const headers: Record<string, string> = {};
      if (step.mode === 'fail' && hit) status = 500;
      if (step.mode === 'limit' && hit) {
        status = 429;
        if (step.retry_after !== undefined) headers['Retry-After'] = String(step.retry_after);
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        res.writeHead(status, headers).end();
        append(endpointLog, {
          t: Date.now(),
          ...fields,
          body_sha256: crypto.createHash('sha256').update(raw).digest('hex'),
          mode: step.mode,
          status,
          saved: status === 200,
        });
      }, step.latency_ms ?? 0);
      timers.add(timer);
    });
  });

  let boundPort = port;
  // Logs are wiped and step timers armed only once the port is ours, so a failed start leaves both alone.
  const armSteps = (): void => {
    fs.writeFileSync(endpointLog, '');
    fs.writeFileSync(modesLog, '');
    t0 = Date.now();
    append(modesLog, { t: t0, mode: 'healthy', users: null });
    for (const st of steps) {
      const mode: Mode = st.mode;
      const users = mode === 'down' ? null : (st.users ?? null);
      at(st.from_s, () => {
        append(modesLog, { t: Date.now(), mode, users });
        // refuses new connects; idle keep-alive sockets are closed too
        if (mode === 'down' && server.listening) server.close();
      });
      at(st.to_s, () => {
        append(modesLog, { t: Date.now(), mode: 'healthy', users });
        if (mode === 'down' && !server.listening) server.listen(boundPort);
      });
    }
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      // From here on a server error, such as a failed re-listen after down, has no handler and stops the process loudly.
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('endpoint: no TCP address after listen'));
        return;
      }
      boundPort = address.port;
      armSteps();
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((done) => {
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
            server.close(() => done()); // also called back with an error if already down
            server.closeAllConnections();
          }),
      });
    });
  });
}

if (import.meta.main) {
  const file = process.env['SCENARIO_FILE'];
  if (file === undefined) throw new Error('endpoint: SCENARIO_FILE is not set');
  const scenario = parseScenario(JSON.parse(fs.readFileSync(file, 'utf8')));
  const port = Number(process.env['PORT'] ?? 9000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('endpoint: PORT must be a port number');
  const endpoint = await start({ scenario, dataDir: process.env['DATA_DIR'] ?? '/data', port });
  console.log(`endpoint listening on ${endpoint.port}`);
}
