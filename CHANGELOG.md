# Changelog

## 0.1.0 — 2026-09-14

First release.

- Reorder queued messages from inside the official queue dock: a draggable grip
  handle on every queued row, plus ↑ / ↓ buttons sitting with the dock's own
  edit / remove / steer actions.
- The host half performs one concurrency-checked `agent/inbox.splice('next-turn', …)`,
  so a move is a single durable inbox event.
- Refusals instead of surprises: `QUEUE_CHANGED` when your view of the queue went
  stale, `NON_USER_MESSAGE` rather than cancelling a row the harness still tracks
  (goal round prompts), `SUBAGENT_UNSUPPORTED` for parent-owned queues, and
  steering rows are never listed.
- Offline selftest, 32 assertions: the move transaction, every refusal, the HTTP
  surface, and the dock decoration driven against DOM stubs.
