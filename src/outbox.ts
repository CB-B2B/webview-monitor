// src/utils/monitor/outbox.ts
//
// §1.5 Phát gói và hàng đợi gửi bù (NFR-005). Toàn bộ truy cập
// `localStorage` nằm ở đây, luôn bọc try/catch (E012 — "không được throw
// ra ngoài").

export const OUTBOX_KEY = 'mon_outbox';
const DROPPED_KEY = 'mon_dropped_n';
export const MAX_ITEMS = 20; // FIFO, tràn ⇒ bỏ gói CŨ NHẤT
export const MAX_ATTEMPT = 3; // NFR-005
export const TTL_MS = 24 * 60 * 60 * 1000; // NFR-005
// KHÔNG dùng dấu phân cách số (30_000): Babel 7.10.4 của dự án không parse
// được, webpack build vỡ. Jest dùng transform khác nên test KHÔNG bắt được.
export const BACKOFF = [30000, 300000, 1800000]; // 30s / 5m / 30m

/**
 * Phân loại item theo kênh phát (phase-2): doc phase-1 ⇒ INGEST_URL, lô event
 * ⇒ EVENTS_INGEST_URL. Outbox là MỘT khoá dùng chung, nhưng hai kênh hai URL —
 * item không mang đích thì drain() theo caller nào cũng gửi nhầm ĐƯỜNG
 * (body doc đi qua path của kênh event và ngược lại — sau QĐ-17 cả hai đổ về
 * MỘT stream `webview_sessions`, nên hại không còn là "nhầm stream" mà là
 * nhầm ACL/L0: lô gửi sai path thoát khỏi công tắc tắt khẩn của chính nó).
 * ARC-n11 r1-TS chỉ chấp nhận chia sẻ COUNTER dropped_n, không chấp nhận nhầm
 * đích. Thiếu field (item persist từ bản phase-1 cũ) ⇒ 'doc' — phase-1 chỉ
 * từng enqueue doc nên mặc định này luôn đúng với dữ liệu thừa kế.
 */
export type OutboxTarget = 'doc' | 'events';

export interface OutboxItem {
  body: string; // SessionPayload đã lọc, đã JSON.stringify — KHÔNG build lại
  attempt: number;
  firstAt: number;
  nextAt: number;
  target?: OutboxTarget; // thiếu ⇒ 'doc' (tương thích item phase-1 cũ)
}

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // E012 — chế độ riêng tư / hết quota
  }
}

function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false; // E012 — không throw ra ngoài
  }
}

// E019 (PERF-m3 r1-TS) — thoái hoá in-memory khi persist outbox thất bại
// (QuotaExceededError): mode suy biến GIỮ NGUYÊN MAX_ITEMS=20/TTL/FIFO, chỉ
// thay persist bằng mảng — trần ~640KB bộ nhớ, capture tiếp tục (mất gửi bù
// qua reload, KHÔNG mất gửi hiện tại). Lần ghi thất bại ĐẦU TIÊN gieo mảng
// với đúng nội dung định ghi (kể cả item đang sống trong localStorage).
let memOutbox: OutboxItem[] | null = null;

export function readOutbox(): OutboxItem[] {
  if (memOutbox !== null) return memOutbox.map(i => ({ ...i }));
  const raw = safeGetItem(OUTBOX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOutbox(items: OutboxItem[]): void {
  if (memOutbox !== null) {
    memOutbox = items; // đã thoái hoá — chỉ còn in-memory
    return;
  }
  if (!safeSetItem(OUTBOX_KEY, JSON.stringify(items))) {
    memOutbox = items; // E019 — QuotaExceededError ⇒ suy biến in-memory
  }
}

/**
 * E006/E004 — đẩy một gói (đã lọc, đã stringify) vào hàng đợi gửi bù.
 * `attempt` bắt đầu từ 1 ngay khi enqueue.
 */
export function enqueue(
  body: string,
  now: number,
  // CR-n3 post-impl r1: default 'doc' cho doc phase-1 — BẤT ĐỐI XỨNG có chủ
  // với default 'events' của enqueueBatch; call-site mới nên truyền tường minh.
  target: OutboxTarget = 'doc',
  retryAt?: number,
): void {
  enqueueBatch([body], now, target, retryAt);
}

/**
 * phase-2 (PERF-M4 r1-TS / E017) — entry-point gom N LÔ vào hàng đợi với
 * MỘT chu trình readOutbox→push→writeOutbox. Item logic KHÔNG đổi (R2-3:
 * 1 item = 1 body bất khả tri — giờ là 1 lô JSON.stringify(EventRow[]));
 * enqueue từng lô một bằng enqueue() cũ là N × (parse+stringify+setItem)
 * đồng bộ toàn file ≤640KB ≈ 30–100ms jank đúng lúc trang chết (pagehide).
 * FIFO bỏ cũ nhất (E018) — mất mát hiện số qua dropped_n.
 * `retryAt` (E014): ưu tiên Retry-After của 429 thay BACKOFF[0] nếu có.
 */
export function enqueueBatch(
  bodies: string[],
  now: number,
  // CR-n3 post-impl r1: default 'events' cho lô event (đối trọng 'doc' của
  // enqueue) — BẤT ĐỐI XỨNG có chủ; call-site nên truyền tường minh.
  target: OutboxTarget = 'events',
  retryAt?: number,
): void {
  if (bodies.length === 0) return;
  const items = readOutbox();
  // §8.1 #13 (R2-9) — [0, oldEnd) là phần item có TRƯỚC lô đang enqueue:
  // chốt TRƯỚC vòng push để lô vừa enqueue không bao giờ tự trục xuất chính
  // nó ở chế độ thường (chỉ nhánh suy biến oldEnd === 0 dưới đây là ngoại lệ,
  // r5-PERF-N1).
  let oldEnd = items.length;
  for (let i = 0; i < bodies.length; i += 1) {
    items.push({
      body: bodies[i],
      target,
      attempt: 1,
      firstAt: now,
      nextAt: retryAt !== undefined ? retryAt : now + BACKOFF[0],
    });
  }
  // Trục xuất có HẠN NGẠCH THEO TARGET (§8.1 #13, sửa r5-PERF-N1): một kênh
  // kẹt chỉ được ăn vào phần của chính nó — khi outbox tràn, bỏ lô cũ nhất
  // CÙNG TARGET với lô vừa enqueue, xét trên PHẦN CŨ. Không còn item cùng
  // target ⇒ bỏ item CŨ NHẤT còn lại (FIFO toàn cục trên phần cũ — nhánh
  // fallback này TỚI ĐƯỢC, T070 b/f). Nếu phần cũ đã cạn thì index 0 chính là
  // lô mới: suy biến cuối, chỉ xảy ra khi MỘT lời gọi enqueueBatch mang hơn
  // MAX_ITEMS lô vào phần cũ đã rỗng/cạn (E018 — r6-PERF-N6).
  // Giữ idiom accumulator PERF-m1 post-impl r1: MỘT chu kỳ get+set
  // localStorage cho cả vòng (incrementDroppedN gọi MỘT lần dưới), không phải
  // N — vòng này chạy đúng lúc trang đang chết (pagehide).
  let removed = 0;
  while (items.length > MAX_ITEMS) {
    // chỉ tìm trong PHẦN CŨ: item cũ nhất cùng target với lô đang enqueue;
    // item legacy phase-1 thiếu field ⇒ coerce 'doc' (tương thích drain(),
    // T070 h1/h2 — KHÔNG theo target của lời gọi).
    let i = items.findIndex(
      (it, idx) => idx < oldEnd && (it.target ?? 'doc') === target,
    );
    if (i < 0) i = 0;
    if (i < oldEnd) oldEnd -= 1; // vùng cũ co lại theo item vừa bỏ
    items.splice(i, 1); // — E018
    removed += 1;
  }
  if (removed > 0) incrementDroppedN(removed); // MỘT lần gọi — E018: mất mát hiện số
  writeOutbox(items);
}

/**
 * Bộ đếm gói bị bỏ hẳn (quá MAX_ATTEMPT hoặc quá TTL) — cộng dồn cho tới
 * khi được một payload sắp gửi đọc và reset (readAndResetDroppedN), để
 * mất mát hiện ra thành số thay vì im lặng (FR-019).
 * E019: persist counter thất bại (cùng QuotaExceededError của outbox) ⇒
 * cộng vào biến in-memory — mất persist, KHÔNG mất số trong phiên.
 */
let memDroppedN = 0;

export function incrementDroppedN(by = 1): void {
  const current = Number(safeGetItem(DROPPED_KEY)) || 0;
  if (!safeSetItem(DROPPED_KEY, String(current + by))) {
    memDroppedN += by; // E019 — nuốt lỗi ghi, giữ số in-memory
  }
}

export function readAndResetDroppedN(): number {
  const current = (Number(safeGetItem(DROPPED_KEY)) || 0) + memDroppedN;
  if (current > 0) {
    safeSetItem(DROPPED_KEY, '0');
    memDroppedN = 0;
  }
  return current;
}

export type ResendFn = (body: string, attempt: number) => boolean;

/**
 * SEC-4/R3-N1 — dọn TTL thụ động: bỏ item quá hạn 24h, TĂNG dropped_n để
 * mất mát hiện ra thành số (FR-019), KHÔNG gửi mạng gì cả.
 *
 * Vì sao cần riêng: TTL chỉ được thực thi bên trong drain(), mà drain()
 * chỉ chạy khi có phiên hoàn tất (`_finish`). Monitor tắt (INGEST_URL rỗng
 * / cờ L1 off) ⇒ drain() không bao giờ chạy ⇒ item từ bản dựng trước nằm
 * lại vĩnh viễn trên thiết bị — phá tiền đề "TTL ngắn" mà R-6 dùng để biện
 * minh việc không mã hoá. pruneExpired() được gọi từ attachLifecycle()
 * MỖI LẦN NẠP TRANG, vô điều kiện với INGEST_URL và cờ, nên tiền đề 24h
 * luôn được thực thi kể cả khi monitor tắt.
 */
export function pruneExpired(now: number): number {
  const items = readOutbox();
  if (items.length === 0) return 0;
  const remaining = items.filter(item => now - item.firstAt <= TTL_MS);
  const removed = items.length - remaining.length;
  if (removed > 0) {
    incrementDroppedN(removed);
    writeOutbox(remaining);
  }
  return removed;
}

/**
 * §1.5: giãn cách bằng đồng hồ tường (Date.now()), trần 2 gói/lần xả.
 * `resend` phải là gọi đồng bộ (vd sendBeacon) và trả về true/false — hàm
 * này không tự quyết định mạng, chỉ điều phối hàng đợi.
 */
export function drain(
  now: number,
  resend: ResendFn,
  maxFlush = 2,
  target: OutboxTarget = 'doc',
): void {
  const items = readOutbox();
  if (items.length === 0) return;

  let flushed = 0;
  const remaining: OutboxItem[] = [];

  for (const item of items) {
    if ((item.target ?? 'doc') !== target) {
      remaining.push(item); // item kênh khác — giữ nguyên, không tiêu suất xả
      continue;
    }
    if (flushed >= maxFlush) {
      remaining.push(item);
      continue;
    }
    if (now - item.firstAt > TTL_MS) {
      incrementDroppedN();
      flushed += 1;
      continue; // bỏ hẳn — quá hạn
    }
    if (now < item.nextAt) {
      remaining.push(item); // chưa tới giờ thử lại
      continue;
    }
    if (item.attempt > MAX_ATTEMPT) {
      // Phòng thủ — không nên xảy ra qua đường bình thường (đã chặn ở
      // nhánh dưới), nhưng một item hỏng/cũ mang attempt vượt trần vẫn
      // phải bị bỏ thay vì thử gửi lại vô hạn.
      incrementDroppedN();
      flushed += 1;
      continue;
    }

    flushed += 1;
    const ok = resend(item.body, item.attempt);
    if (ok) {
      continue; // gửi thành công — bỏ khỏi hàng đợi
    }
    const nextAttempt = item.attempt + 1;
    if (nextAttempt > MAX_ATTEMPT) {
      incrementDroppedN();
      continue; // bỏ hẳn — quá số lần thử
    }
    const backoffIdx = Math.min(nextAttempt - 1, BACKOFF.length - 1);
    remaining.push({
      ...item,
      attempt: nextAttempt,
      nextAt: now + BACKOFF[backoffIdx],
    });
  }

  writeOutbox(remaining);
}

/** Chỉ dùng trong test — trả E019 về chế độ persist bình thường. */
export function __resetOutboxForTest(): void {
  memOutbox = null;
  memDroppedN = 0;
}
