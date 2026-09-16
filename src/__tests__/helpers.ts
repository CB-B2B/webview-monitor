// src/utils/monitor/__tests__/helpers.ts
//
// Fixture dùng chung cho các test hai kênh (T063-T068).
//
// Ghi chú từ TDD plan (docs/features/webview-session-logs.md, "Fixture dùng
// chung" r3-PERF-m2, nguyên văn):
//   "T065, T068 và T070 đều dựng cấu hình '2 kênh gần giống nhau' — viết sai
//   fixture (nhầm `target` hoặc `url`) làm cả ba cùng xanh giả. Dùng chung một
//   factory `makeTwoChannelDeps({ sameUrl?: boolean })`, khai báo một chỗ."
//
// Factory này là chỗ ĐÓ: mọi test hai kênh lấy deps từ đây, chỉ override
// đúng trường cần quan sát (sendBeacon/fetchFn để bắt body hay ép fallback).

import { TransportDeps } from '../transport';

export const DOC_URL = 'https://obs.example/ingest';
export const EVENTS_URL = 'https://obs.example/ingest-events';

/**
 * Hai bộ TransportDeps GIỐNG HỆT nhau trừ `target` ('doc' | 'events') và —
 * trừ khi `sameUrl: true` — `url` (hai URL ingest bắt buộc khác nhau, QĐ-17).
 * `sameUrl: true` dùng cho T068: chứng minh breaker khoá theo TARGET chứ
 * không phải theo url (hai kênh chung một đích vẫn hai quyết định độc lập).
 * Stub jsdom: fetchFn luôn resolve 200 — test nào cần 401/429 tự override.
 */
export function makeTwoChannelDeps(opts: { sameUrl?: boolean } = {}): {
  doc: TransportDeps;
  events: TransportDeps;
} {
  const base = {
    onLine: (): boolean => true,
    hasSendBeacon: true,
    sendBeacon: (): boolean => true,
    fetchFn: (() =>
      Promise.resolve({ ok: true, status: 200 } as Response)) as typeof fetch,
    now: (): number => 1_700_000_000_000,
  };
  return {
    doc: { ...base, url: DOC_URL, target: 'doc' },
    events: {
      ...base,
      url: opts.sameUrl === true ? DOC_URL : EVENTS_URL,
      target: 'events',
    },
  };
}

/**
 * jsdom (jest 29) không hiện thực Blob.prototype.text() — bọc global Blob để
 * giữ lại chuỗi parts, trả về chuỗi THẬT đưa lên dây và hàm hoàn tác. Cùng
 * kỹ thuật với transport.spec.ts (FR-016), nâng lên dùng chung cho T063/T065.
 */
export function captureBlobParts(): {
  parts: () => string[];
  restore: () => void;
} {
  const seen: string[] = [];
  const OriginalBlob = global.Blob;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).Blob = function (parts: string[], opts: unknown) {
    const b = new OriginalBlob(parts, opts as BlobPropertyBag);
    (b as unknown as { __parts: string[] }).__parts = parts;
    seen.push(...parts);
    return b;
  };
  return {
    parts: (): string[] => seen,
    restore: (): void => {
      global.Blob = OriginalBlob;
    },
  };
}
