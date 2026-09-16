// src/utils/monitor/filter.ts
//
// §2.4 (Lớp 1 — type guard scalar) + §2.6 (Lớp 2 — quét đệ quy + bảng B/C)
// của Tech Spec webview-monitoring. Đây là lớp bảo mật quan trọng nhất của
// cả module — KHÔNG được import gì ngoài ./types (luật phụ thuộc §1.1).

import { L2RuleName, SessionPayload } from './types';

/**
 * §2.4 "Chốt kiểu tại chỗ": mọi field bảng A định nghĩa là scalar phải qua
 * type guard này; giá trị không phải string|number|boolean (hoặc
 * undefined) ⇒ từ chối field đó — một object lọt vào ô scalar là bug,
 * không phải dữ liệu.
 */
export function isScalar(
  value: unknown,
): value is string | number | boolean | undefined {
  return (
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

// ─── Lớp 2 — bảng B (theo tên) + bảng C (theo hình dạng giá trị) ──────────

// /i (phase-2 T057/§5.4.3 canary kho): JWT header base64url chuẩn bắt đầu
// "eyJ" thường, nhưng canary kiểm thử (CANARY_EYJhbGciOi.SIGNATURE.PART) và
// token biến dạng in hoa phải BỊ BẮT như nhau — kẹp cả hai hoa/thường.
const RULE_JWT = /eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,}/i;
const RULE_BEARER = /\bBearer\s+\S+/i;
const RULE_LONG_TOKEN = /[A-Za-z0-9+/=_-]{32,}/; // khôi phục '-' '_' (S-1)
const RULE_TOKEN_KEYWORD =
  /token=|access_token|id_token|partner-token|authorization|oo-api-key/i;
const RULE_LONG_DIGITS = /\d{9,}/;
const RULE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const RULE_DATE = /\b(?:\d{4}[-/.]\d{2}[-/.]\d{2}|\d{2}[-/.]\d{2}[-/.]\d{4})\b/;
const RULE_SEP_DIGITS = /(?:\d[ .-]?){9,}/;

const LAYER2_RULES: ReadonlyArray<[L2RuleName, RegExp]> = [
  ['JWT', RULE_JWT],
  ['BEARER', RULE_BEARER],
  ['LONG_TOKEN', RULE_LONG_TOKEN],
  ['TOKEN_KEYWORD', RULE_TOKEN_KEYWORD],
  ['LONG_DIGITS', RULE_LONG_DIGITS],
  ['EMAIL', RULE_EMAIL],
  ['DATE', RULE_DATE],
  ['SEP_DIGITS', RULE_SEP_DIGITS],
];

// Đường dẫn field do generator dựng nội bộ, biết chắc nguồn gốc — không quét.
// session_id = crypto.randomUUID(), về cấu trúc không mang credential.
const LAYER2_EXCLUDED_PATHS = new Set<string>(['session_id']);

const L2_MAX_SCAN = 4096; // P-3: trần ký tự mỗi chuỗi đưa vào regex

export interface Layer2Result {
  payload: SessionPayload;
  blockedCount: number;
  byRule: Partial<Record<L2RuleName, number>>;
  paths: string[];
}

/**
 * Quét đệ quy toàn bộ gói đã lọc bởi Lớp 1, redact mọi chuỗi khớp bảng B/C.
 * Giá trị gốc KHÔNG BAO GIỜ được log/gán vào biến nào khác ngoài scope quét.
 */
export function applyLayer2(input: SessionPayload): Layer2Result {
  let blockedCount = 0;
  const byRule: Partial<Record<L2RuleName, number>> = {};
  const paths: string[] = [];

  const scan = (value: unknown, path: string): unknown => {
    if (LAYER2_EXCLUDED_PATHS.has(path)) return value;

    if (typeof value === 'string') {
      const head =
        value.length > L2_MAX_SCAN ? value.slice(0, L2_MAX_SCAN) : value;
      let probe = head;
      try {
        probe = decodeURIComponent(head);
      } catch {
        /* chuỗi không hợp lệ để decode — dùng bản gốc */
      }
      for (const [name, rule] of LAYER2_RULES) {
        // regex có cờ 'g' sẽ giữ lastIndex — các rule ở đây không dùng 'g'
        if (rule.test(head) || rule.test(probe)) {
          blockedCount += 1;
          byRule[name] = (byRule[name] || 0) + 1;
          paths.push(path);
          return '[redacted]';
        }
      }
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((v, i) => scan(v, `${path}[${i}]`));
    }

    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = scan(v, path ? `${path}.${k}` : k);
      }
      return out;
    }

    return value; // number/boolean/undefined — ngoài phạm vi bảng C (§2.5)
  };

  const payload = scan(input, '') as SessionPayload;
  payload.filter_l2_hits = blockedCount;
  payload.l2_hits_by_rule = byRule;
  payload.l2_paths = paths;
  return { payload, blockedCount, byRule, paths };
}

// ─── phase-2 (webview-session-logs §5.3.3) — sanitizeMessage kênh kho ───────

// E020 — filter tự lỗi ⇒ field thay bằng hằng số này, event VẪN buffer.
export const FILTER_ERROR_PLACEHOLDER = '[filter-error]';

export const MESSAGE_MAX = 512; // cap ký tự output — EventRow.message (T026)

/**
 * MỚI phase-2 — lọc message TỰ DO cho kênh kho (EventRow.message của
 * api_call/business_error/js_error), chạy TẠI CHỖ GHI trước buffer (§5.3.1 —
 * filter → buffer → persist → send). Khác applyLayer2 (doc phase-1, decode
 * 1 lần, GIỮ NGUYÊN): decode-probe lặp TỐI ĐA 2 lần, dừng khi decode không
 * đổi giá trị (fixpoint — SEC2-m2/SEC-m3 r2-TS; T062 đóng lỗ PII
 * double-encoded kiểu user%2540bank.vn).
 *
 * Trả '[redacted]' khi BẤT KỲ probe nào khớp bảng C (8 rule nguyên trạng,
 * cap quét 4096); sạch ⇒ trả bản gốc cắt 512 ký tự. Lỗi nội bộ (regex/decode
 * ném ngoài try) ⇒ trả '[filter-error]' (E020 — fail-closed THEO TRƯỜNG,
 * caller đếm filter_faults lên session_end row).
 */
export function sanitizeMessage(msg: string): string {
  try {
    const head = msg.length > L2_MAX_SCAN ? msg.slice(0, L2_MAX_SCAN) : msg;
    // Dựng chuỗi probe: bản gốc + tối đa 2 lần decode (dừng tại fixpoint).
    const probes: string[] = [head];
    let cur = head;
    for (let i = 0; i < 2; i += 1) {
      let next: string;
      try {
        next = decodeURIComponent(cur);
      } catch {
        break; // chuỗi không hợp lệ để decode — dùng các probe đã có
      }
      if (next === cur) break; // fixpoint — decode nữa không đổi gì
      cur = next;
      probes.push(cur);
    }
    for (const probe of probes) {
      for (const [, rule] of LAYER2_RULES) {
        if (rule.test(probe)) return '[redacted]';
      }
    }
    return msg.length > MESSAGE_MAX ? msg.slice(0, MESSAGE_MAX) : msg;
  } catch {
    return FILTER_ERROR_PLACEHOLDER; // E020 — không throw ra ngoài
  }
}
