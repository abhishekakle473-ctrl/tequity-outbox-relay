# Decisions

One entry per design choice, each as it stands now: what, why, the option dropped where one lost, and the command that proved it, if any. Git history shows how and when each one changed; commits before 589fddc describe an earlier Go design. Assumptions about Tequity's side are in README.md.

## The API and worker use host networking

The intake API and the worker run with `network_mode: host`, so localhost inside them is the grading machine's own. The worker posts to `http://localhost:9000/events` as the brief writes it, and Node's `autoSelectFamily` tries both ::1 and 127.0.0.1. The API listens on `:8080`, every address.

The brief does not say which address Tequity's endpoint listens on. Host networking reaches one bound to 127.0.0.1 only, and no firewall sees the traffic.

Dropped: a Compose network with `host.docker.internal:host-gateway`. On Linux its traffic comes from a Docker address, which a 127.0.0.1-bound endpoint refuses and a firewall such as ufw can drop.

Proof so far, inside Docker Desktop's Linux VM; the Linux run before handover (see CLAUDE.md) proves it on plain Docker:

```
$ docker run -d --network host python:3.12-alpine python -m http.server 9000 --bind 127.0.0.1
$ docker run --rm --network host curlimages/curl:8.10.1 -sS -i http://localhost:9000/
HTTP/1.0 200 OK
```

## Postgres runs on host networking at 127.0.0.1:54329

Postgres runs with host networking as `postgres -p 54329 -c listen_addresses=127.0.0.1 -c timezone=UTC`. The API and worker connect to `127.0.0.1:54329`, never `localhost`, which can mean ::1 first. The password is in the compose file, since the graders have no `.env` file.

With host networking, Postgres takes a port on the grading machine, and 5432 may be in use there; on the build laptop another project holds 127.0.0.1:5432. Listening on 127.0.0.1 keeps other machines out. `timezone=UTC` makes a created_at with no zone UTC.

Dropped: Postgres on a Compose network with a published port, which has the same clash risk and cannot be found by name from host-network containers.

```
$ psql -h 127.0.0.1 -p 54329 -U postgres -c "select current_setting('port'), current_setting('listen_addresses'), inet_server_addr()"
 54329 | 127.0.0.1 | 127.0.0.1
```

## The test rig runs in host-network containers, from its own compose file

The fake endpoint on 9000, the load generator and the checker are Node containers with host networking, started with `docker compose -f rig/compose.yaml up`. The graders' `docker compose up` in the repo root never starts them. No compose override file is ever committed, since compose loads one on its own.

On Docker Desktop for Windows, localhost does not connect Windows and host-network containers in either direction, while containers inside its Linux VM reach each other, as on a Linux machine.

Dropped: rig services under a profile in the main compose file, which relies on nobody turning the profile on.

```
$ docker run -d --network host python:3.12-alpine python -m http.server 8080
$ curl.exe -sS http://localhost:8080/        (on Windows)
curl: (7) Failed to connect to localhost port 8080 after 2237 ms: Could not connect to server
```

## The relay is written in TypeScript, run by Node.js 24 with no build step

The intake API, the worker and the test rig are TypeScript files that Node.js 24 runs directly. Erasable syntax only: no enums, no namespaces. `tsc --noEmit` with a strict tsconfig is a test step in every unit. `typescript`, `@types/node` and `@types/pg` are dev dependencies only (strict tsc needs pg's types), and `pg` is the one runtime dependency. Node's `http` module serves the API and calls port 9000. The API and the worker are two processes from one image; the worker runs one async loop per user.

TypeScript is what the author wants to be judged in, and types on the contracts (the event row, the send result, the scenario format, the log lines) catch mistakes between parts early.

Dropped: plain JavaScript, which finds those mistakes only at run time; and Go, the first choice.

On `node:24.22.3-alpine3.24`, `node main.ts` ran, `node --test` found `*.test.ts` files, and an enum failed with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.

## Every build input is pinned

Every image has an exact patch tag. Postgres is `postgres:16.16-alpine`, the version the `16-alpine` tag gave on the build laptop (`postgres --version` printed `postgres (PostgreSQL) 16.16`). Node is `node:24.22.3-alpine3.24`, and the dependencies are exact: `pg` 8.23.1, and the dev dependencies `typescript` 7.0.2, `@types/node` 24.19.2 and `@types/pg` 8.23.1. `package-lock.json` is committed and the image build runs `npm ci --omit=dev`, so the graders need nothing but Docker and get the same `pg`. With no build step, one stage is enough.

Dropped: floating tags such as `16-alpine`, which can change between our test and the graders' build.

## Every text file has LF line endings

`.gitattributes` holds `* text=auto eol=lf`. Git on the build laptop has `core.autocrlf=true`, so without it a Windows checkout gets CRLF, and an image built there could differ from the graders' Linux build. Commands that compose and the Dockerfile need are written inline, never as shell scripts.

```
$ git ls-files --eol
i/lf    w/lf    attr/text=auto eol=lf   README.md
i/-text w/-text attr/text=auto eol=lf   Tequity-take-home-Outbox-relay.pdf
```

## One worker process, with delivered_at as the only record of progress

Events go in one table: `event_id` (primary key), `user_id`, `created_at`, `body bytea`, `received_at timestamptz DEFAULT now()`, `seq bigint GENERATED ALWAYS AS IDENTITY` and `delivered_at`. One worker process sends for every user, up to 200 at a time: 200 events a second even at 1-second answers. It polls for users with an event ready, each poll starting 200 ms after the last one finished. A loop starts only if its user is not in the in-memory in-flight set at that moment, so one user never has two loops. Each loop looks up the user's oldest unsent event afresh, sends it, waits for the answer, commits `delivered_at` on a 2xx and moves on.

In-flight users, pauses and retry waits live in memory and need not survive a restart; after one, anything without `delivered_at` is sent again.

Dropped: several worker processes coordinating through locks, which 100 events a second does not need.

## delivered_at is committed before the next send, and never causes a resend

After a 2xx the event is saved. The loop commits its `delivered_at` before sending the user's next event, never in parallel. If they overlapped, a crash after event 2 was sent but before event 1's commit would send event 1 again after event 2: a double save and an order break.

If the write fails, the loop retries only the write until it commits. A database error never causes a resend; only a crash before the commit does.

Dropped: committing while the next event is sent, which would save about 5 ms per event.

## Connection pools are sized by hand

The worker's `pg` Pool has `max: 20` and the API's `max: 30`, 50 of Postgres's 100. Each loop takes a connection for one statement at a time through `pool.query`, never while waiting on port 9000. Calls to 9000 share one `new http.Agent({ keepAlive: true })`, so sends reuse their TCP connections; its defaults already keep up to 256 idle sockets and turn TCP keepalive on.

Dropped: `pg`'s default of 10 connections per pool, too few for 200 user loops.

pgbench (a load tool that ships with Postgres), run on the build laptop's Docker Desktop with 20 connections, did about 3,500 steps a second, 17 times what the outage maths needs. Each step was one `UPDATE ... SET delivered_at` by event_id and one query for a user's next unsent event.

## The design is sized for an endpoint that answers in about 10 ms

A user's events go out one at a time, so a heavy user can go no faster than one event per T = (a + o) ÷ (1 − p) + p × 20 ms. Here a is the endpoint's answer time, o our own time per event, p the share of attempts answered 500, and 20 ms the first retry wait. o is about 5 ms, measured with pgbench on Docker Desktop.

Example: after a 5-minute outage, a user sending 30 a second owes 30 × 600 = 18,000 events (9,000 from the outage, 9,000 arriving after it) within 5 minutes, less up to 5 seconds before recovery is noticed. That allows T of about 16 ms, so with p at 2%, a must be about 10 ms or less.

Dropped: retries starting at 0.5 seconds, which at 2% 500s would need a under 1 ms.

## A user waits while its oldest unsent event is under 1 second old

The worker looks at each user's oldest unsent event by `created_at`, then `seq`. If that event arrived less than 1 second ago, by `received_at` on Postgres's clock, the whole user waits; a later event never goes out while an earlier one is held. The check runs before every send, so an earlier event that turns up mid-loop goes first once its second has passed.

Events can arrive out of created_at order over parallel connections; the hold lets a slightly late one take its place, for 1 of the brief's 30 seconds. One that arrives after a later event was sent still goes out, late, and is logged, since dropping it would break exactly once. It is spotted from the user's last delivered created_at, so a restart can miss one.

Dropped: holding each event on its own arrival time, which can send a later event while an earlier one is held.

## The poll picks ready users fairly, from a partial index

Each poll runs:

```sql
SELECT user_id FROM (
  SELECT DISTINCT ON (user_id) user_id, received_at
  FROM events WHERE delivered_at IS NULL
  ORDER BY user_id, created_at, seq) o
WHERE received_at < now() - interval '1 second' AND user_id <> ALL($1)
ORDER BY received_at LIMIT $2;
```

`$1` holds the users in flight or paused, `$2` the free slots. The hold applies after each user's oldest event is picked, busy users are left out before the limit, and the longest-waiting user goes first. The index `events_pending ON events (user_id, created_at, seq) INCLUDE (received_at) WHERE delivered_at IS NULL` holds unsent rows only.

Dropped: filtering on received_at before the pick. With the oldest event held and the second not, the filter picks the second, which goes out first.

At 30,000 unsent events on Docker Desktop this index-only scan takes 8 ms after a VACUUM, 22 ms before; U7 measures heavier churn.


## created_at stays a string and is cast in SQL

created_at never becomes a JavaScript `Date`, which keeps only milliseconds and would merge events that differ in the 4th to 6th decimal. Intake checks it against an RFC 3339 pattern (`Z`, an offset such as `+05:30`, or no zone), cuts any fraction past 6 decimals with a log line, and passes it as `$1::timestamptz`. Postgres runs with `timezone=UTC`, so no zone means UTC. Ordering stays in SQL, with ties broken by `seq`. A string that fails the pattern or the cast (SQLSTATE class 22, Postgres's data errors) gets a 400.

Dropped: refusing a created_at with no zone, since per-user order needs only one fixed rule and a 400 drops the event; and storing nanoseconds as a number, which needs our own parser.

## Bodies are stored as raw bytes and sent unchanged

Each body is stored as `bytea` exactly as it arrived and posted to port 9000 as those bytes, with `Content-Type: application/json`. Intake parses the JSON once, only to check it and pull out event_id, user_id and created_at.

Dropped: a `jsonb` column, which reorders keys, drops duplicate keys and changes spacing, so the body sent could differ from the one received.

## event_id is the primary key, and a repeat keeps the first body

Intake inserts with `ON CONFLICT (event_id) DO NOTHING`. Two posts of one event, even at the same moment, both get a 200 and leave one row. A repeat with a different body also gets a 200, keeps the first body and is logged, since the brief says a resent event keeps its event_id.

Dropped: a 409 for a different body, which could make the load generator retry forever or count a promised event as refused; and overwriting an unsent body, which makes the body sent depend on timing.

## Intake answers 200 only after the commit

Intake answers 200 only after Postgres has committed the event. It answers 400 to a body that is not a UTF-8 JSON object, lacks a non-empty event_id, user_id or created_at, or has an event_id or user_id over 1,000 bytes or holding a NUL; 413 to a body over 1 MB; and 503 to any database error except a refused created_at cast. Every 400 is logged with its reason; `type` and `data` are not checked. `keepAliveTimeout` is 65 s and `headersTimeout` 66 s, so Node's 5-second default never closes a connection the load generator is reusing.

Those three fields let the relay store each event once and in order. Postgres text cannot hold NUL, and its index refuses keys over about 2.7 KB; either would be a 503 at insert, retried forever.

Dropped: answering 400 to a database error, which blames Tequity's event for our fault.
## Any 2xx means saved, and anything else is retried from 20 ms

Any 2xx means saved. Any other status, a refused connection and a failed connect mean not saved; redirects are not followed. A not-saved event is retried after 20 ms, the wait doubling on each failure in a row up to 5 seconds and going back to 20 ms after a success. A single 500 costs about 20 ms, a long failure backs off to one try every 5 seconds per user, and recovery is noticed within 5 seconds. A 4xx other than 429 is retried too, since skipping the event breaks exactly once.

Dropped: waits starting at 0.5 seconds (see the 10 ms entry), and a slower schedule for refused connections, which on localhost fail at once.

## Each failed attempt is logged, and so is a send over 60 seconds

Each failed attempt is logged at error level with the event_id, the user_id, the status and how many times in a row it has failed. A send in flight over 60 seconds is logged as a warning, and again each minute. At startup the worker logs the unsent count.

An event the endpoint always refuses, or a send that never ends, blocks one user; these lines show which one and why.

Dropped: a status line every minute with backlog figures and a count of stuck users, which protects no pass condition; and stamping `attempt_started_at` before each send to list unknown outcomes after a crash, which pgbench measured at about 1 ms per event.

## A send has no overall time limit

The brief says a slow answer is still coming and a 200 means saved, so a timeout and resend is the one way to save twice on an endpoint that is slow but alive. Sends use `http.request`, never `fetch`, which follows redirects and has a hidden 300-second limit; its `timeout` option stays unused, since it fires during a slow answer. Connecting has no timer: on localhost a connection is accepted or refused at once. An error before the socket connected means not sent; one after it is the brief's "No connection: not saved", and the event is resent.

An endpoint that never answers keeps that one user waiting; the brief's table has no such endpoint.

Dropped: a 60-second timeout, then a 120-second ceiling, each followed by a resend; and a 2-second connect timer, which a reused keep-alive socket never clears, so it would kill slow answers.

## The status line decides, and a connection lost before it means resend

On `http.request`'s `response` event, the status line decides: a 200 means saved, whatever happens to the rest of the answer. Every response, whatever its status, is drained with `res.resume()` so its socket goes back to the Agent, and errors while draining are ignored. A connection lost after the request went out and before a status line is the brief's "No connection: We are down. Not saved.", and the event is sent again. Node never resends on its own.

The endpoint cannot be asked what it saved, so no design tells these cases apart: an endpoint that saves and then cuts the connection gets the event twice.

Dropped: giving up after a lost connection, which loses the event whenever nothing was saved.

## A normal stop gives sends in flight 120 seconds

On SIGTERM the worker stops polling and starting sends, lets every send in flight and its `delivered_at` write finish, closes its Pool and exits. Compose's `stop_grace_period` is 120 seconds. A send cut off by the kill or a crash is sent again on restart and may be saved twice. Each service starts Node with an exec-form `CMD ["node", "worker.js"]` (`api.js` for the API), since Node as process 1 ignores SIGTERM without a handler. The API's handler stops taking posts and lets inserts in progress commit.

The worker exits as soon as its sends finish, so the 120 seconds is spent only on a slow one.

Dropped: 20 seconds, which is a timeout-then-resend for any send slower than that.

## A 429 pauses only the user who got it

On a 429 the worker pauses that user for Retry-After seconds, at least 1 second, which covers a missing, zero or broken header. Other users keep sending. The 429 does not raise the retry wait, and the event goes out again after the pause.

The brief does not say whether the limit is per user or covers the whole endpoint, and a per-user pause works for both: under an endpoint-wide limit, every user that hits it pauses itself and the load drops. Heavy rate limiting would still starve a heavy user, since each 429 costs it at least a second; the README assumes the endpoint rarely rate limits when healthy.

Dropped: pausing everyone, which under a per-user limit stalls every user behind one heavy user's 429s; and halving the users in flight on each 429, a control loop for a case the README assumes away.

## Startup waits for a healthy Postgres, and data lives in a named volume

Postgres has a health check, `pg_isready -h 127.0.0.1 -p 54329`, and the API and worker wait for it with `depends_on: condition: service_healthy`. The tables come from one SQL file in `/docker-entrypoint-initdb.d`, which Postgres runs on an empty data folder only, so a schema change needs `docker compose down -v`. Data lives in the named volume `pgdata:/var/lib/postgresql/data`, with fsync and synchronous_commit on, and survives `down` and `up`. Every service has `restart: unless-stopped`.

Dropped: the image's anonymous volume, which a new container after `down` and `up` replaces with an empty one, losing every unsent event we answered 2xx for.

## A database error or a failed loop never stops a process

`depends_on` only orders `docker compose up`, so after a Postgres restart nothing makes the API or worker wait. Neither ever exits on a database error: both retry the connection at startup, and log and retry errors while running, with intake answering 503 meanwhile. Each user loop runs in a try/catch that logs the error with the user_id and event_id and counts it as a failed attempt. The poll loop and the SIGTERM handler run in try/catch too. Both Pools have an `error` handler, and every request and response keeps an `error` listener for its whole life, since an `error` with no listener crashes Node, even one that comes after the send has settled.

Dropped: exiting and letting Docker restart, which loops while Postgres is down; and leaving any of these unguarded, where one stray error kills the worker and the restart resends every send in flight.
