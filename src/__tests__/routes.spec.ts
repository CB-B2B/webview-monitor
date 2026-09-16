// §2.7 normalizeRoute / normalizeApiUrl — T011, T012, T016-T020
//
// Ticket 04 (webview-monitor-package-extraction) — khối test "A-M3 đối
// chiếu route manifest Umi" của bản gốc bị BỌ, không port: nó đọc
// `src/.umi/core/route.tsx` — manifest build-time của `vp`, không tồn tại
// trong package (ADR-0001: route table giờ là host-supplied qua
// `init({ staticRoutes, templateRoutes })`, không còn sinh từ manifest Umi
// của bất kỳ bank nào). Bảng route VÍ DỤ của VPBank vẫn sống trong
// routes.ts (STATIC_ROUTES/TEMPLATE_ROUTES) làm default cho normalizeRoute()
// khi caller không truyền bảng riêng — test dưới đây chỉ khóa hành vi
// của normalizeRoute/normalizeApiUrl/normalizeEventRoute, không đối chiếu
// manifest build của bất kỳ host nào.
import {
  normalizeApiUrl,
  normalizeEventRoute,
  normalizeRoute,
} from '../routes';

describe('normalizeRoute', () => {
  // T011
  it('route tĩnh: giữ nguyên', () => {
    expect(normalizeRoute('/withdraw/account-list')).toBe(
      '/withdraw/account-list',
    );
  });

  // T012
  it('route động: /article/:id', () => {
    expect(normalizeRoute('/article/64f1a2b3c4d5e6f708091a2b')).toBe(
      '/article/:id',
    );
  });

  // A-M3 — luồng 401: pathname '/error' PHẢI ra '/error', không rơi vào
  // 'unknown' (auth failure là nhóm phiên hỏng quan trọng nhất, NFR-003).
  it('A-M3: /error (luồng 401) nhận diện được, không phải unknown', () => {
    expect(normalizeRoute('/error')).toBe('/error');
  });

  // A-M3 — route nhiều segment dưới /gamification/:id
  it('A-M3: /gamification/:id/voucher/:voucherId/code khớp template đủ sâu', () => {
    expect(normalizeRoute('/gamification/g1/voucher/v2/code')).toBe(
      '/gamification/:id/voucher/:voucherId/code',
    );
    expect(normalizeRoute('/gamification/g1/voucher/v2')).toBe(
      '/gamification/:id/voucher/:voucherId',
    );
    expect(normalizeRoute('/gamification/g1')).toBe('/gamification/:id');
  });

  // A-M3 — 5 mục ma đã xoá khỏi bảng; 4 cái đầu không khớp gì nữa.
  // Riêng '/voucher/me' về HÀNH VI vẫn khớp template '/voucher/:voucherId'
  // (hình dáng URL trùng) — việc xoá mục ma của nó do test snapshot bắt,
  // còn ở đây chỉ chừng mọi đường dẫn vẫn phân giải được, không rơi unknown.
  it('A-M3: mục ma (/guide, /search, /tos, /referral/event) ⇒ unknown', () => {
    expect(normalizeRoute('/guide')).toBe('unknown');
    expect(normalizeRoute('/search')).toBe('unknown');
    expect(normalizeRoute('/tos')).toBe('unknown');
    expect(normalizeRoute('/referral/event')).toBe('unknown');
    expect(normalizeRoute('/voucher/me')).toBe('/voucher/:voucherId');
  });

  // A-M3 — 25 route thật mới có mặt
  it('A-M3: các route trước đây thiếu nhận diện đúng', () => {
    expect(normalizeRoute('/brand-new/64f1a2b3c4d5e6f708091a2b/category')).toBe(
      '/brand-new/:id/category',
    );
    expect(normalizeRoute('/support/user-request-helps/123')).toBe(
      '/support/user-request-helps/:id',
    );
    expect(normalizeRoute('/transaction/123')).toBe('/transaction/:id');
    expect(normalizeRoute('/voucher/me/123')).toBe('/voucher/me/:voucherId');
    expect(normalizeRoute('/withdraw/confirm')).toBe('/withdraw/confirm');
    expect(normalizeRoute('/withdraw/request')).toBe('/withdraw/request');
  });

  // T016
  it('EP: URL có cả query và hash — pathname không chứa ? lẫn #', () => {
    const result = normalizeRoute('/account?tab=1#section');
    expect(result).not.toContain('?');
    expect(result).not.toContain('#');
    expect(result).toBe('/account');
  });

  // T017
  it('EP: pathname không khớp route nào ⇒ unknown, không ghi nguyên văn', () => {
    const result = normalizeRoute('/this-route-does-not-exist-xyz');
    expect(result).toBe('unknown');
  });
});

describe('normalizeApiUrl', () => {
  // T018
  it('EP: segment ObjectId 24-hex → :id', () => {
    expect(
      normalizeApiUrl(
        'https://svc.example.com/api/transaction/64f1a2b3c4d5e6f708091a2b',
      ),
    ).toBe('/api/transaction/:id');
  });

  // T019
  it('EP: segment số thuần → :id', () => {
    expect(normalizeApiUrl('https://svc.example.com/api/brand/123456')).toBe(
      '/api/brand/:id',
    );
  });

  // T020
  it('EP: path tương đối (new URL ném) — không throw, giữ path, vẫn thay id', () => {
    expect(() => normalizeApiUrl('/api/brand/123456')).not.toThrow();
    expect(normalizeApiUrl('/api/brand/123456')).toBe('/api/brand/:id');
  });

  it('bỏ query string trước khi chuẩn hoá', () => {
    expect(
      normalizeApiUrl('https://svc.example.com/api/transaction?foo=bar'),
    ).toBe('/api/transaction');
  });

  // SEC-M1 (post-impl r1) — ngưỡng id của endpoint THỐNG NHẤT §5.3.2: JWT
  // (eyJ…) / opaque token ≥20 ký tự trong path segment cũng phải thành :id.
  // Bản cũ chỉ thay 24-hex|số thuần ⇒ JWT lọt nguyên văn CẢ HAI kênh (GA
  // chỉ kiểm charset, bảng C kho không quét endpoint) — trái FR-012.
  it('SEC-M1: segment JWT (eyJ…) ⇒ :id', () => {
    expect(
      normalizeApiUrl(
        'https://x.invalid/v1/redeem/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwOUMifQ.tkB4qbXJ',
      ),
    ).toBe('/v1/redeem/:id');
  });

  it('SEC-M1: segment opaque token ≥20 ký tự ⇒ :id', () => {
    expect(normalizeApiUrl('/api/voucher/o2oi_9f3ab21c88e77aa01b')).toBe(
      '/api/voucher/:id',
    );
  });

  // SEC-M1 — không thay :id bừa: segment ngắn hợp lệ giữ nguyên (số thuần
  // vẫn :id theo nghĩa cũ).
  it('SEC-M1: segment ngắn hợp lệ giữ nguyên — /api/withdraw/confirm-info', () => {
    expect(normalizeApiUrl('/api/brand/123456')).toBe('/api/brand/:id');
    expect(normalizeApiUrl('/api/withdraw/confirm-info')).toBe(
      '/api/withdraw/confirm-info',
    ); // 12 ký tự — dưới ngưỡng 20, không phải id
  });

  // SEC-n1 (post-impl r1) — hash fragment cũng bỏ như query (đồng bộ
  // normalizeEventRoute §5.3.2 bước 1 — trước đây nhánh tương đối giữ hash).
  it('SEC-n1: hash fragment bị bỏ — /api/foo#frag ⇒ /api/foo', () => {
    expect(normalizeApiUrl('/api/foo#frag')).toBe('/api/foo');
    expect(normalizeApiUrl('https://svc.example.com/api/foo?x=1#frag')).toBe(
      '/api/foo',
    );
  });
});

// ─── phase-2 (webview-session-logs §5.3.2) — normalizeEventRoute route SPA ──
// T013 (edge, FR-001/FR-008): hàm MỚI cho EventRow.route — KHÔNG đụng bảng
// ví dụ của normalizeRoute() ở trên (ARC-M1 r1-TS: doc phase-1 vẫn dùng
// bảng đó làm default — hai hàm hai vai trò khác nhau, không đụng nhau).
describe('normalizeEventRoute — T013 (§5.3.2)', () => {
  // T013 fixture 1 — URL tuyệt đối: bỏ query, segment dãy ≥4 số ⇒ :id,
  // giữ cấu trúc route (placeholder, không bỏ hẳn segment).
  it('T013: URL tuyệt đối + query + segment mã số ⇒ /v1/user/:id/profile', () => {
    expect(
      normalizeEventRoute(
        'https://api.example/v1/user/103492/profile?token=eyJhbGciOiJIUzI1NiJ9.sig',
      ),
    ).toBe('/v1/user/:id/profile');
  });

  // T013 fixture 2 — query bỏ HOÀN TOÀN, không ngoại lệ (FR-008).
  it('T013: /voucher?token=abc&src=push ⇒ /voucher (query bỏ hoàn toàn)', () => {
    expect(normalizeEventRoute('/voucher?token=abc&src=push')).toBe('/voucher');
    // hash cũng bỏ
    expect(normalizeEventRoute('/voucher#section')).toBe('/voucher');
  });

  // T013 fixture 3 — segment ≥20 ký tự liền (token/hash) ⇒ :id.
  it('T013: /redeem/o2oi_9f3ab21c88e77aa01b (≥20 liền) ⇒ /redeem/:id', () => {
    expect(normalizeEventRoute('/redeem/o2oi_9f3ab21c88e77aa01b')).toBe(
      '/redeem/:id',
    );
  });

  // T013 fixture 4 — ký tự lạ ⇒ cắt tại vị trí đầu tiên (charset whitelist).
  it('T013: ký tự lạ ⇒ cắt giữ prefix hợp lệ dài nhất', () => {
    // 'é' không thuộc ^\/[A-Za-z0-9:._\/-]*$ ⇒ cắt ngay tại đó
    expect(normalizeEventRoute('/voucher/caf\u00e9')).toBe('/voucher/caf');
    // ký tự lạ ngay đầu ⇒ chuỗi rỗng
    expect(normalizeEventRoute('\u00e9voucher')).toBe('');
  });

  // Bổ sung §5.3.2 — segment UUID ⇒ :id; cap 128.
  it('T013: segment UUID ⇒ :id; route dài cap 128 ký tự', () => {
    expect(
      normalizeEventRoute('/article/550e8400-e29b-41d4-a716-446655440000'),
    ).toBe('/article/:id');
    // cap 128 (kho): dựng path dài từ NHỀU segment ngắn (dưới ngưỡng :id)
    const long = `/${Array.from({ length: 60 }, () => 'ab').join('/')}`;
    expect(long.length).toBeGreaterThan(128);
    expect(normalizeEventRoute(long).length).toBe(128);
  });

  // 19 ký tự segment = dưới ngưỡng, giữ nguyên (biên dưới của ≥20).
  it('T013: segment 19 ký tự liền (dưới ngưỡng) ⇒ giữ nguyên', () => {
    expect(normalizeEventRoute('/x/abcdefghijklmnopqrs')).toBe(
      '/x/abcdefghijklmnopqrs',
    );
  });

  // ARC-M1 r1-TS — normalizeRoute() với bảng ví dụ KHÔNG đổi cho doc:
  // cùng input, hai hàm hai vai trò khác nhau, không đụng nhau.
  it('T013: normalizeRoute() với bảng ví dụ không đổi (ARC-M1)', () => {
    expect(normalizeRoute('/support/user-request-helps')).toBe(
      '/support/user-request-helps',
    );
    expect(normalizeRoute('/voucher?token=abc')).toBe('/voucher');
    expect(normalizeRoute('/khong-ton-tai-route')).toBe('unknown');
  });
});

