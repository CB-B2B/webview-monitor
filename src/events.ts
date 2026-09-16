// src/utils/monitor/events.ts
//
// phase-2 (webview-session-logs §1.2) — RECORDER: nhận hook từ 3 điểm móc
// (layouts route effect / request.ts bodyInfo / global error hooks), cổng
// sampling sticky 2 bit (§0.9/FR-015), cap 200 lỗi + 500 event mẫu (QĐ-11/
// QĐ-12), coalesce retry trùng cửa sổ 10s (§2.4b), giữ currentRoute, gọi
// filter TẠI CHỖ GHI (trước buffer — §5.3.1) rồi đẩy sang chunker.pushEvent.
//
// Kênh mirror GA đã bỏ (quyết định 2026-08-17) — kho là nơi duy nhất nhận
// event. Trước đây trackEvent() còn gọi ga.mirrorToGa(raw) ngay sau buffer.
//
// KHÔNG gửi mạng, KHÔNG đụng localStorage, KHÔNG đụng dataLayer trực tiếp
// (luật phụ thuộc §1.2: không import ./transport ./outbox ./umi ./antd —
// static.spec grep-check). trackEvent() là nơi DUY NHẤT giữ chuỗi gốc —
// mọi chuỗi rời hàm này phải đã qua sanitize.

import {
  ErrKind,
  EventInput,
  EventKind,
  EventRow,
  FINISH_REASONS,
  FinishReason,
  HttpBodyInfo,
} from './types';
import { SessionState } from './state';
import { FILTER_ERROR_PLACEHOLDER, sanitizeMessage } from './filter';
import { normalizeApiUrl, normalizeEventRoute } from './routes';
import * as chunker from './chunker';
import { getConfig } from './config';

// §2.2 — cap nội dung/phiên (FR-015 P0 + QĐ-12). KHÔNG dấu _ trong số (Babel).
export const ERROR_EVENTS_CAP = 200;
export const SAMPLED_EVENTS_CAP = 500;
export const COALESCE_WINDOW_MS = 10000;
const CODE_MAX = 128; // cap ký tự code kênh kho (T026)
// §5.3.4 (r1-SEC-M4): code là TRƯỜNG HẸP — charset kiểm tại đây (kênh kho,
// kênh duy nhất sau QĐ-18); lệch charset ⇒ drop field, không
// redact (chốt một hành vi như err_name ⇒ 'Error').
const CODE_CHARSET = /^[A-Za-z0-9_.:-]{1,128}$/;

let session: SessionState | null = null;
let streamArmed = false; // EVENTS_INGEST_URL rỗng ⇒ off-at-birth (T043)
let hooksInstalled = false;

// §2.4b — map O(1) key → {lastTs, count, anchorSeq, anchorRow} (PERF-M2
// r1-TS: storm đa endpoint luân phiên A,B,A,B mỗi giây phải gộp được, không
// chỉ so row cuối). anchorRow còn trong buffer (seq > chunker.getFlushedSeq)
// ⇒ mutate anchor; đã flush ⇒ row MỚI kế thừa coalesce_count tích lũy.
interface CoalesceEntry {
  lastTs: number;
  count: number;
  anchorSeq: number;
  anchorRow: EventRow | null;
}
let coalesceMap = new Map<string, CoalesceEntry>();

function coalesceKey(raw: EventInput): string {
  return `${raw.type}|${raw.endpoint}|${raw.errKind}|${raw.status}|${raw.code}`;
}

function isErrorKind(type: EventKind): boolean {
  return type === 'js_error' || type === 'business_error';
}

/** Row "lỗi" theo nghĩa cap 200 (FR-015): api_call thất bại + business_error + js_error. */
function countsTowardErrorCap(raw: EventInput): boolean {
  return (
    isErrorKind(raw.type) ||
    (raw.type === 'api_call' && raw.errKind !== undefined)
  );
}

/**
 * §2.4b chốt coalesce "Chỉ áp row lỗi (api_call thất bại + business_error)"
 * — js_error DỪNG Ở NGOÀI coalesce (ARC-M1 post-impl r1): 2 TypeError trùng
 * name khác message là 2 row riêng + 2 GA hit; nếu gộp, message thứ 2 mất
 * khỏi wire (anchor mutate chỉ giữ message anchor) và phình api_retry_dupes.
 */
function isCoalescible(raw: EventInput): boolean {
  return countsTowardErrorCap(raw) && raw.type !== 'js_error';
}

/**
 * §2.4a — cổng sampling đọc sticky 2 bit §0.9 (KHÔNG tung đồng xu mỗi event:
 * timeline nguyên vẹn hoặc vắng sạch — R2-4/US-4/metric liền mạch). Lỗi +
 * session_end KHÔNG bao giờ lấy mẫu (FR-015/QĐ-11). Quyết định lấy mẫu chốt
 * tại nguồn cho kênh kho (kênh duy nhất sau QĐ-18 — r1-SEC-n2).
 */
function shouldKeep(type: EventKind, isSuccess: boolean): boolean {
  if (type !== 'route_view' && !(type === 'api_call' && isSuccess)) return true;
  const s = session;
  if (!s) return false;
  return type === 'route_view' ? s.routeSampled : s.apiOkSampled;
}

// sample_rate ghi trong row là rate THỜI ĐIỂM bốc sticky bit (§0.9) — không
// phải cờ live (CR-M1 post-impl r1: fetchFlag cập nhật giữa phiên không làm
// row mang rate mới). Đọc BẢN CHỤP trong SessionState do _start() ghi; lỗi
// luôn 1 (không lấy mẫu).
function effSampleRate(raw: EventInput): number {
  const s = session;
  if (!s) return 1;
  if (raw.type === 'route_view') return s.routeRate;
  if (raw.type === 'api_call' && raw.errKind === undefined) return s.apiOkRate;
  return 1;
}

function pruneCoalesceMap(now: number): void {
  // Map dọn entry >10s (§2.4b) — cửa sổ TRƯỢT, không tích luỹ vô hạn key.
  coalesceMap.forEach((entry, key) => {
    if (now - entry.lastTs > COALESCE_WINDOW_MS) coalesceMap.delete(key);
  });
}

/**
 * Nơi DUY NHẤT giữ chuỗi gốc. Thứ tự BẤT BIẾN (§2.4d/§5.3.1):
 * cổng sampling → coalesce → caps → sanitizeEvent (dựng row field-by-field,
 * KHÔNG spread object lạ — §2.4 phase-1) → buffer (chunker). Sau QĐ-18 chỉ
 * còn MỘT đường ra: buffer → transport (không còn nhánh GA song song).
 *
 * Row bị sampling gạt: KHÔNG tiêu seq, KHÔNG đếm overflow (ngoài mẫu theo
 * thiết kế — T051). Row bị cap cắt: đếm overflow tương ứng.
 */
export function trackEvent(raw: EventInput): void {
  const s = session;
  if (!s || !streamArmed || s.sessionClosed) return;

  const isSuccess = raw.type === 'api_call' && raw.errKind === undefined;
  if (raw.type !== 'session_end' && !shouldKeep(raw.type, isSuccess)) return;

  // ── Coalesce (§2.4b) — chỉ api_call thất bại + business_error (ARC-M1
  // post-impl r1: js_error ngoài coalesce), cửa sổ trượt 10s ──
  const isErrorRow = countsTowardErrorCap(raw);
  const coalescible = isCoalescible(raw);
  let coalesceKeyStr: string | null = null;
  let inheritedCount = 0;
  if (coalescible) {
    const now = performance.now();
    pruneCoalesceMap(now);
    coalesceKeyStr = coalesceKey(raw);
    const entry = coalesceMap.get(coalesceKeyStr);
    if (entry && now - entry.lastTs <= COALESCE_WINDOW_MS) {
      entry.count += 1;
      entry.lastTs = now;
      s.apiRetryDupes += 1; // api_retry_dupes — lộ volume thật (§2.2)
      if (
        entry.anchorRow &&
        entry.anchorSeq > chunker.getFlushedSeq() // anchor còn trong buffer
      ) {
        // Mutate anchor: coalesce_count + latency lần gần nhất; t_offset/seq
        // GIỮ anchor lần đầu. Không row mới ⇒ không seq, không mirror GA.
        entry.anchorRow.coalesce_count = entry.count;
        if (raw.latencyMs !== undefined)
          entry.anchorRow.latency_ms = raw.latencyMs;
        return;
      }
      inheritedCount = entry.count; // anchor đã flush ⇒ row mới kế thừa count
    } else {
      coalesceMap.set(coalesceKeyStr, {
        lastTs: now,
        count: 1,
        anchorSeq: 0,
        anchorRow: null,
      });
    }
  }

  // ── Caps (FR-015/QĐ-12) — KHÔNG áp cho session_end ──
  if (raw.type !== 'session_end') {
    if (isErrorRow) {
      if (s.errorEventCount >= ERROR_EVENTS_CAP) {
        s.errorEventsOverflow += 1; // T023 — mất mát hiện ra thành số
        return;
      }
    } else if (s.sampledEventCount >= SAMPLED_EVENTS_CAP) {
      s.eventsOverflow += 1; // T024
      return;
    }
  }

  // ── sanitizeEvent — kênh kho (§5.3.1) ──
  const routeSrc =
    raw.route !== undefined && raw.route !== '' ? raw.route : s.currentRoute;
  const route = normalizeEventRoute(routeSrc);
  let message: string | undefined;
  if (raw.message !== undefined) {
    message = sanitizeMessage(String(raw.message));
    if (message === FILTER_ERROR_PLACEHOLDER) s.filterFaults += 1; // E020
  }

  // Dựng row TỪNG trường (object literal + gán có điều kiện — cho JSON.stringify
  // chỉ phát keys thuộc schema §2.2, T053; không spread object lạ).
  const row: EventRow = {
    record_type: 'event',
    session_id: s.sessionId,
    session_started_at: s.startedAt,
    t_offset: performance.now() - s.navMs,
    seq: 0, // gán SAU khi qua mọi chốt — chỉ row được buffer tiêu seq (T051)
    type: raw.type,
    route,
    sample_rate: effSampleRate(raw),
    release_version: getConfig().releaseVersion,
    env_name: getConfig().envName,
    device_model: s.deviceModel,
  };
  if (raw.endpoint !== undefined)
    row.endpoint = normalizeApiUrl(String(raw.endpoint));
  if (raw.method !== undefined && raw.method !== '')
    row.method = String(raw.method).slice(0, 16);
  if (typeof raw.status === 'number') row.status = raw.status;
  if (raw.errKind !== undefined) row.err_kind = raw.errKind;
  if (raw.code !== undefined && raw.type !== 'session_end') {
    const code = String(raw.code).slice(0, CODE_MAX);
    if (CODE_CHARSET.test(code)) row.code = code; // lệch charset ⇒ bỏ field (§5.3.4)
  }
  if (message !== undefined) row.message = message;
  if (raw.latencyMs !== undefined) row.latency_ms = raw.latencyMs;
  if (inheritedCount >= 2) row.coalesce_count = inheritedCount;
  if (raw.type === 'session_end') {
    // §2.3: session_end dùng code = reason. SEC-n2 post-impl r1: kênh kho
    // cũng phải validate — chỉ gán finish_reason khi code là literal hợp lệ
    // của enum FinishReason (cast không validate từng để chuỗi lạ lên wire);
    // giá trị lạ ⇒ omit field, row vẫn phát.
    const reason = String(raw.code) as FinishReason;
    if (FINISH_REASONS.includes(reason)) row.finish_reason = reason;
    // CR-m1 post-impl r1 (E016): overflow đếm THEO LOẠI ROW bị drop vì >32KB
    // — row lỗi ⇒ error_events_overflow, row mẫu ⇒ events_overflow.
    const dropped = chunker.getDroppedByKind();
    row.error_events_overflow = s.errorEventsOverflow + dropped.error;
    row.events_overflow = s.eventsOverflow + dropped.sampled;
    row.api_retry_dupes = s.apiRetryDupes;
    row.filter_faults = s.filterFaults;
  }

  // ── buffer (kênh kho — đường ra duy nhất sau QĐ-18) ──
  row.seq = s.eventSeq += 1;
  chunker.pushEvent(row);
  if (isErrorRow && coalesceKeyStr !== null) {
    const entry = coalesceMap.get(coalesceKeyStr);
    if (entry) {
      entry.anchorRow = row; // row vừa buffer trở thành anchor mới
      entry.anchorSeq = row.seq;
    }
  }
  if (isErrorRow) {
    s.errorEventCount += 1; // row coalesce đếm 1 vào cap 200 (§2.4b)
  } else if (raw.type !== 'session_end') {
    s.sampledEventCount += 1;
  }
}

// ─── Điểm móc từng nguồn sự kiện (§2.3) ─────────────────────────────────────

/** FR-001 — layouts useEffect([location.pathname]) → monitor.route(). */
export function recordRoute(pathname: string): void {
  const s = session;
  if (!s || s.sessionClosed) return;
  // currentRoute cập nhật NGẪC cả khi route_view ngoài mẫu — ngữ cảnh js_error
  // phải luôn đúng màn đang đứng (§2.3).
  s.currentRoute = normalizeEventRoute(String(pathname));
  trackEvent({ type: 'route_view', route: s.currentRoute });
}

/** Đầu vào recordApiCall — chỉ scalar (bài học A-8 phase-1). */
export interface ApiCallInput {
  url: string; // nguyên — recordApiCall tự cắt query + normalizeApiUrl
  method?: string;
  ms: number; // độ trễ đo tại call site
  errKind?: ErrKind;
  status?: number;
  body?: HttpBodyInfo;
}

/**
 * FR-002/FR-004 — §1.3 mục 3, tách 3 nhánh TỪ CÙNG MỘT call:
 * (1) res.err (errKind !== undefined) ⇒ api_call THẤT BẠI — không sample,
 *     đếm cap 200; (2) !err && body.ok === false ⇒ business_error (HTTP 200
 *     + success:false — dạng "không vào được" phổ biến nhất, đọc body THÔ
 *     TRƯỚC chỗ request.ts:163-166 ghi đè); (3) còn lại ⇒ api_call thành
 *     công — chỉ ghi nếu state.apiOkSampled (sticky bit), đếm cap 500.
 */
export function recordApiCall(input: ApiCallInput): void {
  const s = session;
  if (!s || s.sessionClosed || !streamArmed) return;
  try {
    const endpoint = normalizeApiUrl(String(input.url).split('?')[0]);
    if (input.errKind !== undefined) {
      trackEvent({
        type: 'api_call',
        endpoint,
        method: input.method,
        status: input.status,
        latencyMs: input.ms,
        errKind: input.errKind,
        code: input.body && input.body.code,
        message: input.body && input.body.message,
      });
    } else if (input.body && input.body.ok === false) {
      trackEvent({
        type: 'business_error',
        endpoint,
        method: input.method,
        status: input.status,
        latencyMs: input.ms,
        code: input.body.code,
        message: input.body.message,
      });
    } else {
      // thành công — cổng apiOkSampled quyết trong trackEvent (§2.4a)
      trackEvent({
        type: 'api_call',
        endpoint,
        method: input.method,
        status: input.status,
        latencyMs: input.ms,
      });
    }
  } catch {
    /* NFR-001 — không throw ra ngoài */
  }
}

/** FR-003 — window.onerror + unhandledrejection; guard reentrancy (T044). */
export function installGlobalErrorHooks(): void {
  if (hooksInstalled) return;
  if (
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function'
  )
    return;
  hooksInstalled = true;

  window.addEventListener('error', (ev: ErrorEvent) => {
    try {
      const err =
        ev && ev.error && typeof ev.error === 'object'
          ? (ev.error as Error)
          : undefined;
      const name = (err && typeof err.name === 'string' && err.name) || 'Error';
      const msg =
        (err && typeof err.message === 'string' && err.message) ||
        (typeof (ev && ev.message) === 'string' ? ev.message : '');
      trackEvent({ type: 'js_error', code: name, message: msg }); // route mặc định currentRoute
    } catch {
      /* T044 — lỗi trong chính handler ⇒ bỏ, không đệ quy sinh js_error mới */
    }
  });

  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    try {
      const reason: unknown = ev && ev.reason;
      const asObj =
        reason && typeof reason === 'object'
          ? (reason as { name?: unknown; message?: unknown })
          : undefined;
      const name =
        (asObj && typeof asObj.name === 'string' && asObj.name) || 'Error';
      const msg =
        (asObj && typeof asObj.message === 'string' && asObj.message) ||
        (typeof reason === 'string' ? reason : '');
      trackEvent({ type: 'js_error', code: name, message: msg });
    } catch {
      /* T044 */
    }
  });
}

// ─── Vòng đời stream (index.ts gọi — §1.3 mục 1) ────────────────────────────

/**
 * Từ _start(): nhận tham chiếu SessionState sống (đọc/ghi counters, sticky
 * bit), arm chunker khi EVENTS_INGEST_URL khác rỗng.
 */
export function initEventStream(s: SessionState | null): void {
  session = s;
  coalesceMap = new Map();
  streamArmed = !!s && getConfig().eventsIngestUrl !== '';
  if (streamArmed) chunker.arm();
}

/** R2-6 — visibilitychange hidden: flush checkpoint, KHÔNG đóng stream. */
export function flushCheckpoint(): void {
  const s = session;
  if (!s || s.sessionClosed) return;
  chunker.flush('hidden');
}

/**
 * pagehide/init_failed (§1.3 mục 7): emit session_end row mang finish_reason
 * + 4 counter tràn (error_events_overflow/events_overflow/api_retry_dupes/
 * filter_faults) RỒI flush('pagehide') ≤2 beacon + phần còn lại enqueueBatch.
 * index._finish() gọi TRƯỚC khi phát doc phase-1 (tổng ≤3 beacon — R2-7).
 */
export function closeEventStream(reason: FinishReason): void {
  const s = session;
  if (!s || s.sessionClosed) return;
  try {
    trackEvent({ type: 'session_end', code: reason, route: s.currentRoute });
  } catch {
    /* NFR-001 — session_end fail không được chặn final flush */
  }
  chunker.flush('pagehide');
}

export function __resetEventsForTest(): void {
  session = null;
  streamArmed = false;
  coalesceMap = new Map();
  // hooksInstalled giữ true sau lần đầu — tránh gỡ/lắp listener trùng khi
  // reset giữa chừng; listener tự no-op khi session === null.
}
