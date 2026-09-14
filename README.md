# dsh-queue-reorder

Reorder the messages you queued while a DSH agent was busy — **inside the
official queue dock**, not in a panel beside it.

- A six-dot **grip** on every queued row: drag a row where you want it.
- **↑ / ↓** buttons per row, wearing the dock's own action-button class, for when
  you want precision instead of a drag.
- The dock is decorated, never replaced: previews, inline editing, steering,
  removal, attachments and collapse all behave exactly as shipped. Disable the
  plugin and the dock is untouched.

## Install

```sh
dsh plugin --profile web add -w dsh-queue-reorder
# restart dsh web, then reload the page
```

Requires DSH `>=0.1.2-alpha.1 <0.2.0-0` (the client-plugin contract before
0.1.2 has no `conversation.input.dock` slot).

Uninstall:

```sh
dsh plugin --profile web remove dsh-queue-reorder
```

### From a checkout

```sh
dsh plugin --profile web add -w link:/absolute/path/to/dsh-queue-reorder
```

## Design

Two halves, both small:

- **Host** (`lib/index.js`) registers one same-origin route,
  `POST /queue-reorder`, and performs a single concurrency-checked
  `agent/inbox.splice('next-turn', …)`. The move is one durable inbox event.
- **Browser** (`lib/client.js`) is a hand-authored module-loader bundle with no
  build step. A hidden `conversation.input.dock` entry (rendering `null`) reads
  the session snapshot for the queued ids and their order; a `MutationObserver`
  decorates the official dock's rows with the grip and the buttons.

## What it refuses, and why

| Refusal | Reason |
| --- | --- |
| `QUEUE_CHANGED` | Your view of the queue no longer matches the live queue; retry rather than scramble it. |
| `NON_USER_MESSAGE` | The move would discard and reinsert a row whose source the harness still tracks (a goal round prompt, for example), cancelling that work. |
| `SUBAGENT_UNSUPPORTED` | A subagent session's queue is owned by its parent session. |
| Steering rows | Only `next-turn` (`placement: "queued"`) rows move; `next-step` stays put. |

## Caveats

- The decorator attaches to the official dock's markup (`[data-queue-dock]`, its
  row list, the trailing action container). Those are implementation details of
  `@deepseek-ai/dsh-client-ui-conversation`, not a published contract: if the
  dock is restructured, the controls may stop appearing. It fails soft — the
  dock keeps working, you just lose the grip until this plugin catches up.
- Verified on DSH 0.1.5-rc.1. Tested with `selftest.mjs` (host transaction,
  refusals, HTTP surface, and the DOM decoration against DOM stubs) plus manual
  use in a browser.

## Tests

```sh
node selftest.mjs
```

No network, no browser, no build.

## License

MIT
