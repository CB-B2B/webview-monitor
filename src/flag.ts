// src/utils/monitor/flag.ts
//
// §1.6 Công tắc tắt — Lớp L1: cờ cấu hình lúc chạy, đọc từ chính domain
// obs-qrx. Fetch KHÔNG chặn `start()`; giá trị đọc về áp dụng cho phiên KẾ
// TIẾP, nên `start()` của phiên hiện tại luôn dùng giá trị đã có sẵn trong
// `cachedFlag` (mặc định enabled=true, rate=1 — E011).
//
// Bản trước ghi "giữ trong biến module, không cache localStorage" — câu đó tự
// mâu thuẫn và là nguyên nhân của L-C1: "phiên kế tiếp" đòi sống sót qua một
// lần nạp trang, mà biến module thì không. Xem chú thích dài ở FLAG_KEY.
//
// ĐÍNH CHÍNH §1.6 (`docs/features/webview-monitoring.md:1145`): dòng đó hứa cờ
// có hiệu lực với "phiên mở mới: ngay". KHÔNG đạt được — `app.ts` gọi
// `monitor.start()` TRƯỚC `attachLifecycle()` (nơi `fetchFlag()` chạy), nên
// phiên đọc được cờ mới vẫn khởi động bằng giá trị cũ. Muốn "ngay" thì phải
// `await` cờ trước `start()`, điều chính §1.6 cấm. Thực tế: trễ ĐÚNG MỘT
// PHIÊN — đã đo. Hai yêu cầu đó của spec mâu thuẫn nhau.
//
// ── phase-2 (webview-session-logs §2.2) ──
// +2 field (route_sample_rate / api_ok_sample_rate — type validation, thiếu
// ⇒ default tính TẠI CHỖ ĐỌC).
//
// KÊNH GA ĐÃ BỎ (quyết định 2026-08-17): trước đây file này còn `ga_enabled`,
// `isFlagConfirmed()` (marker localStorage `mon_flag_ok`) và `isGaArmed()`
// (gate 5 điều kiện §0.4) phục vụ kênh mirror sang GTM. Kho OpenObserve giữ
// toàn bộ dữ liệu nên kênh đó không còn lý do tồn tại; giữ lại chỉ để ghi một
// khoá localStorage không ai đọc. GTM/GA4 sẵn có của app KHÔNG liên quan và
// không bị đụng tới.
//
// Cờ `ga_enabled` nếu còn sót trong JSON trả về sẽ bị bỏ qua như mọi khoá lạ
// khác — không cần dọn `/etc/haproxy/obs/monitor_flag.json` gấp.

// URL điểm nhận cờ L1 — đọc từ config host-supplied qua init() (ADR-0001).
// Rỗng ⇒ fetchFlag() no-op, giữ nguyên mặc định "bật" (đúng §1.6, ADR-0002
// nhóm network-endpoint: fail-safe, không throw).
import { getConfig } from './config';

export interface MonitorFlag {
  enabled: boolean;
  rate: number; // phase-1 — GIỮ trường, deprecated; KHÔNG dùng bốc sampling
  http: boolean;
  steps: boolean;
  // ── phase-2 §2.2 — option để JSON phase-1 (và test seed phase-1) không
  // phải khai; default được tính tại chỗ đọc (defaultRate dưới đây), không
  // nướng cứng vào object — giữ toEqual 4 khoá của hệ phase-1 nguyên vẹn.
  route_sample_rate?: number; // 0..1, thiếu ⇒ 1 (§2.2)
  api_ok_sample_rate?: number; // 0..1, thiếu ⇒ 1; rollout khởi đầu 0.1 (§1.5)
}

const DEFAULT_FLAG: MonitorFlag = {
  enabled: true,
  rate: 1,
  http: true,
  steps: true,
};

// Default của 2 núm rate — clamp 0..1, sai kiểu ⇒ 1 (§2.2 "type validation").
function defaultRate(v: unknown): number {
  if (typeof v !== 'number' || !isFinite(v)) return 1;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// Khoá persist cờ L1. BẮT BUỘC phải có, không phải tối ưu.
//
// Webview này là miniapp trong app bank: mỗi lần mở là một document MỚI HOÀN
// TOÀN (xác nhận với chủ sản phẩm 2026-08-14). Nên một biến module không sống
// qua nổi ranh giới phiên — bản trước giữ cờ trong `let cachedFlag` và không
// persist, kết quả là giá trị `fetchFlag()` đọc về bị vứt đi trước khi có
// `_start()` nào kịp đọc, tức **công tắc tắt khẩn cấp L1 không bao giờ tắt
// được gì**. Đã đo thật: điểm cuối trả `{"enabled":false}` mà phiên kế tiếp
// vẫn gửi, vô hạn (claude-046, L-C1).
//
// KHÔNG đặt TTL cho khoá này — có chủ đích. TTL hết hạn nghĩa là rơi về
// DEFAULT_FLAG.enabled=true, tức công tắc khẩn cấp TỰ BẬT LẠI giữa lúc sự cố
// hoặc khi máy mất mạng dài. Đó là fail-open trên đúng thứ tồn tại để fail
// safe. §3.2 E011 vốn đã nói đúng ngữ nghĩa cần có — "giữ nguyên cache hiện
// có" — chỉ là trước đây không có gì để giữ.
const FLAG_KEY = 'mon_flag';

function readPersistedFlag(): MonitorFlag | null {
  try {
    const raw = window.localStorage.getItem(FLAG_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!isValidFlag(j)) return null;
    // Phase-1 JSON (4 field) vẫn đọc được — field phase-2 thiếu ⇒ giữ
    // undefined, default tính tại chỗ đọc (§2.2 backward-compatible).
    return {
      enabled:
        typeof j.enabled === 'boolean' ? j.enabled : DEFAULT_FLAG.enabled,
      rate: typeof j.rate === 'number' ? j.rate : DEFAULT_FLAG.rate,
      http: typeof j.http === 'boolean' ? j.http : DEFAULT_FLAG.http,
      steps: typeof j.steps === 'boolean' ? j.steps : DEFAULT_FLAG.steps,
      ...(typeof j.route_sample_rate === 'number'
        ? { route_sample_rate: defaultRate(j.route_sample_rate) }
        : {}),
      ...(typeof j.api_ok_sample_rate === 'number'
        ? { api_ok_sample_rate: defaultRate(j.api_ok_sample_rate) }
        : {}),
    };
  } catch {
    // localStorage bị chặn / quota / JSON hỏng — NFR-001: không throw ra ngoài.
    return null;
  }
}

function persistFlag(flag: MonitorFlag): void {
  try {
    window.localStorage.setItem(FLAG_KEY, JSON.stringify(flag));
  } catch {
    /* NFR-001 */
  }
}

let cachedFlag: MonitorFlag = readPersistedFlag() || { ...DEFAULT_FLAG };

export function getCachedFlag(): MonitorFlag {
  return cachedFlag;
}

// Truy cập đọc cho các module khác (events.ts đọc rate hiệu dụng của row).
export function effectiveRouteRate(): number {
  return defaultRate(cachedFlag.route_sample_rate);
}

export function effectiveApiOkRate(): number {
  return defaultRate(cachedFlag.api_ok_sample_rate);
}

// Chỉ dùng trong test — seed trực tiếp cache thay vì đợi network, vì §1.6
// cố ý không cho fetch ảnh hưởng tới phiên đang chạy.
export function __setCachedFlagForTest(flag: MonitorFlag): void {
  cachedFlag = flag;
}

export function __resetFlagForTest(): void {
  cachedFlag = { ...DEFAULT_FLAG };
  try {
    window.localStorage.removeItem(FLAG_KEY);
  } catch {
    /* NFR-001 */
  }
}

// E022 — "sai shape" = object nhưng KHÔNG có field nào đúng kiểu. Phải trả
// false cho loại body rác này (nếu chỉ kiểm object-ness thì {enabled:'nope'}
// vẫn được coi "đọc được" ⇒ ghi đè persist bằng rác).
function isValidFlag(v: unknown): v is Partial<MonitorFlag> {
  if (!v || typeof v !== 'object') return false;
  const j = v as Record<string, unknown>;
  return (
    typeof j.enabled === 'boolean' ||
    typeof j.rate === 'number' ||
    typeof j.http === 'boolean' ||
    typeof j.steps === 'boolean' ||
    typeof j.route_sample_rate === 'number' ||
    typeof j.api_ok_sample_rate === 'number'
  );
}

/**
 * E011: cờ L1 không đọc được / timeout 2s ⇒ giữ nguyên cache hiện có
 * (mặc định enabled=true nếu chưa từng đọc được lần nào). KHÔNG throw,
 * KHÔNG để promise trần (A-7) — luôn kết thúc bằng .catch(swallow).
 *
 * E022: body rác (200 nhưng không parse được / sai shape) ⇒ không đụng cache
 * tốt — kho fail-open với cache cũ (FR-013).
 */
export function fetchFlag(fetchFn: typeof fetch = fetch): void {
  const flagUrl = getConfig().flagUrl;
  if (!flagUrl) return;
  let signal: AbortSignal | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 2000);
    signal = controller.signal;
  } catch {
    signal = undefined;
  }
  // Dọn timer khi đã xong: bỏ quên thì mỗi phiên để lại một timer 2s treo vô
  // ích (và làm jest báo open handle).
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
  };
  fetchFn(flagUrl, { signal, cache: 'no-store' } as RequestInit)
    .then(res => res.json())
    .then(json => {
      if (!isValidFlag(json)) return; // E022 — không persist giá trị rác
      cachedFlag = {
        enabled:
          typeof json.enabled === 'boolean' ? json.enabled : cachedFlag.enabled,
        rate: typeof json.rate === 'number' ? json.rate : cachedFlag.rate,
        http: typeof json.http === 'boolean' ? json.http : cachedFlag.http,
        steps: typeof json.steps === 'boolean' ? json.steps : cachedFlag.steps,
        ...(typeof json.route_sample_rate === 'number'
          ? { route_sample_rate: defaultRate(json.route_sample_rate) }
          : {}),
        ...(typeof json.api_ok_sample_rate === 'number'
          ? { api_ok_sample_rate: defaultRate(json.api_ok_sample_rate) }
          : {}),
      };
      // Ghi ngay: phiên HIỆN TẠI cố ý không đổi hành vi (§1.6), giá trị này
      // sinh ra để phiên KẾ TIẾP đọc — mà phiên kế tiếp là một document mới.
      persistFlag(cachedFlag);
    })
    .catch(() => {
      /* E011 — giữ cache hiện có, không throw, không log giá trị */
    })
    .then(clear, clear);
}
