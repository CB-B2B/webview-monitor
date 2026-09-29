// src/__tests__/watchdog.spec.ts
//
// buildWatchdogScript() returns a raw ES5 STRING meant for an HTML
// <script> tag, never bundled/transformed by babel/tsc at runtime — there
// is no TypeScript AST to import and unit-test against normal jsdom-run
// TS. The only meaningful way to test it is to treat the string as a black
// box: eval it in a real (or real-enough) global environment and observe
// its side effects, exactly like a browser would.
//
// Approach chosen: `new Function('window', src)(window)` against vitest's
// jsdom `window` global, combined with `vi.useFakeTimers()`. This is a
// lightweight eval-in-vm harness (no extra dependency — `Function` is a
// stdlib primitive, and jsdom + fake timers are already this repo's
// existing test stack for every other suite in `src/__tests__/`). A real
// headless-browser test (Playwright) was considered and rejected: the repo
// has no browser-automation tooling installed today (package.json has no
// playwright/puppeteer devDependency), and adding one purely for this one
// script would violate the "don't add a dependency for what stdlib+jsdom
// already covers" rule — the watchdog's only real runtime surface
// (setTimeout, navigator.sendBeacon, navigator.onLine, fetch,
// location.pathname) is fully reachable through jsdom.

import { buildWatchdogScript, MAIN_BUNDLE_RE } from '../watchdog';

const INGEST_URL = 'https://obs-qrx.invalid/boot-timeout';
const TIMEOUT_MS = 8000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type WvGlobals = {
  __WV_BOOTED__?: boolean;
  __WV_SID__?: string;
  __WV_SID_WEAK__?: boolean;
  __WV_TIMED_OUT__?: boolean;
};
const wv = window as unknown as WvGlobals;

function runWatchdog(): void {
  const src = buildWatchdogScript({ ingestUrl: INGEST_URL, timeoutMs: TIMEOUT_MS });
  // eslint-disable-next-line no-new-func -- deliberate black-box eval, see file header
  new Function('window', src)(window);
}

function installPerformanceEntries(entries: Record<string, unknown[]>): void {
  Object.defineProperty(window.performance, 'getEntriesByType', {
    configurable: true,
    writable: true,
    value: (type: string) => entries[type] || [],
  });
}

function captureBeacon() {
  const sendBeacon = vi.fn((_url: string, _body: string) => true);
  Object.defineProperty(window.navigator, 'sendBeacon', {
    configurable: true,
    writable: true,
    value: sendBeacon,
  });
  return sendBeacon;
}

describe('buildWatchdogScript — black-box eval', () => {
  const perfDesc = Object.getOwnPropertyDescriptor(window.performance, 'getEntriesByType');
  beforeEach(() => {
    vi.useFakeTimers();
    delete wv.__WV_BOOTED__;
    delete wv.__WV_SID__;
    delete wv.__WV_SID_WEAK__;
    delete wv.__WV_TIMED_OUT__;
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (perfDesc) Object.defineProperty(window.performance, 'getEntriesByType', perfDesc);
    else delete (window.performance as unknown as { getEntriesByType?: unknown }).getEntriesByType;
  });

  it('healthy boot: __WV_BOOTED__ set before timeout → zero network calls', () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: sendBeacon,
    });
    const fetchMock = vi.fn();
    (window as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    runWatchdog();
    (window as unknown as { __WV_BOOTED__?: boolean }).__WV_BOOTED__ = true;
    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wv.__WV_TIMED_OUT__).toBeUndefined();
  });

  it('boot failure: timeout elapses with no signal → exactly one beacon, minimal payload', () => {
    const sendBeacon = vi.fn((_url: string, _body: string) => true);
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: sendBeacon,
    });
    const fetchMock = vi.fn();
    (window as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    vi.setSystemTime(1700000000000);
    installPerformanceEntries({});

    runWatchdog();
    // __WV_BOOTED__ never set — this is exactly the failure this script exists for.
    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    const [url, body] = sendBeacon.mock.calls[0];
    expect(url).toBe(INGEST_URL);
    expect(JSON.parse(body as string)).toEqual({
      event: 'boot_timeout',
      session_id: wv.__WV_SID__,
      pathname: window.location.pathname,
      ts: 1700000000000 + TIMEOUT_MS,
      load_js_downloaded: false,
    });
  });

  it('session id: generated before the timer as a UUID on window.__WV_SID__, carried by boot_timeout', () => {
    const sendBeacon = vi.fn((_url: string, _body: string) => true);
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: sendBeacon,
    });

    runWatchdog();
    const sid = wv.__WV_SID__;
    expect(sid).toMatch(UUID_RE);
    expect(wv.__WV_SID_WEAK__).toBeUndefined();

    vi.advanceTimersByTime(TIMEOUT_MS + 1);
    const body = JSON.parse(sendBeacon.mock.calls[0][1]);
    expect(body.session_id).toBe(sid);
    expect('sid_weak' in body).toBe(false);
  });

  it('no crypto: still a UUID via Math.random, flagged weak on __WV_SID_WEAK__ and sid_weak', () => {
    const cryptoDesc = Object.getOwnPropertyDescriptor(window, 'crypto');
    Object.defineProperty(window, 'crypto', { configurable: true, value: undefined });
    const sendBeacon = vi.fn((_url: string, _body: string) => true);
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: sendBeacon,
    });
    try {
      runWatchdog();
    } finally {
      if (cryptoDesc) Object.defineProperty(window, 'crypto', cryptoDesc);
    }
    expect(wv.__WV_SID__).toMatch(UUID_RE);
    expect(wv.__WV_SID_WEAK__).toBe(true);

    vi.advanceTimersByTime(TIMEOUT_MS + 1);
    const body = JSON.parse(sendBeacon.mock.calls[0][1]);
    expect(body.session_id).toBe(wv.__WV_SID__);
    expect(body.sid_weak).toBe(true);
  });

  it('firing boot_timeout sets window.__WV_TIMED_OUT__ = true', () => {
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: vi.fn(() => true),
    });

    runWatchdog();
    expect(wv.__WV_TIMED_OUT__).toBeUndefined();
    vi.advanceTimersByTime(TIMEOUT_MS + 1);
    expect(wv.__WV_TIMED_OUT__).toBe(true);
  });

  it('main bundle downloaded: boot_timeout carries server response, html ready and load_js_downloaded: true', () => {
    installPerformanceEntries({
      navigation: [{ startTime: 0, responseStart: 300, domContentLoadedEventEnd: 900 }],
      resource: [
        { name: 'https://cdn.example/gtm.js', initiatorType: 'script' },
        { name: 'https://cdn.example/umi.3f2a9c.js', initiatorType: 'script' },
      ],
    });
    const sendBeacon = captureBeacon();

    runWatchdog();
    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    const body = JSON.parse(sendBeacon.mock.calls[0][1]);
    expect(body.load_server_response_ms).toBe(300);
    expect(body.load_html_ready_ms).toBe(900);
    expect(body.load_js_downloaded).toBe(true);
  });

  it('main bundle not downloaded yet: load_js_downloaded: false; html not ready (0) ⇒ field omitted, not 0', () => {
    installPerformanceEntries({
      navigation: [{ startTime: 0, responseStart: 300, domContentLoadedEventEnd: 0 }],
      resource: [{ name: 'https://cdn.example/gtm.js', initiatorType: 'script' }],
    });
    const sendBeacon = captureBeacon();

    runWatchdog();
    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    const body = JSON.parse(sendBeacon.mock.calls[0][1]);
    expect(body.load_server_response_ms).toBe(300);
    expect('load_html_ready_ms' in body).toBe(false);
    expect(body.load_js_downloaded).toBe(false);
  });

  it('performance throws: beacon still fires with session_id, load fields dropped', () => {
    const perfWinDesc = Object.getOwnPropertyDescriptor(window, 'performance');
    Object.defineProperty(window, 'performance', {
      configurable: true,
      get() {
        throw new Error('performance blocked');
      },
    });
    const sendBeacon = captureBeacon();
    try {
      runWatchdog();
      vi.advanceTimersByTime(TIMEOUT_MS + 1);
    } finally {
      if (perfWinDesc) Object.defineProperty(window, 'performance', perfWinDesc);
    }

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const body = JSON.parse(sendBeacon.mock.calls[0][1]);
    expect(body.session_id).toBe(wv.__WV_SID__);
    expect(Object.keys(body).filter(k => k.indexOf('load_') === 0)).toEqual([]);
  });

  it('boot failure with no sendBeacon: falls back to fetch exactly once', () => {
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => Promise.resolve());
    (window as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    runWatchdog();
    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(INGEST_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ event: 'boot_timeout' });
  });

  it('offline at timeout: no beacon, no fetch (mirrors package-wide onLine guard)', () => {
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: sendBeacon,
    });

    runWatchdog();
    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it('debug: false (default) — zero console calls, even on boot failure', () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: sendBeacon,
    });
    const debugSpy = vi.spyOn(console, 'debug');

    runWatchdog(); // default config has no `debug` key
    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('debug: true — logs armed/verdict lines on boot failure, still sends exactly one beacon', () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: sendBeacon,
    });
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const src = buildWatchdogScript({
      ingestUrl: INGEST_URL,
      timeoutMs: TIMEOUT_MS,
      debug: true,
    });
    // eslint-disable-next-line no-new-func -- deliberate black-box eval, see file header
    new Function('window', src)(window);
    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const lines = debugSpy.mock.calls.map(call => String(call[0]));
    expect(lines.some(l => l.includes('armed'))).toBe(true);
    expect(lines.some(l => l.includes('firing boot_timeout'))).toBe(true);
    expect(lines.some(l => l.includes('sendBeacon result: true'))).toBe(true);
  });

  it('debug: true — logs "not firing" when __WV_BOOTED__ is set in time, sends nothing', () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: sendBeacon,
    });
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const src = buildWatchdogScript({
      ingestUrl: INGEST_URL,
      timeoutMs: TIMEOUT_MS,
      debug: true,
    });
    // eslint-disable-next-line no-new-func -- deliberate black-box eval, see file header
    new Function('window', src)(window);
    (window as unknown as { __WV_BOOTED__?: boolean }).__WV_BOOTED__ = true;
    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    expect(sendBeacon).not.toHaveBeenCalled();
    const lines = debugSpy.mock.calls.map(call => String(call[0]));
    expect(lines.some(l => l.includes('not firing'))).toBe(true);
  });

  it('missing ingestUrl: no beacon, no fetch', () => {
    const src = buildWatchdogScript({ ingestUrl: '', timeoutMs: TIMEOUT_MS });
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: sendBeacon,
    });

    // eslint-disable-next-line no-new-func -- deliberate black-box eval
    new Function('window', src)(window);
    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    expect(sendBeacon).not.toHaveBeenCalled();
  });
});

// v0.3.0 — watchdog (boot_timeout.load_js_downloaded) và summary (load.js_*)
// phải nhận cùng một bundle chính: một mẫu duy nhất, xuất từ watchdog.ts.
describe('MAIN_BUNDLE_RE — một mẫu cho cả watchdog và summary', () => {
  const cases: Array<[string, boolean]> = [
    ['https://cdn.example/umi.js', true],
    ['https://cdn.example/umi.3f2a9c.js', true],
    ['https://cdn.example/umi.3f2a9c.js?v=1#x', true],
    ['https://cdn.example/static/umi.js?t=1', true],
    ['https://cdn.example/vendors~umi.js', false],
    ['https://cdn.example/umi.a.b.js', false],
    ['https://cdn.example/umi.3f2a9c.css', false],
    ['https://cdn.example/p__index.3f2a9c.js', false],
  ];

  it.each(cases)('%s ⇒ %s (dùng chung được trong TS)', (url, expected) => {
    expect(MAIN_BUNDLE_RE.test(url)).toBe(expected);
  });

  it.each(cases)('%s ⇒ load_js_downloaded %s (script watchdog nhúng đúng mẫu đó)', (url, expected) => {
    vi.useFakeTimers();
    delete wv.__WV_BOOTED__;
    installPerformanceEntries({ resource: [{ name: url, initiatorType: 'script' }] });
    const sendBeacon = captureBeacon();
    runWatchdog();
    vi.advanceTimersByTime(TIMEOUT_MS + 1);
    expect(JSON.parse(sendBeacon.mock.calls[0][1]).load_js_downloaded).toBe(expected);
    vi.useRealTimers();
  });
});
