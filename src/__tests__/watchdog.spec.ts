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

import { buildWatchdogScript } from '../watchdog';

const INGEST_URL = 'https://obs-qrx.invalid/boot-timeout';
const TIMEOUT_MS = 8000;

function runWatchdog(): void {
  const src = buildWatchdogScript({ ingestUrl: INGEST_URL, timeoutMs: TIMEOUT_MS });
  // eslint-disable-next-line no-new-func -- deliberate black-box eval, see file header
  new Function('window', src)(window);
}

describe('buildWatchdogScript — black-box eval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete (window as unknown as { __WV_BOOTED__?: boolean }).__WV_BOOTED__;
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

    runWatchdog();
    // __WV_BOOTED__ never set — this is exactly the failure this script exists for.
    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    const [url, body] = sendBeacon.mock.calls[0];
    expect(url).toBe(INGEST_URL);
    expect(JSON.parse(body as string)).toEqual({
      event: 'boot_timeout',
      pathname: window.location.pathname,
      ts: 1700000000000 + TIMEOUT_MS,
    });
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
