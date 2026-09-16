// src/utils/monitor/state.ts
//
// §1.3 Vòng đời một phiên — kiểu SessionState nội bộ (không xuất ra bên
// ngoài module). Tách riêng để payload.ts và index.ts đều dùng chung mà
// không tạo phụ thuộc vòng.

import {
  ErrKind,
  FinishReason,
  HttpSample,
  MarkName,
  StepName,
  StepResult,
} from './types';

export interface StepFailure {
  endpoint: string;
  status?: number;
  errKind?: ErrKind;
}

export interface SessionState {
  sessionId: string;
  sidWeak?: true;
  startedAt: number; // epoch ms — quy chiếu navigation start (không phải mount)
  navMs: number; // performance.now() lúc start()
  steps: StepResult[]; // đúng 6 phần tử, khởi tạo 'pending'
  httpSamples: HttpSample[];
  httpOverflow: number;
  marks: Partial<Record<MarkName, number>>;
  finished: boolean; // phase-1: doc đã phát (giữ nguyên cho payload legacy)
  finishReason?: FinishReason;
  homeReached: boolean;
  topError?: unknown; // Error-like gốc — chuyển sang TechError lúc buildPayload
  sampleRate: number;
  sendAttempt: number;
  currentStepSeq: number | null;
  stepFirstFailure: Partial<Record<number, StepFailure>>;

  // ── phase-2 (webview-session-logs §2.5) — tách vòng đời doc/stream ──
  docSent: boolean; // doc phase-1 đã phát đúng 1 lần (R2-6)
  sessionClosed: boolean; // event stream đã đóng (pagehide/init_failed)
  routeSampled: boolean; // sticky bit §0.9 — bốc MỘT lần trong _start()
  routeRate: number; // rate THỜI ĐIỂM bốc sticky bit (CR-M1 post-impl r1)
  apiOkSampled: boolean; // sticky bit §0.9 — api_call thành công
  apiOkRate: number; // rate THỜI ĐIỂM bốc sticky bit (CR-M1 post-impl r1)
  eventSeq: number; // seq EventRow — chỉ cấp cho row được buffer (T051)
  errorEventCount: number; // số row lỗi đã buffer (cap 200, FR-015)
  sampledEventCount: number; // số row mẫu đã buffer (cap 500, QĐ-12)
  errorEventsOverflow: number;
  eventsOverflow: number;
  apiRetryDupes: number; // số lần gộp retry trùng cửa sổ 10s (§2.4b)
  filterFaults: number; // E020 — tổng lỗi filter trong phiên
  currentRoute: string; // normalizeEventRoute() — ngữ cảnh js_error
  deviceModel: string; // FR-006; '' khi thiếu
}

export function initStepResults(
  stepNames: ReadonlyArray<StepName>,
): StepResult[] {
  return stepNames.map((name, seq) => ({
    seq,
    name,
    started_at_offset: 0,
    ms: 0,
    status: 'pending',
  }));
}
