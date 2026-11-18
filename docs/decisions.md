# Decisions

One entry per design choice, each as it stands now: what, why, the option dropped, and the command that proved it, if any. Git history shows how each one changed. Assumptions about Tequity's side are in README.md.

## 2026-11-18: The API and worker use host networking

The intake API and the worker run with `network_mode: host`, so localhost inside them is the grading machine's own. The worker posts to `http://localhost:9000/events` as the brief writes it, and Node's `autoSelectFamily` tries both ::1 and 127.0.0.1. The API listens on `:8080`, every address.

The brief does not say which address Tequity's endpoint listens on. Host networking reaches one bound to 127.0.0.1 only, and no firewall sees the traffic.

Dropped: a Compose network with `host.docker.internal:host-gateway`. On Linux its traffic comes from a Docker address, which a 127.0.0.1-bound endpoint refuses and a firewall such as ufw can drop.

Proof so far, inside Docker Desktop's Linux VM; the Linux run before handover proves it on plain Docker:

```
$ docker run -d --network host python:3.12-alpine python -m http.server 9000 --bind 127.0.0.1
$ docker run --rm --network host curlimages/curl:8.10.1 -sS -i http://localhost:9000/
HTTP/1.0 200 OK
```

## 2026-11-19: Postgres runs on host networking at 127.0.0.1:54329

Postgres runs with host networking as `postgres -p 54329 -c listen_addresses=127.0.0.1 -c timezone=UTC`. The API and worker connect to `127.0.0.1:54329`, never `localhost`, which can mean ::1 first. The password is in the compose file, since the graders have no `.env` file.

With host networking, Postgres takes a port on the grading machine, and 5432 may be in use there; on the build laptop another project holds 127.0.0.1:5432. Listening on 127.0.0.1 keeps other machines out. `timezone=UTC` makes a created_at with no zone UTC.

Dropped: Postgres on a Compose network with a published port, which has the same clash risk and cannot be found by name from host-network containers.

```
$ psql -h 127.0.0.1 -p 54329 -U postgres -c "select current_setting('port'), current_setting('listen_addresses'), inet_server_addr()"
 54329 | 127.0.0.1 | 127.0.0.1
```

## 2026-11-19: The test rig runs in host-network containers, from its own compose file

The fake endpoint on 9000, the load generator and the checker are Node containers with host networking, started with `docker compose -f rig/compose.yaml up`. The graders' `docker compose up` in the repo root never starts them. No compose override file is ever committed, since compose loads one on its own.

On Docker Desktop for Windows, localhost does not connect Windows and host-network containers in either direction, while containers inside its Linux VM reach each other, as on a Linux machine.

Dropped: rig services under a profile in the main compose file, which relies on nobody turning the profile on.

```
$ docker run -d --network host python:3.12-alpine python -m http.server 8080
$ curl.exe -sS http://localhost:8080/        (on Windows)
curl: (7) Failed to connect to localhost port 8080 after 2237 ms: Could not connect to server
```

## 2026-11-19: The relay is written in Node.js 24, on Postgres 16

The intake API, the worker and the test rig are plain JavaScript on Node.js 24 LTS, with no build step. Node's `http` module serves the API and makes the calls to port 9000, and `pg` is the only dependency. The API and the worker are two processes, one image run as two compose services, so a busy worker never slows intake. The worker runs one async loop per user it is sending for.

Node is the stack the owner works in and wants to be judged on, and the brief allows any language. 100 events a second is light work for Node, whose job here is waiting on Postgres and on port 9000.

Dropped: Go, picked earlier without asking the owner.

## 2026-11-19: Every build input is pinned

Every image has an exact patch tag. Postgres is `postgres:16.16-alpine`, the version the `16-alpine` tag gave on the build laptop (`postgres --version` printed `postgres (PostgreSQL) 16.16`). Node gets an exact Node 24 tag when the Dockerfile is written. `package-lock.json` is committed and the image build runs `npm ci --omit=dev`, so the graders need nothing but Docker and get the same `pg`. With no build step, one stage is enough.

Dropped: floating tags such as `16-alpine`, which can change between our test and the graders' build.

## 2026-11-19: Every text file has LF line endings

`.gitattributes` holds `* text=auto eol=lf`. Git on the build laptop has `core.autocrlf=true`, so without it a Windows checkout gets CRLF, and an image built there could differ from the graders' Linux build. The repo has no shell scripts beyond what compose and the Dockerfile hold inline.

Dropped: relying on each machine's git settings.

```
$ git ls-files --eol
i/lf    w/lf    attr/text=auto eol=lf   README.md
i/-text w/-text attr/text=auto eol=lf   Tequity-take-home-Outbox-relay.pdf
```

## 2026-11-19: One worker process, with delivered_at as the only record of progress

Events go in one table: `event_id` (primary key), `user_id`, `created_at`, `body bytea`, `received_at timestamptz DEFAULT now()`, `seq bigint GENERATED ALWAYS AS IDENTITY` and `delivered_at`. One worker process sends for every user, up to 200 at a time. Every 200 ms it polls for users with an event ready and runs a loop for each: send the oldest unsent event, wait for the answer, on a 2xx commit `delivered_at`, move on.

Which users are in flight, paused or waiting to retry is kept in memory, since none of it has to survive a restart. After one, anything without `delivered_at` is sent again.

200 slots give 200 events a second even at 1-second answers, the rate a 5-minute outage needs.

Dropped: several worker processes sharing users through locks, coordination that 100 events a second does not need.

## 2026-11-19: delivered_at is committed before the next send, and never causes a resend

After a 2xx the event is saved. The loop commits its `delivered_at` before sending the user's next event, never in parallel. If they overlapped, a crash after event 2 was sent but before event 1's commit would send event 1 again after event 2: a double save and an order break.

If the write fails, the loop retries only the write until it commits. A database error never causes a resend; only a crash before the commit does.

Dropped: committing while the next event is sent, which would save about 5 ms per event.

## 2026-11-19: Connection pools are sized by hand

The worker's `pg` Pool has `max: 20` and the API's `max: 30`, 50 of Postgres's 100. `pg` defaults to 10, too few for 200 user loops. Each loop takes a connection for one statement at a time through `pool.query`, never while waiting on port 9000. Calls to 9000 share one `http.Agent` with `keepAlive: true` and `maxFreeSockets: 200`, so sends reuse their TCP connections.

Dropped: one large pool for both processes, where a busy worker could starve intake.

pgbench (a load tool that ships with Postgres) with 20 connections ran about 3,460 worker steps a second, 17 times what the outage maths needs:

```
$ pgbench -h 127.0.0.1 -p 54329 -U postgres -n -r -c 20 -j 20 -T 20 -f step.sql postgres
tps = 3460.405120
```

## 2026-11-19: The design is sized for an endpoint that answers in about 10 ms

One user's events go out one at a time, so one event takes T = (a + o) ÷ (1 − p) + p × 20 ms, where a is the endpoint's answer time, o our own time per event, p the share of attempts answered 500 and 20 ms the first retry wait.

After a 5-minute outage, a user sending 30 a second owes 18,000 events within 5 minutes of recovery. Noticing recovery can take 5 seconds, so 295 seconds remain and T must be at most 16.4 ms. With o = 5 ms, a must be at most 11.4 ms with no 500s, 10.7 ms at 2% and 8.0 ms at 10%.

Dropped: retries starting at 0.5 seconds, which at 2% 500s need an endpoint faster than 1 ms.

pgbench with 20 connections measured o: 4.2 ms to commit `delivered_at`, 0.5 ms to find the next event.

## 2026-11-19: A user waits while its oldest unsent event is under 1 second old

The worker looks at each user's oldest unsent event by `created_at`, then `seq`. If that event arrived less than 1 second ago, by `received_at` on Postgres's clock, the whole user waits; a later event never goes out while an earlier one is held. The check runs before every send, so an earlier event that turns up mid-loop goes first once its second has passed.

Events can reach us out of created_at order over parallel connections. The hold lets a slightly late one take its place, for 1 of the brief's 30 seconds. One that arrives after a later event was sent still goes out, late, and is logged, since dropping it would break exactly once.

Dropped: holding each event on its own arrival time, which can send a later event while an earlier one is held.

## 2026-11-19: The poll picks ready users fairly, from a partial index

Every 200 ms the worker runs:

```sql
SELECT user_id FROM (
  SELECT DISTINCT ON (user_id) user_id, received_at
  FROM events WHERE delivered_at IS NULL
  ORDER BY user_id, created_at, seq) o
WHERE received_at < now() - interval '1 second' AND user_id <> ALL($1)
ORDER BY received_at LIMIT $2;
```

`$1` holds the users in flight or paused, `$2` the free slots. The hold applies after each user's oldest event is picked, busy users are left out before the limit, and the longest-waiting user goes first. The index `events_pending ON events (user_id, created_at, seq) INCLUDE (received_at) WHERE delivered_at IS NULL` holds unsent rows only.

Dropped: filtering on received_at before the pick, which skips a held oldest event.

`EXPLAIN ANALYZE` with 1,000 unsent events: Index Only Scan using events_pending, Heap Fetches: 0, 1.758 ms.

## 2026-11-19: created_at stays a string and is cast in SQL

created_at never becomes a JavaScript `Date`, which keeps only milliseconds and would merge events that differ in the 4th to 6th decimal. Intake checks it against an RFC 3339 pattern (`Z`, an offset such as `+05:30`, or no zone), cuts any fraction past 6 decimals with a log line, and passes it as `$1::timestamptz`. Postgres runs with `timezone=UTC`, so no zone means UTC. Ordering stays in SQL, with ties broken by `seq`. A string that fails the pattern or the cast (SQLSTATE class 22, Postgres's data errors) gets a 400.

Dropped: refusing a created_at with no zone, since per-user order needs only one fixed rule and a 400 drops the event; and storing nanoseconds as a number, which needs our own parser.

## 2026-11-18: Bodies are stored as raw bytes and sent unchanged

Each body is stored as `bytea` exactly as it arrived and posted to port 9000 as those bytes, with `Content-Type: application/json`. Intake parses the JSON once, only to check it and pull out event_id, user_id and created_at.

Dropped: a `jsonb` column, which reorders keys, drops duplicate keys and changes spacing, so the body sent could differ from the one received.

## 2026-11-19: event_id is the primary key, and a repeat keeps the first body

Intake inserts with `ON CONFLICT (event_id) DO NOTHING`. Two posts of one event, even at the same moment, both get a 200 and leave one row. A repeat with a different body also gets a 200, keeps the first body and is logged, since the brief says a resent event keeps its event_id.

Dropped: a 409 for a different body, which could make the load generator retry forever or count a promised event as refused; and overwriting an unsent body, which makes the body sent depend on timing.

## 2026-11-19: Intake answers 200 only after the commit

Intake answers 200 only after Postgres has committed the event. It answers 400 to a body that is not a JSON object or lacks a non-empty event_id, user_id or created_at, 413 to a body over 1 MB, and 503 to any database error except a refused created_at cast. `type` and `data` pass through unchecked. Every 400 is logged with its reason.

The relay needs those three fields to store each event once and send it in order. A 2xx promises delivery; a 400 or 503 promises nothing, so neither can break exactly once.

Dropped: answering 400 to a database error, which blames Tequity's event for our fault.

## 2026-11-19: Any 2xx means saved, and anything else is retried from 20 ms

Any 2xx means saved. Any other status, a refused connection and a failed connect mean not saved; redirects are not followed. A not-saved event is retried after 20 ms, the wait doubling on each failure in a row up to 5 seconds and going back to 20 ms after a success. A single 500 costs about 20 ms, a long failure backs off to one try every 5 seconds per user, and recovery is noticed within 5 seconds. A 4xx other than 429 is retried too, since skipping the event breaks exactly once.

Dropped: waits starting at 0.5 seconds (see the 10 ms entry), and a slower schedule for refused connections, which on localhost cost under 1 ms.

## 2026-11-19: Failures are logged loudly, with a status line every minute

Each failed attempt is logged at error level with the event_id, the user_id, the status and how many times in a row it has failed. A send in flight over 60 seconds is logged as a warning, and again each minute. Once a minute the worker prints the unsent count, the oldest unsent event's age, the longest send in flight and the number of users stuck on 10 or more failures in a row. At startup it logs the unsent count.

An event the endpoint always refuses, or a send that never ends, blocks one user; both show up here without searching the logs.

Dropped: stamping `attempt_started_at` before each send to list unknown outcomes after a crash. pgbench measured it at about 1 ms per event.

## 2026-11-19: A send has no overall time limit

The worker waits for every answer. The brief says a slow answer is still coming and a 200 means saved, so a timeout and resend is the one way to save twice on an endpoint that is slow but alive. Sends use `http.request`, never `fetch`, which follows redirects and has a hidden 300-second limit. Its `timeout` option stays unused, since it fires during a slow answer. Connecting has no timer either, since on localhost a connection is accepted or refused at once. An error before the socket connected means not sent; after it, the outcome is unknown. `socket.setKeepAlive(true, 10000)` is on as a backstop, with Linux's own probe interval and count.

An endpoint that holds a connection and never answers keeps that one user waiting. The brief's table has no such endpoint.

Dropped: a 60-second timeout, then a 120-second ceiling, each followed by a resend; and a 2-second connect timer cleared on the `connect` event, which a reused keep-alive socket never fires, so the timer would kill a slow answer there.

## 2026-11-19: The status line decides, and a connection lost before it means resend

On `http.request`'s `response` event, the status line decides: a 200 means saved, whatever happens to the rest of the answer, which is drained with `res.resume()` and its errors ignored. A connection lost after the request went out and before a status line is the brief's "No connection: We are down. Not saved.", and the event is sent again. Node never resends on its own.

The endpoint cannot be asked what it saved, so no design tells these cases apart: an endpoint that saves and then cuts the connection gets the event twice.

Dropped: giving up after a lost connection, which loses the event whenever nothing was saved.

## 2026-11-19: A normal stop gives sends in flight 120 seconds

On SIGTERM the worker stops polling and starting sends, lets every send in flight and its `delivered_at` write finish, closes its Pool and exits. Compose's `stop_grace_period` is 120 seconds. A send cut off by the kill or a crash is sent again on restart and may be saved twice. Each service starts Node with an exec-form `CMD ["node", "worker.js"]` (`api.js` for the API), since Node as process 1 ignores SIGTERM without a handler. The API's handler stops taking posts and lets inserts in progress commit.

A short grace period is a timeout-then-resend for slow sends. The worker exits as soon as its sends finish, so the 120 seconds is spent only on a slow one.

Dropped: 20 seconds.

## 2026-11-19: A 429 pauses only the user who got it

On a 429 the worker pauses that user for Retry-After seconds, at least 1 second, which also covers a missing header, a value that is not a whole number and `Retry-After: 0`. Other users keep sending. The 429 does not raise the retry wait, and the event goes out again after the pause.

The brief does not say whether the limit is per user or covers the whole endpoint, and a per-user pause works for both. Under an endpoint-wide limit, every user that hits it pauses itself and the load drops, at the cost of a few extra 429s.

Dropped: pausing everyone, which under a per-user limit would stall every user behind one heavy user's 429s, past the 30 seconds.

## 2026-11-19: Startup waits for a healthy Postgres, and data lives in a named volume

Postgres has a health check, `pg_isready -h 127.0.0.1 -p 54329`, and the API and worker wait for it with `depends_on: condition: service_healthy`. The tables come from one SQL file in `/docker-entrypoint-initdb.d`, which Postgres runs on an empty data folder only, so a schema change needs `docker compose down -v`. Data lives in the named volume `pgdata:/var/lib/postgresql/data`, with fsync and synchronous_commit on, and survives `down` and `up`. Every service has `restart: unless-stopped`.

Dropped: the image's anonymous volume, which a new container after `down` and `up` replaces with an empty one, losing every unsent event we answered 2xx for; and a migration tool, which one SQL file does not need.

## 2026-11-19: A database error or a failed loop never stops a process

`depends_on` only orders `docker compose up`, so after a Postgres restart nothing makes the API or worker wait. Neither ever exits on a database error: both retry the connection at startup, and log and retry errors while running, with intake answering 503 meanwhile. Each user loop runs in a try/catch that logs the error with the user_id and event_id and counts it as a failed attempt. Both Pools have an `error` handler, since an error on an idle connection without one crashes Node.

Dropped: exiting and letting Docker restart, which loops while Postgres is down; and loops with no try/catch, where one user's unhandled rejection kills the worker and the restart hits the same row again.

## 2026-11-19: Before handover, a fresh clone runs on Linux

Before handover the repo runs the way the graders run it, on Linux with plain Docker Engine: `git clone`, `docker compose up`, then the rig from `rig/compose.yaml`. That run proves host networking reaches an endpoint bound to 127.0.0.1, and the README records its commands and output.

Docker Desktop on Windows hides differences in file modes, line endings and file name case, runs host networking inside a VM and never runs a firewall.

Dropped: handing over after testing on Docker Desktop alone. A GitHub Actions Ubuntu runner is one way to get a Linux machine; it needs the repo on GitHub, which is decided then.
