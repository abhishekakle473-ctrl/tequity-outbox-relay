# Decisions

One entry per decision, oldest first. Each says what we decided, why, what else we looked at, and the command that showed it works.

## 2026-11-18: The API and worker use host networking

The intake API and the worker run with `network_mode: host`. Inside them, localhost is the grading machine's own localhost. The worker posts to `http://localhost:9000/events` exactly as the brief writes it, and the API listens on the machine's port 8080 directly. Our compose file has no `ports:` sections, since host networking ignores them.

The brief puts Tequity's endpoint at localhost:9000 on the grading machine and says nothing about which address it listens on. A server bound to 127.0.0.1 accepts connections from that machine only, and Python servers such as Flask and uvicorn bind there by default. Host networking reaches such a server, and the machine's firewall never sees the traffic.

The other option was a normal Compose network with `extra_hosts: ["host.docker.internal:host-gateway"]`, posting to `host.docker.internal:9000`. It works on Docker Desktop with no settings. On Linux, though, the traffic comes from a Docker network address, so an endpoint bound to 127.0.0.1 refuses it and a firewall such as Ubuntu's ufw can drop it. That would fail on Tequity's machine, where we can neither see nor fix it. Hard-coding Docker's host address 172.17.0.1 has the same problem and is wrong on Docker Desktop. A setting to switch between the two adds config the graders would never use.

On Docker Desktop for Windows (Docker 28.4.0, host networking enabled in Settings), a host-network container cannot reach a server on Windows' own localhost. The case this decision exists for, a server bound to 127.0.0.1, failed there. It also failed with the server bound to 0.0.0.0:

```
$ python -m http.server 9000 --bind 127.0.0.1        (on Windows; same result with --bind 0.0.0.0)
$ docker run --rm --network host curlimages/curl:8.10.1 -sS -i --max-time 10 http://localhost:9000/
curl: (7) Failed to connect to localhost port 9000 after 0 ms: Could not connect to server
```

Docker Desktop runs containers in a Linux VM, and its host network is that VM's network. Inside the VM, a host-network container reached a server in another host-network container bound to 127.0.0.1:9000:

```
$ docker run -d --name hn-srv9000 --network host python:3.12-alpine python -m http.server 9000 --bind 127.0.0.1
$ docker run --rm --network host curlimages/curl:8.10.1 -sS -i --retry 10 --retry-connrefused --retry-delay 1 --max-time 30 http://localhost:9000/
HTTP/1.0 200 OK
Server: SimpleHTTP/0.6 Python/3.12.16
```

`netstat -tln` in the server container showed `127.0.0.1:9000 ... LISTEN`. The 127.0.0.1 case is still unproven on plain Docker on Linux, which is how Tequity grades. We prove it when the test rig runs on Linux.

## 2026-11-18: Postgres runs on host networking at 127.0.0.1:54329

Postgres also runs with host networking, started as `postgres -p 54329 -c listen_addresses=127.0.0.1`. The API and worker connect to it at localhost:54329.

With host networking, Postgres takes a port on the grading machine itself. The default, 5432, may already be in use there. It is on the laptop this was built on, where another project's Postgres container holds 127.0.0.1:5432. Port 54329 is unlikely to be taken. Listening on 127.0.0.1 keeps Postgres out of reach of other machines. If 54329 is taken after all, Postgres fails to start and `docker compose up` shows the error.

Keeping Postgres on a normal Compose network and publishing a port has the same clash risk on that port, and the host-network API and worker cannot find it by service name anyway.

Inside Docker Desktop's Linux VM, a second host-network container connected to it:

```
$ docker run -d --name hn-pg --network host -e POSTGRES_PASSWORD=check postgres:16-alpine -p 54329 -c listen_addresses=127.0.0.1
$ docker run --rm --network host -e PGPASSWORD=check postgres:16-alpine sh -c "until pg_isready -q -h 127.0.0.1 -p 54329; do sleep 1; done; psql -h 127.0.0.1 -p 54329 -U postgres -c \"select current_setting('port') as port, current_setting('listen_addresses') as listen, inet_server_addr() as connected_to\""
 port  |  listen   | connected_to
-------+-----------+--------------
 54329 | 127.0.0.1 | 127.0.0.1
(1 row)
```

`netstat -tln` showed `127.0.0.1:54329 ... LISTEN` next to the other project's `127.0.0.1:5432 ... LISTEN`.

## 2026-11-18: The test rig runs in host-network containers

The test rig, meaning a fake endpoint on port 9000, a load generator and a checker, runs as containers with host networking. None of it runs as a program on Windows.

On Docker Desktop for Windows, localhost does not connect Windows and host-network containers in either direction. A host-network container cannot reach a Windows server on localhost (first entry above), and Windows cannot reach a host-network container's port:

```
$ docker run -d --name hn-srv8080 --network host python:3.12-alpine python -m http.server 8080
$ curl.exe -sS -i --max-time 10 http://localhost:8080/        (on Windows)
curl: (7) Failed to connect to localhost port 8080 after 2237 ms: Could not connect to server
```

Docker Desktop runs containers in a Linux VM, and host-network containers inside that VM reach each other on localhost (the 127.0.0.1:9000 test in the first entry). That matches the grading machine, where Tequity's endpoint and load generator talk to us over the machine's own localhost. On Linux, the same rig runs unchanged.

## 2026-11-18: The relay is written in Go, on Postgres 16

The intake API, the worker and the test rig are written in Go. Postgres is version 16, with the image tag pinned.

The worker runs one goroutine (a cheap parallel task in Go) per user it is sending for, which fits the one-event-at-a-time-per-user rule. Go's standard library has an HTTP server and an HTTP client with exact control over timeouts, and timeouts decide when a send's outcome is unknown. The build is one binary with no runtime to install in the image.

Python with asyncio was the close second: less code, fast enough for 100 events a second, but more packages to pin. Node is much like Python. Java and Kotlin bring bigger images and slower starts for no gain here. Postgres 16 is the version the host networking checks ran on.

## 2026-11-18: One worker process, with delivered_at as the only record of progress

Events go in one `events` table: event_id as the primary key, user_id, created_at, the body as received, `received_at timestamptz NOT NULL DEFAULT now()` (when the event arrived, by Postgres's clock), `seq bigint GENERATED ALWAYS AS IDENTITY` (an arrival number used to break ties), and `delivered_at`. A single worker process sends for all users. Every 200 ms it asks Postgres which users have an event ready to go (the 1-second hold decides "ready"). It skips users it is already sending for, and starts a loop for each of the others, up to 200 users at a time. A loop sends the user's oldest unsent event, waits for the answer, and on a 2xx sets `delivered_at`, commits and moves on to the next one.

After a 2xx the event is saved, whatever happens next on our side. If the `UPDATE ... SET delivered_at` fails, the loop retries only that UPDATE until it commits, and never sends the event again because of a database error. The user's loop waits until the commit goes through. Only a crash before that commit leads to a resend. (Added 2026-11-19 after review.)

Connection pools are set by hand, since Go's defaults do not fit. Go's database pool has no limit by default, and Postgres allows 100 connections, so 200 user loops could take them all and leave intake unable to commit. The worker's pool is capped at 20 connections and the API's at 30, 50 in all. Each user loop holds a connection only for one statement at a time. pgbench with 20 connections ran about 3,460 worker steps a second (mark delivered, then look up the next event), 17 times the 200 a second the outage maths needs. Go's HTTP client keeps only 2 idle connections per host by default, so most of 200 sends at once would open a new TCP connection each time; the worker sets `MaxIdleConnsPerHost` to 200. (Added 2026-11-19 after review.)

The worker keeps in memory which users are in flight, plus any pause or retry wait. None of that has to survive a restart. After one, anything without `delivered_at` is sent again, and the worst a forgotten wait costs is one extra 500 or 429.

The other option was several worker processes splitting users between them through row locks or leases in Postgres. At 100 events a second one process has plenty of room, and with one there is nothing to coordinate. If it dies, Docker restarts it. The limit of 200 users in flight comes from the per-user maths: even at 1-second answers it gives 200 events a second in total, the rate needed to clear a 5-minute outage.

## 2026-11-18: The endpoint must answer in about 10 ms for the heaviest user to keep up

Changed 2026-11-19 after review. The first version said 14 ms. It left out the waits before retries and guessed our own time per event at 2 ms; the measured figure is about 5 ms.

One user's events go out one at a time. If event 2 went out before event 1 was saved, and event 1 then got a 500, event 2 would be saved first and the order would break. So one user's speed is capped by the time one event takes from start to finish.

That time has three parts: the endpoint's answer time, a; our own time per event, o, which is marking the event delivered (a durable commit) and looking up the user's next event; and the retries. When a share p of attempts get a 500, each failure costs another attempt plus the wait before it, and the first retry waits 20 ms (see the retry entry). On average one event takes

T = (a + o) ÷ (1 − p) + p × 20 ms

The second retry, at 40 ms, comes up for a share p × p of events, small enough to leave out below 10%.

We measured o on Docker Desktop on Windows with pgbench (a load tool that ships with Postgres). It ran the worker's statements over TCP against a host-network Postgres at 127.0.0.1:54329 holding 30,000 unsent events, with the index from the poll entry:

```
$ docker exec hn-pg pgbench -h 127.0.0.1 -p 54329 -U postgres -n -r -c 20 -j 20 -T 20 -f /tmp/step.sql postgres
  4.210  UPDATE events SET delivered_at = now() WHERE event_id = 'e' || :s;
  0.513  SELECT seq, received_at FROM events WHERE user_id = 'u' || :u AND delivered_at IS NULL ORDER BY created_at, seq LIMIT 1;
```

With one connection the same two statements took 2.958 ms and 0.599 ms. So o is about 3.6 ms with one connection and 4.7 ms with 20 at once, and the maths uses 5 ms. The figures for Linux come from the test rig.

After an outage of D seconds, a user sending r events a second owes r × (D + 300) events by 5 minutes after recovery: its backlog plus what it sends in those 5 minutes. Retries are capped at 5 seconds, so the worker can notice recovery up to 5 seconds late, which leaves 295 seconds. For the heaviest user, taken as 30 a second, after a 5-minute outage that is 30 × 600 = 18,000 events in 295 seconds: 61 a second, so T must be 16.4 ms or less. These are the slowest endpoint answer times that still meet it, with o = 5 ms:

| Share of attempts answered 500 | First retry after 0.5 s (old) | First retry after 20 ms (now) |
|---|---|---|
| 0% | 11.4 ms | 11.4 ms |
| 2% | under 1 ms | 10.7 ms |
| 10% | none | 8.0 ms |

With the old waits, a 14 ms endpoint and 2% 500s give T of about 29.8 ms, and the heaviest user clears about 9,900 of its 18,000 events in time. With the 20 ms waits, T is about 19.8 ms and it clears about 14,900, still short. At 10 ms and 2%, T is about 15.7 ms and it clears all of them.

In normal running, a user sending 30 a second needs T of 33.3 ms or less, which allows answers up to about 27 ms at 2% 500s.

Across all users, a 5-minute outage means 60,000 events in 295 seconds, about 203 a second, and 200 users in flight cover that even at 1-second answers. The heaviest user is the limit, and the total is not.

No design gets round this. The order rule forces one event at a time per user, and the brief sends one event per request. So the README assumes answers in about 10 ms or less when healthy, with 500s on at most a few percent of requests. Requests over localhost usually take a few ms. If the endpoint rate limits us below about 200 a second during recovery, nothing meets the 5 minutes after a 5-minute outage.

## 2026-11-18: A user waits while its oldest unsent event is under 1 second old

The worker looks at each user's oldest unsent event by created_at. If that event arrived less than 1 second ago, the whole user waits. No later event of that user goes out while an earlier one is still inside its hold. The same check runs before every send in a user's loop, so an earlier event that arrives mid-loop stops the loop until its second has passed, and then goes out first.

"Arrived" means `received_at`, set by Postgres's clock when intake inserts the row. created_at is the load generator's clock and only decides order. The hold is applied after picking each user's oldest unsent event, never in a WHERE before the pick. Filtering first would skip a user's held oldest event and pick their second one, which is the order bug described below. The poll query:

```sql
SELECT user_id FROM (
  SELECT DISTINCT ON (user_id) user_id, received_at
  FROM events WHERE delivered_at IS NULL
  ORDER BY user_id, created_at, seq) o
WHERE received_at < now() - interval '1 second' AND user_id <> ALL($1);
```

`$1` is the list of users the worker is already sending for. (Added 2026-11-19 after review: the first version named no arrival time.)

Events can reach us out of created_at order, for example over parallel connections. The hold lets a slightly late earlier event take its place, and costs 1 of the 30 seconds the brief allows.

The first version of this choice held each event on its own arrival time. That had an order bug: a later event could go out while an earlier one was still held. The hold now applies to the user, keyed on its oldest unsent event.

Sending at once, with no hold, was the other option. It sends a slightly late earlier event after a later one. An earlier event that arrives after a later one has already been sent still goes out once its second has passed, and the worker logs it. It is out of order, but sent: dropping it would break exactly once.

## 2026-11-18: created_at is a Postgres timestamp, with ties broken by arrival order

created_at is parsed and stored as a Postgres `timestamptz`, which keeps microseconds. The brief's example has 3 decimal places, and the README assumes at most 6. If finer digits ever round two events of one user to the same value, they go out in the order they reached us. There is no unique rule on (user_id, created_at), so a tie can never cause an event to be refused.

The other option was storing created_at as a number of nanoseconds, which needs our own parsing code for a case the brief's example does not suggest.

## 2026-11-18: Bodies are stored as raw bytes and sent unchanged

The body of each post is stored as `bytea` (raw bytes), exactly as it arrived, and the worker posts those bytes with `Content-Type: application/json`. Intake still parses the JSON once, to check it and to pull out event_id, user_id and created_at into their own columns.

The other option was a `jsonb` column (Postgres's parsed JSON type) and sending what Postgres gives back. jsonb reorders keys, drops duplicate keys and changes spacing, so the body sent could differ from the one received, and the brief asks for the same body.

## 2026-11-18: event_id is the primary key, and repeats are skipped

event_id is the primary key of the events table, and intake inserts with `ON CONFLICT (event_id) DO NOTHING`. Two posts of the same event, even at the same moment on separate connections, both get a 200, and Postgres makes sure only one row exists. The brief says Tequity may send the same event more than once with the same event_id, so a repeat is normal and gets the same answer as the first.

## 2026-11-18: The first body stands when an event_id comes back different

When a post repeats an event_id we already have but carries a different body, we keep the first body, answer 200 and log it. The brief says a resent event keeps the same event_id, so we treat the post as a resend.

A 409 (a "conflict" error) was the other option. It might make Tequity's load generator retry forever, or count an event we already promised to deliver as refused. Overwriting an unsent event with the new body was the third, but it means the body sent depends on timing.

## 2026-11-18: Intake answers 200 after the commit, and 400 to events we could not send

Intake answers 200 only after Postgres has committed the event. It answers 400 when the body is not a JSON object, or when event_id, user_id or created_at is missing, empty or unreadable, and 413 ("too large") when the body is over 1 MB. It does not check `type` or `data`; they pass through to the endpoint as they came.

Those three fields are the ones the relay needs: event_id to store each event once, user_id and created_at to send in order. A 2xx for an event we cannot send would break the brief's promise that a 2xx reaches the endpoint. A 400 makes no promise, so it cannot break exactly once.

## 2026-11-18: Any 2xx means saved, and anything else means not saved and retried

The brief's table covers 200, 500, 429, no connection and slow. For everything else: any 2xx means saved. Any 5xx, any 3xx and any 4xx other than 429 mean not saved, and redirects are not followed. A refused connection or a failed connect means the request was never sent, so not saved. A connection lost after the request went out is the unknown case, covered in its own entry, and 429 has its own entry too.

A not-saved event is retried after 20 ms, and the wait doubles on each failure in a row (40, 80, 160 ms and so on) up to 5 seconds. It goes back to 20 ms after a success. A single 500 then costs about 20 ms, and a long failure backs off to one try every 5 seconds per user within about 10 seconds. With that cap the worker notices recovery within about 5 seconds, well inside the 5 minutes the brief allows. A refused connection follows the same schedule: on localhost it costs well under 1 ms, so a 20 ms start is as cheap there as for a 500.

Changed 2026-11-19 after review. The first version started at 0.5 seconds. With 2% of attempts answered 500, those waits alone made the heaviest user too slow to clear a 5-minute outage; the numbers are in the 10 ms entry.

A 4xx other than 429 most likely means a bug of ours. Retrying it can hold up that user, and skipping the event breaks exactly once, so the worker keeps retrying and logs it loudly.

## 2026-11-18: No overall timeout on a send; only a lost connection is resent

A send has no overall timeout. The brief says a slow answer is still coming and a 200 at the end means saved. A timeout followed by a resend is the one way we would save an event twice on an endpoint that is slow but alive, so we always wait for the answer.

The connect step has a 2-second timeout. A refused or failed connect means the request was never sent, so the event is not saved and is retried. TCP keepalive (the system sending small probes on an idle connection to check its other end is still there) is on: probes start after 10 seconds of silence, repeat every 5 seconds, and the connection fails after 3 missed probes. Keepalive catches a connection whose other end has vanished without closing it. An endpoint that is alive but slow still answers the probes, so its request keeps waiting.

On localhost the endpoint's own kernel answers keepalive probes, so an endpoint that holds a connection open and never answers keeps that send, and its user, waiting for good. We accept that. A ceiling followed by a resend is the timeout-then-resend this entry rules out, and the brief's table has no endpoint that never answers: a slow answer "is still coming". Only that one user waits; the other send slots carry on. To make such a send visible, the worker logs a warning with the event_id and user_id for any send in flight over 60 seconds, and again each further minute. (Added 2026-11-19 after review, which proposed a 120-second ceiling.)

The outcome is decided by the status line alone. Once a status line has come back, a 200 means saved, and any error in the rest of the answer, while it comes in or is drained, is ignored; the body is drained only so the connection can be used again. A 200 followed by a cut body must never count as unknown, or the event would be resent and saved twice. (Added 2026-11-19 after review.)

A connection that fails or closes after the request went out, before a status line comes back, is the unknown case. We send the event again. The most likely cause is the endpoint dying mid-request, and that most likely saved nothing. Giving up was the other option, and it is wrong whenever nothing was saved. The HTTP client must never resend a POST on its own: Go's client only retries a POST when nothing at all was written, which is safe.

The first version of this choice had a 60-second timeout and resent after it. It was dropped for the reason in the first paragraph.

## 2026-11-18: A normal stop gives in-progress sends 120 seconds

Changed 2026-11-19 after review. The first version gave 20 seconds.

When the worker gets SIGTERM, it starts no new sends and waits for the ones in progress, then exits as soon as the last one has its answer and its `delivered_at` write. Compose's `stop_grace_period` for the worker is 120 seconds; after that the worker is killed. Any send cut off, by that kill or by a crash, has no `delivered_at`, so it is sent again on restart and may be saved twice. A 200 that arrives just before a crash, ahead of the commit of `delivered_at`, has the same result.

A short grace period is a timeout-then-resend in another form: a slow send killed at the deadline is resent on restart, which is the double save the no-timeout entry rules out. With 120 seconds, only a send slower than two minutes is cut off. The worker exits as soon as its sends finish, so the full 120 seconds is spent only when a send is that slow, and then a slow stop is the price of avoiding a double save.

Two things in the Go code and image make this work. The HTTP call and the `delivered_at` write run on a context that SIGTERM does not cancel (`context.WithoutCancel`), so the stop signal cannot abort the send we are waiting for or the write after it. And the image starts the binary with an exec-form `ENTRYPOINT ["/relay", ...]`, so SIGTERM reaches Go at all; with the shell form, `/bin/sh` is process 1 and does not pass the signal on.

The review also proposed stamping `attempt_started_at` on each event before sending it, so that a restart could log every event whose outcome is unknown. We left that out. pgbench measured the stamp, even with a non-durable commit, at about 1.0 to 1.2 ms per event: BEGIN, SET LOCAL synchronous_commit = off, UPDATE and COMMIT. That would raise our time per event from about 5 ms to 6 ms and lower the endpoint speed the heaviest user needs from about 10.7 ms to about 9.7 ms (see the 10 ms entry), all for a log line after a crash. At startup the worker logs how many events are unsent instead.

The earlier plans were 70 seconds, sized to a 60-second request timeout that no longer exists, and then 20 seconds, sized to the brief's 30-second window. The 20 seconds was dropped for the reason above.

## 2026-11-18: A 429 pauses all sending for Retry-After

On any 429 the worker starts no new sends to the endpoint, for any user, until Retry-After seconds have passed. The pause is at least 1 second: a missing header, one that is not a whole number, and `Retry-After: 0` all give 1 second, so a 429 can never cause a tight loop. A 429 does not raise the retry wait from the retry entry; the Retry-After pause is the whole of its delay. (Added 2026-11-19 after review.) Sends already in progress carry on. A later 429 during a pause moves its end to whichever end is later. The event that got the 429 was not saved and goes out again after the pause.

The brief lists rate limiting next to down and slow, as a state of the endpoint, and nothing in it says the limit is per user. Pausing only the user who got the 429 would leave every other user firing into the limit. Light users waiting a few seconds is fine against the 30 seconds the brief allows.

## 2026-11-18: The API and worker start once Postgres is healthy

Postgres has a health check, `pg_isready -h 127.0.0.1 -p 54329`, and the API and worker wait for it with `depends_on: condition: service_healthy`. The tables come from one SQL file that Postgres runs on its first start, from `/docker-entrypoint-initdb.d`, so there is no migration tool. Every service has `restart: unless-stopped`.

Postgres keeps its data in a named volume, `pgdata:/var/lib/postgresql/data`, and fsync and synchronous_commit stay at their defaults (on). Without a named volume, the postgres image's own volume is anonymous: after `docker compose down` and `up` the new container gets a new, empty one, and every unsent event we answered 2xx for is gone. Only `docker compose down -v` deletes the named volume. The init SQL runs only on an empty data folder, so a change to the schema needs `down -v` to take effect. (Added 2026-11-19 after review.)

`docker compose up` starts containers in parallel, and Tequity's load generator could post before Postgres or the API is ready. The README assumes Tequity starts sending once our services show as running. A post refused in the first few seconds got no 2xx, so it carries no promise.
