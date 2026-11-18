# How we work on the outbox relay

This repo is a take-home for Tequity. The brief is Tequity-take-home-Outbox-relay.pdf in the repo root, and nobody ever edits it. It asks for an intake API on port 8080 that stores each event in Postgres before answering, and workers that pass every stored event on to Tequity's endpoint on port 9000, exactly once and in created_at order per user, while that endpoint fails, rate limits, slows down or goes away. The graders clone the repo onto a clean Linux machine and run `docker compose up`. They install nothing else and change nothing.

Every session starts by reading docs/problem.md, the problem statement all design work traces back to.

The full AI chat history goes to Tequity unedited, along with the git history. Write every chat reply and every commit knowing they will see it.

## Design comes first

No product code (the intake API and the workers) gets written until the design is agreed. The test rig (a fake endpoint on 9000, a checker and a load generator) is test code, and it can be built once its own behaviour is agreed.

## Every decision is written down when it is made

When we settle a design choice, the same commit adds an entry to docs/decisions.md saying what was decided and why. When it rests on an assumption about Tequity's side (their endpoint, their load generator, their machine, how they grade), the same commit also adds that assumption to the list at the top of README.md. The README lists only those assumptions; design choices live only in docs/decisions.md. Each entry holds only the current decision, in at most 150 words: what, why, the option dropped if one was weighed and lost, and the command that proved it, if any. One decision per commit. The commit message states the decision, for example "Hold a user's later events while an earlier one has an unknown outcome". A message like "Update README and decisions.md" is never acceptable.

## History is never rewritten

The brief asks for the full git history, unsquashed. No squash, amend, rebase, reset or force-push, ever. A changed decision is a new commit that rewrites its entry in place to the current decision, with a message stating the new decision and why it changed. Git keeps the history and the dates, so entries carry neither.

## Before handover

The repo runs the way the graders run it, on Linux with plain Docker Engine: `git clone`, `docker compose up`, then the test rig from `rig/compose.yaml`. That run proves host networking reaches an endpoint bound to 127.0.0.1, and measures our own time per event on Linux; the README then gives its commands and output. A GitHub Actions Ubuntu runner is one way to get a Linux machine; it needs the repo on GitHub, which the author decides at that point. Every AI chat session is exported unedited and committed under `docs/chat/`.

## Postgres is the only state

All state lives in Postgres: no Redis, Kafka or other queue, no files on disk, and nothing in process memory that has to survive a restart.

## Working means a test run showed it

Nothing counts as working until a test run shows it. Any claim that something works, in a commit, the README or a chat reply, names the command that was run and what it printed.

## Small

Keep the code as small as the problem allows. No layers, options, config or libraries the brief does not call for.

## Writing

Everything written here follows the anti-ai writing rules: plain words, short sentences, no filler. Chat replies use bullets. Documents in the repo use prose, with one exception: the README opens with its assumptions as a list, because the brief asks for one.
