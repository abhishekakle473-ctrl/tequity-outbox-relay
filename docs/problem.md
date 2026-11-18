# The problem

This file states the problem set by Tequity's brief (Tequity-take-home-Outbox-relay.pdf in the repo root). It holds no solutions. Every later design choice should trace back to something here.

## What we are building

Tequity owns both ends. Their load generator posts events to us, and their endpoint receives what we pass on. Between the two we build an outbox relay (a service that writes each incoming message to its own database first and forwards it later): an intake API on port 8080 that stores each event in Postgres before it answers, and workers that post the stored events to Tequity's endpoint on port 9000. Nobody else calls us. The endpoint misbehaves on purpose, and grading looks at what it saved.

## What the brief fixes

Intake is `POST http://localhost:8080/events`, up to 100 events a second, with a few users sending far more than the rest. A body looks like this:

```json
{
  "event_id":   "6f1c2a9e-1d7b-4c1e-9a43-2b8f0d6e7c11",
  "user_id":    "usr_004211",
  "created_at": "2026-11-17T10:42:07.318Z",
  "type":       "user.updated",
  "data":       { "email": "a@example.com" }
}
```

`event_id` is unique per event, and a resent event keeps it. For one user, `created_at` never repeats and gives the true order; the brief says to trust it. A 2xx from us promises the event will reach their endpoint.

Delivery is `POST http://localhost:9000/events` with the same body. A 200 means saved. A 500 means not saved. A 429 means not saved, wait the whole seconds given in Retry-After. No connection means down, not saved. A slow answer is still in progress, and a 200 at the end means saved. The endpoint saves the same event twice if it gets it twice.

Any language is allowed. Postgres is the only state: no Redis, Kafka or other queue. Tequity runs `git clone` and `docker compose up` on a Linux machine with Docker, which starts our system only. Their endpoint is already running, and they install and edit nothing.

The run passes when four conditions hold, named here for the rest of the repo. Exactly once: every event we answered 2xx for reaches the endpoint one time. Order: each user's events arrive in `created_at` order; different users may interleave. Timing: each event arrives within 30 seconds of our 2xx while the endpoint is healthy, or within 5 minutes of it recovering if it was down or failing. Intake stays up: our API keeps accepting events while the endpoint is down, slow or rate limiting.

We hand in the full, unsquashed git history, a README that opens with our assumptions, and the unedited AI chat history. Where the brief is silent, we assume, write it down and keep going.

## What must always hold

An event gets a 2xx only after Postgres has committed it. Answering on 8080 never waits on 9000. The body sent is the body received. An event that got a 200 is never sent again. A user's event goes out only after all their earlier events are saved, since sending past an unsaved one can break order. Restarting any of our containers loses nothing.

## Out of scope

Authentication and TLS, which the brief never mentions. More than one machine. Order between users. Cleaning up old rows. Changes to Tequity's endpoint or load generator. Dashboards.

## Open points

Each needs an assumption or a design choice, made one at a time later. The last sentence of each names the pass condition at risk.

Inside a container, localhost is the container itself, and Docker on Linux gives no default name for the host. This can break exactly once and timing.

Events can reach us out of `created_at` order, and once a later event has gone out, an earlier one cannot be put back in place. Postgres timestamps keep microseconds only, so finer digits would be rounded and could tie. This can break order, and timing if later events are held back to wait for a late one.

If a user's events must go out one at a time to keep their order, a heavy user is capped by the endpoint's answer time: at 200 ms, five events a second. This can break timing.

A five minute outage at 100 a second leaves 30,000 events, all due within 5 minutes of recovery while new ones keep coming, and we only see recovery by trying. This can break timing.

Postgres jsonb (a column type holding parsed JSON) reorders keys and changes spacing, so keeping the exact bytes may need the raw request. This can break exactly once, if Tequity compares bodies.

The same `event_id` can arrive with a different body, and the brief says nothing about which counts. This can break exactly once.

Two copies of one event can arrive at once on separate connections; both need a 2xx, and only one may be stored. This can break exactly once.

Port 9000 can answer outside the table: a 400, 404, 503, a redirect, a 429 without a usable Retry-After, or a cut connection after sending. Each needs a meaning: saved, not saved or unknown. This can break exactly once.

A slow answer has no stated limit. If we stop waiting, the outcome is unknown: sending again may save twice, giving up loses the event, and the endpoint gives us no way to check. This can break exactly once, and order and timing, since that user's later events wait behind it.

We can crash mid-send, after the endpoint saved the event but before we recorded it. This can break exactly once.

Retry-After may cover the whole endpoint or only the user whose request got the 429. This can break timing.

Bad input can arrive: broken JSON, missing fields, an unreadable `created_at`, a huge body. A 2xx for something we cannot send breaks our promise; a 4xx for something Tequity thinks valid loses it. This can break exactly once.

`docker compose up` starts our containers in parallel, so posts may come before Postgres or the API is ready. This can break intake stays up.
