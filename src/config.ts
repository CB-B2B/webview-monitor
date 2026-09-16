// src/utils/monitor/config.ts
//
// MỘT điểm đọc cấu hình của toàn module monitor (§1.1 điểm móc 4, R3-M4).
// Sau ticket 03 (webview-monitor-package-extraction), module KHÔNG còn tự
// đọc `process.env.*` để dựng cấu hình của chính nó — theo
// docs/adr/0001-monitor-package-host-supplied-config.md, "config" là một
// object thuần do HOST APP (src/app.ts) tự dựng từ `.umirc.ts`/biến môi
// trường lúc build của chính nó, rồi truyền vào qua `monitor.init(config)`.
// Đây là bước chuẩn bị cho việc tách monitor/* thành package dùng chung
// nhiều bank — "vp" tự dùng đúng API host-supplied config này, không có gì
// đặc quyền so với một bank tương lai.
//
// Ngoại lệ DUY NHẤT: công tắc biên dịch L2 (`process.env.MONITOR === 'off'`)
// vẫn là literal tĩnh viết thẳng trong index.ts (KHÔNG qua config.ts, KHÔNG
// qua init()) — đó là cơ chế Terser fold loại cả cây mã khỏi bundle
// (R3-M3), một khái niệm build-time hoàn toàn khác với runtime config do
// host cung cấp; nó vẫn phải giữ nguyên dạng literal để define() thay được.

import { StepName } from './types';

export interface MonitorConfig {
  // ── Nhóm identity/shape — ADR-0002: THIẾU ⇒ throw ngay trong init() ──
  /** Danh sách bước khởi tạo của HOST — KHÔNG có mặc định cấp package. */
  steps: ReadonlyArray<StepName>;
  /** Route tĩnh của HOST (dùng cho SessionPayload.pathname). */
  staticRoutes: ReadonlyArray<string>;
  /** Route có tham số của HOST (`/brand/:id`...). */
  templateRoutes: ReadonlyArray<string>;
  /** Mã đối tác — literal của HOST, ghi vào SessionPayload.partner. */
  partnerId: string;

  // ── Nhóm network-endpoint — ADR-0002: THIẾU ⇒ fail-safe, KHÔNG throw ──
  /** URL điểm nhận doc phase-1; rỗng ⇒ doc coi như TẮT (§1.6). */
  ingestUrl: string;
  /** URL cờ L1; rỗng ⇒ fetchFlag() no-op (E011). */
  flagUrl: string;
  /** URL ingest stream event phase-2; rỗng ⇒ events off-at-birth (§0.2). */
  eventsIngestUrl: string;

  // ── Nhóm chẩn đoán, không thuộc hai nhóm trên của ADR-0002 — rỗng vẫn
  // an toàn (classifyHost() chỉ trả 'other'), không có lý do throw. ──
  /** Endpoint API chính — classifyHost() phân loại http_samples.host. */
  mainEndpoint: string;
  /** Endpoint API sys — classifyHost(). */
  sysEndpoint: string;
  /** Git sha ngắn lúc build (FR-026); 'unknown' khi không lấy được. */
  releaseVersion: string;
  /** env_name của EventRow; 'unknown' khi nguồn không có (NFR-001). */
  envName: string;
}

function safeStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// ADR-0002 nhóm 1 — identity/shape: throw ĐỒNG BỘ, mô tả rõ trường thiếu,
// TRƯỚC khi start()/attachLifecycle() có thể được gọi. Đây là lỗi khai báo
// tại call site của host (host developer's own terminal), không phải điều
// kiện runtime — nên KHÔNG bọc safe(), rethrow nguyên trạng như step().
function assertIdentityFields(config: MonitorConfig): void {
  if (!config.steps || config.steps.length === 0) {
    throw new Error(
      'monitor.init(config): config.steps là bắt buộc (danh sách bước khởi tạo) — ' +
        'ADR-0002 fail-fast, không có giá trị mặc định cấp package.',
    );
  }
  if (!config.staticRoutes || !config.templateRoutes) {
    throw new Error(
      'monitor.init(config): config.staticRoutes và config.templateRoutes là bắt ' +
        'buộc (route table của host) — ADR-0002 fail-fast.',
    );
  }
  if (!config.partnerId) {
    throw new Error(
      'monitor.init(config): config.partnerId là bắt buộc — ADR-0002 fail-fast.',
    );
  }
}

let currentConfig: MonitorConfig | null = null;

/**
 * Bề mặt công khai `monitor.init(config)` (ADR-0001/ADR-0002). Validate
 * theo hai nhóm không đồng nhất — xem assertIdentityFields() ở trên cho
 * nhóm throw; nhóm network-endpoint chỉ chuẩn hoá về chuỗi rỗng an toàn,
 * không throw (start()/attachLifecycle() tự thành no-op khi thiếu, §1.6).
 */
export function initConfig(config: MonitorConfig): void {
  assertIdentityFields(config);
  currentConfig = {
    steps: config.steps,
    staticRoutes: config.staticRoutes,
    templateRoutes: config.templateRoutes,
    partnerId: config.partnerId,
    ingestUrl: safeStr(config.ingestUrl),
    flagUrl: safeStr(config.flagUrl),
    eventsIngestUrl: safeStr(config.eventsIngestUrl),
    mainEndpoint: safeStr(config.mainEndpoint),
    sysEndpoint: safeStr(config.sysEndpoint),
    releaseVersion: safeStr(config.releaseVersion) || 'unknown',
    envName: safeStr(config.envName) || 'unknown',
  };
}

/**
 * Đọc cấu hình hiện hành. Gọi TRƯỚC init() (lỗi tích hợp, không phải điều
 * kiện runtime NFR-001 nói tới) ⇒ throw — mọi call site thật đều nằm sau
 * safe()/step() nên lỗi này bị nuốt thành no-op có log dev, đúng tinh thần
 * "monitor không được làm hỏng trải nghiệm chính" dù chưa init().
 */
export function getConfig(): MonitorConfig {
  if (!currentConfig) {
    throw new Error(
      'monitor: init(config) phải được gọi trước start()/attachLifecycle().',
    );
  }
  return currentConfig;
}

export function __resetConfigForTest(): void {
  currentConfig = null;
}
