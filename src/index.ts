// Placeholder public entry point.
//
// Real monitor logic (init/start/attachLifecycle, STEP_NAMES, route tables,
// redaction, outbox, etc.) is ported from the `vp` host repo's
// `src/utils/monitor/` in a later ticket (04), blocked on this scaffolding
// ticket plus ticket 03 (config contract implementation). This file exists
// only so the package is installable and importable end-to-end right now.

export const VERSION = '0.0.1';

/**
 * Placeholder for the real `monitor.init(config)` entry point described in
 * README.md. Intentionally does nothing yet.
 */
export function init(_config: unknown): void {
  // no-op placeholder — see ticket 03/04
}
