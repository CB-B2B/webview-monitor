// src/utils/monitor/chunker.ts
//
// phase-2 (webview-session-logs §1.2/§2.4c/§2.4e) — VẬN CHUYỂN sự kiện:
// buffer in-memory (row ĐÃ lọc từ nguồn — events.ts gọi filter trước khi
// push, nên ở đây KHÔNG import ./filter nữa: ARC-n10 r1-TS), chính sách
// flush (32 event | 30s+idle | hidden | pagehide), seal lô ≤32KB THEO BYTE,
// ≤2 beacon pagehide (QĐ-13/R2-7), phần còn lại enqueueBatch MỘT lần đọc/ghi
// (PERF-M4), sau flush mid-session thành công ⇒ drainOutbox (PERF-M3).
//
// KHÔNG sinh sự kiện, không quyết định sampling (việc của events.ts — §1.2).
// Không throw (NFR-001); flush nuốt lỗi TỪNG LÔ độc lập (§3.1).

import { getConfig } from './config';
import {
  byteLength,
  dispatchChunks,
  drainOutbox,
  TransportDeps,
  tryBeaconOnly,
} from './transport';
import { enqueueBatch, incrementDroppedN } from './outbox';
import { EventRow, SealedBatch } from './types';

// §2.2 — hằng số code (không phải env); KHÔNG dùng dấu _ phân cách số
// (Babel 7.10 của dự án không parse được — jest transform khác nên test
// KHÔNG bắt được lỗi này, phải tránh ngay từ nguồn).
export const FLUSH_EVENT_COUNT = 32;
export const FLUSH_INTERVAL_MS = 30000;
export const CHUNK_MAX_BYTES = 32768;
export const PAGEHIDE_MAX_BEACONS = 2;
// ~250B phần mảng/dấu phẩy của JSON array (§2.4c) — trừ hẳn khỏi ngân sách
// byte của row để lô stringify xong vẫn ≤32KB.
const BATCH_ARRAY_OVERHEAD = 250;

export type FlushTrigger = 'count' | 'timer' | 'hidden' | 'pagehide';

let armed = false; // EVENTS_INGEST_URL rỗng ⇒ không dựng gì cả (T043)
let terminal = false; // đã flush('pagehide') — không nhận thêm
let buffer: EventRow[] = [];
let chunkSeq = 0; // thứ tự lô trong phiên — metadata nội bộ (§0.8)
let lastFlushedSeq = 0; // seq lớn nhất đã rời buffer — để events.ts so anchor
// E016 — row đơn lẻ vượt 32KB sau khi cắt, đếm THEO LOẠI ROW (CR-m1
// post-impl r1): row lỗi ⇒ bucket error (error_events_overflow), row mẫu ⇒
// bucket sampled (events_overflow).
let droppedErrorRows = 0;
let droppedSampledRows = 0;
let isFlushing = false; // E023 — cờ re-entrant (timer đụng hidden/pagehide)
let timerId: ReturnType<typeof setTimeout> | undefined;
let visibilityHooked = false;

// TextEncoder module-level DÙNG CHUNG: tái dùng chính instance byteLength()
// của transport.ts (PERF-n1 r1-TS — cấm new TextEncoder() mỗi lời; đo byte
// là nghiệp vụ nóng của seal). Giữ một instance cho cả hai module.
export { byteLength };

function fetchNotSupported(): Promise<Response> {
  return Promise.reject(new Error('fetch not supported'));
}

function buildDeps(): TransportDeps {
  return {
    url: getConfig().eventsIngestUrl,
    target: 'events', // item outbox sinh tại đây là lô event — không drain nhầm doc
    onLine: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
    hasSendBeacon:
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function',
    sendBeacon: (u: string, b: Blob) => navigator.sendBeacon(u, b),
    fetchFn:
      typeof fetch === 'undefined' ? fetchNotSupported : fetch.bind(globalThis),
    now: () => Date.now(),
  };
}

/** seq lớn nhất đã rời buffer — events.ts dùng nhận diện anchor đã flush (§2.4b). */
export function getFlushedSeq(): number {
  return lastFlushedSeq;
}

/** E016 — row bị bỏ vì vượt 32KB sau khi cắt, THEO LOẠI ROW (CR-m1 post-impl r1). */
function isDroppedErrorRow(row: EventRow): boolean {
  return (
    row.type === 'js_error' ||
    row.type === 'business_error' ||
    (row.type === 'api_call' && row.err_kind !== undefined)
  );
}

export function getDroppedByKind(): { error: number; sampled: number } {
  return { error: droppedErrorRows, sampled: droppedSampledRows };
}

/**
 * §2.4c seal — đo MỖI row ĐÚNG MỘT LẦN tại thời điểm seal (JSON.stringify
 * riêng + cộng dồn; cấm đo lại nguyên lô sau mỗi row — O(n²) + ~1,5MB
 * garbage/lô). Lô chạm ngân sách ⇒ seal, mở lô mới (không cắt đôi row);
 * row đơn lẻ vượt ngân sách ⇒ E016 bỏ row + đếm, lô + row khác vẫn đi.
 */
function sealBatches(rows: EventRow[]): SealedBatch[] {
  const batches: SealedBatch[] = [];
  const budget = CHUNK_MAX_BYTES - BATCH_ARRAY_OVERHEAD;
  let current: EventRow[] = [];
  let currentBytes = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    let size: number;
    try {
      size = byteLength(JSON.stringify(row)) + 1; // +1 dấu phẩy/phần tử
    } catch {
      if (isDroppedErrorRow(row)) droppedErrorRows += 1;
      else droppedSampledRows += 1; // row không serialize được — bỏ đúng row (E016)
      continue;
    }
    if (size > budget) {
      if (isDroppedErrorRow(row)) droppedErrorRows += 1;
      else droppedSampledRows += 1; // E016 — không bỏ cả lô vì 1 row
      continue;
    }
    if (current.length > 0 && currentBytes + size > budget) {
      batches.push(seal(current));
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += size;
  }
  if (current.length > 0) batches.push(seal(current));
  return batches;
}

function seal(rows: EventRow[]): SealedBatch {
  chunkSeq += 1;
  return {
    schema: 'wv-events/1',
    chunk_seq: chunkSeq,
    first_seq: rows[0].seq,
    last_seq: rows[rows.length - 1].seq,
    event_count: rows.length,
    rows,
  };
}

// ─── Flush scheduler (§2.4e) ────────────────────────────────────────────────

function stopTimer(): void {
  if (timerId !== undefined) {
    clearTimeout(timerId);
    timerId = undefined;
  }
}

function armTimer(): void {
  if (terminal || timerId !== undefined) return;
  timerId = setTimeout(() => {
    timerId = undefined;
    // PERF-m2 r1-TS — dời việc sang idle; rIC KHÔNG timeout có thể trì hoãn
    // vô hạn (iOS WKWebView thường thiếu hẳn API) ⇒ {timeout:2000}, không
    // có thì chạy thẳng.
    try {
      // SAFETY: requestIdleCallback thiếu trong TS lib.dom ở một số target build
      // của dự án (iOS WKWebView không hỗ trợ) — truy cập best-effort qua
      // optional chaining, không giả định API tồn tại.
      const ric = (
        window as unknown as {
          requestIdleCallback?: (
            cb: () => void,
            o?: { timeout: number },
          ) => number;
        }
      ).requestIdleCallback;
      if (typeof ric === 'function') {
        ric(() => flush('timer'), { timeout: 2000 });
        return;
      }
    } catch {
      /* chạy thẳng */
    }
    flush('timer');
  }, FLUSH_INTERVAL_MS);
}

function onVisibility(): void {
  try {
    if (document.visibilityState === 'hidden') {
      // Ngoại lệ CÓ CHỦ ĐÍCH của NFR-001 (§2.4e): hidden là tín hiệu đáng tin
      // cuối trên mobile — flush ĐỒNG BỘ, KHÔNG qua rIC; buffer có trần ~32
      // event nên chi phí bị chặn. Dừng timer chờ visible cài lại.
      stopTimer();
      flush('hidden');
    } else {
      armTimer(); // R2-6 — visible lại ⇒ stream tiếp tục, cài lại timer
    }
  } catch {
    /* NFR-001 */
  }
}

/**
 * Scheduler + listener — chỉ arm khi events.ts khởi động với EVENTS_INGEST_URL
 * khác rỗng (initEventStream). T043: URL rỗng ⇒ không buffer, không outbox,
 * không timer — không dựng cơ sở hạ tầng không xả được (§1.6 phase-1).
 */
export function arm(): void {
  if (armed || !getConfig().eventsIngestUrl) return;
  armed = true;
  armTimer();
  if (
    !visibilityHooked &&
    typeof document !== 'undefined' &&
    typeof document.addEventListener === 'function'
  ) {
    visibilityHooked = true;
    document.addEventListener('visibilitychange', onVisibility);
  }
}

/**
 * Flush theo trigger. E023: cờ re-entrant + seal NGUYÊN TỬ bằng swap tham
 * chiếu buffer (`const rows = buffer; buffer = []`) — hai trigger đụng nhau
 * xử lý tập rời rạc, không row nhân bản; row mang seq đơn điệu nên gửi lặp
 * vẫn khử trùng lúc query (GROUP BY session_id, seq).
 *
 * pagehide (terminal): ≤PAGEHIDE_MAX_BEACONS lô ĐẦU FIFO qua beacon
 * (tryBeaconOnly — KHÔNG tự enqueue); MỌI body thất bại + phần còn lại gom
 * vào enqueueBatch() MỘT lần đọc/ghi đồng bộ TRƯỚC khi hàm kết thúc
 * (E017/E018 — PERF-M4). mid: mọi lô qua bảng quyết định §1.5 (beacon;
 * beacon false ⇒ fetch-keepalive 1 lần ⇒ outbox); sent>0 ⇒ drainOutbox
 * (PERF-M3 — ≤2 item/lần theo cadence tự nhiên ≤1 lần/30s).
 */
export function flush(trigger: FlushTrigger): void {
  if (!armed || isFlushing) return; // E023
  if (trigger === 'pagehide' && terminal) return;
  // CR-n1 post-impl r1: pagehide ĐÙNG terminal kể cả khi buffer rỗng —
  // trước đây `terminal = true` nằm trong `if (rows.length > 0)` nên một
  // pagehide flush rỗng để chunker còn "sống" sau khi trang đã chết (timer
  // cài lại được, pushEvent nhận tiếp).
  if (trigger === 'pagehide') {
    terminal = true;
    stopTimer();
  }
  isFlushing = true;
  try {
    const rows = buffer; // seal nguyên tử — swap tham chiếu (E023)
    buffer = [];
    if (rows.length > 0) {
      // CR-m1 post-impl r1 (E016): snapshot tổng drop TRƯỚC seal — delta phát
      // sinh trong CHÍNH lần flush pagehide này (sau khi session_end row đã
      // seal, không còn cơ hội lên counters của row đó) ⇒ cộng mon_dropped_n
      // ở dưới, hiện số qua doc phiên kế tiếp.
      const droppedBefore = droppedErrorRows + droppedSampledRows;
      const batches = sealBatches(rows);
      if (batches.length > 0) {
        lastFlushedSeq = Math.max(
          lastFlushedSeq,
          batches[batches.length - 1].last_seq,
        );
        const deps = buildDeps();
        if (trigger === 'pagehide') {
          // PERF-m2 post-impl r1 — MỘT lần đọc/ghi outbox đúng nghĩa PERF-M4:
          // trước đây dispatchChunks() tự enqueue TỪNG lô beacon fail ⇒ worst
          // case 3 chu kỳ read+write localStorage đúng lúc trang chết. Giờ:
          // tryBeaconOnly từng lô (không enqueue), gom body thất bại + phần
          // rest, MỘT enqueueBatch duy nhất.
          const bodies: string[] = [];
          let beaconAttempts = 0;
          for (let i = 0; i < batches.length; i += 1) {
            let body: string;
            try {
              body = JSON.stringify(batches[i].rows); // wire phẳng §0.8
            } catch {
              continue; // lô không serialize được — bỏ lô, không chặn lô sau (§3.1)
            }
            // 2 lô ĐẦU FIFO (QĐ-13/R2-7): đúng PAGEHIDE_MAX_BEACONS lô được
            // THỬ beacon — kể cả fail cũng không thử lô thứ 3.
            if (beaconAttempts < PAGEHIDE_MAX_BEACONS) {
              beaconAttempts += 1;
              if (tryBeaconOnly(body, deps)) continue; // SENT qua beacon
            }
            bodies.push(body);
          }
          if (bodies.length > 0) {
            // CR-n3: target 'events' tường minh — default của enqueueBatch
            // là 'events' nhưng mọi call-site của chunker truyền rõ.
            enqueueBatch(bodies, deps.now(), 'events');
          }
        } else {
          const result = dispatchChunks(batches, deps); // mid (CR2-m1 r2)
          if (result.sent > 0) drainOutbox(deps); // PERF-M3 r1-TS
        }
      }
      if (trigger === 'pagehide') {
        const delta = droppedErrorRows + droppedSampledRows - droppedBefore;
        if (delta > 0) incrementDroppedN(delta); // E016/CR-m1 — hiện số
      }
    }
  } catch {
    /* NFR-001 — nuốt, không throw lúc flush */
  } finally {
    isFlushing = false;
  }
  // Chỉ cài lại chu kỳ 30s cho trigger timer (định kỳ lặp) và count (trang
  // đang sống — timer thường đã có, armTimer no-op). KHÔNG arm sau 'hidden':
  // §2.4e dừng timer khi hidden và chờ VISIBLE cài lại (onVisibility) — arm
  // lại ngay tại hidden sẽ giữ timer chạy ngầm dưới nền hidden, phá tiết
  // kiệm và gây flush rIC không bao giờ chạy (rIC treo khi tab ẩn).
  if (trigger === 'timer' || trigger === 'count') armTimer();
}

/** pushEvent — buffer row ĐÃ lọc; đủ 32 ⇒ flush ngay (§2.4e). */
export function pushEvent(row: EventRow): void {
  if (!armed || terminal) return;
  try {
    buffer.push(row);
    if (buffer.length >= FLUSH_EVENT_COUNT) flush('count');
  } catch {
    /* NFR-001 */
  }
}

export function __resetChunkerForTest(): void {
  stopTimer();
  armed = false;
  terminal = false;
  buffer = [];
  chunkSeq = 0;
  lastFlushedSeq = 0;
  droppedErrorRows = 0;
  droppedSampledRows = 0;
  isFlushing = false;
  // Listener giữ nguyên (visibilityHooked) — guard `armed` chặn mọi hành
  // vi cho tới lần arm() kế tiếp; gỡ listener giữa chừng jsdom không cần.
}
