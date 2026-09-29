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
// inspection — session_id (a random UUID v4 generated here, not personal
// data), pathname, ts and numeric/boolean load_* milestones; no query
// string, no referrer, no headers, no resource URLs.
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
  /**
   * Opt-in console.debug lines for local/dev verification — OFF by
   * default so every existing host and every existing test observes zero
   * behavior change. Logs the arm time, whether/when __WV_BOOTED__ got set,
   * and the fire-or-skip verdict at timeout. Every call site is wrapped by
   * the same outer try/catch as the rest of the script (a console-less
   * embedded webview, or a frozen console object, must never turn into a
   * thrown error here — that would defeat the whole point of a watchdog).
   * Never enable this in production: it is meant for a host's own local
   * dev config, gated at the HOST's call site (see vp's config/html.ts),
   * not by any check inside this script itself.
   */
  debug?: boolean;
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
  const debug = config.debug === true;

  return (
    '(function (w) {\n' +
    '  try {\n' +
    '    var INGEST_URL = ' +
    ingestUrl +
    ';\n' +
    '    var TIMEOUT_MS = ' +
    timeoutMs +
    ';\n' +
    '    var DEBUG = ' +
    String(debug) +
    ';\n' +
    // Guarded the same way as every other browser API in this file — a
    // console-less embedded webview (or a locked-down one) must fall
    // through silently, not throw. try/catch AROUND the console call
    // (not just typeof) because some hosts throw on invoking a
    // native-looking but stubbed console.debug, not just on missing it.
    '    function log(msg) {\n' +
    '      if (!DEBUG) return;\n' +
    '      try {\n' +
    "        if (w.console && typeof w.console.debug === 'function') {\n" +
    "          w.console.debug('[watchdog debug] ' + msg);\n" +
    '        }\n' +
    '      } catch (logErr) {\n' +
    '        /* no-op — logging must never throw from the watchdog */\n' +
    '      }\n' +
    '    }\n' +
    // session_id generated BEFORE the timer and shared with the bundle via
    // window.__WV_SID__ (start() reuses it), so boot_timeout and the session
    // summary of the same page join on O2. Same source order as start():
    // randomUUID -> getRandomValues -> Math.random. Each step guarded; a
    // failure just falls through to the next.
    '    var SID = \'\';\n' +
    '    var c = w.crypto;\n' +
    '    try {\n' +
    "      if (c && typeof c.randomUUID === 'function') SID = String(c.randomUUID());\n" +
    '    } catch (uuidErr) {\n' +
    "      SID = '';\n" +
    '    }\n' +
    '    if (!SID) {\n' +
    '      try {\n' +
    "        if (c && typeof c.getRandomValues === 'function' && typeof Uint8Array === 'function') {\n" +
    '          var b = new Uint8Array(16);\n' +
    '          c.getRandomValues(b);\n' +
    '          b[6] = (b[6] & 15) | 64;\n' +
    '          b[8] = (b[8] & 63) | 128;\n' +
    "          var h = '';\n" +
    "          for (var i = 0; i < 16; i++) h += (b[i] < 16 ? '0' : '') + b[i].toString(16);\n" +
    "          SID = h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);\n" +
    '        }\n' +
    '      } catch (grvErr) {\n' +
    "        SID = '';\n" +
    '      }\n' +
    '    }\n' +
    '    var WEAK = false;\n' +
    '    if (!SID) {\n' +
    '      WEAK = true;\n' +
    "      SID = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {\n" +
    '        var r = (Math.random() * 16) | 0;\n' +
    "        return (ch === 'x' ? r : (r & 3) | 8).toString(16);\n" +
    '      });\n' +
    '    }\n' +
    '    try {\n' +
    '      w.__WV_SID__ = SID;\n' +
    '      if (WEAK) w.__WV_SID_WEAK__ = true;\n' +
    '    } catch (sidErr) {\n' +
    '      /* no-op — a frozen window must not stop the timer from arming */\n' +
    '    }\n' +
    "    log('armed, timeout=' + TIMEOUT_MS + 'ms');\n" +
    '    setTimeout(function () {\n' +
    '      try {\n' +
    '        if (w.__WV_BOOTED__ === true) {\n' +
    "          log('__WV_BOOTED__ already true at timeout — not firing');\n" +
    '          return;\n' +
    '        }\n' +
    '        if (!INGEST_URL) {\n' +
    "          log('timeout reached but no ingestUrl configured — not firing');\n" +
    '          return;\n' +
    '        }\n' +
    '        if (!w.navigator || w.navigator.onLine === false) {\n' +
    "          log('timeout reached but offline — not firing');\n" +
    '          return;\n' +
    '        }\n' +
    "        log('timeout reached, __WV_BOOTED__ not set — firing boot_timeout');\n" +
    // Read by start() -> summary.boot_timed_out, so a bundle that ran late
    // (both rows exist on O2) is filterable without a join.
    '        w.__WV_TIMED_OUT__ = true;\n' +
    '        var body = {\n' +
    "          event: 'boot_timeout',\n" +
    '          session_id: SID,\n' +
    '          pathname: w.location ? w.location.pathname : \'\',\n' +
    '          ts: Date.now()\n' +
    '        };\n' +
    '        if (WEAK) body.sid_weak = true;\n' +
    // Load milestones at fire time (ms from Navigation start, same names as
    // the summary's flattened load_* columns). Each read in its OWN
    // try/catch: a throwing/missing performance API drops only that field,
    // the beacon still fires. 0 means "not reached yet" -> omitted, never 0.
    // load_js_downloaded: the main bundle (umi.*.js) has a resource entry ->
    // stuck in JS; none -> stuck on the network. Only the boolean is sent,
    // never the resource URL.
    '        var p = null;\n' +
    '        var nav = null;\n' +
    '        try {\n' +
    '          p = w.performance;\n' +
    "          nav = p.getEntriesByType('navigation')[0] || null;\n" +
    '        } catch (navErr) {\n' +
    '          nav = null;\n' +
    '        }\n' +
    '        try {\n' +
    "          if (nav && typeof nav.responseStart === 'number' && nav.responseStart > 0) body.load_server_response_ms = nav.responseStart;\n" +
    '        } catch (rsErr) {\n' +
    '          /* no-op — drop the field, keep the beacon */\n' +
    '        }\n' +
    '        try {\n' +
    "          if (nav && typeof nav.domContentLoadedEventEnd === 'number' && nav.domContentLoadedEventEnd > 0) body.load_html_ready_ms = nav.domContentLoadedEventEnd;\n" +
    '        } catch (dclErr) {\n' +
    '          /* no-op — drop the field, keep the beacon */\n' +
    '        }\n' +
    '        try {\n' +
    "          var res = p.getEntriesByType('resource');\n" +
    '          var dl = false;\n' +
    '          for (var j = 0; j < res.length; j++) {\n' +
    "            if (res[j].initiatorType === 'script' && /\\/umi\\.[^\\/?#]*\\.js([?#]|$)/.test(String(res[j].name))) {\n" +
    '              dl = true;\n' +
    '              break;\n' +
    '            }\n' +
    '          }\n' +
    '          body.load_js_downloaded = dl;\n' +
    '        } catch (resErr) {\n' +
    '          /* no-op — drop the field, keep the beacon */\n' +
    '        }\n' +
    '        var payload = JSON.stringify(body);\n' +
    '        var sent = false;\n' +
    '        try {\n' +
    '          if (w.navigator && typeof w.navigator.sendBeacon === \'function\') {\n' +
    '            sent = w.navigator.sendBeacon(INGEST_URL, payload);\n' +
    '          }\n' +
    '        } catch (beaconErr) {\n' +
    '          sent = false;\n' +
    '        }\n' +
    "        log('sendBeacon result: ' + sent);\n" +
    '        if (!sent) {\n' +
    '          try {\n' +
    '            if (typeof w.fetch === \'function\') {\n' +
    "              log('falling back to fetch');\n" +
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
