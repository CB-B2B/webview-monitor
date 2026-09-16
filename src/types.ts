// src/utils/monitor/types.ts
//
// Kiểu dữ liệu công khai của module giám sát (§2.1, §2.2, §2.3 Tech Spec
// webview-monitoring). Không có logic — chỉ khai báo kiểu, để dùng chung
// giữa mã sản xuất và test (T077 đòi hằng số danh sách trường dùng chung).

// Ví dụ cụ thể của `vp` (VPBank) — KHÔNG phải danh sách cố định của
// module: sau ticket 03 (webview-monitor-package-extraction), danh sách
// bước thật sự do host truyền vào qua `monitor.init({ steps })`
// (ADR-0001 — học-thời-gọi không có mặc định cấp module). Kiểu
// `StepName` giữ dạng union chuỗi 6 giá trị này vì `vp` (host duy nhất
// hiện có) vẫn dùng đúng tập này — một bank khác sẽ cần union khác
// khi được tách thành package (hoãn theo ADR-0001).
export type StepName =
  | 'auth_user' // authUser(location.query)          layouts/index.tsx:183
  | 'home_float_icon' // getHomeFloatIcon()                            :185
  | 'partner_id' // getPartnerId()                                :186
  | 'home_banner' // handleShowHomeBanner()                        :187
  | 'config' // getCfg()                                      :188
  | 'search_hint'; // fetchSearchHintNews({...})                  :189-191

// Ví DỤ của `vp` — giá trị THẬT do `src/app.ts` truyền vào qua
// `monitor.init({ steps: STEP_NAMES, ... })`. KHÔNG còn là hằng số nội bộ
// của index.ts — xem src/app.ts cho call site thật.
export const STEP_NAMES: ReadonlyArray<StepName> = [
  'auth_user',
  'home_float_icon',
  'partner_id',
  'home_banner',
  'config',
  'search_hint',
];

export type MarkName = 'mount' | 'home_ready';

export type FinishReason =
  | 'home_shown'
  | 'pagehide'
  | 'visibility_hidden'
  | 'init_failed'
  | 'queue_flush';

// SEC-n2 post-impl r1 — danh sách literal FinishReason dùng chung cho việc
// VALIDATE runtime (events.ts session_end): cast `as FinishReason` một mình
// không chặn chuỗi lạ lên wire; đối chiếu bảng này trước khi gán field.
export const FINISH_REASONS: readonly FinishReason[] = [
  'home_shown',
  'pagehide',
  'visibility_hidden',
  'init_failed',
  'queue_flush',
];

export type ErrKind =
  | 'timeout' // request.isTimeoutErr(err) === true
  | 'offline' // navigator.onLine === false tại thời điểm lỗi
  | 'http' // response status >= 400
  | 'parse' // 2xx nhưng body không parse được / thiếu field bắt buộc
  | 'unknown'; // còn lại — BAO GỒM lỗi CORS/opaque

export interface HttpSample {
  url: string; // đã qua normalizeApiUrl() — KHÔNG BAO GIỜ là url gốc
  host: 'main' | 'sys' | 'other'; // enum, không ghi hostname nguyên văn
  method: string;
  t_offset: number; // performance.now() lúc BẮT ĐẦU, quy chiếu navMs
  ms: number;
  ok: boolean;
  err_kind?: ErrKind; // chỉ có khi ok === false
  step_seq: number | null; // bước đang mở lúc request bắt đầu; null = bay ngoài mọi bước
}

export interface StepResult {
  seq: number; // 0..5
  name: StepName;
  started_at_offset: number; // performance.now() lúc vào bước, quy chiếu navMs
  ms: number;
  status: 'ok' | 'error' | 'pending';
  http_status?: number;
  error_code?: string; // mã nghiệp vụ từ BE — KHÔNG phải message tự do
  err_kind?: ErrKind;
  failed_endpoint?: string; // normalizeApiUrl() của request hỏng đầu tiên trong bước
}

export interface TechError {
  type: string; // err.constructor.name / err.name — KHÔNG phải err.toString() thô
  message: string; // đã qua Lớp 2, cắt còn 512 ký tự
  stack?: string; // đã qua Lớp 2, cắt còn 2.000 ký tự
}

// Tên rule đi kèm để gắn vào l2_hits_by_rule — hằng trong mã, không phải dữ liệu
export type L2RuleName =
  | 'JWT'
  | 'BEARER'
  | 'LONG_TOKEN'
  | 'TOKEN_KEYWORD'
  | 'LONG_DIGITS'
  | 'EMAIL'
  | 'DATE'
  | 'SEP_DIGITS';

export interface SessionPayload {
  /** HỢP ĐỒNG R2-1b/QĐ-17 (§8.1 #5 — R2-1b lớp 1): doc phase-1 KHÔNG BAO GIỜ
   *  mang `record_type` — sự VẮNG MẶT chính là discriminator (isDocBody dựa
   *  vào nó khi retry ở transport.ts). `never` biến việc gán vào đây thành lỗi
   *  biên dịch (bắt hồi quy ở `tsc`, không đợi runtime — NFR-001 cấm thêm
   *  throw), và không phát gì lên dây (optional, không bao giờ gán —
   *  buildPayload dựng field-by-field nên không vỡ). */
  record_type?: never;

  // --- Định danh phiên (bảng A) ---
  session_id: string; // crypto.randomUUID() — FR-008
  sid_weak?: true; // chỉ có khi phải dùng fallback sinh id (E008)

  // --- Thời gian (bảng A) --- LUÔN number, không bao giờ string (§2.5)
  session_started_at: number; // epoch ms
  session_finished_at: number;
  session_duration_ms: number;
  time_to_home_ms?: number; // marks.home_ready − navigation start

  // --- Kết quả bước (bảng A) ---
  steps: StepResult[]; // đúng 6 phần tử, kể cả bước chưa chạy tới ('pending')

  // --- Kết quả phiên ---
  home_reached: boolean;
  finish_reason: FinishReason;

  // --- Trang (bảng A) ---
  pathname: string; // normalizeRoute() — KHÔNG BAO GIỜ raw pathname/href

  // --- Thiết bị (FR-005/FR-006 phase-2) — phẳng, cùng giá trị EventRow ---
  // Option để fixture phase-1 (không khai) vẫn hợp kiểu; buildPayload LUÔN
  // đặt (giá trị '' khi thiếu — EventRow.device_model bắt buộc phía stream).
  device_model?: string; // detectDeviceModel(); '' khi thiếu (UA Reduction)

  // --- Môi trường (bảng A) ---
  env: {
    device_type: 'mobile' | 'tablet' | 'desktop' | 'unknown';
    os: string;
    os_version: string;
    webview_version: string;
    language: string;
    connection_type: string;
    release_version: string;
  };

  // --- Lỗi kỹ thuật (bảng A) ---
  http_samples: HttpSample[]; // trần 20
  http_overflow: number; // số request bị cắt khỏi mẫu
  error?: TechError;

  // --- Phân nhóm đối tác (bảng A) --- giá trị thật do host truyền qua
  // config.partnerId (ADR-0001) — `vp` truyền literal 'vpbank' tại app.ts,
  // không còn cứng trong module (xem payload.ts).
  partner: string;

  // --- Chẩn đoán ---
  filter_l2_hits: number;
  l2_hits_by_rule: Partial<Record<L2RuleName, number>>;
  l2_paths: string[];
  send_attempt: number;
  sample_rate: number;
  dropped_n?: number;
}

// Danh sách tên field cấp 1 hợp lệ của SessionPayload — DÙNG CHUNG giữa
// buildPayload() (§2.4 Lớp 1) và test T077 (§5.5 mục 2), để không lệch tay.
// is_drill KHÔNG có ở đây — GỠ theo QĐ-33/QĐ-37: không có nhánh diễn tập.
export const WHITELIST_FIELDS: ReadonlyArray<keyof SessionPayload> = [
  'session_id',
  'sid_weak',
  'session_started_at',
  'session_finished_at',
  'session_duration_ms',
  'time_to_home_ms',
  'steps',
  'home_reached',
  'finish_reason',
  'pathname',
  'env',
  'device_model',
  'http_samples',
  'http_overflow',
  'error',
  'partner',
  'filter_l2_hits',
  'l2_hits_by_rule',
  'l2_paths',
  'send_attempt',
  'sample_rate',
  'dropped_n',
];

// ─── phase-2 (webview-session-logs §2.2) — event stream ────────────────────

export type EventKind =
  | 'route_view' // FR-001 — mỗi lần SPA chuyển màn
  | 'api_call' // FR-002 — thành công (mẫu) + thất bại (100%)
  | 'js_error' // FR-003 — window.onerror / unhandledrejection
  | 'business_error' // FR-004 — HTTP 200 + body success:false
  | 'session_end'; // đóng phiên trên pagehide/init_failed

/** Đầu vào monitor.event() — CHƯA filter (§2.2). */
export interface EventInput {
  type: EventKind;
  route?: string; // mặc định: currentRoute
  endpoint?: string; // đã normalizeApiUrl() TẠI CALL SITE
  method?: string;
  status?: number;
  errKind?: ErrKind;
  code?: string; // data.code hoặc err.name (js_error); session_end: reason
  message?: string; // thô — sẽ qua sanitizeMessage()
  latencyMs?: number;
}

/**
 * 1 dòng timeline — nguồn chân lý (FR-002, r1-ARC-M2). 100% trường phẳng
 * (FR-007 — tránh blocker C-12 phase-1); mỗi record tự đứng được khi truy vấn.
 */
export interface EventRow {
  record_type: 'event';
  session_id: string; // cùng session id doc phase-1 (FR-005)
  session_started_at: number; // epoch ms
  t_offset: number; // ms từ session start (performance.now() − navMs)
  seq: number; // tăng dần từ 1 — CHỈ cấp cho row được buffer
  type: EventKind;
  route: string; // normalizeEventRoute() §5.3.2
  sample_rate: number; // cờ rate áp cho row — báo cáo đọc kèm (FR-011 note)
  release_version: string; // FR-005
  env_name: string; // phẳng hoá, KHÔNG nhúng env{} lồng
  device_model: string; // FR-006; '' khi UA Reduction thiếu Client Hints
  endpoint?: string;
  method?: string;
  status?: number;
  err_kind?: ErrKind;
  code?: string; // cắt 128 (kho); js_error: code = err.name
  message?: string; // ĐÃ sanitizeMessage(), cắt 512
  latency_ms?: number;
  coalesce_count?: number; // ≥2 khi row đại diện N lần trùng (§2.4b)
  finish_reason?: FinishReason; // session_end
  error_events_overflow?: number; // cap 200 (FR-015)
  events_overflow?: number; // cap 500 (QĐ-12)
  api_retry_dupes?: number; // số lần gộp retry (§2.4b)
  filter_faults?: number; // E020 — tổng lỗi filter trong phiên (SEC-m5)
}

/**
 * Lô vận chuyển — metadata NỘI BỘ, KHÔNG gửi trên dây (§0.8 wire phẳng):
 * body gửi = JSON.stringify(batch.rows) — mảng EventRow phẳng, mỗi phần tử
 * MỘT record trên OpenObserve; không tồn tại record "chunk" trên kho.
 */
export interface SealedBatch {
  schema: 'wv-events/1'; // chữ ký version — debug/dedupe nội bộ
  chunk_seq: number; // thứ tự lô trong phiên (log + outbox key)
  first_seq: number;
  last_seq: number;
  event_count: number;
  rows: EventRow[];
}

/**
 * T064 (R2-1b/E013) — discriminator body doc vs body lô event, khoá ở HÀM
 * CÓ TÊN thay vì biểu thức inline rải rác. Vào: MẢNG ĐÃ PARSE lại từ body
 * string của đường outbox (JSON.parse(body) — vòng serialize là một phần của
 * hợp đồng: `undefined` biến mất qua JSON.stringify nên discrimination phải
 * đọc được trên dữ liệu đã qua dây).
 *
 * Ra `true` ⇔ phần tử đầu là object mà `record_type` VẮNG MẶT (=== undefined)
 * — dấu hiệu doc phase-1. `false` cho: lô EventRow (`record_type === 'event'`),
 * body probe/replay (`record_type === 'probe'` — runbook §8.2, KHÔNG bị dán
 * nhãn doc), mọi giá trị record_type khác, mảng rỗng, phần tử scalar/null, và
 * không-phải-mảng.
 *
 * ⚠️ Giới hạn đã biết (post-impl r11 — code-reviewer MAJOR-1 / SEC-F4 / ARC-m1):
 * một object RÁC thiếu record_type (vd `[{foo:1}]`) KHÔNG phân biệt được với
 * doc bằng riêng field này ⇒ vẫn trả `true`. Đây KHÔNG phải rò kênh: định
 * tuyến URL theo kênh do `OutboxItem.target` quyết (outbox.ts `drain()`), hàm
 * này chỉ gác việc đóng dấu `send_attempt` (field CHỈ-doc). Rác-dạng-object
 * chỉ tới được khi localStorage hỏng/legacy — chấp nhận là residual, không
 * giả vờ đã đóng.
 */
export function isDocBody(body: unknown): boolean {
  if (!Array.isArray(body) || body.length === 0) return false;
  const first = body[0];
  if (typeof first !== 'object' || first === null) return false;
  // record_type VẮNG MẶT ⇒ doc phase-1. Bất kỳ giá trị nào (kể cả 'event',
  // 'probe', rác) ⇒ KHÔNG phải doc ⇒ không đóng dấu send_attempt.
  return (first as { record_type?: unknown }).record_type === undefined;
}

/**
 * Cờ success GỐC của body phản hồi (§1.4a) — đọc TRƯỚC chỗ request.ts ghi
 * đè `success: status < 400`. Chỉ scalar qua biên giới module (A-8 phase-1).
 */
export interface HttpBodyInfo {
  ok: boolean;
  code?: string;
  message?: string;
}
