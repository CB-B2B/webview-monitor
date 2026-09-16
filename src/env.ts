// src/utils/monitor/env.ts
//
// §2.3 SessionPayload.env — dựng ở mức DẢI/LOẠI, không phải chuỗi UA đầy
// đủ (bảng A). Không phụ thuộc gì ngoài ./types và ./config.

import { getConfig } from './config';
import { SessionPayload } from './types';

type Env = SessionPayload['env'];

function detectDeviceType(ua: string): Env['device_type'] {
  if (/iPad|Tablet(?!.*Mobile)/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'mobile';
  if (ua) return 'desktop';
  return 'unknown';
}

function majorDotX(version: string | undefined): string {
  if (!version) return 'unknown';
  const major = version.split(/[._]/)[0];
  return /^\d+$/.test(major) ? `${major}.x` : 'unknown';
}

function detectOs(ua: string): { os: string; os_version: string } {
  const iosMatch = ua.match(/OS (\d+)[._](\d+)/);
  if (/iPhone|iPad|iPod/i.test(ua) && iosMatch) {
    return { os: 'iOS', os_version: majorDotX(iosMatch[1]) };
  }
  const androidMatch = ua.match(/Android (\d+)(?:\.(\d+))?/);
  if (androidMatch) {
    return { os: 'Android', os_version: majorDotX(androidMatch[1]) };
  }
  return { os: 'unknown', os_version: 'unknown' };
}

function detectWebviewVersion(ua: string): string {
  const chromeMatch = ua.match(/(?:Chrome|CriOS)\/(\d+)/);
  if (chromeMatch) return majorDotX(chromeMatch[1]);
  const safariMatch = ua.match(/Version\/(\d+)/);
  if (safariMatch) return majorDotX(safariMatch[1]);
  return 'unknown';
}

function getConnectionType(): string {
  try {
    const nav = navigator as Navigator & {
      connection?: { effectiveType?: string };
    };
    return nav.connection?.effectiveType || 'unknown';
  } catch {
    return 'unknown';
  }
}

// release_version — đọc từ config host-supplied qua init() (ADR-0001): git
// sha ngắn do host tự xác định lúc build, 'unknown' khi nguồn không có
// (NFR-001 — không throw).

export function buildEnv(): Env {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const { os, os_version } = detectOs(ua);
  return {
    device_type: detectDeviceType(ua),
    os,
    os_version,
    webview_version: detectWebviewVersion(ua),
    language:
      (typeof navigator !== 'undefined' && navigator.language) || 'unknown',
    connection_type: getConnectionType(),
    release_version: getConfig().releaseVersion,
  };
}

// ─── phase-2 (webview-session-logs §2.5 / FR-006) — device model ───────────

/**
 * FR-006: suy ra DÒNG MÁY từ user agent — đủ lọc một dòng máy cụ thể (ca
 * Galaxy S15). Chuẩn hoá dạng gọn: Android lấy token model đứng giữa
 * "; Android x;" và " Build/"/")" (vd "SM-S911B"); iOS không lộ model trong
 * UA ⇒ trả nhãn dòng 'iPhone'/'iPad'; không suy ra được ⇒ '' (UA Reduction
 * đã thay model bằng chuỗi chung — risk §11 PRD, khi đó dựa Client Hints).
 */
export function detectDeviceModel(ua: string): string {
  if (!ua) return '';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPhone|iPod/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) {
    // "...; Android 14; SM-S911B Build/UP1A...) ..." hoặc "...; Android 10; K)"
    const m = ua.match(/Android[^;)]*;\s*([^;)]+?)(?=\s+Build|\))/);
    const model = m ? m[1].trim() : '';
    // 'K' là placeholder chung của Chrome cho device ẩn danh — không phải dòng máy.
    if (model && model !== 'K' && !/^\w$/i.test(model)) return model;
    return '';
  }
  return ''; // desktop/unknown — không có model đáng kể trong UA
}

/**
 * Risk §11 PRD (r1-PM-M7): UA Reduction xoá model khỏi UA; model thật nằm ở
 * Client Hints getHighEntropyValues('model') — webview của bank CÓ THỂ không
 * bật. Best-effort, fire-and-forget: đọc được thì gọi lại onModel để thay thế
 * giá trị suy từ UA; mọi lỗi nuốt (NFR-001). Phải thử trên webview thật
 * trước tuần 1 (milestone §7).
 */
export function refineDeviceModel(onModel: (model: string) => void): void {
  try {
    const nav = navigator as Navigator & {
      userAgentData?: {
        getHighEntropyValues?: (hints: string[]) => Promise<{ model?: string }>;
      };
    };
    const uad = nav.userAgentData;
    if (!uad || typeof uad.getHighEntropyValues !== 'function') return;
    uad
      .getHighEntropyValues(['model'])
      .then(v => {
        if (v && typeof v.model === 'string' && v.model) onModel(v.model);
      })
      .catch(() => {
        /* best-effort — webview không hỗ trợ hint 'model' */
      });
  } catch {
    /* NFR-001 — không throw ra ngoài */
  }
}
