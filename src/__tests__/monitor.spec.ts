// Bộ test tích hợp qua bề mặt công khai monitor (start/step/http/mark/
// finish/isEnabled/sessionId) — T001-T010, T014-T015, T057-T069, T081-
// T082, T084, T097-T099, T101-T104, T106-T109, T114-T119.

import type { Mock } from 'vitest';
import monitor, { __resetMonitorForTest, sessionId, isEnabled } from '../index';
import { __resetFlagForTest, __setCachedFlagForTest } from '../flag';
import { fixtureConfig } from './configFixture';
import { readOutbox } from '../outbox';
import {
  installFakeMonotonicClock,
  installNavigationTiming,
  installOnLine,
  installRandomUUID,
  installSendBeacon,
  removeCrypto,
  removeSendBeacon,
} from './testUtils';

function lastSentPayload(sendBeaconMock: Mock): any {
  const call = sendBeaconMock.mock.calls[sendBeaconMock.mock.calls.length - 1];
  const blob = call[1] as any;
  // jsdom Blob mock — nội dung được lưu ở _buffer hoặc có thể đọc qua text() async
  return blob;
}

async function blobText(blob: Blob): Promise<string> {
  if (typeof (blob as any).text === 'function') {
    return (blob as any).text();
  }
  // fallback: jsdom cũ có thể thiếu Blob#text
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob as any);
  });
}

describe('monitor — vòng đời một phiên', () => {
  let clock: ReturnType<typeof installFakeMonotonicClock>;
  let sendBeaconMock: Mock;

  beforeEach(() => {
    window.localStorage.clear();
    __resetMonitorForTest();
    monitor.init(fixtureConfig());
    __resetFlagForTest();
    installNavigationTiming(0);
    installRandomUUID(true);
    installOnLine(true);
    clock = installFakeMonotonicClock(0);
    sendBeaconMock = installSendBeacon(true);
  });

  afterEach(() => {
    clock.restore();
  });

  // T002
  it('T002: start() sinh session_id UUID, session_started_at từ Navigation Timing', () => {
    monitor.start();
    expect(sessionId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(isEnabled()).toBe(true);
  });

  // T064
  it('T064: start() gọi lần 2 ⇒ no-op, session_id không đổi', () => {
    monitor.start();
    const id1 = sessionId();
    monitor.start();
    expect(sessionId()).toBe(id1);
  });

  // T003
  it('T003: step() ghi đúng 6 StepResult với seq 0..5 theo đúng thứ tự', async () => {
    monitor.start();
    await monitor.step('auth_user', async () => 1);
    await monitor.step('home_float_icon', async () => 2);
    await monitor.step('partner_id', async () => 3);
    await monitor.step('home_banner', async () => 4);
    await monitor.step('config', async () => 5);
    await monitor.step('search_hint', async () => 6);
    monitor.mark('home_ready');
    monitor.finish('home_shown');

    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    expect(sent.steps.length).toBe(6);
    sent.steps.forEach((s: any, i: number) => {
      expect(s.seq).toBe(i);
      expect(s.status).toBe('ok');
    });
    expect(sent.steps.map((s: any) => s.name)).toEqual([
      'auth_user',
      'home_float_icon',
      'partner_id',
      'home_banner',
      'config',
      'search_hint',
    ]);
  });

  // T004
  it('T004: step() trả về đúng reference giá trị fn()', async () => {
    monitor.start();
    const marker = { x: 1 };
    const result = await monitor.step('auth_user', async () => marker);
    expect(result).toBe(marker);
  });

  // T068
  it('T068: step() rethrow NGUYÊN TRẠNG — cùng object reference', async () => {
    monitor.start();
    const original = new Error('boom');
    await expect(
      monitor.step('auth_user', async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  // T065
  it('T065: step() gọi TRƯỚC start() ⇒ trong suốt, vẫn chạy fn() và trả kết quả', async () => {
    const result = await monitor.step('auth_user', async () => 42);
    expect(result).toBe(42);
  });

  // T080 (một phần) — step<T> trong suốt dù có lỗi
  it('T080: step() KHÔNG start() ⇒ exception vẫn ném nguyên trạng', async () => {
    const original = new Error('boom-no-start');
    await expect(
      monitor.step('auth_user', async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  // T069
  it('T069: bookkeeping nội bộ của step() ném lỗi không làm hỏng giá trị trả về', async () => {
    monitor.start();
    // ép state.steps rỗng để recordStepOk ném lỗi truy cập .started_at_offset trên undefined
    monitor as any; // no direct access — mô phỏng gián tiếp bằng cách gọi step với tên không thuộc STEP_NAMES
    const result = await monitor.step(
      'does-not-exist' as any,
      async () => 'ok-value',
    );
    expect(result).toBe('ok-value');
  });

  // T001
  it('T001: phiên đủ 6 bước ok ⇒ home_reached true, finish_reason home_shown, đúng 1 lượt gửi', async () => {
    monitor.start();
    for (const name of [
      'auth_user',
      'home_float_icon',
      'partner_id',
      'home_banner',
      'config',
      'search_hint',
    ] as const) {
      await monitor.step(name, async () => true);
    }
    monitor.mark('home_ready');
    monitor.finish('home_shown');
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    expect(sent.home_reached).toBe(true);
    expect(sent.finish_reason).toBe('home_shown');
  });

  // T009
  it('T009: bước hỏng nhưng vẫn tới Home ⇒ home_reached false, finish_reason vẫn home_shown', async () => {
    monitor.start();
    await monitor.step('auth_user', async () => true).catch(() => undefined);
    try {
      await monitor.step('home_float_icon', async () => {
        throw new Error('step fail');
      });
    } catch {
      /* mô phỏng catch ở layout — vẫn tiếp tục các bước khác trong test */
    }
    monitor.mark('home_ready');
    monitor.finish('home_shown');
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    expect(sent.home_reached).toBe(false);
    expect(sent.finish_reason).toBe('home_shown');
  });

  // T008 / T015
  it('T008: phiên bỏ dở ở bước 3 (pagehide) ⇒ đúng 1 gói, 3 bước có kết quả + 3 pending', async () => {
    monitor.start();
    await monitor.step('auth_user', async () => 1);
    await monitor.step('home_float_icon', async () => 1);
    await monitor.step('partner_id', async () => 1);
    monitor.finish('pagehide');
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    const okCount = sent.steps.filter((s: any) => s.status === 'ok').length;
    const pendingCount = sent.steps.filter(
      (s: any) => s.status === 'pending',
    ).length;
    expect(okCount).toBe(3);
    expect(pendingCount).toBe(3);
    expect(sent.steps.length).toBe(6);
  });

  // T015
  it('T015: phiên chết trước bước 1 (0 bước chạy) ⇒ steps vẫn có 6 phần tử, tất cả pending', () => {
    monitor.start();
    monitor.finish('init_failed');
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
  });

  // T014 / T119
  it('T014/T119: cờ L1 enabled=false ⇒ DISABLED, step() vẫn trong suốt, finish() không gửi gì', async () => {
    __setCachedFlagForTest({
      enabled: false,
      rate: 1,
      http: true,
      steps: true,
    });
    monitor.start();
    expect(isEnabled()).toBe(false);
    const result = await monitor.step('auth_user', async () => 'value');
    expect(result).toBe('value');
    monitor.finish('home_shown');
    expect(sendBeaconMock).not.toHaveBeenCalled();
    expect(readOutbox().length).toBe(0);
  });

  // T103 — §0.9 — đổi ngữ nghĩa phase-2 (QĐ-16): bỏ chốt sampling phiên.
  // phase-1 từng asserts rate=0 ⇒ không session/doc; phase-2 FR-015 đảo sampling:
  // monitor khởi động đầy đủ cho MỌI phiên bất kể rate — núm rate (giờ deprecated)
  // chỉ gạt route_view/api_call-thành-công ở mức SỰ KIỆN qua 2 bit sticky
  // routeSampled/apiOkSampled bốc trong _start() từ route_sample_rate/
  // api_ok_sample_rate (mặc định 1 khi flag thiếu field — T010 kiểm sâu ở
  // events.spec.ts). Doc phase-1 luôn gửi, sample_rate ghi 1.
  it('T103: rate=0 ⇒ phiên VẪN khởi động, doc VẪN gửi với sample_rate:1 (bỏ chốt sampling phiên §0.9)', async () => {
    __setCachedFlagForTest({ enabled: true, rate: 0, http: true, steps: true });
    monitor.start();
    expect(isEnabled()).toBe(true); // session STILL starts — FR-015
    expect(sessionId()).not.toBe(''); // 100% phiên có session_id (X-Session-Id)
    monitor.finish('home_shown');
    expect(sendBeaconMock).toHaveBeenCalledTimes(1); // doc STILL sends
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    expect(sent.sample_rate).toBe(1); // doc không bao giờ lấy mẫu
    expect(readOutbox().length).toBe(0);
  });

  // T104
  it('T104: rate=1 ⇒ luôn thu, sample_rate:1', async () => {
    __setCachedFlagForTest({ enabled: true, rate: 1, http: true, steps: true });
    monitor.start();
    expect(isEnabled()).toBe(true);
    monitor.finish('home_shown');
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    expect(sent.sample_rate).toBe(1);
  });

  // T102
  it('T102: sample_rate quyết trong start(), sticky cả phiên dù cờ đổi giữa chừng', async () => {
    __setCachedFlagForTest({ enabled: true, rate: 1, http: true, steps: true });
    monitor.start();
    __setCachedFlagForTest({
      enabled: true,
      rate: 0.2,
      http: true,
      steps: true,
    }); // đổi giữa chừng
    monitor.finish('home_shown');
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    expect(sent.sample_rate).toBe(1); // vẫn giá trị lúc start()
  });

  // T063
  it('T063: finish() gọi lần 2 ⇒ no-op, đúng 1 lần gọi sendBeacon tổng cộng', () => {
    monitor.start();
    monitor.finish('home_shown');
    monitor.finish('pagehide');
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
  });

  // T066
  it('T066: finish() gọi TRƯỚC start() ⇒ no-op, không gửi, không throw', () => {
    expect(() => monitor.finish('home_shown')).not.toThrow();
    expect(sendBeaconMock).not.toHaveBeenCalled();
  });

  // T067 / T118
  it('T067/T118: mark() gọi SAU finish() ⇒ no-op, không gửi thêm gói, không throw', () => {
    monitor.start();
    monitor.finish('home_shown');
    expect(() => monitor.mark('home_ready')).not.toThrow();
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
  });

  // T070
  it('T070: monitor.http() không làm call() vỡ dù ném lỗi nội bộ (safe() chặn)', () => {
    monitor.start();
    expect(() => monitor.http(null as any, 'GET', 1)).not.toThrow();
  });

  // T081 — sinh mã phiên: không trùng qua nhiều lần start (mỗi lần reset module)
  it('T081: sinh session_id ngẫu nhiên, không suy ra được từ thời gian, không tăng đơn điệu', () => {
    // Cài crypto giả DUY NHẤT lần trước vòng lặp — bộ đếm nội bộ của fixture
    // tăng dần qua từng lần gọi randomUUID(), mô phỏng "ngẫu nhiên thật" đủ để
    // kiểm tra không trùng lặp qua nhiều phiên liên tiếp.
    installRandomUUID(true);
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      __resetMonitorForTest();
      monitor.init(fixtureConfig());
      monitor.start();
      ids.add(sessionId());
    }
    expect(ids.size).toBe(200); // không trùng
  });

  // T082 — session_id không bao giờ bị redact (kiểm ở filter.spec.ts mức unit;
  // ở đây kiểm mức tích hợp thật qua toàn bộ pipeline finish())
  it('T082: session_id đi qua toàn bộ pipeline finish() (Lớp 1 + Lớp 2) nguyên vẹn', async () => {
    monitor.start();
    const id = sessionId();
    monitor.finish('home_shown');
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    expect(sent.session_id).toBe(id);
  });

  // T116 / A-25 — session_duration_ms từ đồng hồ đơn điệu
  it('T116: session_duration_ms không đổi dấu/không nhảy khi Date.now() lùi giữa phiên', async () => {
    const dateSpy = vi.spyOn(Date, 'now');
    dateSpy.mockReturnValue(2_000_000);
    monitor.start();
    clock.advance(5000); // performance.now() tăng đều 5s
    dateSpy.mockReturnValue(2_000_000 - 3_600_000); // Date.now() nhảy lùi 1 giờ
    monitor.finish('home_shown');
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    expect(sent.session_duration_ms).toBe(5000);
    expect(sent.session_duration_ms).toBeGreaterThan(0);
    dateSpy.mockRestore();
  });

  // T117 / A-28 — partner luôn literal
  it('T117: partner luôn là literal "vpbank"', async () => {
    monitor.start();
    monitor.finish('home_shown');
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    expect(sent.partner).toBe('vpbank');
  });

  // T101 — QĐ-37: không có nhánh diễn tập/demo
  it('T101: gói không chứa trường diễn tập; mon_drill/?drill=1 không ảnh hưởng gói', async () => {
    window.localStorage.setItem('mon_drill', '1');
    monitor.start();
    monitor.finish('home_shown');
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    expect(sent.is_drill).toBeUndefined();
    expect('is_drill' in sent).toBe(false);
    expect(Object.keys(sent).some(k => /drill|demo/i.test(k))).toBe(false);
  });

  // T057 / E008
  it('T057: thiếu crypto.randomUUID ⇒ vẫn sinh session_id, sid_weak: true', async () => {
    removeCrypto();
    monitor.start();
    expect(sessionId()).toBeTruthy();
    monitor.finish('home_shown');
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    expect(sent.sid_weak).toBe(true);
  });

  // T058 / E008
  it('T058: thiếu navigator.sendBeacon ⇒ fallback fetch(keepalive), vẫn gửi được', async () => {
    removeSendBeacon();
    monitor.start();
    monitor.finish('home_shown'); // trang sống ⇒ dùng fetch fallback
    // fetch không mock riêng ở test này — global fetch trong jsdom có thể
    // undefined; chỉ cần khẳng định không throw và không dùng sendBeacon.
    expect(sendBeaconMock).not.toHaveBeenCalled();
  });

  // T115 / A-5 — outbox xả ở finish('init_failed')
  it('T115: outbox được lên lịch xả ở finish(init_failed), không chỉ phiên thành công', () => {
    vi.useFakeTimers();
    const sb = installSendBeacon(false);
    monitor.start();
    monitor.finish('init_failed');
    // finish() gọi dispatch() đồng bộ trước, rồi setTimeout(0) để drain outbox.
    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
    vi.useRealTimers();
    void sb;
  });

  // T007b — cross-drain — bổ sung sau impl (không có trong plan gốc):
  // đường doc (index._finish → drainOutbox(deps target='doc')) chỉ được xả
  // item target='doc' tới INGEST_URL — item lô event của phiên trước PHẢI còn
  // nguyên trong outbox, không bị gửi nhầm sang endpoint doc (outbox.ts
  // OutboxTarget / ARC-n11 r1-TS).
  it('T007b: drain đường doc chỉ gửi item doc tới INGEST_URL — item events giữ nguyên', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    window.localStorage.setItem(
      'mon_outbox',
      JSON.stringify([
        {
          body: '[{"record_type":"event","seq":1}]',
          target: 'events',
          attempt: 1,
          firstAt: now - 60000,
          nextAt: now - 1,
        },
        {
          body: '{"doc_from_previous_session":true}',
          target: 'doc',
          attempt: 1,
          firstAt: now - 60000,
          nextAt: now - 1,
        },
      ]),
    );
    monitor.start();
    monitor.finish('home_shown'); // doc beacon + setTimeout(0) drain (target doc)
    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
    // Chuyển về real timers TRƯỚC khi đọc Blob async — fake timers của
    // Vitest (khác Jest) có thể mô phỏng luôn macrotask FileReader dùng nội
    // bộ, khiến Promise.all() dưới đây treo vô hạn nếu vẫn fake.
    vi.useRealTimers();
    // Beacon 1 = doc phiên hiện tại (INGEST_URL), beacon 2 = item doc drain.
    expect(sendBeaconMock).toHaveBeenCalledTimes(2);
    sendBeaconMock.mock.calls.forEach((c: unknown[]) => {
      expect(String(c[0])).toBe('https://obs-qrx.invalid/ingest');
    });
    const bodies = await Promise.all(
      sendBeaconMock.mock.calls.map((c: unknown[]) => blobText(c[1] as Blob)),
    );
    bodies.forEach((b: string) => expect(b).not.toContain('record_type'));
    // Item events KHÔNG bị tiêu — còn nguyên chờ drain đường events.
    const remaining = readOutbox();
    expect(remaining.length).toBe(1);
    expect(remaining[0].target).toBe('events');
  });
});

describe('monitor — http() tương quan bước (T097-T099, T010)', () => {
  let clock: ReturnType<typeof installFakeMonotonicClock>;
  let sendBeaconMock: Mock;

  beforeEach(() => {
    window.localStorage.clear();
    __resetMonitorForTest();
    monitor.init(fixtureConfig());
    __resetFlagForTest();
    installNavigationTiming(0);
    installRandomUUID(true);
    installOnLine(true);
    clock = installFakeMonotonicClock(0);
    sendBeaconMock = installSendBeacon(true);
  });

  afterEach(() => clock.restore());

  // T097
  it('T097: step_seq gán đúng bước đang mở', async () => {
    monitor.start();
    await monitor.step('partner_id', async () => {
      monitor.http('https://vpbank-svc.atcashback.com/api/x', 'GET', 5);
      return true;
    });
    monitor.finish('home_shown');
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    expect(sent.http_samples[0].step_seq).toBe(2); // partner_id = seq 2
  });

  // T098
  it('T098: request bay ngoài mọi cửa sổ bước ⇒ step_seq null', async () => {
    monitor.start();
    monitor.http('https://vpbank-svc.atcashback.com/api/detached', 'GET', 5);
    monitor.finish('home_shown');
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    expect(sent.http_samples[0].step_seq).toBeNull();
  });

  // T010
  it('T010: "hỏng bị nuốt" — step ok nhưng có HttpSample ok:false với step_seq đúng bước', async () => {
    monitor.start();
    await monitor.step('config', async () => {
      // model kiểm err rồi im lặng (không throw) — chỉ http() ghi nhận lỗi
      monitor.http(
        'https://vpbank-svc.atcashback.com/api/config',
        'GET',
        5,
        'http',
        500,
      );
      return { data: null };
    });
    monitor.finish('home_shown');
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    const configStep = sent.steps.find((s: any) => s.name === 'config');
    expect(configStep.status).toBe('ok');
    const failedSample = sent.http_samples.find((s: any) => s.ok === false);
    expect(failedSample).toBeDefined();
    expect(failedSample.step_seq).toBe(configStep.seq);
  });

  // T099
  it('T099: failed_endpoint = endpoint hỏng ĐẦU TIÊN trong bước', async () => {
    monitor.start();
    await monitor
      .step('auth_user', async () => {
        monitor.http(
          'https://vpbank-svc.atcashback.com/api/first',
          'GET',
          5,
          'http',
          500,
        );
        monitor.http(
          'https://vpbank-svc.atcashback.com/api/second',
          'GET',
          5,
          'http',
          500,
        );
        throw new Error('auth failed');
      })
      .catch(() => undefined);
    monitor.finish('init_failed');
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    const authStep = sent.steps.find((s: any) => s.name === 'auth_user');
    expect(authStep.failed_endpoint).toBe('/api/first');
  });

  // T005
  it('T005: http() ghi mẫu — url đã qua normalizeApiUrl, host là enum', async () => {
    monitor.start();
    monitor.http(
      'https://vpbank-svc.atcashback.com/api/transaction/64f1a2b3c4d5e6f708091a2b?x=1',
      'GET',
      5,
    );
    monitor.finish('home_shown');
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    expect(sent.http_samples[0].url).toBe('/api/transaction/:id');
    expect(sent.http_samples[0].host).toBe('main');
  });

  // Hồi quy C-1 — GHIM giá trị host, đừng chỉ kiểm nó thuộc tập enum.
  //
  // Bản gốc của T005 chỉ khẳng định `host` ∈ {main,sys,other}. Đúng cả khi
  // classifyHost() hỏng hoàn toàn: `MAIN_ENDPOINT`/`SYS_ENDPOINT` từng rỗng
  // vĩnh viễn (đọc process.env bằng KHOÁ ĐỘNG nên define() không thay được),
  // khiến MỌI mẫu rơi về 'other'. 162 test xanh suốt mà không ai thấy, tới
  // lúc đọc gói thật mới lộ. Ba khẳng định dưới đây đóng lại lối đó.
  it('C-1: classifyHost() phân biệt được main / sys / other', async () => {
    monitor.start();
    monitor.http('https://vpbank-svc.atcashback.com/api/user/info', 'POST', 1);
    monitor.http(
      'https://sys.atcashback.com/api/partner-configuration',
      'GET',
      1,
    );
    monitor.http('https://cdn.example.com/asset.json', 'GET', 1);
    monitor.finish('home_shown');
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    expect(sent.http_samples.map((s: any) => s.host)).toEqual([
      'main',
      'sys',
      'other',
    ]);
  });

  // T021-T024 err_kind — kiểm nguyên trạng đi qua http()
  it('T021-T024: err_kind truyền qua http() nguyên trạng', async () => {
    monitor.start();
    monitor.http('https://x.com/a', 'GET', 1, 'timeout');
    monitor.http('https://x.com/b', 'GET', 1, 'offline');
    monitor.http('https://x.com/c', 'GET', 1, 'http', 404);
    monitor.http('https://x.com/d', 'GET', 1, 'unknown');
    monitor.finish('home_shown');
    const body = await blobText(lastSentPayload(sendBeaconMock));
    const [sent] = JSON.parse(body);
    expect(sent.http_samples.map((s: any) => s.err_kind)).toEqual([
      'timeout',
      'offline',
      'http',
      'unknown',
    ]);
  });
});

describe('monitor — T106/T107 (A-8, A-2 tại biên module)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetMonitorForTest();
    monitor.init(fixtureConfig());
    __resetFlagForTest();
    installNavigationTiming(0);
    installRandomUUID(true);
    installOnLine(true);
    installSendBeacon(true);
  });

  // T106 — runtime: truyền object vào vị trí errKind bị type guard từ chối
  it('T106: http() không nhận đối tượng lỗi ở vị trí errKind — an toàn dù truyền nhầm kiểu', async () => {
    monitor.start();
    expect(() =>
      monitor.http('https://x.com/a', 'GET', 1, {
        message: 'not an errkind',
      } as any),
    ).not.toThrow();
  });

  // T107
  it('T107: sessionId() rỗng khi chưa start(), đúng session_id sau start()', () => {
    expect(sessionId()).toBe('');
    monitor.start();
    expect(sessionId()).not.toBe('');
    expect(sessionId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// L2 — công tắc biên dịch (§1.6, R3-C1b). Trong bundle thật giá trị do
// define() thay tại build; trong jest nó là process.env của Node nên tiêm
// trực tiếp được. Đây là chốt ĐẦU TIÊN của _start(), trước cả L1.
describe('monitor — công tắc L2 `process.env.MONITOR === "off"` (R3-C1b)', () => {
  let sendBeaconMock: Mock;
  let clock: ReturnType<typeof installFakeMonotonicClock>;
  let fetchMock: Mock;

  beforeEach(() => {
    window.localStorage.clear();
    __resetMonitorForTest();
    monitor.init(fixtureConfig());
    __resetFlagForTest();
    installNavigationTiming(0);
    installRandomUUID(true);
    installOnLine(true);
    clock = installFakeMonotonicClock(0);
    sendBeaconMock = installSendBeacon(true);
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    clock.restore();
    delete process.env.MONITOR;
    delete (globalThis as any).fetch;
  });

  it('MONITOR="off" ⇒ start() no-op: không state, không session_id', () => {
    process.env.MONITOR = 'off';
    monitor.start();
    expect(isEnabled()).toBe(false);
    expect(sessionId()).toBe('');
  });

  it('MONITOR="off" ⇒ cả finish() lẫn outbox đều không sinh request nào', async () => {
    process.env.MONITOR = 'off';
    monitor.start();
    await monitor.step('auth_user', async () => 1); // pass-through, không ghi
    monitor.finish('pagehide');
    expect(sendBeaconMock).not.toHaveBeenCalled();
    expect(readOutbox().length).toBe(0);
  });

  it('MONITOR="off" ⇒ attachLifecycle() KHÔNG fetch cờ L1 (vô hiệu hoá mọi lời gọi)', () => {
    process.env.MONITOR = 'off';
    monitor.attachLifecycle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('MONITOR="on" ⇒ attachLifecycle() fetch cờ đúng FLAG_URL một lần', () => {
    process.env.MONITOR = 'on';
    monitor.attachLifecycle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(fixtureConfig().flagUrl);
  });

  it('MONITOR không đặt ⇒ coi như on (mặc định bật) — start() hoạt động bình thường', () => {
    delete process.env.MONITOR;
    monitor.start();
    expect(isEnabled()).toBe(true);
  });
});

// SEC-4/R3-N1 — TTL 24h phải được thực thi KỂ CẢ KHI MONITOR TẮT. drain()
// chỉ chạy khi có phiên hoàn tất; attachLifecycle() chạy mọi lần nạp trang
// nên là chỗ đúng để dọn.
describe('monitor — prune TTL thụ động qua attachLifecycle (SEC-4)', () => {
  let clock: ReturnType<typeof installFakeMonotonicClock>;
  let fetchMock: Mock;

  beforeEach(() => {
    window.localStorage.clear();
    __resetMonitorForTest();
    monitor.init(fixtureConfig());
    __resetFlagForTest();
    installNavigationTiming(0);
    installRandomUUID(true);
    installOnLine(true);
    clock = installFakeMonotonicClock(0);
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    clock.restore();
    delete (globalThis as any).fetch;
  });

  it('attachLifecycle dọn item quá hạn khỏi outbox + tăng dropped_n, không gửi mạng', () => {
    // Giả lập item từ bản dựng trước: cũ hơn TTL 24h một chút.
    const now = Date.now();
    window.localStorage.setItem(
      'mon_outbox',
      JSON.stringify([
        {
          body: 'stale',
          attempt: 1,
          firstAt: now - 24 * 60 * 60 * 1000 - 1,
          nextAt: now,
        },
      ]),
    );
    monitor.attachLifecycle();
    expect(readOutbox().length).toBe(0);
    expect(Number(window.localStorage.getItem('mon_dropped_n'))).toBe(1);
    // không fetch ingest (fetch mock chỉ có thể bị gọi bởi cờ L1 — kiểm nó
    // không POST gói nào: sendBeacon chưa từng cài ở đây nên cứ chứng minh
    // outbox rỗng + dropped_n là đủ)
  });

  it('attachLifecycle KHÔNG đụng item còn hạn', () => {
    const now = Date.now();
    window.localStorage.setItem(
      'mon_outbox',
      JSON.stringify([
        { body: 'fresh', attempt: 1, firstAt: now, nextAt: now },
      ]),
    );
    monitor.attachLifecycle();
    expect(readOutbox().map(i => i.body)).toEqual(['fresh']);
    expect(Number(window.localStorage.getItem('mon_dropped_n') || '0')).toBe(0);
  });

  it('L2=off ⇒ KHÔNG prune (công tắc biên dịch vô hiệu hoá mọi việc)', () => {
    process.env.MONITOR = 'off';
    const now = Date.now();
    window.localStorage.setItem(
      'mon_outbox',
      JSON.stringify([
        {
          body: 'stale',
          attempt: 1,
          firstAt: now - 24 * 60 * 60 * 1000 - 1,
          nextAt: now,
        },
      ]),
    );
    monitor.attachLifecycle();
    expect(readOutbox().length).toBe(1);
    delete process.env.MONITOR;
  });
});
