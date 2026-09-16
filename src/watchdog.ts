// src/watchdog.ts
//
// Boot-failure watchdog (ticket 05, webview-monitor-package-extraction).
// If a host app's entire bundle fails to load/execute (404, network
// failure, syntax error before any of its own code runs), NO code living
// inside that bundle — including the rest of this package — can ever
// observe the failure, because it never ran. The only place a failure like
// that is observable is a separate, tiny <script> placed in the HTML
// BEFORE the bundle's own script tag.
//
// buildWatchdogScript() returns that script as a raw ES5 STRING — it is
// never bundled, transformed, or type-checked by babel/tsc at runtime. It
// must survive being pasted, unprocessed, directly into an HTML
// `<script>` tag on an arbitrary/old browser. Same discipline as vp's
// existing STRIP_ENTRY_QUERY_SCRIPT (config/html.ts): ES5 only, no
// destructuring/arrow/template-literal/optional-chaining syntax, every
// browser API access guarded by try/catch or typeof checks, and it must
// NEVER throw — a thrown error here would be exactly the kind of
// bundle-execution failure this script exists to detect, except now
// self-inflicted.
//
// Self-contained by design (ADR-0001 partial-adoption amendment): no
// import of any other file in this package, no reference to any other
// package export. It cannot assume `filter.ts`'s redaction pipeline ever
// runs, so the payload below ships ONLY fields hand-verified safe by
// inspection — no session_id (nothing here generates one), no query
// string, no referrer, no headers.
//
// Single timer, checked at fire time: `window.__WV_BOOTED__` is read once,
// when the timeout fires. If the bundle set it before then, the timer
// callback sees `true` and returns without any network call — functionally
// identical to "clearing the timer" since neither path sends a beacon. No
// polling loop is needed and one fewer timer is one fewer thing that can
// go wrong in unprocessed ES5.

export interface WatchdogScriptConfig {
  /** Host's own ingest endpoint for this beacon. Host-supplied — no default (ADR-0001). */
  ingestUrl: string;
  /**
   * Milliseconds to wait for `window.__WV_BOOTED__` before treating the
   * boot as failed. Host-supplied — no default (ADR-0001); see the
   * calling host's own comment for whether this value has been tuned
   * against real network conditions.
   */
  timeoutMs: number;
}

/**
 * Returns a raw ES5 string implementing the watchdog. Interpolates only
 * `ingestUrl` (JSON-stringified, so a value containing `</script>` or
 * quotes can't break out of the literal) and `timeoutMs` (coerced to a
 * finite non-negative number, so a bad config can't inject arbitrary
 * script source).
 */
export function buildWatchdogScript(config: WatchdogScriptConfig): string {
  const ingestUrl = JSON.stringify(String(config.ingestUrl || ''));
  const timeoutMsNum = Number(config.timeoutMs);
  const timeoutMs = String(
    Number.isFinite(timeoutMsNum) && timeoutMsNum >= 0 ? timeoutMsNum : 0,
  );

  return (
    '(function (w) {\n' +
    '  try {\n' +
    '    var INGEST_URL = ' +
    ingestUrl +
    ';\n' +
    '    var TIMEOUT_MS = ' +
    timeoutMs +
    ';\n' +
    '    setTimeout(function () {\n' +
    '      try {\n' +
    '        if (w.__WV_BOOTED__ === true) return;\n' +
    '        if (!INGEST_URL) return;\n' +
    '        if (!w.navigator || w.navigator.onLine === false) return;\n' +
    '        var payload = JSON.stringify({\n' +
    "          event: 'boot_timeout',\n" +
    '          pathname: w.location ? w.location.pathname : \'\',\n' +
    '          ts: Date.now()\n' +
    '        });\n' +
    '        var sent = false;\n' +
    '        try {\n' +
    '          if (w.navigator && typeof w.navigator.sendBeacon === \'function\') {\n' +
    '            sent = w.navigator.sendBeacon(INGEST_URL, payload);\n' +
    '          }\n' +
    '        } catch (beaconErr) {\n' +
    '          sent = false;\n' +
    '        }\n' +
    '        if (!sent) {\n' +
    '          try {\n' +
    '            if (typeof w.fetch === \'function\') {\n' +
    '              w.fetch(INGEST_URL, {\n' +
    "                method: 'POST',\n" +
    '                body: payload,\n' +
    '                keepalive: true\n' +
    '              })[\'catch\'](function () {});\n' +
    '            }\n' +
    '          } catch (fetchErr) {\n' +
    '            /* no-op — never throw from the watchdog */\n' +
    '          }\n' +
    '        }\n' +
    '      } catch (innerErr) {\n' +
    '        /* no-op — never throw from the watchdog */\n' +
    '      }\n' +
    '    }, TIMEOUT_MS);\n' +
    '  } catch (outerErr) {\n' +
    '    /* no-op — watchdog must never crash the host page */\n' +
    '  }\n' +
    '})(window);'
  );
}
