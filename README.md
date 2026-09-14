# dsh-queue-reorder

[![npm](https://img.shields.io/npm/v/dsh-queue-reorder)](https://www.npmjs.com/package/dsh-queue-reorder)
[![license](https://img.shields.io/npm/l/dsh-queue-reorder)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-ready-478CBF)](https://github.com/topics/dsh-plugin)

Reorder the messages you queued while a DSH agent was busy — **inside the
official queue dock**, not in a panel beside it.

![The queue dock: two queued messages, each with a drag handle and move buttons beside the dock's own edit, remove and steer actions](https://raw.githubusercontent.com/damlys99/dsh-queue-reorder/main/assets/queue-dock.png)

## What you get

- A **grip handle** on every queued row: drag a message where you want it.
- **↑ / ↓** per row, wearing the dock's own action-button class, for precision
  instead of a drag. The last row's ↓ is disabled, because there is nothing
  after it.
- The dock is **decorated, never replaced**. Previews, inline editing, steering,
  removal, attachments and collapse stay exactly as the conversation plugin
  ships them; uninstall and the dock is untouched.

## Install

```sh
dsh plugin --profile web add -w dsh-queue-reorder
# restart dsh web, then reload the page
```

Requires DSH `>=0.1.2-alpha.1 <0.2.0-0` (earlier client-plugin contracts have no
`conversation.input.dock` slot). From a checkout instead:

```sh
dsh plugin --profile web add -w link:/absolute/path/to/dsh-queue-reorder
```

Uninstall:

```sh
dsh plugin --profile web remove dsh-queue-reorder
```

## Design

Two small halves, no build step, no runtime dependencies:

- **Host** (`lib/index.js`) registers one same-origin route,
  `POST /queue-reorder`, and performs a single concurrency-checked
  `agent/inbox.splice('next-turn', …)` over the smallest span containing both
  ends of the move.
- **Browser** (`lib/client.js`) is a hand-authored module-loader bundle. A hidden
  `conversation.input.dock` entry (which renders `null`) reads the session
  snapshot for the queued ids and their order — the dock's DOM carries no ids —
  and a `MutationObserver` decorates the official rows. It re-reads each row's
  position at click and drag time, because the dock reorders those very elements
  in place.

## What it refuses, and why

| Refusal | Reason |
| --- | --- |
| `QUEUE_CHANGED` | Your view of the queue no longer matches the live queue; retry rather than scramble it. |
| `NON_USER_MESSAGE` | The move would discard and reinsert a row whose source the harness still tracks (a goal round prompt, for example), cancelling that work. |
| `SUBAGENT_UNSUPPORTED` | A subagent session's queue is owned by its parent session. |
| Steering rows | Only `next-turn` (`placement: "queued"`) rows move; `next-step` stays put. |

A refused move changes nothing: every guard runs before the splice.

## Caveats

- The decorator attaches to the official dock's markup (`[data-queue-dock]`, its
  row list, the trailing action container). Those are implementation details of
  `@deepseek-ai/dsh-client-ui-conversation`, not a published contract: if the dock
  is restructured, the controls may stop appearing. It fails soft — the dock keeps
  working, you just lose the grip until this plugin catches up.
- Verified on DSH 0.1.5-rc.1, in a browser and through `selftest.mjs`.
- The route answers on the loopback interface without the GUI's session cookie,
  like other plugin HTTP routes. A cross-site browser request is still blocked:
  the JSON content type forces a CORS preflight that the route answers with 405.

## Tests

```sh
node selftest.mjs
```

No network, no browser, no build. 32 assertions covering the move transaction,
every refusal, the request decoder, the HTTP surface, and the dock decoration
(injection idempotence, live index reads, drop marking, notice reporting).

## License

MIT
