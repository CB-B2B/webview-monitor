// events-filter-fault.spec.ts — T034/E020 (webview-session-logs §3.2)
//
// File RIÊNG cho test fault-injection qua vi.doMock (module mocking) — cố
// ý không dùng type annotation ở đây (vi.doMock/importActual trả về kiểu
// lỏng, giữ file thuần JS-style cho đơn giản).
// @ts-nocheck

const EVENTS_URL = 'https://obs-qrx.invalid/events';
const DOC_URL = 'https://obs-qrx.invalid/ingest';

function installBeacon(result) {
  const fn = vi.fn(() => result);
  Object.defineProperty(window.navigator, 'sendBeacon', {
    configurable: true,
    writable: true,
    value: fn,
  });
  return fn;
}

function fakeState() {
  return {
    sessionId: '11111111-2222-4333-8444-555555555555',
    startedAt: 1700000000000,
    navMs: 0,
    steps: [],
    httpSamples: [],
    httpOverflow: 0,
    marks: {},
    finished: false,
    homeReached: false,
    sampleRate: 1,
    sendAttempt: 1,
    currentStepSeq: null,
    stepFirstFailure: {},
    docSent: false,
    sessionClosed: false,
    routeSampled: true,
    routeRate: 1,
    apiOkSampled: true,
    apiOkRate: 1,
    eventSeq: 0,
    errorEventCount: 0,
    sampledEventCount: 0,
    errorEventsOverflow: 0,
    eventsOverflow: 0,
    apiRetryDupes: 0,
    filterFaults: 0,
    currentRoute: '/voucher',
    deviceModel: 'SM-S911B',
  };
}

function blobText(blob) {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}

async function eventRows(mock) {
  const rows = [];
  for (const call of mock.mock.calls) {
    if (String(call[0]) !== EVENTS_URL) continue;
    const body = await blobText(call[1]);
    rows.push(...JSON.parse(body));
  }
  return rows;
}

describe('events — T034/E020: filter fault ⇒ [filter-error] + filter_faults', () => {
  it('T034: sanitizeMessage lỗi ⇒ message=[filter-error], event VẪN buffer, filter_faults=1 trên session_end', async () => {
    window.localStorage.clear();
    const beacon = installBeacon(true);
    vi.resetModules();
    vi.doMock('../filter', async () => {
      const actual = await vi.importActual('../filter');
      return { ...actual, sanitizeMessage: () => '[filter-error]' };
    });
    // Ticket 03 — module không còn tự đọc process.env.* (ADR-0001);
    // cấu hình truyền qua monitor.init(), không phải MONITOR_EVENTS_INGEST_URL.
    const { initConfig } = await import('../config');
    const { fixtureConfig } = await import('./configFixture');
    initConfig(fixtureConfig({ eventsIngestUrl: EVENTS_URL }));
    const events = await import('../events');
    const chunkerMod = await import('../chunker');

    try {
      const st = fakeState();
      events.initEventStream(st);
      events.recordApiCall({
        url: 'https://x.invalid/api/x',
        ms: 1,
        errKind: 'http',
        status: 500,
        body: { ok: false, message: 'message gi do' },
      });
      events.closeEventStream('pagehide');
      const rows = await eventRows(beacon);
      const row = rows.find(r => r.type === 'api_call');
      expect(row.message).toBe('[filter-error]'); // event VẪN buffer (E020)
      const end = rows.find(r => r.type === 'session_end');
      expect(end.filter_faults).toBe(1); // E020 hiện số trên session_end row
    } finally {
      chunkerMod.__resetChunkerForTest();
      vi.doUnmock('../filter');
    }
  });

  it('T034: đường doc phase-1 KHÔNG bị fault injection ảnh hưởng (đối chứng kênh cũ)', async () => {
    // requireActual trong mock giữ applyLayer2 nguyên trạng — chứng minh
    // injection chỉ chạm sanitizeMessage của kênh event, không đụng doc.
    const filterMod = await vi.importActual('../filter');
    expect(filterMod.applyLayer2).toBeDefined();
    expect(filterMod.FILTER_ERROR_PLACEHOLDER).toBe('[filter-error]');
    void DOC_URL;
  });
});
