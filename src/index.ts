// src/utils/monitor/index.ts
//
// Bề mặt công khai của module giám sát webview-monitoring giai đoạn 1 +
// giai đoạn 2 (webview-session-logs: event stream). Đúng 3 file
// được phép import module này: src/app.ts, src/layouts/index.tsx,
// src/utils/request.ts (§1.1 luật phụ thuộc — phase-2 giữ nguyên 3 file).
//
// monitor.ts KHÔNG BAO GIỜ throw ra ngoài (NFR-001) — mọi hàm công khai
// trừ `step()` bọc bằng safe(); `step()` rethrow nguyên trạng lỗi nghiệp
// vụ, chỉ phần bookkeeping của chính module nằm trong try/catch lồng.
//
// phase-2 (R2-6): vòng đời doc phase-1 và event stream TÁCH — doc phát
// đúng 1 lần tại finish đầu tiên (docSent); event stream ghi tiếp sau Home
// tới pagehide (sessionClosed); guard của _http/_mark/step đổi sang
// sessionClosed.

import { applyLayer2 } from './filter';
import {
  __resetTransportForTest,
  dispatch,
  drainOutbox,
  TransportDeps,
} from './transport';
import { __resetConfigForTest } from './config';
import {
  effectiveApiOkRate,
  effectiveRouteRate,
  fetchFlag,
  getCachedFlag,
} from './flag';
import { getConfig, initConfig, MonitorConfig } from './config';
import { buildPayload } from './payload';
import { normalizeApiUrl } from './routes';
import { pruneExpired } from './outbox';
import { initStepResults, SessionState } from './state';
import {
  ErrKind,
  EventInput,
  FinishReason,
  HttpBodyInfo,
  MarkName,
  StepName,
} from './types';
import { detectDeviceModel, refineDeviceModel } from './env';
import * as events from './events';
import { __resetChunkerForTest as resetChunkerForTest } from './chunker';

export { buildWatchdogScript } from './watchdog';
export type { WatchdogScriptConfig } from './watchdog';

export type { MonitorConfig } from './config';
export type {
  ErrKind,
  StepName,
  MarkName,
  FinishReason,
  EventKind,
  EventInput,
  EventRow,
  HttpBodyInfo,
} from './types';

// Config host-supplied (ADR-0001/ADR-0002) — gọi `init(config)` TRƯỚC
// start()/attachLifecycle(). Đọc ở MỘT chỗ duy nhất là ./config (R3-M4).
// Luật literal tĩnh của define() (xem chú thích dài ở ./config.ts) vẫn
// được tôn trọng: index.ts không còn viết `process.env.<tên-khác>` nào
// ngoài guard L2 `process.env.MONITOR`.

let state: SessionState | null = null;
let lifecycleAttached = false;

// ADR-0002 nhóm identity/shape — throw đồng bộ, KHÔNG bọc safe(): lỗi
// khai báo tại call site của host (host developer's own terminal), không
// phải điều kiện runtime NFR-001 nói tới — xem docs/adr/0002.
function _init(config: MonitorConfig): void {
  initConfig(config);
}

// ─── Bookkeeping nội bộ (KHÔNG throw ra safe()/step()) ────────────────────

function getNavigationStart(): number {
  try {
    const entries = performance.getEntriesByType('navigation');
    if (entries && entries.length > 0) {
      const origin =
        typeof (performance as unknown as { timeOrigin?: number })
          .timeOrigin === 'number'
          ? (performance as unknown as { timeOrigin: number }).timeOrigin
          : Date.now();
      return origin + (entries[0] as PerformanceEntry).startTime;
    }
  } catch {
    /* fallthrough */
  }
  try {
    const navStart = (
      performance as unknown as { timing?: { navigationStart?: number } }
    ).timing?.navigationStart;
    if (typeof navStart === 'number' && navStart > 0) return navStart;
  } catch {
    /* fallthrough */
  }
  return Date.now();
}

function classifyHost(url: string): 'main' | 'sys' | 'other' {
  const { mainEndpoint, sysEndpoint } = getConfig();
  if (mainEndpoint && url.indexOf(mainEndpoint) === 0) return 'main';
  if (sysEndpoint && url.indexOf(sysEndpoint) === 0) return 'sys';
  return 'other';
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * FR-008: mã tra cứu NGẪU NHIÊN THUẦN, không suy ra được từ token/user
 * id/thời gian. E008: thiếu crypto.randomUUID ⇒ fallback getRandomValues,
 * fallback cuối Math.random — CẢ HAI fallback đều đặt `sid_weak: true`,
 * không im lặng hạ chuẩn.
 */
function generateSessionId(): { id: string; weak?: true } {
  try {
    if (
      typeof crypto !== 'undefined' &&
      typeof crypto.randomUUID === 'function'
    ) {
      return { id: crypto.randomUUID() };
    }
  } catch {
    /* fallthrough */
  }
  try {
    if (
      typeof crypto !== 'undefined' &&
      typeof crypto.getRandomValues === 'function'
    ) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = toHex(bytes);
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      return { id, weak: true };
    }
  } catch {
    /* fallthrough */
  }
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
  return { id, weak: true };
}

// phase-2 R2-6: guard đổi từ state.finished (doc đã gửi) sang state.
// sessionClosed (stream đã đóng) — bước vẫn bookkeep sau Home cho tới khi
// trang chết.
function recordStepOk(idx: number, t0: number): void {
  if (!state || state.sessionClosed) return;
  const s = state.steps[idx];
  if (!s) return;
  s.started_at_offset = t0 - state.navMs;
  s.ms = performance.now() - t0;
  s.status = 'ok';
}

function recordStepError(idx: number, t0: number, err: unknown): void {
  if (!state || state.sessionClosed) return;
  const s = state.steps[idx];
  if (!s) return;
  s.started_at_offset = t0 - state.navMs;
  s.ms = performance.now() - t0;
  s.status = 'error';
  const failure = state.stepFirstFailure[idx];
  if (failure) {
    s.http_status = failure.status;
    s.failed_endpoint = failure.endpoint;
    s.err_kind = failure.errKind;
  }
  if (state.topError === undefined) state.topError = err;
}

function buildTransportDeps(): TransportDeps {
  return {
    url: getConfig().ingestUrl,
    target: 'doc', // phase-2: item outbox sinh ở đây là doc — không drain nhầm lô event
    onLine: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
    hasSendBeacon:
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function',
    sendBeacon: (u: string, b: Blob) => navigator.sendBeacon(u, b),
    fetchFn:
      typeof fetch === 'undefined'
        ? (fetchNotSupported as unknown as typeof fetch)
        : fetch.bind(globalThis),
    now: () => Date.now(),
  };
}

function fetchNotSupported(): Promise<Response> {
  return Promise.reject(new Error('fetch not supported'));
}

// ─── (1) step() — RETHROW nguyên trạng, không dùng safe() bao trọn ───────

async function step<T>(name: StepName, fn: () => Promise<T>): Promise<T> {
  if (!state || state.sessionClosed) return fn();
  const idx = getConfig().steps.indexOf(name);
  const t0 = performance.now();
  const prevStepSeq = state.currentStepSeq;
  state.currentStepSeq = idx;
  try {
    const result = await fn();
    try {
      recordStepOk(idx, t0);
    } catch {
      /* nuốt lỗi bookkeeping */
    }
    return result;
  } catch (err) {
    try {
      recordStepError(idx, t0, err);
    } catch {
      /* nuốt lỗi bookkeeping */
    }
    throw err; // NGUYÊN TRẠNG — cùng object, không bọc, không đổi type/message
  } finally {
    if (state && state.currentStepSeq === idx)
      state.currentStepSeq = prevStepSeq;
  }
}

// ─── (2) Mọi hàm fire-and-forget khác bọc bằng safe() ─────────────────────

function safe<A extends unknown[]>(fn: (...a: A) => void): (...a: A) => void {
  return (...a: A) => {
    try {
      fn(...a);
    } catch (e) {
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.warn('[monitor] swallowed internal error', e); // KHÔNG log payload/giá trị gốc
      }
    }
  };
}

function _start(): void {
  // Ticket 05 (boot watchdog) — LITERAL FIRST LINE of _start(), before the
  // idempotency check, before the L2 kill switch, before anything else.
  // The <script> from buildWatchdogScript() (see ./watchdog) runs BEFORE
  // this bundle's own script tag and starts a timer waiting for this exact
  // flag; every line of setup below this one is exactly the kind of work
  // whose failure the watchdog exists to catch, so this assignment cannot
  // wait for any of it — including the `if (state) return` idempotency
  // guard, which only protects against _start() being called twice within
  // an already-successfully-booted page.
  try {
    if (typeof window !== 'undefined') {
      (window as unknown as { __WV_BOOTED__?: boolean }).__WV_BOOTED__ = true;
    }
  } catch {
    /* NFR-001 — never let boot-signal bookkeeping block startup */
  }

  if (state) return; // idempotent

  // L2 — công tắc biên dịch (§1.6), phải là CHỐT ĐẦU TIÊN, trước cả L1.
  // Giá trị được define() thay tại build ('on' | 'off'); đây là biểu thức
  // literal tĩnh nên là lớp CÔNG TẮC DUY NHẤT foldable (R3-M3): build với
  // MONITOR=off thì nhánh này gập thành return vô điều kiện và terser loại
  // được phần thân phía sau. Không được tách `process.env.MONITOR` qua biến
  // hay hàm trung gian — mất literal là mất cả folding (bài học C-1).
  if (process.env.MONITOR === 'off') return; // L2 — §1.6

  const flag = getCachedFlag();
  if (!flag.enabled) return; // DISABLED — §1.6

  // "Chưa có điểm nhận" là điều kiện CẤU HÌNH, không phải điều kiện truyền
  // tải — phải chặn ở CÙNG TẦNG với công tắc L1/L2 (§1.6), không phải ở
  // transport.ts. phase-2 (§1.3 mục 1): HAI chốt cấu hình ĐỘC LẬP — INGEST_URL
  // rỗng ⇒ doc tắt; EVENTS_INGEST_URL rỗng ⇒ events tắt (off-at-birth, T043).
  // Chỉ khi CẢ HAI rỗng thì không sinh session gì cả.
  if (!getConfig().ingestUrl && !getConfig().eventsIngestUrl) return;

  // FR-015/ARC-M1 r1: KHÔNG còn chốt sampling phiên phase-1 — monitor khởi
  // động đầy đủ cho MỌI phiên bất kể rate. Hệ quả có chủ: sessionId() khác
  // rỗng ở 100% phiên ⇒ X-Session-Id header có ở mọi request (FR-005 nối
  // backend-log). `flag.rate` deprecated — KHÔNG dùng để bốc sampling.
  const { id, weak } = generateSessionId();
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  state = {
    sessionId: id,
    sidWeak: weak,
    startedAt: getNavigationStart(),
    navMs: performance.now(),
    steps: initStepResults(getConfig().steps),
    httpSamples: [],
    httpOverflow: 0,
    marks: {},
    finished: false,
    homeReached: false,
    sampleRate: 1, // FR-015: doc không bao giờ lấy mẫu — payload ghi 1
    sendAttempt: 1,
    currentStepSeq: null,
    stepFirstFailure: {},
    // ── phase-2 ──
    docSent: false,
    sessionClosed: false,
    // §0.9 sticky 2 bit — bốc MỘT LẦN/phiên; cổng sự kiện chỉ ĐỌC bit
    // (không tung đồng xu mỗi event — R2-4). Field thiếu trong cờ ⇒ default 1.
    routeSampled:
      Math.random() <
      (typeof flag.route_sample_rate === 'number' ? flag.route_sample_rate : 1),
    apiOkSampled:
      Math.random() <
      (typeof flag.api_ok_sample_rate === 'number'
        ? flag.api_ok_sample_rate
        : 1),
    // CR-M1 post-impl r1 — rate HIỆU DỤNG tại thời điểm bốc sticky bit được
    // chụp lại vào state: EventRow.sample_rate đọc BẢN CHỤP này (không đọc cờ
    // live) — fetchFlag cập nhật rate giữa phiên không làm row mang rate mới,
    // giữ nguyên vẹn phép ngoại suy funnel NFR-003. Giá trị đã clamp 0..1 ở
    // mọi đường đọc/ghi cache của flag.ts (defaultRate).
    routeRate: effectiveRouteRate(),
    apiOkRate: effectiveApiOkRate(),
    eventSeq: 0,
    errorEventCount: 0,
    sampledEventCount: 0,
    errorEventsOverflow: 0,
    eventsOverflow: 0,
    apiRetryDupes: 0,
    filterFaults: 0,
    currentRoute: '',
    deviceModel: detectDeviceModel(ua), // FR-006; Client Hints thay thế khi có
  };

  // Risk §11 (r1-PM-M7): UA Reduction có thể xoá model — thử Client Hints
  // best-effort, đọc được thì thay giá trị suy từ UA.
  refineDeviceModel(model => {
    if (state && !state.sessionClosed && model) state.deviceModel = model;
  });

  // §1.3 mục 1: init event stream (arm chunker) + global error
  // hooks (FR-003) — events channel tự tắt khi EVENTS_INGEST_URL rỗng.
  events.initEventStream(state);
  events.installGlobalErrorHooks();
}

/**
 * v1.1 (§2.1) — MỘT call, HAI đầu ra: nạp http_samples[] legacy CHỈ khi
 * !docSent (ARC-m5 r1-TS — doc đã gửi thì mảng không còn ai đọc) VÀ ủy thác
 * events.recordApiCall (api_call/business_error theo §1.3 mục 3). `body` là
 * scalar-only HttpBodyInfo — cờ success GỐC đọc TRƯỚC chỗ request.ts ghi đè.
 */
function _http(
  url: string,
  method: string | undefined,
  ms: number,
  errKind?: ErrKind,
  status?: number,
  body?: HttpBodyInfo,
): void {
  if (!state || state.sessionClosed) return;
  const clean = url.split('?')[0];
  const normUrl = normalizeApiUrl(clean);
  const endMs = performance.now();
  const startOffset = endMs - ms - state.navMs; // t_offset = lúc BẮT ĐẦU request
  if (!state.docSent) {
    // http_samples[] legacy — giữ cho KPI phase-1, không dùng cho truy vấn
    // mới (r1-ARC-M2: event stream là nguồn chân lý timeline).
    state.httpSamples.push({
      url: normUrl,
      host: classifyHost(clean),
      method: method || 'GET',
      t_offset: startOffset,
      ms,
      ok: errKind === undefined,
      err_kind: errKind,
      step_seq: state.currentStepSeq,
    });
    if (
      errKind !== undefined &&
      state.currentStepSeq !== null &&
      !state.stepFirstFailure[state.currentStepSeq]
    ) {
      state.stepFirstFailure[state.currentStepSeq] = {
        endpoint: normUrl,
        status,
        errKind,
      };
    }
  }
  events.recordApiCall({
    url: clean,
    method,
    ms,
    errKind,
    status,
    body,
  });
}

function _mark(name: MarkName): void {
  if (!state || state.sessionClosed) return;
  state.marks[name] = performance.now() - state.navMs;
}

/** v2 (§2.1) — FR-001: ghi route_view + cập nhật currentRoute (ngữ cảnh js_error). */
function _route(pathname: string): void {
  if (!state || state.sessionClosed) return;
  events.recordRoute(pathname);
}

/** v2 (§2.1) — lối vào chung mọi EventKind (nội bộ + test). */
function _event(evt: EventInput): void {
  events.trackEvent(evt);
}

/**
 * v1.1 (R2-6/§0.6) — tách ĐỘI SỐ docSent/sessionClosed:
 * (a) mọi reason: doc gửi ĐÚNG 1 LẦN/phiên (phase-1 semantics nguyên trạng —
 *     finish đầu tiên được gọi, luồng chuẩn home_shown trong rAF);
 * (b) home_shown/queue_flush: KHÔNG dừng recorder;
 * (c) pagehide/init_failed: emit session_end + final flush('pagehide') ≤2
 *     beacon + phần còn lại outbox MỘT lần ghi, RỒI MỚI phát doc (tổng ≤3
 *     beacon lúc chết trang — R2-7/QĐ-13), sau đó sessionClosed=true;
 * (d) visibility_hidden: doc (nếu chưa gửi) + flush checkpoint — KHÔNG đóng
 *     event stream (R2-6: ghi tiếp khi visible lại).
 */
function _finish(reason: FinishReason): void {
  if (!state) return;

  // (c) — event stream đóng TRƯỚC khi phát doc (§1.3 mục 7: session_end row
  // → flush ≤2 beacon → doc beacon thứ 3).
  if (
    !state.sessionClosed &&
    (reason === 'pagehide' || reason === 'init_failed')
  ) {
    events.closeEventStream(reason);
    state.sessionClosed = true;
  }
  // (d) — checkpoint flush, stream tiếp tục.
  if (reason === 'visibility_hidden') {
    events.flushCheckpoint();
  }

  if (!state.docSent) {
    state.docSent = true; // doc đúng 1 lần/phiên — mọi finish_reason
    state.finished = true; // phase-1 flag tương đương docSent
    state.finishReason = reason;
    state.homeReached =
      state.steps.length === getConfig().steps.length &&
      state.steps.every(s => s.status === 'ok');

    const built = buildPayload(state, reason);
    const { payload: filtered } = applyLayer2(built);

    const deps = buildTransportDeps();
    dispatch(filtered, reason, deps);

    // §1.5 "Điểm xả — MỘT điều kiện duy nhất": mọi finish_reason, sau khi
    // gói của phiên hiện tại đã được phát, qua setTimeout(0).
    try {
      setTimeout(() => {
        try {
          drainOutbox(deps);
        } catch {
          /* NFR-001 */
        }
      }, 0);
    } catch {
      /* môi trường thiếu setTimeout — không throw */
    }
  }

  // Refresh cờ L1 đã chuyển sang `_attachLifecycle()` — chạy vô điều kiện,
  // không phụ thuộc việc phiên này có `state` hay có tới được `_finish()`
  // hay không (R3-M1). Ở đây không gọi nữa để tránh gọi hai lần một phiên.
}

function _attachLifecycle(): void {
  if (lifecycleAttached) return;
  lifecycleAttached = true;

  // SEC-4/R3-N1 — dọn TTL outbox THỤ ĐỘNG, mỗi lần nạp trang, vô điều kiện
  // với INGEST_URL và cờ L1: drain() chỉ chạy khi có phiên hoàn tất, nên khi
  // monitor tắt thì không ai thực thi TTL 24h nữa — dữ liệu chẩn đoán (đã
  // qua Lớp 2, không token/PII trực tiếp) sẽ nằm lại vô thời hạn, phá tiền
  // đề thứ hai của R-6. Chỉ thuần lọc localStorage + đếm dropped_n, không
  // mạng. L2 tắt thì bỏ luôn — công tắc biên dịch vô hiệu hoá mọi việc, kể
  // cả chạm localStorage.
  if (process.env.MONITOR !== 'off') {
    try {
      pruneExpired(Date.now());
    } catch {
      /* NFR-001 */
    }
  }

  // Làm mới cờ L1 ở ĐÂY, vô điều kiện — không phải trong `_finish()`.
  //
  // `_finish()` return sớm khi `!state`, mà `state` chỉ tồn tại sau khi
  // `_start()` qua trọn ba chốt (cờ L1 → INGEST_URL → lấy mẫu). Đặt lời gọi
  // ở đó khiến công tắc khẩn cấp nằm HẠ NGUỒN của chính thứ nó phải tắt: nếu
  // sự cố nằm ngay trên đường khởi tạo — đúng loại sự cố L1 sinh ra để dập —
  // thì `_finish()` không tới được và cờ không bao giờ được làm mới nữa
  // (R3-M1). Ở đây thì nó chạy kể cả khi monitor đã tự tắt, nên vẫn còn
  // đường gỡ ra.
  //
  // Không chặn gì: `fetchFlag()` không `await`, timeout 2s, nuốt mọi lỗi
  // (§3.2 E011). Giá trị đọc về cố ý KHÔNG đổi hành vi phiên hiện tại — nó
  // được persist cho phiên kế tiếp (xem flag.ts).
  // L2 tắt thì không fetch — công tắc biên dịch vô hiệu hoá MỌI lời gọi
  // (§1.6), kể cả lời gọi mạng này; cùng biểu thức literal như chốt ở
  // `_start()` để cả hai gập được cùng lúc.
  if (process.env.MONITOR !== 'off') {
    fetchFlag(buildTransportDeps().fetchFn);
  }

  // §2.3 — listener giữ nguyên phase-1 (pagehide/visibilitychange); thân
  // xử lý giờ phân nhánh trong _finish() theo R2-6 (doc 1 lần + stream
  // đóng tại pagehide / checkpoint tại hidden).
  if (
    typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function'
  ) {
    window.addEventListener('pagehide', () => finish('pagehide'));
  }
  if (
    typeof document !== 'undefined' &&
    typeof document.addEventListener === 'function'
  ) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') finish('visibility_hidden');
    });
  }
}

// ADR-0002 — init() KHÔNG bọc safe(): nhóm identity/shape phải throw
// đồng bộ ra ngoài cho host bắt được ngay lần chạy local đầu tiên —
// bao bằng safe() sẽ nuốt lỗi thành no-op âm thầm, đúng điều ADR-0002
// nói không được xảy ra.
export const init = _init;
export const start = safe(_start);
export const http = safe(_http);
export const mark = safe(_mark);
export const route = safe(_route);
export const event = safe(_event);
export const finish = safe(_finish);
export const attachLifecycle = safe(_attachLifecycle);

export function isEnabled(): boolean {
  try {
    return state !== null;
  } catch {
    return false;
  }
}

export function sessionId(): string {
  try {
    return state ? state.sessionId : '';
  } catch {
    return '';
  }
}

export { step };

// Chỉ dùng trong test — mỗi test phải chạy trên một "trang" sạch, và
// module này không có gì sống sót qua reload thật (§1.3) nên việc reset
// tay ở đây chỉ mô phỏng đúng điều đó cho môi trường jest (không reload
// được DOM thật giữa hai test). phase-2: reset cả 3 module con để không
// rò buffer/counters giữa các test.
export function __resetMonitorForTest(): void {
  state = null;
  lifecycleAttached = false;
  events.__resetEventsForTest();
  resetChunkerForTest();
  __resetTransportForTest();
  __resetConfigForTest();
}

const monitor = {
  init,
  start,
  step,
  http,
  mark,
  route,
  event,
  finish,
  attachLifecycle,
  isEnabled,
  sessionId,
};

export default monitor;
