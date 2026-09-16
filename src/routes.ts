// src/utils/monitor/routes.ts
//
// §2.7 Tech Spec — normalizeRoute() (bảng route) + normalizeApiUrl().
// Không phụ thuộc gì ngoài chính nó — an toàn để import từ mọi nơi trong
// module monitor.
//
// A-M3: bảng này được sinh bằng cách ĐỐI CHIẾU với route manifest do Umi
// sinh (`src/.umi/core/route.tsx`, được `umi setup`/`umi dev`/`umi build`
// tạo lại sau mỗi lần cài phụ thuộc) — routes.spec.ts có test snapshot
// tự suy tập route từ manifest và ĐỎ nếu bảng dưới đây lệch dù một mục.
// Đừng sửa tay bảng này mà không chạy test đó; thêm/xoá trang trong
// src/pages cũng sẽ làm test đỏ cho tới khi bảng được cập nhật.

export const STATIC_ROUTES: ReadonlyArray<string> = [
  '/',
  '/account',
  '/brand-new',
  '/brand-new/all',
  '/brand-new/brand-group',
  '/brand-new/check-cashback',
  '/brand-new/guide',
  '/brand-new/hot-trend',
  '/brand-new/redirect',
  '/debug-share',
  // Luồng 401 (app.ts navigation.to('/error?msg=authFailed')) — nhóm phiên
  // hỏng quan trọng nhất; thiếu route này là auth-failure rơi hết vào
  // 'unknown' (finding A-M3 vòng r2).
  '/error',
  '/guide/cashback',
  '/landing',
  '/landing-voucher',
  '/landing-voucher/normal-voucher',
  '/leaderboards',
  '/redirect',
  '/referral',
  '/referral/guide',
  '/referral/rewards',
  '/result',
  '/search/brand-sellers',
  '/search/brands',
  '/search/hot-brands',
  '/seller',
  '/share-statistic',
  '/support',
  '/support/faqs',
  '/support/fqa',
  '/support/guide',
  '/support/intercom',
  '/support/submit',
  '/support/user-request-helps',
  '/support/user-request-helps/form',
  '/tnc-article',
  '/tos/confirm',
  '/tos/file',
  '/transaction',
  '/voucher',
  '/withdraw',
  '/withdraw-history',
  '/withdraw/account-list',
  '/withdraw/confirm',
  '/withdraw/confirm-info',
  '/withdraw/request',
];

// Route có tham số đường dẫn — template với segment `:tên`. matcher() dựng
// regex: mỗi `:tên` thành `[^/]+`, còn lại escape nguyên văn. Đặt tên biến
// khớp tên file trong src/pages ($id, $voucherId) để đối chiếu manifest.
export const TEMPLATE_ROUTES: ReadonlyArray<string> = [
  '/article/:id',
  '/articles/:id',
  '/brand-new/:id',
  '/brand-new/:id/category',
  '/brand-new/:id/seller',
  '/brand-new/:id/seller/:id',
  '/brand-new/:id/shopping-now',
  '/gamification/:id',
  '/gamification/:id/article',
  '/gamification/:id/home',
  '/gamification/:id/honor-roll',
  '/gamification/:id/list-rewards',
  '/gamification/:id/milestones',
  '/gamification/:id/mission',
  '/gamification/:id/summary',
  '/gamification/:id/top-rewards',
  '/gamification/:id/voucher',
  '/gamification/:id/voucher/:voucherId',
  '/gamification/:id/voucher/:voucherId/code',
  '/referral/event/:id',
  '/support/user-request-helps/:id',
  '/transaction/:id',
  '/voucher/:voucherId',
  '/voucher/me/:voucherId',
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function templateToRegExp(template: string): RegExp {
  const pattern = template
    .split('/')
    .map(seg => (seg.startsWith(':') ? '[^/]+' : escapeRegExp(seg)))
    .join('/');
  return new RegExp(`^${pattern}$`);
}

// Sắp theo số segment giảm dần: template nhiều segment phải khớp trước để
// `/gamification/:id/voucher` không bị `/gamification/:id` "ăn" nhầm (regex
// có neo ^$ nên sai khác không xảy ra, nhưng thứ tự ổn định này giữ hành vi
// đúng kể cả khi ai đó bỏ neo).
function buildMatchers(
  templateRoutes: ReadonlyArray<string>,
): ReadonlyArray<[RegExp, string]> {
  return templateRoutes
    .map(t => [templateToRegExp(t), t] as [RegExp, string])
    .sort((a, b) => b[1].split('/').length - a[1].split('/').length);
}

// Matcher mặc định dựng cho bảng route VÍ DỤ của `vp` (TEMPLATE_ROUTES ở
// trên) — tính một lần lúc module load, tránh dựng lại regex mỗi lần gọi
// khi caller không truyền bảng riêng.
const DEFAULT_MATCHERS = buildMatchers(TEMPLATE_ROUTES);

/**
 * Bảng A: chỉ pathname đã chuẩn hoá được gửi đi — cấm query string, cấm
 * hash, cấm href đầy đủ. Không khớp route tĩnh/động nào ⇒ 'unknown'.
 *
 * ADR-0001 — route table thật (host-supplied) truyền qua tham số
 * `staticRoutes`/`templateRoutes` (payload.ts đọc từ getConfig()); mặc
 * định dùng bảng VÍ DỤ của `vp` ở trên để test/phần còn lại gọi trực tiếp
 * không phải truyền lại — sau khi tách package, tham số sẽ không còn có
 * mặc định (mỗi bank tự cấp, ADR-0001).
 */
export function normalizeRoute(
  pathname: string,
  staticRoutes: ReadonlyArray<string> = STATIC_ROUTES,
  templateRoutes: ReadonlyArray<string> = TEMPLATE_ROUTES,
): string {
  const clean = pathname.split('?')[0].split('#')[0];
  if (staticRoutes.indexOf(clean) !== -1) return clean;
  const matchers =
    templateRoutes === TEMPLATE_ROUTES
      ? DEFAULT_MATCHERS
      : buildMatchers(templateRoutes);
  for (const [re, tpl] of matchers) {
    if (re.test(clean)) return tpl;
  }
  return 'unknown';
}

const ID_SEGMENT = /^[0-9a-fA-F]{24}$|^\d+$/; // Mongo ObjectId 24-hex hoặc số thuần

/**
 * Chuẩn hoá URL của một request API: bỏ query + hash, thay các segment giống
 * id (24-hex | số thuần | UUID | ≥20 ký tự liền) bằng ':id'. Không throw dù
 * input không phải URL tuyệt đối hợp lệ.
 *
 * SEC-M1 post-impl r1 (§5.3.2): ngưỡng id của endpoint THỐNG NHẤT với
 * normalizeEventRoute — bản cũ chấp nhận 2 ngưỡng (endpoint chỉ thay
 * 24-hex|số thuần, nhẹ hơn EVENT_SEG_LONG của route) khiến JWT (`eyJ…`) hay
 * opaque token ≥20 ký tự trong path segment lọt NGUYÊN VĂN vào kênh kho
 * (bảng C kho không quét endpoint) — trái FR-012 "không token". Nâng ngưỡng
 * tại normalize để endpoint kênh kho sạch (vế "nhánh endpoint GA" đã bỏ
 * theo QĐ-18).
 */
export function normalizeApiUrl(rawUrl: string): string {
  // SEC-n1 post-impl r1: hash cũng bỏ — đồng bộ normalizeEventRoute/normalizeRoute.
  const noQueryHash = rawUrl.split('?')[0].split('#')[0];
  let path: string;
  try {
    path = new URL(noQueryHash).pathname;
  } catch {
    path = noQueryHash;
  }
  return path
    .split('/')
    .map(seg => (isIdSegment(seg) ? ':id' : seg))
    .join('/');
}

// ─── phase-2 (webview-session-logs §5.3.2) — route SPA cho event stream ────

// Phân tách hàm (ARC-M1 r1-TS): normalizeRoute() manifest trên KHÔNG ĐỤNG —
// nó phục vụ pathname của doc phase-1 (payload.ts) + hàng rào routes.spec.
// Từ post-impl r1 (SEC-M1) endpoint (normalizeApiUrl) và route SPA
// (normalizeEventRoute) dùng CHUNG một ngưỡng id — xem isIdSegment dưới.

const EVENT_ROUTE_MAX = 128; // cap kho (§5.3.2)
const EVENT_SEG_DIGITS = /\d{4,}/; // id/mã — dãy ≥4 số liền trong segment
const EVENT_SEG_LONG = /\S{20,}/; // token/hash — segment ≥20 ký tự liền
const EVENT_SEG_UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const EVENT_ROUTE_CHARSET = /^\/[A-Za-z0-9:._/-]*$/;

// Predicate id của ENDPOINT (SEC-M1 post-impl r1, §5.3.2): 24-hex | số thuần
// | UUID | ≥20 ký tự liền. Route SPA (normalizeEventRoute) giữ ngưỡng số
// riêng (\d{4,}) như §5.3.2 bước (2) — điểm THỐNG NHẤT là cả hai đều bắt
// UUID + token ≥20 ký tự (JWT/opaque không lọt kênh nào).
function isIdSegment(seg: string): boolean {
  return ID_SEGMENT.test(seg) || seg.length >= 20 || EVENT_SEG_UUID.test(seg);
}

/**
 * MỚI phase-2 (§5.3.2) — chuẩn hoá route SPA cho EventRow.route. Bước:
 * (1) bỏ query + hash — query bỏ HOÀN TOÀN, không ngoại lệ (FR-008);
 * (2) URL tuyệt đối ⇒ lấy pathname; (3) TỪNG segment khớp dãy ≥4 số |
 * ≥20 ký tự liền | UUID ⇒ thay ':id' (giữ cấu trúc route — placeholder,
 * không bỏ hẳn); (4) ghép, cap 128; (5) charset whitelist — ký tự lạ ⇒
 * cắt tại vị trí đầu tiên. Không throw với input bất kỳ (NFR-001).
 */
export function normalizeEventRoute(rawUrl: string): string {
  const noQueryHash = String(rawUrl).split('?')[0].split('#')[0];
  let path: string;
  try {
    path = new URL(noQueryHash).pathname;
  } catch {
    path = noQueryHash; // pathname tương đối — dùng nguyên
  }
  const replaced = path
    .split('/')
    .map(seg =>
      EVENT_SEG_DIGITS.test(seg) ||
      EVENT_SEG_LONG.test(seg) ||
      EVENT_SEG_UUID.test(seg)
        ? ':id'
        : seg,
    )
    .join('/');
  let clean =
    replaced.length > EVENT_ROUTE_MAX
      ? replaced.slice(0, EVENT_ROUTE_MAX)
      : replaced;
  if (!EVENT_ROUTE_CHARSET.test(clean)) {
    // Ký tự lạ ⇒ giữ prefix dài nhất hợp lệ (cắt TẠI vị trí đầu tiên).
    const m = clean.match(/^\/[A-Za-z0-9:._/-]*/);
    clean = m ? m[0] : '';
  }
  return clean;
}
