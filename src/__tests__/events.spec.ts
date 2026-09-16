// events.spec.ts — phase-2 (webview-session-logs §1.2/§2.3/§2.4)
// T001-T008, T010, T017, T018, T023-T026, T043, T044, T051, T053, T054, T058:
// recorder event stream — cổng sampling sticky 2 bit, caps 200/500, coalesce
// 10s, global error hooks, wire phẳng §0.8. Sandbox per-test (MONITOR_EVENTS_
// INGEST_URL đặt QUA TEST, không đụng jest.setup-env.js của phase-1).

import fc from 'fast-check';
import type { Mock } from 'vitest';
import {
  allBeaconBodies,
  allBeaconRows,
  beaconUrls,
  installFakeMonotonicClock,
  installNavigationTiming,
  installOnLine,
  installRandomUUID,
  installSendBeacon,
  loadMonitorSandbox,
  MonitorSandbox,
} from './testUtils';
import type { SessionState } from '../state';

const EVENTS_URL = 'https://obs-qrx.invalid/events';
const DOC_URL = 'https://obs-qrx.invalid/ingest';

function fakeState(overrides: Partial<SessionState> = {}): SessionState {
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
    ...overrides,
  };
}

async function rowsByUrl(mock: Mock, url: string): Promise<any[]> {
  const urls = beaconUrls(mock);
  const bodies = await allBeaconBodies(mock);
  const rows: any[] = [];
  urls.forEach((u, i) => {
    if (u === url) rows.push(...JSON.parse(bodies[i]));
  });
  return rows;
}

const eventRows = (mock: Mock) => rowsByUrl(mock, EVENTS_URL);
const docRows = (mock: Mock) => rowsByUrl(mock, DOC_URL);

describe('events — recorder (T001-T008, T017, T018, T023-T026, T043, T044)', () => {
  let sb: MonitorSandbox;
  let clock: ReturnType<typeof installFakeMonotonicClock>;
  let beacon: Mock;

  beforeEach(async () => {
    window.localStorage.clear();
    installNavigationTiming(0);
    installRandomUUID(true);
    installOnLine(true);
    clock = installFakeMonotonicClock(0);
    beacon = installSendBeacon(true);
    sb = await loadMonitorSandbox({ eventsUrl: EVENTS_URL });
  });

  afterEach(() => {
    sb.index.__resetMonitorForTest();
    clock.restore();
  });

  // T001 (FR-001) — route_view mang route chuẩn hoá, KHÔNG query.
  it('T001: chuyển pathname ⇒ 1 row route_view mang route chuẩn hoá (bỏ query)', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    sb.events.recordRoute('/voucher?token=eyJhbGciOiJIUzI1NiJ9&src=push');
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe('route_view');
    expect(rows[0].route).toBe('/voucher'); // query bỏ hoàn toàn
    expect(rows[0].route).not.toContain('token');
  });

  // T056 (FR-001) — chuỗi Navigate / → /brand-new ⇒ 2 row, không dedup.
  it('T056: / → /brand-new ⇒ 2 row route_view (timeline phản ánh đúng sự thật)', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    sb.events.recordRoute('/');
    sb.events.recordRoute('/brand-new');
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    expect(rows.map((r: any) => r.route)).toEqual(['/', '/brand-new']);
  });

  // T002 (FR-002) — MỘT call HAI đầu ra: row api_call + http_samples[] legacy.
  it('T002: api_call thành công ⇒ 1 row + http_samples[] legacy nạp song song', async () => {
    sb.monitor.start();
    sb.monitor.http(
      'https://vpbank-svc.atcashback.com/api/pay?sig=1',
      'POST',
      12,
      undefined,
      200,
      { ok: true },
    );
    sb.chunker.flush('timer');
    sb.monitor.finish('home_shown');
    const rows = await eventRows(beacon);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe('api_call');
    expect(rows[0].endpoint).toBe('/api/pay');
    expect(rows[0].method).toBe('POST');
    expect(rows[0].status).toBe(200);
    expect(rows[0].latency_ms).toBe(12);
    // đầu ra thứ hai: doc phase-1 vẫn có http_samples
    const docs = await docRows(beacon);
    expect(docs.length).toBe(1);
    expect(docs[0].http_samples.length).toBe(1);
    expect(docs[0].http_samples[0].url).toBe('/api/pay');
  });

  // T003 (FR-002/FR-015) — row lỗi KHÔNG qua cổng sampling (sticky 2 bit §0.9).
  it('T003: api_call thất bại ⇒ row err_kind, KHÔNG qua cổng sampling (sticky false)', async () => {
    const st = fakeState({ routeSampled: false, apiOkSampled: false });
    sb.events.initEventStream(st);
    sb.events.recordApiCall({
      url: 'https://x.invalid/api/pay',
      method: 'POST',
      ms: 30,
      errKind: 'http',
      status: 500,
      body: { ok: false, code: 'PAY_FAIL', message: 'He thong ban' },
    });
    // thành công cùng lúc ⇒ bị sticky bit gạt (đối chứng chiều ngược)
    sb.events.recordApiCall({ url: 'https://x.invalid/api/ok', ms: 5 });
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe('api_call');
    expect(rows[0].err_kind).toBe('http');
    expect(rows[0].code).toBe('PAY_FAIL');
    expect(rows[0].message).toBe('He thong ban');
  });

  // T004 (FR-004) — HTTP 200 + body success:false ⇒ business_error từ body THÔ
  // (cờ success bề mặt status<400 KHÔNG được dùng — nếu dùng thì đây là
  // api_call thành công chứ không phải business_error).
  it('T004: HTTP 200 + body success:false ⇒ row business_error mang code+message body thô', async () => {
    sb.monitor.start();
    sb.monitor.http(
      'https://x.invalid/api/withdraw',
      'POST',
      20,
      undefined,
      200,
      {
        ok: false,
        code: 'INSUFFICIENT_BALANCE',
        message: 'So du khong du',
      },
    );
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe('business_error');
    expect(rows[0].status).toBe(200);
    expect(rows[0].code).toBe('INSUFFICIENT_BALANCE');
    expect(rows[0].message).toBe('So du khong du');
  });

  // T005 (FR-003) — window.onerror ⇒ js_error code=err.name, route=currentRoute.
  it('T005: window error ⇒ row js_error với code=err.name, route=màn đang đứng', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    sb.events.installGlobalErrorHooks();
    sb.events.recordRoute('/withdraw/confirm'); // currentRoute
    window.dispatchEvent(
      new ErrorEvent('error', {
        error: new TypeError('khong the doc property'),
        message: 'khong the doc property',
      }),
    );
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    expect(rows.length).toBe(2);
    const jsErr = rows.find((r: any) => r.type === 'js_error');
    expect(jsErr.code).toBe('TypeError');
    expect(jsErr.route).toBe('/withdraw/confirm');
  });

  // T006 (FR-003) — unhandledrejection ⇒ js_error tương tự T005.
  it('T006: unhandledrejection ⇒ row js_error, handler không crash', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    sb.events.installGlobalErrorHooks();
    // jsdom không có PromiseRejectionEvent — Event thường + reason gắn tay
    const ev = new Event('unhandledrejection');
    (ev as any).reason = new Error('promise tu choi');
    expect(() => window.dispatchEvent(ev)).not.toThrow();
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    const jsErr = rows.find((r: any) => r.type === 'js_error');
    expect(jsErr).toBeDefined();
    expect(jsErr.code).toBe('Error');
  });

  // T007 (FR-002/FR-014) — pagehide ⇒ session_end row mang counters, row cuối
  // cùng trước final flush; doc phase-1 phát SAU (beacon cuối là doc).
  it('T007: pagehide ⇒ session_end row cuối + finish_reason + 4 counter tràn, doc phát sau', async () => {
    sb.monitor.start();
    sb.monitor.route('/voucher');
    sb.monitor.finish('pagehide');
    const rows = await eventRows(beacon);
    const last = rows[rows.length - 1];
    expect(last.type).toBe('session_end');
    expect(last.finish_reason).toBe('pagehide');
    expect(last.error_events_overflow).toBe(0);
    expect(last.events_overflow).toBe(0);
    expect(last.api_retry_dupes).toBe(0);
    expect(last.filter_faults).toBe(0);
    // beacon CUỐI CÙNG là doc phase-1 (tổng ≤3 beacon lúc chết trang — R2-7)
    const urls = beaconUrls(beacon);
    expect(urls[urls.length - 1]).toBe(DOC_URL);
  });

  // T008 (FR-005/FR-006) — EventRow mang đủ trường phẳng như doc cùng phiên.
  it('T008: EventRow mang session_id + release_version + env_name + device_model khớp doc', async () => {
    sb.monitor.start();
    const id = sb.index.sessionId();
    sb.monitor.route('/voucher');
    sb.monitor.finish('pagehide');
    const rows = await eventRows(beacon);
    const row = rows.find((r: any) => r.type === 'route_view');
    const docs = await docRows(beacon);
    expect(row.session_id).toBe(id);
    expect(typeof row.session_id).toBe('string');
    expect(row.release_version).toBe(docs[0].env.release_version);
    expect(row.env_name).toBeDefined();
    expect(row.device_model).toBe(docs[0].device_model);
    expect(typeof row.session_started_at).toBe('number');
  });

  // T010 (FR-015) — đảo sampling: rate 2 bit = 0 ⇒ doc vẫn gửi sample_rate 1,
  // sessionId khác rỗng, route_view/api_ok không ghi, LỖI vẫn ghi đủ.
  it('T010: route/api_ok rate=0 ⇒ doc vẫn gửi sample_rate:1, lỗi đầy đủ, không route_view/api_ok', async () => {
    sb.flag.__setCachedFlagForTest({
      enabled: true,
      rate: 1,
      http: true,
      steps: true,
      route_sample_rate: 0,
      api_ok_sample_rate: 0,
    });
    sb.monitor.start();
    expect(sb.index.sessionId()).not.toBe('');
    sb.monitor.route('/voucher');
    sb.monitor.http('https://x.invalid/api/ok', 'GET', 5, undefined, 200, {
      ok: true,
    });
    sb.monitor.http('https://x.invalid/api/bad', 'GET', 5, 'http', 500);
    sb.chunker.flush('timer');
    sb.monitor.finish('home_shown');
    const rows = await eventRows(beacon);
    expect(rows.map((r: any) => r.type)).toEqual(['api_call']); // chỉ lỗi
    expect(rows[0].err_kind).toBe('http');
    const docs = await docRows(beacon);
    expect(docs[0].sample_rate).toBe(1);
  });

  // T010 — flag thiếu cả 2 field rate (JSON phase-1 thuần) ⇒ bit sticky mặc
  // định 1: route_view/api_ok VẪN ghi (§2.2 default; §0.9 QĐ-16).
  it('T010: flag phase-1 không khai rate mới ⇒ sticky bit mặc định 1, event vẫn ghi', async () => {
    sb.flag.__setCachedFlagForTest({
      enabled: true,
      rate: 1,
      http: true,
      steps: true, // KHÔNG khai route_sample_rate/api_ok_sample_rate
    });
    sb.monitor.start();
    sb.monitor.route('/voucher');
    sb.monitor.http('https://x.invalid/api/ok', 'GET', 5, undefined, 200, {
      ok: true,
    });
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    expect(rows.map((r: any) => r.type)).toEqual(['route_view', 'api_call']);
  });

  // T017 (FR-014/R2-6) — hidden ⇒ flush checkpoint, stream TIẾP TỤC khi visible.
  it('T017: visibilitychange hidden ⇒ flush checkpoint, ghi tiếp khi visible lại', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    sb.events.recordRoute('/voucher');
    // hidden — flush đồng bộ checkpoint
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    let rows = await eventRows(beacon);
    expect(rows.length).toBe(1);
    // visible lại — stream tiếp tục ghi, CÙNG session
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    sb.events.recordRoute('/withdraw');
    sb.chunker.flush('timer');
    rows = await eventRows(beacon);
    expect(rows.length).toBe(2);
    expect(rows[1].route).toBe('/withdraw');
    expect(rows[1].session_id).toBe(rows[0].session_id);
    delete (document as any).visibilityState; // trả về getter mặc định jsdom
  });

  // T018 (FR-002/R2-6) — finish('home_shown') ⇒ doc gửi nhưng recorder KHÔNG dừng.
  it('T018: finish(home_shown) ⇒ doc gửi nhưng api_call sau Home vẫn có row', async () => {
    sb.monitor.start();
    sb.monitor.finish('home_shown');
    const docs1 = await docRows(beacon);
    expect(docs1.length).toBe(1); // doc đã phát đúng 1 lần
    sb.monitor.http('https://x.invalid/api/after-home', 'GET', 7);
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe('api_call');
    expect(rows[0].endpoint).toBe('/api/after-home');
    const docs2 = await docRows(beacon);
    expect(docs2.length).toBe(1); // doc KHÔNG phát lần 2
  });

  // T023 (FR-015) — ERROR_EVENTS_CAP BVA: lỗi 199, 200 ghi.
  it('T023: lỗi thứ 199 và 200 VẪN ghi (cap 200)', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    for (let i = 0; i < 200; i += 1) {
      sb.events.recordApiCall({
        url: `https://x.invalid/api/e${i}`,
        ms: 1,
        errKind: 'http',
        status: 500,
      });
    }
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    expect(rows.filter((r: any) => r.type === 'api_call').length).toBe(200);
    expect(st.errorEventsOverflow).toBe(0);
  });

  // T023 — lỗi thứ 201 bị cắt + error_events_overflow=1 (hiện số session_end).
  it('T023: lỗi thứ 201 bị cắt + error_events_overflow=1 trên session_end row', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    for (let i = 0; i < 201; i += 1) {
      sb.events.recordApiCall({
        url: `https://x.invalid/api/e${i}`,
        ms: 1,
        errKind: 'http',
        status: 500,
      });
    }
    sb.events.closeEventStream('pagehide');
    const rows = await eventRows(beacon);
    expect(rows.filter((r: any) => r.type === 'api_call').length).toBe(200);
    const end = rows.find((r: any) => r.type === 'session_end');
    expect(end.error_events_overflow).toBe(1);
  });

  // T024 (FR-015/QĐ-12) — SAMPLED_EVENTS_CAP BVA: 499, 500 ghi.
  it('T024: event mẫu thứ 499 và 500 VẪN ghi (cap 500, rate=1)', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    for (let i = 0; i < 500; i += 1) {
      sb.events.recordRoute('/voucher');
    }
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    expect(rows.filter((r: any) => r.type === 'route_view').length).toBe(500);
    expect(st.eventsOverflow).toBe(0);
  });

  // T024 — event thứ 501 bị cắt + events_overflow.
  it('T024: event mẫu thứ 501 bị cắt + events_overflow=1', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    for (let i = 0; i < 501; i += 1) {
      sb.events.recordRoute('/voucher');
    }
    sb.events.closeEventStream('pagehide');
    const rows = await eventRows(beacon);
    expect(rows.filter((r: any) => r.type === 'route_view').length).toBe(500);
    const end = rows.find((r: any) => r.type === 'session_end');
    expect(end.events_overflow).toBe(1);
  });

  // T025 (FR-002/§10b) — Coalesce BVA: cùng key cách 9s ⇒ gộp, giữ anchor.
  // Tiên quyết ARC-m8: KHÔNG có flush chen giữa hai lần lỗi.
  it('T025: cùng key cách 9s ⇒ gộp (coalesce_count+1, giữ anchor t_offset/seq)', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    sb.events.recordApiCall({
      url: 'https://x.invalid/api/storm',
      ms: 10,
      errKind: 'http',
      status: 502,
    });
    clock.advance(9000); // trong cửa sổ 10s
    sb.events.recordApiCall({
      url: 'https://x.invalid/api/storm',
      ms: 25,
      errKind: 'http',
      status: 502,
    });
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    expect(rows.length).toBe(1); // anchor mutate, KHÔNG row mới
    expect(rows[0].coalesce_count).toBe(2);
    expect(rows[0].seq).toBe(1); // seq giữ anchor lần đầu
    expect(rows[0].t_offset).toBe(0); // t_offset giữ anchor
    expect(rows[0].latency_ms).toBe(25); // latency lần gần nhất
    expect(st.apiRetryDupes).toBe(1);
  });

  // T025 — 11s (ngoài cửa sổ) ⇒ row mới.
  it('T025: cùng key cách 11s ⇒ row MỚI (ngoài cửa sổ 10s)', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    sb.events.recordApiCall({
      url: 'https://x.invalid/api/storm',
      ms: 10,
      errKind: 'http',
      status: 502,
    });
    clock.advance(11000);
    sb.events.recordApiCall({
      url: 'https://x.invalid/api/storm',
      ms: 10,
      errKind: 'http',
      status: 502,
    });
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    expect(rows.length).toBe(2);
    expect(rows[0].coalesce_count).toBeUndefined();
    expect(rows[1].coalesce_count).toBeUndefined();
  });

  // T026 (FR-010) — message cắt 512 / code cắt 128 (BVA tại đúng ngưỡng).
  it('T026: message 512 giữ nguyên, 513 cắt còn 512; code 128 giữ, 129 cắt còn 128', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    const msg512 = 'khong co gi dang ghi la '.repeat(23).slice(0, 512); // sạch
    const msg513 = `${msg512}x`;
    sb.events.recordApiCall({
      url: 'https://x.invalid/api/a',
      ms: 1,
      errKind: 'http',
      status: 500,
      body: { ok: false, code: 'E_' + 'a'.repeat(126), message: msg512 },
    });
    sb.events.recordApiCall({
      url: 'https://x.invalid/api/b',
      ms: 1,
      errKind: 'http',
      status: 500,
      body: { ok: false, code: 'E_' + 'a'.repeat(127), message: msg513 },
    });
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    const a = rows.find((r: any) => r.endpoint === '/api/a');
    const b = rows.find((r: any) => r.endpoint === '/api/b');
    expect(a.message.length).toBe(512);
    expect(b.message.length).toBe(512);
    expect(a.code.length).toBe(128);
    expect(b.code.length).toBe(128);
  });

  // §5.3.4 code charset kênh kho — code lệch /^[A-Za-z0-9_.:-]{1,128}$/ sau
  // khi slice ⇒ BỎ field (field vắng mặt), không redact (chốt một hành vi).
  it('T026b: code lệch charset §5.3.4 ⇒ field code vắng mặt trên EventRow', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    sb.events.recordApiCall({
      url: 'https://x.invalid/api/cs1',
      ms: 1,
      errKind: 'http',
      status: 500,
      body: { ok: false, code: 'CO SO KHOANG TRANG-!' }, // dấu cách ⇒ lệch charset
    });
    sb.events.recordApiCall({
      url: 'https://x.invalid/api/cs2',
      ms: 1,
      errKind: 'http',
      status: 500,
      body: { ok: false, code: 'E_100%:OK' }, // '%' không thuộc whitelist
    });
    sb.events.recordApiCall({
      url: 'https://x.invalid/api/cs3',
      ms: 1,
      errKind: 'http',
      status: 500,
      body: { ok: false, code: 'E_OK:x-1.2' }, // hợp lệ ⇒ giữ
    });
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    const cs1 = rows.find((r: any) => r.endpoint === '/api/cs1');
    const cs2 = rows.find((r: any) => r.endpoint === '/api/cs2');
    const cs3 = rows.find((r: any) => r.endpoint === '/api/cs3');
    expect(cs1.code).toBeUndefined();
    expect('code' in cs1).toBe(false); // field ABSENT, không phải chuỗi rỗng
    expect(cs2.code).toBeUndefined();
    expect('code' in cs2).toBe(false);
    expect(cs3.code).toBe('E_OK:x-1.2');
  });

  // T043 (FR-014/§1.6) — EVENTS_INGEST_URL rỗng ⇒ không buffer, không outbox
  // (trạng thái TẮT do chưa cấu hình — không dựng hạ tầng không xả được).
  it('T043: MONITOR_EVENTS_INGEST_URL rỗng ⇒ không event beacon, không outbox item', async () => {
    const off = await loadMonitorSandbox({}); // không đặt eventsUrl
    try {
      off.monitor.start();
      expect(off.index.sessionId()).not.toBe(''); // doc channel vẫn sống
      off.monitor.route('/voucher');
      off.monitor.http('https://x.invalid/api/x', 'GET', 1, 'http', 500);
      off.monitor.finish('pagehide');
      const urls = beaconUrls(beacon); // mock từ beforeEach — dùng chung
      expect(urls).toEqual([DOC_URL]); // CHỈ doc — không beacon event nào
      expect(off.outbox.readOutbox().length).toBe(0);
    } finally {
      off.index.__resetMonitorForTest();
    }
  });

  // T044 (FR-003) — lỗi nảy sinh trong chính global error hook ⇒ bỏ, không
  // đệ quy sinh js_error mới (số row không tăng sau lỗi nội bộ).
  it('T044: lỗi trong chính hook ⇒ nuốt, không đệ quy sinh js_error mới', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    sb.events.installGlobalErrorHooks();
    // performance.now() ném đúng 1 lần — trackEvent vỡ NGAY TRONG handler
    const spy = vi.spyOn(performance, 'now');
    spy.mockImplementationOnce(() => {
      throw new Error('clock broken');
    });
    expect(() =>
      window.dispatchEvent(
        new ErrorEvent('error', { error: new Error('loi dau') }),
      ),
    ).not.toThrow();
    // lần 2 đồng hồ hoạt động lại ⇒ đúng 1 row js_error (của lần 2)
    window.dispatchEvent(
      new ErrorEvent('error', { error: new Error('loi sau') }),
    );
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    expect(rows.filter((r: any) => r.type === 'js_error').length).toBe(1);
    spy.mockRestore();
  });

  // CR-M1 (post-impl r1, §2.2/§0.9) — sample_rate trên EventRow là BẢN CHỤP
  // rate tại thời điểm _start() bốc sticky bit, KHÔNG PHẢI cờ live: fetchFlag
  // giữa phiên (đúng tuần rollout 1→0.1) đổi rate ⇒ row vẫn mang rate của
  // lúc bốc bit, phép ngoại suy funnel NFR-003 không bị lệch cửa sổ đo mẫu.
  it('CR-M1: fetchFlag đổi rate giữa phiên ⇒ row.sample_rate giữ rate lúc bốc sticky bit', async () => {
    sb.flag.__setCachedFlagForTest({
      enabled: true,
      rate: 1,
      http: true,
      steps: true,
      route_sample_rate: 0.5,
    });
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.1); // < 0.5 ⇒ routeSampled
    try {
      sb.monitor.start();
      // cờ live đổi GIỮA PHIÊN (giá trị fetchFlag persist cho phiên kế tiếp)
      sb.flag.__setCachedFlagForTest({
        enabled: true,
        rate: 1,
        http: true,
        steps: true,
        route_sample_rate: 0.1,
      });
      sb.monitor.route('/voucher');
      sb.chunker.flush('timer');
      const rows = await eventRows(beacon);
      expect(rows.length).toBe(1);
      expect(rows[0].sample_rate).toBe(0.5); // bản chụp, KHÔNG phải 0.1 live
    } finally {
      rnd.mockRestore();
    }
  });

  // ARC-M1 (post-impl r1, §2.4b "Chỉ áp row lỗi (api_call thất bại +
  // business_error)") — js_error DỪNG Ở NGOÀI coalesce: 2 TypeError trùng
  // name khác message trong 10s phải là 2 row riêng; gộp sẽ làm message thứ 2
  // mất khỏi wire và phình api_retry_dupes.
  it('ARC-M1: 2 js_error trùng name khác message trong 10s ⇒ 2 row riêng, dupes không tăng', async () => {
    const sbGa = await loadMonitorSandbox({ eventsUrl: EVENTS_URL });
    try {
      const st = fakeState();
      sbGa.events.initEventStream(st);
      sbGa.events.trackEvent({
        type: 'js_error',
        code: 'TypeError',
        message: 'loi thu nhat',
      });
      clock.advance(1000); // TRONG cửa sổ 10s — điều kiện từng bị gộp
      sbGa.events.trackEvent({
        type: 'js_error',
        code: 'TypeError',
        message: 'loi thu hai',
      });
      sbGa.chunker.flush('timer');
      // Kênh kho: 2 row riêng, đủ 2 message trên wire
      const rows = await eventRows(beacon);
      const jsErrors = rows.filter((r: any) => r.type === 'js_error');
      expect(jsErrors.length).toBe(2); // KHÔNG gộp — 2 row riêng
      expect(jsErrors.map((r: any) => r.message)).toEqual([
        'loi thu nhat',
        'loi thu hai',
      ]);
      expect(st.apiRetryDupes).toBe(0); // js_error không nuôi api_retry_dupes
      expect(st.errorEventCount).toBe(2); // cap 200 vẫn đếm đủ (§2.4b)
    } finally {
      sbGa.index.__resetMonitorForTest();
    }
  });

  // SEC-n2 (post-impl r1) — finish_reason của session_end phải validate
  // against enum FinishReason: cast `as FinishReason` một mình cho chuỗi lạ
  // lên wire; code lạ ⇒ omit field, row vẫn phát.
  it('SEC-n2: session_end code lạ ⇒ row vẫn phát nhưng KHÔNG có finish_reason', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    sb.monitor.event({ type: 'session_end', code: 'bogus' as any });
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    const end = rows.find((r: any) => r.type === 'session_end');
    expect(end).toBeDefined(); // row vẫn phát
    expect('finish_reason' in end).toBe(false); // field ABSENT
    expect(end.api_retry_dupes).toBe(0); // counters khác không bị ảnh hưởng
  });

  // T034 (E020) row-level — chuyển sang events-filter-fault.spec.ts (riêng
  // file): vi.doMock khiến pipeline transform babel hoá cả file, không để
  // được type annotation ở đây.
});

// ─── T058 — coalesce multi-key (PERF-M2 r1-TS) ──────────────────────────────
describe('events — T058 coalesce multi-key (§2.4b)', () => {
  let sb: MonitorSandbox;
  let clock: ReturnType<typeof installFakeMonotonicClock>;
  let beacon: Mock;

  beforeEach(async () => {
    window.localStorage.clear();
    installNavigationTiming(0);
    installRandomUUID(true);
    installOnLine(true);
    clock = installFakeMonotonicClock(0);
    beacon = installSendBeacon(true);
    sb = await loadMonitorSandbox({ eventsUrl: EVENTS_URL });
  });

  afterEach(() => {
    sb.index.__resetMonitorForTest();
    clock.restore();
  });

  // 2 key lỗi luân phiên A,B,A,B mỗi 1s trong 15s ⇒ đúng 2 row, mỗi row mang
  // volume thật (coalesce_count); storm không cạn cap 200 trong ~40s.
  it('T058: A,B,A,B mỗi 1s trong 15s ⇒ đúng 2 row, coalesce_count đúng volume', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    for (let i = 0; i < 15; i += 1) {
      sb.events.recordApiCall({
        url: `https://x.invalid/api/${i % 2 === 0 ? 'aaa' : 'bbb'}`,
        ms: 1,
        errKind: 'http',
        status: 502,
      });
      clock.advance(1000);
    }
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    expect(rows.length).toBe(2); // 1 anchor cho A + 1 cho B
    const byEp: Record<string, any> = {};
    rows.forEach((r: any) => {
      byEp[r.endpoint] = r;
    });
    expect(byEp['/api/aaa'].coalesce_count).toBe(8); // A: lần 0,2,...,14
    expect(byEp['/api/bbb'].coalesce_count).toBe(7); // B: lần 1,3,...,13
    expect(st.apiRetryDupes).toBe(13);
    expect(st.errorEventCount).toBe(2); // storm tiêu 2/200 chứ không 15
  });

  // Anchor đã flush ⇒ row MỚI kế thừa coalesce_count tích luỹ (volume không mất).
  it('T058: anchor đã flush ⇒ row mới kế thừa count tích lũy', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    sb.events.recordApiCall({
      url: 'https://x.invalid/api/aaa',
      ms: 1,
      errKind: 'http',
      status: 502,
    });
    sb.chunker.flush('timer'); // anchor rời buffer
    clock.advance(1000); // trong cửa sổ 10s
    sb.events.recordApiCall({
      url: 'https://x.invalid/api/aaa',
      ms: 2,
      errKind: 'http',
      status: 502,
    });
    sb.chunker.flush('timer');
    const rows = await eventRows(beacon);
    expect(rows.length).toBe(2);
    expect(rows[1].coalesce_count).toBe(2); // kế thừa count tích luỹ
    expect(rows[1].seq).toBe(2); // row mới có seq mới
  });
});

// ─── T051/T053/T054 — property + wire phẳng §0.8 ────────────────────────────
describe('events — property T051/T053 + wire phẳng T054', () => {
  let sb: MonitorSandbox;
  let beacon: Mock;

  beforeEach(async () => {
    window.localStorage.clear();
    installNavigationTiming(0);
    installRandomUUID(true);
    installOnLine(true);
    beacon = installSendBeacon(true);
    sb = await loadMonitorSandbox({ eventsUrl: EVENTS_URL });
  });

  afterEach(() => {
    sb.index.__resetMonitorForTest();
  });

  // T051 — seq đơn điệu tăng dần, không trùng; row bị sampling KHÔNG tiêu seq.
  it('T051: property — seq liên tục 1..n, row sampling không tiêu seq', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('route', 'ok', 'err'), {
          maxLength: 30,
        }),
        async (kinds: string[]) => {
          window.localStorage.clear();
          beacon.mockClear();
          const st = fakeState({ routeSampled: false, apiOkSampled: false });
          sb.events.initEventStream(st);
          let i = 0;
          for (const k of kinds) {
            i += 1;
            if (k === 'route') sb.events.recordRoute('/voucher');
            else if (k === 'ok')
              sb.events.recordApiCall({
                url: `https://x.invalid/ok${i}`,
                ms: 1,
              });
            else
              sb.events.recordApiCall({
                url: `https://x.invalid/err${i}`,
                ms: 1,
                errKind: 'http',
                status: 500,
              });
          }
          sb.chunker.flush('timer');
          const rows = await allBeaconRows(beacon);
          const errors = rows.filter((r: any) => r.err_kind !== undefined);
          // sticky false ⇒ chỉ lỗi được buffer, và seq vẫn LIÊN TỤC từ 1
          expect(errors.length).toBe(kinds.filter(k => k === 'err').length);
          errors.forEach((r: any, idx: number) => {
            expect(r.seq).toBe(idx + 1); // không trùng, không nhảy cóc
          });
          return true;
        },
      ),
      { numRuns: 25 },
    );
  });

  // T053 — EventRow serialize chỉ chứa keys thuộc schema §2.2 — builder đóng
  // allowlist trường (§5.3.5), input có key lạ cũng không phát sinh field lạ.
  it('T053: property — EventRow chỉ chứa keys thuộc schema §2.2', async () => {
    const ROW_KEYS = new Set([
      'record_type',
      'session_id',
      'session_started_at',
      't_offset',
      'seq',
      'type',
      'route',
      'sample_rate',
      'release_version',
      'env_name',
      'device_model',
      'endpoint',
      'method',
      'status',
      'err_kind',
      'code',
      'message',
      'latency_ms',
      'coalesce_count',
      'finish_reason',
      'error_events_overflow',
      'events_overflow',
      'api_retry_dupes',
      'filter_faults',
    ]);
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            kind: fc.constantFrom('route', 'ok', 'err', 'js', 'end'),
            msg: fc.option(fc.string({ maxLength: 50 }), { nil: undefined }),
            code: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
          }),
          { maxLength: 12 },
        ),
        async (evts: any[]) => {
          window.localStorage.clear();
          beacon.mockClear();
          const st = fakeState();
          sb.events.initEventStream(st);
          for (const e of evts) {
            // Bơm key lạ TRỰC TIẾP vào EventInput — builder phải dựng row
            // field-by-field, key lạ không được phát sinh field lạ (§5.3.5).
            const junk = {
              device_model: 'KHONG_DUOC_LEN_WIRE',
              user_id: 'cua_nguoi_dung',
              junk_field: 'la',
            };
            if (e.kind === 'route') sb.events.recordRoute('/voucher');
            else if (e.kind === 'ok')
              sb.events.recordApiCall({ url: 'https://x.invalid/ok', ms: 1 });
            else if (e.kind === 'err')
              sb.events.trackEvent({
                type: 'api_call',
                endpoint: 'https://x.invalid/err',
                latencyMs: 1,
                errKind: 'http',
                status: 500,
                ...(e.msg !== undefined ? { message: e.msg } : {}),
                ...(e.code !== undefined ? { code: e.code } : {}),
                ...junk,
              } as any);
            else if (e.kind === 'js')
              sb.events.trackEvent({
                type: 'js_error',
                code: 'Error',
                message: e.msg,
                ...junk,
              } as any);
            else sb.events.closeEventStream('pagehide');
          }
          sb.chunker.flush('pagehide');
          const rows = await allBeaconRows(beacon);
          for (const row of rows) {
            Object.keys(row).forEach(k => {
              expect(ROW_KEYS.has(k)).toBe(true);
            });
          }
          return true;
        },
      ),
      { numRuns: 25 },
    );
  });

  // T054 — wire phẳng §0.8: trường tra cứu timeline là scalar top-level.
  it('T054: mọi row có 7 trường tra cứu timeline scalar top-level, không lồng', async () => {
    const st = fakeState();
    sb.events.initEventStream(st);
    sb.events.recordRoute('/voucher');
    sb.events.recordApiCall({
      url: 'https://x.invalid/err',
      ms: 3,
      errKind: 'http',
      status: 500,
      body: { ok: false, code: 'E_X', message: 'loi gi do' },
    });
    sb.events.closeEventStream('pagehide');
    const rows = await allBeaconRows(beacon);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(typeof row.session_id).toBe('string');
      expect(typeof row.session_started_at).toBe('number');
      expect(typeof row.t_offset).toBe('number');
      expect(typeof row.seq).toBe('number');
      expect(typeof row.type).toBe('string');
      expect(typeof row.route).toBe('string');
      expect(typeof row.device_model).toBe('string');
      // FR-007: 100% phẳng — không giá trị lồng (object/array) trên row
      Object.values(row).forEach(v => {
        expect(v === null || typeof v !== 'object').toBe(true);
      });
    }
  });
});
