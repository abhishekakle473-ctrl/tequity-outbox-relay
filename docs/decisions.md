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
