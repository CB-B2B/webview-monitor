# @internal/webview-monitor

Host-configured webview session monitor (init/start/attachLifecycle steps,
error tracking, time-to-home). Shared across bank webview repos.

## Status

**Real monitor logic is live** (ticket 04): the module moved wholesale from
`vp`'s `src/utils/monitor/` — session lifecycle (`init/start/attachLifecycle/
step/http/mark/route/event/finish`), Layer-1/Layer-2 redaction, sampling,
outbox retry/backoff, and the event-stream chunker/transport. `vp` now
installs this package as a git dependency instead of owning the code
locally; see `vp`'s own `package.json` and `src/app.ts` for the real call
site. The test suite (`src/__tests__/*.spec.ts`) is ported from `vp`'s
original `src/utils/monitor/__tests__/` and exercises this package's public
API directly — no host `app.ts`/`layouts` file is involved.

## Installation

This package is **not published to any npm registry** (see ADR-0001 — ~10
known consumers didn't justify standing up and securing a private registry).
Install it as a git dependency, pinned to a tag:

```json
{
  "dependencies": {
    "@internal/webview-monitor": "github:CB-B2B/webview-monitor#v0.1.0"
  }
}
```

Pin to a specific `vX.Y.Z` tag, not a branch — see [Versioning](#versioning).

## Public API: `monitor.init(config)`

Call `init(config)` once, before `start()` / `attachLifecycle()`. `config` is
a plain object your app builds from its own `.umirc.ts` / build-time env vars.

> **This package has no built-in defaults.** Per ADR-0001 (`docs/adr/0001-monitor-package-host-supplied-config.md`
> in the host `vp` repo), every field below proven bank-specific in VPBank's
> original implementation — step list, route tables, `partnerId`, GTM key,
> API endpoints — must be supplied explicitly by every consumer, including
> `vp` itself. The package never reads `process.env.*` and never assumes any
> one bank's shape is the norm. If you omit a field, you get the validation
> behavior below, not a silently-inherited value from another bank.

### Config fields

The field list and required/optional split below reflect the config contract
decided in ADR-0002 (`docs/adr/0002-monitor-init-config-validation-contract.md`
in the host `vp` repo), whose status is **accepted** as of this writing.
Field *names* are illustrative (carried over from the `vp` decision docs);
the implementation ticket (03) is the source of truth if this README and the
shipped types ever disagree — file an issue against this repo if they do.

| Field | Required? | Validation behavior if missing |
|---|---|---|
| `steps` | **Required** | `init()` throws synchronously (fail-fast) |
| `staticRoutes` / `templateRoutes` | **Required** | `init()` throws synchronously (fail-fast) |
| `partnerId` | **Required** | `init()` throws synchronously (fail-fast) |
| `ingestUrl` / `eventsIngestUrl` | Optional | `init()` returns normally; `start()`/`attachLifecycle()` become no-ops for that session (fail-safe, monitor treated as disabled) |
| `flagUrl` | Optional | Same as above — fail-safe, no-op, same shape as an L1-disabled session |

**Why the split isn't uniform:** identity/shape fields (`steps`,
`staticRoutes`/`templateRoutes`, `partnerId`) are call-site authoring
mistakes fully inside the host developer's control, and are cheapest to
catch loud and immediate, on the very first local run — so they throw.
Network-endpoint fields (`ingestUrl`/`eventsIngestUrl`, `flagUrl`) may
legitimately be absent in some environments (e.g. local/staging) without
that being evidence the integration is *shaped* wrong, so they degrade
silently instead — consistent with `flag.ts`'s existing empty-`FLAG_URL`
behavior in the `vp` host repo and with NFR-001 ("monitor must never break
the primary experience"). There is no third "depends" category: an
unclassified future field defaults to fail-fast unless someone documents a
specific reason it behaves like a network endpoint.

### Example (illustrative — field shapes not finalized)

```ts
import * as monitor from '@internal/webview-monitor';

monitor.init({
  partnerId: 'my-bank',
  steps: ['auth_user', 'home_float_icon', 'config'],
  staticRoutes: { '/home': 'home' },
  ingestUrl: process.env.MONITOR_INGEST_URL, // optional — read by the HOST, not this package
  flagUrl: process.env.MONITOR_FLAG_URL,     // optional
});

monitor.start();
monitor.attachLifecycle();
```

The package never reads `process.env.*` itself — reading env vars and
build-time dead-code folding (`MONITOR=off`) stay the host app's
responsibility, so each bank keeps its own Terser/webpack fold intact.

## Versioning

Releases are tagged `vX.Y.Z` (semver) on `main`. Consumers pin
`#vX.Y.Z` in their `package.json` git dependency URL and upgrade by bumping
the tag deliberately — there is no floating "latest".

## Scope note

The extraction from `vp` (ticket 04) moved the module as-is — no behavior
change, no redesign. `STEP_NAMES`/`STATIC_ROUTES`/`TEMPLATE_ROUTES` still
ship as illustrative VPBank example constants (used as `normalizeRoute()`'s
default route table when a caller doesn't pass its own), exactly as they did
inside `vp` after ticket 03's decoupling — every consumer, including `vp`,
is expected to pass its own `steps`/`staticRoutes`/`templateRoutes` via
`init()` rather than relying on these defaults (ADR-0001).
