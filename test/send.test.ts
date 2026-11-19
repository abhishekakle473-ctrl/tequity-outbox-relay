import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { post } from '../src/send.ts';

const ids = { event_id: 'e1', user_id: 'u0001' };

interface Server {
  url: string;
  connections: () => number;
  requests: () => number;
  close: () => Promise<void>;
}

// An HTTP server on a free port that counts the TCP connections and requests it sees.
async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void): Promise<Server> {
  let connections = 0;
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(chunks)));
  });
  server.on('connection', () => connections++);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/events`,
    connections: () => connections,
    requests: () => requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const body = Buffer.from('{"event_id":"e1","user_id":"u0001","created_at":"2026-11-19T00:00:00.000Z"}');

async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void,
  fn: (server: Server, agent: http.Agent) => Promise<void>
): Promise<void> {
  const server = await serve(handler);
  const agent = new http.Agent({ keepAlive: true });
  try {
    await fn(server, agent);
  } finally {
    agent.destroy();
    await server.close();
  }
}

test('a 200 is saved, and the endpoint gets the stored bytes as application/json', async () => {
  let got: Buffer | undefined;
  let type: string | undefined;
  await withServer(
    (req, res, b) => {
      got = b;
      type = req.headers['content-type'];
      res.end();
    },
    async (server, agent) => {
      assert.deepEqual(await post(agent, server.url, body, ids), { kind: 'saved' });
    }
  );
  assert.deepEqual(got, body);
  assert.equal(type, 'application/json');
});

test('a 200 whose body is cut off after the status line is still saved, and the late error is logged with its ids', async (t) => {
  const logged = t.mock.method(console, 'error', () => undefined);
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('partial');
      setTimeout(() => res.socket?.destroy(), 50);
    },
    async (server, agent) => {
      assert.deepEqual(await post(agent, server.url, body, ids), { kind: 'saved' });
      await new Promise((r) => setTimeout(r, 100)); // let the cut happen while the test still runs
    }
  );
  const lines = logged.mock.calls.map((c) => JSON.parse(String(c.arguments[0])) as Record<string, unknown>);
  assert.ok(lines.some((l) => l['event_id'] === 'e1' && l['user_id'] === 'u0001' && l['level'] === 'warn'), JSON.stringify(lines));
});

test('any status other than 2xx or 429 is a retry naming the status, and a redirect is not followed', async () => {
  for (const status of [500, 302, 404]) {
    await withServer(
      (_req, res) => {
        res.writeHead(status, { Location: '/elsewhere' }).end();
      },
      async (server, agent) => {
        const result = await post(agent, server.url, body, ids);
        assert.equal(result.kind, 'retry', `status ${status}`);
        assert.ok(result.kind === 'retry' && result.why.includes(String(status)), `status ${status}: ${JSON.stringify(result)}`);
        assert.equal(server.requests(), 1, `status ${status}: one request, no redirect followed`);
      }
    );
  }
});

test('a 429 pauses for Retry-After seconds, and at least 1 second', async () => {
  const cases: Array<[string | undefined, number]> = [
    ['7', 7],
    ['0', 1],
    [undefined, 1],
    ['abc', 1],
  ];
  for (const [header, seconds] of cases) {
    await withServer(
      (_req, res) => {
        res.writeHead(429, header === undefined ? {} : { 'Retry-After': header }).end();
      },
      async (server, agent) => {
        assert.deepEqual(await post(agent, server.url, body, ids), { kind: 'pause', seconds }, `Retry-After ${header}`);
      }
    );
  }
});

test('a refused connection is a retry naming ECONNREFUSED', async () => {
  const server = await serve(() => undefined);
  const url = server.url;
  await server.close();
  const agent = new http.Agent({ keepAlive: true });
  try {
    const result = await post(agent, url, body, ids);
    assert.ok(result.kind === 'retry' && result.why.includes('ECONNREFUSED'), JSON.stringify(result));
  } finally {
    agent.destroy();
  }
});

test('a connection reset after the request went out is a retry', async () => {
  await withServer(
    (req) => req.socket.destroy(),
    async (server, agent) => {
      const result = await post(agent, server.url, body, ids);
      assert.equal(result.kind, 'retry');
      assert.equal(server.requests(), 1);
    }
  );
});

test('a 3-second answer on a reused keep-alive socket is waited for and saved', async () => {
  let n = 0;
  await withServer(
    (_req, res) => {
      n++;
      if (n === 1) res.end();
      else setTimeout(() => res.end(), 3000);
    },
    async (server, agent) => {
      assert.deepEqual(await post(agent, server.url, body, ids), { kind: 'saved' });
      const t0 = Date.now();
      assert.deepEqual(await post(agent, server.url, body, ids), { kind: 'saved' });
      assert.ok(Date.now() - t0 >= 2900, 'waited for the slow answer');
      assert.equal(server.connections(), 1, 'the second post reused the first socket');
    }
  );
});

test('every answer is drained, so one socket carries several posts', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('the endpoint failed, with a body');
    },
    async (server, agent) => {
      for (let i = 0; i < 3; i++) assert.equal((await post(agent, server.url, body, ids)).kind, 'retry');
      assert.equal(server.connections(), 1);
    }
  );
});

test('a reused keep-alive socket reset before any status line is a retry, never saved', async () => {
  let n = 0;
  await withServer(
    (req, res) => {
      n++;
      if (n === 1) res.end();
      else req.socket.destroy();
    },
    async (server, agent) => {
      assert.deepEqual(await post(agent, server.url, body, ids), { kind: 'saved' });
      const second = await post(agent, server.url, body, ids);
      assert.equal(second.kind, 'retry');
      assert.equal(server.connections(), 1, 'the reset came on the reused socket');
    }
  );
});

test('a url the request cannot use comes back as a retry, never a rejection', async () => {
  const agent = new http.Agent({ keepAlive: true });
  try {
    const result = await post(agent, 'ftp://127.0.0.1/events', body, ids);
    assert.equal(result.kind, 'retry');
  } finally {
    agent.destroy();
  }
});

test('a Retry-After beyond the longest Node timer is cut to that timer, about 24.8 days', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(429, { 'Retry-After': '99999999999' }).end();
    },
    async (server, agent) => {
      assert.deepEqual(await post(agent, server.url, body, ids), { kind: 'pause', seconds: 2_147_483 });
    }
  );
});

test('an unusable Retry-After is logged with its ids when it is taken as 1 second', async (t) => {
  const logged = t.mock.method(console, 'error', () => undefined);
  await withServer(
    (_req, res) => {
      res.writeHead(429, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }).end();
    },
    async (server, agent) => {
      assert.deepEqual(await post(agent, server.url, body, ids), { kind: 'pause', seconds: 1 });
    }
  );
  const lines = logged.mock.calls.map((c) => JSON.parse(String(c.arguments[0])) as Record<string, unknown>);
  assert.ok(lines.some((l) => l['event_id'] === 'e1' && String(l['msg']).includes('Retry-After')), JSON.stringify(lines));
});

test('a multi-byte body arrives byte for byte', async () => {
  const multi = Buffer.from('{"event_id":"e1","user_id":"u0001","created_at":"2026-11-19T00:00:00Z","data":{"name":"Zoë 🚀"}}');
  let got: Buffer | undefined;
  await withServer(
    (_req, res, b) => {
      got = b;
      res.end();
    },
    async (server, agent) => {
      assert.deepEqual(await post(agent, server.url, multi, ids), { kind: 'saved' });
    }
  );
  assert.deepEqual(got, multi);
});
