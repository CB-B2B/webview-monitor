// src/utils/monitor/payload.ts
//
// §2.4 Lớp 1 — dựng SessionPayload TỪNG trường một, không bao giờ spread
// object "lạ" (§2.4). §2.2/§2.3 (pickSamples, toTechError).

import { getConfig } from './config';
import { buildEnv } from './env';
import { readAndResetDroppedN } from './outbox';
import { normalizeRoute } from './routes';
import { SessionState } from './state';
import { FinishReason, HttpSample, SessionPayload, TechError } from './types';

const MESSAGE_MAX = 512;
const STACK_MAX = 2000;
const HTTP_SAMPLES_HALF = 10; // 10 đầu + 10 cuối (A-27)

/**
 * §2.4 A-27: giữ 10 mẫu ĐẦU + 10 mẫu CUỐI, không phải 20 mẫu mới nhất — vì
 * request hỏng đầu tiên (thường là câu trả lời) không được để mất.
 */
export function pickSamples(samples: ReadonlyArray<HttpSample>): {
  samples: HttpSample[];
  overflow: number;
} {
  if (samples.length <= HTTP_SAMPLES_HALF * 2) {
    return { samples: samples.slice(), overflow: 0 };
  }
  const head = samples.slice(0, HTTP_SAMPLES_HALF);
  const tail = samples.slice(samples.length - HTTP_SAMPLES_HALF);
  return {
    samples: [...head, ...tail],
    overflow: samples.length - HTTP_SAMPLES_HALF * 2,
  };
}

/**
 * E010: JSON.stringify() thất bại (circular reference / getter ném lỗi)
 * ⇒ thay bằng hằng số cố định, KHÔNG cố in một phần object gây lỗi ra
 * (tránh rò credential đang nằm trong chính object đó).
 */
export function toTechError(err: unknown): TechError {
  try {
    const anyErr = err as {
      constructor?: { name?: string };
      name?: string;
      message?: unknown;
      stack?: unknown;
    };
    const type =
      (anyErr && anyErr.constructor && anyErr.constructor.name) ||
      (anyErr && anyErr.name) ||
      'Error';
    const rawMessage =
      anyErr && anyErr.message !== undefined ? anyErr.message : String(err);
    const message = String(rawMessage).slice(0, MESSAGE_MAX);
    const rawStack = anyErr && anyErr.stack;
    const stack =
      typeof rawStack === 'string' ? rawStack.slice(0, STACK_MAX) : undefined;
    // Chạm thử JSON.stringify để bắt sớm mọi thứ bất thường còn sót —
    // type/message/stack ở trên đều đã là scalar nên luôn an toàn, nhưng
    // giữ bước này để không ai vô tình thêm field object vào sau này.
    JSON.stringify({ type, message, stack });
    return stack === undefined
      ? { type: String(type), message }
      : { type: String(type), message, stack };
  } catch {
    return { type: 'SerializeError', message: 'unserializable' };
  }
}

function getPathname(): string {
  try {
    return window.location.pathname;
  } catch {
    return '';
  }
}

/**
 * §2.4 buildPayload() — Lớp 1: dựng TỪNG trường một bằng object literal
 * (kích hoạt excess property check của TS), KHÔNG spread bất kỳ object lạ
 * nào (res.data/err/location...). Đây là gói TRƯỚC khi qua Lớp 2.
 */
export function buildPayload(
  state: SessionState,
  finishReason: FinishReason,
): SessionPayload {
  const { samples, overflow } = pickSamples(state.httpSamples);
  const techError =
    state.topError === undefined ? undefined : toTechError(state.topError);
  const droppedN = readAndResetDroppedN();

  const payload: SessionPayload = {
    session_id: state.sessionId,
    sid_weak: state.sidWeak,
    session_started_at: state.startedAt,
    session_finished_at: Date.now(),
    session_duration_ms: performance.now() - state.navMs, // A-25: đồng hồ đơn điệu
    time_to_home_ms: state.marks.home_ready,
    steps: state.steps.map(s => ({ ...s })),
    home_reached: state.homeReached,
    finish_reason: finishReason,
    pathname: normalizeRoute(
      getPathname(),
      getConfig().staticRoutes,
      getConfig().templateRoutes,
    ),
    // phase-2 FR-005/FR-006 — phẳng, cùng giá trị EventRow cùng phiên (tạo ở
    // _start() bằng detectDeviceModel + Client Hints best-effort).
    device_model: state.deviceModel || '',
    env: buildEnv(),
    http_samples: samples,
    http_overflow: state.httpOverflow + overflow,
    error: techError,
    // A-28: giá trị THẬT do host truyền qua config.partnerId (ADR-0001) —
    // KHÔNG còn literal cứng trong module.
    partner: getConfig().partnerId,
    filter_l2_hits: 0, // gán lại sau applyLayer2
    l2_hits_by_rule: {}, // gán lại sau applyLayer2
    l2_paths: [], // gán lại sau applyLayer2
    send_attempt: state.sendAttempt,
    // FR-015: doc phase-1 KHÔNG bao giờ lấy mẫu (100% phiên) — ghi 1; núm
    // rate giờ chỉ gạt route_view/api_call-thành-công ở mức sự kiện (sticky
    // 2 bit §0.9), không còn ý nghĩa với doc. Giá trị rate hiệu dụng của
    // từng row nằm trong EventRow.sample_rate.
    sample_rate: 1,
    dropped_n: droppedN > 0 ? droppedN : undefined,
  };
  return payload;
}
