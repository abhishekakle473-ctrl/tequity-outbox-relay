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

Events go in one `events` table: event_id as the primary key, user_id, created_at, the body as received, an arrival number used to break ties, and `delivered_at`. A single worker process sends for all users. Every 200 ms it asks Postgres which users have an event ready to go (the 1-second hold decides "ready"). It skips users it is already sending for, and starts a loop for each of the others, up to 200 users at a time. A loop sends the user's oldest unsent event, waits for the answer, and on a 2xx sets `delivered_at`, commits and moves on to the next one.

The worker keeps in memory which users are in flight, plus any pause or retry wait. None of that has to survive a restart. After one, anything without `delivered_at` is sent again, and the worst a forgotten wait costs is one extra 500 or 429.

The other option was several worker processes splitting users between them through row locks or leases in Postgres. At 100 events a second one process has plenty of room, and with one there is nothing to coordinate. If it dies, Docker restarts it. The limit of 200 users in flight comes from the per-user maths: even at 1-second answers it gives 200 events a second in total, the rate needed to clear a 5-minute outage.

## 2026-11-18: The endpoint must answer in about 14 ms for the heaviest user to keep up

One user's events go out one at a time. If event 2 went out before event 1 was saved, and event 1 then got a 500, event 2 would be saved first and the order would break. So one user's speed is capped at 1 ÷ (the endpoint's answer time + our time per event). Our time per event is one database commit on localhost, estimated at 2 ms; the test rig will measure it.

| Endpoint answer time | Most events per second for one user |
|---|---|
| 2 ms | 250 |
| 10 ms | about 83 |
| 50 ms | about 19 |
| 200 ms | about 5 |
| 1 s | about 1 |

In normal running, a user sending 30 events a second needs answers in about 31 ms or less, or it falls further behind every second.

After an outage of D seconds, a user sending r events a second needs r × (D + 300) ÷ 300 events a second to clear its backlog and keep up with new events within the 5 minutes the brief allows. After a 5-minute outage that is 2r: 60 a second for a user sending 30, which needs answers in about 14 ms. Across all users it is 60,000 events in 300 seconds, 200 a second, and 200 users in flight cover that even at 1-second answers. The heaviest user is the limit, and the total is not.

No design gets round this. The order rule forces one event at a time per user, and the brief sends one event per request. So the README assumes answers in about 14 ms or less when healthy. Requests over localhost usually take a few ms. If the endpoint rate limits us below 200 a second during recovery, nothing meets the 5 minutes after a 5-minute outage.
