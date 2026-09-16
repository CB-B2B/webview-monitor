// src/utils/monitor/__tests__/record-type.spec.ts
//
// T063/T064 (QĐ-17 vòng bổ sung) — bất biến phân biệt bản ghi doc phase-1
// (SessionPayload) và lô event phase-2 (EventRow[]) — cả hai lên CÙNG stream
// `webview_sessions` sau QĐ-17: field `record_type` là marker CHỈ dành cho
// EventRow; body doc không bao giờ được chứa chuỗi này (R2-1b, E013).

import { readOutbox } from '../outbox';
import { dispatch } from '../transport';
import { isDocBody } from '../types';
import { EventRow, SessionPayload, StepResult, HttpSample } from '../types';
import { captureBlobParts, makeTwoChannelDeps } from './helpers';

function docPayload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    session_id: '11111111-2222-4333-8444-555555555555',
    session_started_at: 1,
    session_finished_at: 2,
    session_duration_ms: 1,
    steps: [],
    home_reached: true,
    finish_reason: 'home_shown',
    pathname: '/',
    env: {
      device_type: 'mobile',
      os: 'iOS',
      os_version: '17.x',
      webview_version: '119.x',
      language: 'vi',
      connection_type: '4g',
      release_version: 'unknown',
    },
    http_samples: [],
    http_overflow: 0,
    partner: 'vpbank',
    filter_l2_hits: 0,
    l2_hits_by_rule: {},
    l2_paths: [],
    send_attempt: 1,
    sample_rate: 1,
    ...overrides,
  };
}

function eventRow(seq: number): EventRow {
  return {
    record_type: 'event',
    session_id: '11111111-2222-4333-8444-555555555555',
    session_started_at: 1700000000000,
    t_offset: seq,
    seq,
    type: 'route_view',
    route: '/voucher',
    sample_rate: 1,
    release_version: 'unknown',
    env_name: 'dev',
    device_model: 'SM-S911B',
  };
}

describe('T063 — body stringify tại điểm dispatch không chứa key record_type (R2-1b)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  // T063 — test ĐƠN, 2 ca (KHÔNG property-based — sửa r3-PERF-M3: bất biến
  // đúng THEO CẤU TRÚC, payload.ts không dòng nào gán/đọc record_type, và
  // lớp 1 `record_type?: never` đã biến việc gán thành lỗi biên dịch).
  // Assert trên body ĐÃ STRINGIFY tại điểm dispatch (sửa r3-ARC-m8) — thứ
  // lên dây là JSON.stringify([payload]) của dispatch(), không phải đầu ra
  // buildPayload trực tiếp.
  //
  // Red-check bằng mutation (đã chạy tay, KHÔNG giữ trong test): ép
  // `record_type: 'event'` (cast as any) vào payload trong test ⇒ body bắt
  // được qua Blob capture CÓ chứa 'record_type' ⇒ cơ chế assert nhìn thấy
  // dây thật; bỏ poison ⇒ xanh. Không có poison nào được commit.
  it('T063: (a) doc tối thiểu ⇒ body beacon không chứa record_type', () => {
    const { doc } = makeTwoChannelDeps();
    const capture = captureBlobParts();
    try {
      dispatch(docPayload(), 'home_shown', { ...doc, sendBeacon: () => true });
      expect(capture.parts().length).toBe(1); // đã lên dây (không rơi outbox)
      expect(capture.parts()[0]).not.toContain('record_type');
    } finally {
      capture.restore();
    }
    // nếu Beacon API không có thì body phải nằm trong outbox — cũng không
    // được chứa record_type (cùng bất biến, hai đường ra)
    expect(readOutbox().every(it => !it.body.includes('record_type'))).toBe(
      true,
    );
  });

  it('T063: (b) doc đủ field (steps + http_samples + finish_reason) ⇒ body beacon không chứa record_type', () => {
    const steps: StepResult[] = [
      {
        seq: 0,
        name: 'auth_user',
        started_at_offset: 0,
        ms: 120,
        status: 'ok',
      },
      {
        seq: 1,
        name: 'config',
        started_at_offset: 130,
        ms: 45,
        status: 'error',
        http_status: 500,
        err_kind: 'http',
        failed_endpoint: '/api/cfg',
      },
    ];
    const httpSamples: HttpSample[] = [
      {
        url: '/api/cfg',
        host: 'main',
        method: 'GET',
        t_offset: 135,
        ms: 40,
        ok: false,
        err_kind: 'http',
        step_seq: 1,
      },
    ];
    const { doc } = makeTwoChannelDeps();
    const capture = captureBlobParts();
    try {
      dispatch(
        docPayload({
          steps,
          http_samples: httpSamples,
          http_overflow: 2,
          finish_reason: 'pagehide',
          time_to_home_ms: 900,
          error: { type: 'Error', message: 'boom' },
          dropped_n: 3,
        }),
        'pagehide',
        { ...doc, sendBeacon: () => true },
      );
      expect(capture.parts().length).toBe(1);
      const sent = capture.parts()[0];
      expect(sent).not.toContain('record_type');
      // đủ field thật sự lên dây — không phải payload rỗng vô tình xanh
      expect(sent).toContain('"steps"');
      expect(sent).toContain('"http_samples"');
      expect(sent).toContain('"finish_reason"');
    } finally {
      capture.restore();
    }
  });
});

describe('T064 — isDocBody: discriminator đặt tên, đọc qua vòng serialize', () => {
  // T064 — khoá discriminator ở HÀM CÓ TÊN, không phải biểu thức inline.
  // Vòng serialize là BẮT BUỘC: `undefined` biến mất qua JSON.stringify —
  // test trên object trực tiếp sẽ bỏ lọt (kể cả khi hàm chỉ kiểm tra vắng
  // mặt record_type, vì object TS mang key undefined vẫn "có" key đó).
  it('T064: isDocBody(JSON.parse(JSON.stringify([doc]))) === true và isDocBody qua serialize([eventRow]) === false', () => {
    const doc = docPayload();
    const roundTrippedDoc = JSON.parse(JSON.stringify([doc]));
    expect(isDocBody(roundTrippedDoc)).toBe(true);

    const row = eventRow(1);
    const roundTrippedRow = JSON.parse(JSON.stringify([row]));
    expect(isDocBody(roundTrippedRow)).toBe(false);
  });

  // T064 (biên): rỗng / rác ⇒ false — discriminator không được "mặc định doc"
  // cho những gì không phải mảng bản ghi hợp lệ (anti-recursion khi parse lại).
  it('T064: mảng rỗng / phần tử rác / không phải mảng ⇒ false', () => {
    expect(isDocBody([])).toBe(false);
    expect(isDocBody([42])).toBe(false);
    expect(isDocBody('not-an-array')).toBe(false);
    expect(isDocBody(null)).toBe(false);
  });

  // T064 (post-impl r11 — code-reviewer MAJOR-1 / SEC-F4 / ARC-m1): siết
  // discriminator sang `record_type === undefined`. Body có record_type khác
  // 'event' (probe/replay §8.2) KHÔNG được dán nhãn doc; object rác thiếu
  // record_type vẫn trả true (residual đã ghi rõ trong JSDoc — call site gác
  // kênh bằng OutboxItem.target, không bằng hàm này).
  it('T064 (r11): body probe (record_type≠"event"/"undefined") ⇒ KHÔNG phải doc', () => {
    expect(isDocBody([{ record_type: 'probe', note: 'acceptance' }])).toBe(
      false,
    );
    expect(isDocBody([{ record_type: 'event' }])).toBe(false);
  });

  it('T064 (r11): object rác thiếu record_type ⇒ true (residual có chủ đích, JSDoc ghi rõ)', () => {
    // KHÔNG phân biệt được với doc bằng riêng field này; không phải rò kênh.
    expect(isDocBody([{ foo: 1 }])).toBe(true);
  });
});
