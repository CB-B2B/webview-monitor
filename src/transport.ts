// src/utils/monitor/transport.ts
//
// §1.5 Phát gói — quyết định "gửi thẳng / outbox / bỏ" (decision table
// T071–T076) + §3.2 Error Catalog E001–E008. Không throw, mọi promise
// luôn kết thúc bằng .catch (NFR-001 quy tắc 3, A-7).
//
// phase-2 (webview-session-logs §2.5): tách hạt sendRaw() khỏi dispatch()
// (doc) + thêm dispatchChunks() cho lô event — CÙNG bảng quyết định §1.5,
// không nhân đôi logic; TextEncoder module-level dùng chung (PERF-n1 r1-TS);
// circuit breaker E013 (≥3 lần 401/403 liên tiếp ⇒ dừng drain phần còn lại
// của phiên — SEC-m6 r1-TS).

import {
  drain,
  enqueue,
  incrementDroppedN,
  OutboxTarget,
  TTL_MS,
} from './outbox';
import { FinishReason, isDocBody, SealedBatch, SessionPayload } from './types';

const MAX_BEACON_BYTES = 64 * 1024; // trần thực tế của sendBeacon (E007)

// PERF-n1 r1-TS — TextEncoder module-level DÙNG CHUNG, cấm `new` mỗi lời
// gọi (mỗi instance mang bảng tra UTF-8 riêng; đo byte là nghiệp vụ nóng của
// chunker). jsdom cũ có thể thiếu — fallback encodeURIComponent phía dưới.
const SHARED_ENCODER: TextEncoder | null =
  typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function byteLength(str: string): number {
  try {
    if (SHARED_ENCODER) return SHARED_ENCODER.encode(str).length;
  } catch {
    /* fallthrough */
  }
  // Xấp xỉ không cần TextEncoder (jsdom cũ có thể thiếu):
  return unescape(encodeURIComponent(str)).length;
}

export { byteLength };

/**
 * E007: cắt bớt TẠI CHỖ trước khi thử gửi, không chờ tới khi bị từ chối.
 * Trả `null` nếu sau khi cắt tối đa vẫn vượt 64KB (E007 — bỏ gửi hẳn).
 */
function ensureWithinBudget(payload: SessionPayload): SessionPayload | null {
  let body = JSON.stringify([payload]);
  if (byteLength(body) <= MAX_BEACON_BYTES) return payload;

  const trimmed: SessionPayload = {
    ...payload,
    http_samples: [],
    http_overflow: payload.http_overflow + payload.http_samples.length,
  };
  body = JSON.stringify([trimmed]);
  if (byteLength(body) <= MAX_BEACON_BYTES) return trimmed;

  return null; // vẫn vượt sau khi cắt tối đa — bỏ gửi (E007), ghi khoảng trống FR-019
}

export interface TransportDeps {
  url: string;
  onLine: () => boolean;
  hasSendBeacon: boolean;
  sendBeacon: (url: string, blob: Blob) => boolean;
  fetchFn: typeof fetch;
  now: () => number;
  /** Kênh phát của deps này — quyết định target item outbox (chống cross-drain
   * gửi body doc sang endpoint event và ngược lại — xem outbox.ts). Chunker
   * đặt 'events', doc phase-1 đặt 'doc'; thiếu (đỡ call-site cũ) ⇒ 'doc'. */
  target?: OutboxTarget;
}

// ─── E013 circuit breaker (SEC-m6 r1-TS) ────────────────────────────────────
// 401/403 chỉ quan sát được ở fetch fallback (beacon không đọc status).
// ≥3 lần 401/403 LIÊN TIẾP ⇒ token ingest sai/bị thu hồi — retry không chữa
// được, dừng drain các lô còn lại của phiên (giữ trong outbox chờ TTL);
// gửi thành công resets chuỗi.
// ARC-m1 post-impl r1 — breaker theo TỪNG TARGET ('doc'|'events'): hai kênh
// dùng CHUNG một credential chỉ-ghi (HAProxy chèn hộ), thứ tách chúng là HAI
// PATH ⇒ hai quyết định ACL/L0 độc lập ở HAProxy (R2-9) — 401/403 do sai ACL
// riêng path /ingest-events không được phép chặn drain của kênh doc và ngược
// lại (trước đây 2 biến dùng chung khiến cross-channel coupling).
const breaker = new Map<OutboxTarget, { fail: number; halted: boolean }>();

function breakerOf(target: OutboxTarget): { fail: number; halted: boolean } {
  let b = breaker.get(target);
  if (!b) {
    b = { fail: 0, halted: false };
    breaker.set(target, b);
  }
  return b;
}

export function isDrainHalted(target: OutboxTarget = 'doc'): boolean {
  return breakerOf(target).halted;
}

export function __resetTransportForTest(): void {
  breaker.clear();
}

/**
 * phase-2 §2.5 — HẠT phát của bảng quyết định §1.5, tách khỏi dispatch()
 * để dispatchChunks() dùng lại NGUYÊN TRẠNG (không nhân đôi logic):
 * 1. offline / URL rỗng ⇒ outbox thẳng, không thử mạng (E004; URL rỗng —
 *    sendBeacon('') tự POST về chính trang, xem chú thích dưới).
 * 2. sendBeacon(url, blob) === true ⇒ coi là đã gửi — trả true.
 * 3. false / thiếu API ⇒ allowFetchFallback (nhánh sống) thử MỘT lần
 *    fetch(keepalive) để phân loại E001/E002/E003; nhánh chết
 *    (pagehide/hidden/init_failed) đi thẳng outbox — không dùng fetch làm
 *    đường chính lúc trang đang chết (R-4).
 * Trả `true` ĐÚNG khi beacon xác nhận đã gửi — caller (chunker §2.4e) dùng
 * làm điều kiện drainOutbox().
 */
export function sendRaw(
  body: string,
  allowFetchFallback: boolean,
  deps: TransportDeps,
): boolean {
  const now = deps.now();
  const target: OutboxTarget = deps.target ?? 'doc';

  // Chốt chặn URL điểm nhận rỗng: navigator.sendBeacon('') KHÔNG phải no-op
  // — trình duyệt phân giải '' theo base URL của tài liệu hiện tại, tức là
  // POST thẳng về CHÍNH TRANG ĐANG MỞ (đã kiểm chứng thật: 405 kèm toàn bộ
  // SessionPayload trong body, token nằm cả trong query lẫn header Referer,
  // cookie same-origin bị đính kèm). sendBeacon('') vẫn trả `true`, nên nếu
  // không chặn ở đây dispatch() sẽ hiểu nhầm là ĐÃ GỬI, không đẩy vào
  // outbox ⇒ mất phiên trong im lặng. INGEST_URL chỉ rỗng khi hạ tầng D0
  // chưa cấu hình (xem index.ts) — trường hợp này luôn đi outbox chờ.
  if (!deps.url) {
    enqueue(body, now, target);
    return false;
  }

  if (!deps.onLine()) {
    enqueue(body, now, target); // E004
    return false;
  }

  if (deps.hasSendBeacon) {
    let sent = false;
    try {
      sent = deps.sendBeacon(
        deps.url,
        new Blob([body], { type: 'text/plain;charset=UTF-8' }),
      );
    } catch {
      sent = false;
    }
    if (sent) return true; // SENT
  }

  if (allowFetchFallback) {
    attemptFetchFallback(deps.url, body, deps.fetchFn, now, target);
  } else {
    // Trang đang chết — không gọi fetch (tránh preflight lúc trang chết,
    // R-4) — đi thẳng outbox (E006/E017, hoặc E008 nếu thiếu sendBeacon).
    enqueue(body, now, target);
  }
  return false;
}

/** Doc phase-1 — nguyên trạng §1.5 (T071–T076), giờ ủy thác thân cho sendRaw. */
export function dispatch(
  rawPayload: SessionPayload,
  finishReason: FinishReason,
  deps: TransportDeps,
): void {
  const payload = ensureWithinBudget(rawPayload);
  if (!payload) return; // E007 cuối cùng — kiểm TRƯỚC url rỗng, không phá thứ tự ưu tiên

  const body = JSON.stringify([payload]);
  sendRaw(body, finishReason === 'home_shown', deps);
}

/**
 * E014 — "ưu tiên Retry-After nếu có": đọc header retry-after (giây) của
 * phản hồi 429, kẹp bằng TTL 24h để server lỗi không giữ item vô hạn.
 * Giá trị không số/âm ⇒ undefined (dùng BACKOFF mặc định).
 */
function parseRetryAfterMs(res: Response): number | undefined {
  try {
    const v = res.headers?.get?.('retry-after');
    if (typeof v !== 'string' || v === '') return undefined;
    const sec = Number(v);
    if (!isFinite(sec) || sec < 0) return undefined;
    return Math.min(sec * 1000, TTL_MS);
  } catch {
    return undefined;
  }
}

function attemptFetchFallback(
  url: string,
  body: string,
  fetchFn: typeof fetch,
  now: number,
  target: OutboxTarget,
): void {
  fetchFn(url, {
    method: 'POST',
    body,
    keepalive: true,
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
  })
    .then(res => {
      if (res.ok) {
        breakerOf(target).fail = 0; // gửi được ⇒ sống lại — reset chuỗi E013
        return; // SENT
      }
      if (res.status === 401 || res.status === 403) {
        // E001/E013 — token ingest sai: nuốt, KHÔNG retry cho lô này; đếm
        // mất mát thành số (FR-019) + nuôi circuit breaker CỦA TARGET NÀY.
        const b = breakerOf(target);
        b.fail += 1;
        if (b.fail >= 3) b.halted = true;
        incrementDroppedN(); // E013 — mất mát hiện số qua mon_dropped_n
        return;
      }
      if (res.status === 429) {
        // E014 — lô vào outbox attempt=1, backoff; ưu tiên Retry-After
        const ra = parseRetryAfterMs(res);
        enqueue(body, now, target, ra !== undefined ? now + ra : undefined);
        return;
      }
      // E003 (5xx) / mọi mã khác — enqueue retry
      enqueue(body, now, target);
    })
    .catch(() => {
      // E004/E005 (mạng lỗi / CORS opaque) — coi như E004, enqueue retry
      enqueue(body, now, target);
    });
}

/**
 * phase-2 (§2.1/§0.8) — phát N lô event GIỮA PHIÊN (mid): body mỗi lô =
 * JSON.stringify(batch.rows) — mảng EventRow PHẲNG (metadata SealedBatch
 * không bao giờ lên dây); beacon từ chối ⇒ fetch-keepalive 1 lần (trang còn
 * sống) ⇒ outbox. Nuốt lỗi TỪNG LÔ độc lập (§3.1 — một lô hỏng không chặn
 * lô sau).
 *
 * CR2-m1 post-impl r2 — KHÔNG còn tham số phase: đường pagehide đã chuyển
 * hẳn sang tryBeaconOnly() + gom MỘT enqueueBatch trong chunker (PERF-m2
 * post-impl r1); giữ nhánh 'pagehide' ở đây là code mồ côi — ai tái dùng
 * sẽ quay lại đúng hành vi enqueue-từng-lô đã loại bỏ.
 */
export interface ChunksDispatchResult {
  sent: number; // số lô beacon xác nhận ĐÃ gửi
  queued: number; // số lô rơi vào outbox (hoặc chờ fetch-pending)
}

/**
 * PERF-m2 post-impl r1 — dò beacon THUẦN cho pagehide: trả true ĐÚNG khi
 * url khác rỗng, online, có sendBeacon, và beacon xác nhận gửi. KHÔNG enqueue
 * bên trong (khác sendRaw) — caller (chunker pagehide) gom mọi body thất bại
 * rồi enqueueBatch MỘT lần đọc/ghi, thay vì từng lô tự enqueue như cũ.
 */
export function tryBeaconOnly(body: string, deps: TransportDeps): boolean {
  if (!deps.url) return false;
  if (!deps.onLine()) return false;
  if (!deps.hasSendBeacon) return false;
  try {
    return deps.sendBeacon(
      deps.url,
      new Blob([body], { type: 'text/plain;charset=UTF-8' }),
    );
  } catch {
    return false;
  }
}

export function dispatchChunks(
  batches: SealedBatch[],
  deps: TransportDeps,
): ChunksDispatchResult {
  const result: ChunksDispatchResult = { sent: 0, queued: 0 };
  for (let i = 0; i < batches.length; i += 1) {
    try {
      const body = JSON.stringify(batches[i].rows); // wire phẳng §0.8
      if (sendRaw(body, true, deps)) {
        // mid — đường sống duy nhất còn lại (xem docstring CR2-m1)
        result.sent += 1;
      } else {
        result.queued += 1;
      }
    } catch {
      result.queued += 1; // lô hỏng không chặn lô sau (§3.1)
    }
  }
  return result;
}

/**
 * §1.5 "Điểm xả — MỘT điều kiện duy nhất": móc vào finish(), mọi
 * finish_reason. Trần 2 gói/lần xả. Mỗi lần resend, tăng `send_attempt`
 * trong chính payload đã lọc trước đó — KHÔNG build lại (FR-016).
 *
 * phase-2: drain cũng là cơ hội retry của lô event (gắn flush scheduler
 * §2.4e — chunker gọi sau flush mid-session thành công). E013: circuit
 * breaker bật ⇒ giữ nguyên hàng đợi chờ TTL, không drain tiếp phiên này.
 */
export function drainOutbox(deps: TransportDeps): void {
  // Chốt chặn ở TẦNG XẢ — riêng biệt với chốt trong sendRaw().
  // Đây là điều kiện "chưa cấu hình", KHÔNG phải "gửi thất bại": không có lý
  // do nào để thử lại (URL sẽ không tự xuất hiện), nên KHÔNG được đi qua
  // resend() — nếu để resend() trả false, outbox.ts sẽ tăng `attempt` rồi bỏ
  // hẳn gói kèm incrementDroppedN() một khi vượt MAX_ATTEMPT, bơm dropped_n
  // GIẢ cho một gói chưa từng có nơi để gửi (phá FR-019), và vẫn tiêu một
  // suất `flushed` của trần 2 gói/lần xả. Return sớm ở đây giữ nguyên hàng
  // đợi, không đụng attempt/dropped_n, chờ tới khi có URL thật.
  if (!deps.url) return;
  if (isDrainHalted(deps.target ?? 'doc')) return; // E013 — kênh auth chết, giữ lô chờ TTL
  const now = deps.now();
  drain(
    now,
    (body, attempt) => {
      let toSend = body;
      try {
        const arr = JSON.parse(body);
        // T064 — discrimination body doc vs lô event khoá ở hàm có tên
        // isDocBody (types.ts), không còn biểu thức inline: chỉ doc phase-1
        // mang send_attempt — lô event (EventRow[]) không có field này, gửi
        // nguyên trạng (đã lọc từ nguồn, FR-016).
        if (isDocBody(arr)) {
          arr[0].send_attempt = attempt + 1;
          toSend = JSON.stringify(arr);
        }
      } catch {
        /* giữ nguyên body gốc nếu parse lỗi */
      }
      if (!deps.hasSendBeacon) return false;
      try {
        return deps.sendBeacon(
          deps.url,
          new Blob([toSend], { type: 'text/plain;charset=UTF-8' }),
        );
      } catch {
        return false;
      }
    },
    2,
    deps.target ?? 'doc',
  );
}
