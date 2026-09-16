// §1.5 decision table (T071-T076) + §3.2 Error Catalog E001-E008
import type { Mock } from 'vitest';
import { dispatch, drainOutbox, TransportDeps } from '../transport';
import { enqueue, readOutbox } from '../outbox';
import { SessionPayload } from '../types';

function payload(overrides: Partial<SessionPayload> = {}): SessionPayload {
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

function baseDeps(overrides: Partial<TransportDeps> = {}): TransportDeps {
  return {
    url: 'https://obs-qrx.atcashback.com/api/default/webview_sessions/_json',
    onLine: () => true,
    hasSendBeacon: true,
    sendBeacon: vi.fn(() => true),
    fetchFn: vi.fn(() =>
      Promise.resolve({ ok: true, status: 200 } as Response),
    ),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

// Nhường một nhịp macrotask để mọi chuỗi .then() trong dispatch() kịp chạy hết.
// Trước đây dùng setImmediate — global đó do CLI `umi-test` của Umi 3 bơm vào;
// môi trường jsdom của jest 29 không có nó (setImmediate là API của Node, không
// phải của trình duyệt). setTimeout 0 cho đúng ranh giới macrotask ấy và có ở cả
// hai nơi. File này không dùng fake timer nên không có gì chặn nó lại.
function flushMicrotasks() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('Decision table T071-T076', () => {
  // T071
  it('online · có beacon · beacon true ⇒ gửi xong, không ghi outbox', () => {
    const deps = baseDeps();
    dispatch(payload(), 'home_shown', deps);
    expect(deps.sendBeacon).toHaveBeenCalledTimes(1);
    expect(readOutbox().length).toBe(0);
  });

  // T072
  it('online · beacon false · trang sống (home_shown) ⇒ thử fetch keepalive 1 lần, ok ⇒ không outbox', async () => {
    const deps = baseDeps({
      sendBeacon: vi.fn(() => false),
      fetchFn: vi.fn(() =>
        Promise.resolve({ ok: true, status: 200 } as Response),
      ),
    });
    dispatch(payload(), 'home_shown', deps);
    await flushMicrotasks();
    expect(deps.fetchFn).toHaveBeenCalledTimes(1);
    expect(readOutbox().length).toBe(0);
  });

  // T073
  it('online · beacon false · trang đang chết (pagehide) ⇒ KHÔNG gọi fetch, thẳng outbox', () => {
    const deps = baseDeps({ sendBeacon: vi.fn(() => false) });
    dispatch(payload(), 'pagehide', deps);
    expect(deps.fetchFn).not.toHaveBeenCalled();
    expect(readOutbox().length).toBe(1);
  });

  // T074
  it('offline · trang sống ⇒ outbox thẳng, không chạm mạng', () => {
    const deps = baseDeps({ onLine: () => false });
    dispatch(payload(), 'home_shown', deps);
    expect(deps.sendBeacon).not.toHaveBeenCalled();
    expect(deps.fetchFn).not.toHaveBeenCalled();
    expect(readOutbox().length).toBe(1);
  });

  // T075
  it('offline · trang đang chết ⇒ outbox thẳng', () => {
    const deps = baseDeps({ onLine: () => false });
    dispatch(payload(), 'pagehide', deps);
    expect(readOutbox().length).toBe(1);
  });

  // T076
  it('thiếu sendBeacon · trang đang chết ⇒ outbox (không gọi fetch trên trang chết)', () => {
    const deps = baseDeps({ hasSendBeacon: false, sendBeacon: vi.fn() });
    dispatch(payload(), 'pagehide', deps);
    expect(deps.sendBeacon).not.toHaveBeenCalled();
    expect(deps.fetchFn).not.toHaveBeenCalled();
    expect(readOutbox().length).toBe(1);
  });
});

describe('Error Catalog E001-E008', () => {
  // T048/T049
  it('E001: 401 qua fetch keepalive ⇒ nuốt lỗi, KHÔNG enqueue', async () => {
    const deps = baseDeps({
      sendBeacon: vi.fn(() => false),
      fetchFn: vi.fn(() =>
        Promise.resolve({ ok: false, status: 401 } as Response),
      ),
    });
    dispatch(payload(), 'home_shown', deps);
    await flushMicrotasks();
    expect(readOutbox().length).toBe(0);
  });

  it('E001: 403 qua fetch keepalive ⇒ nuốt lỗi, KHÔNG enqueue', async () => {
    const deps = baseDeps({
      sendBeacon: vi.fn(() => false),
      fetchFn: vi.fn(() =>
        Promise.resolve({ ok: false, status: 403 } as Response),
      ),
    });
    dispatch(payload(), 'home_shown', deps);
    await flushMicrotasks();
    expect(readOutbox().length).toBe(0);
  });

  // T050
  it('E002: 429 ⇒ enqueue retry', async () => {
    const deps = baseDeps({
      sendBeacon: vi.fn(() => false),
      fetchFn: vi.fn(() =>
        Promise.resolve({ ok: false, status: 429 } as Response),
      ),
    });
    dispatch(payload(), 'home_shown', deps);
    await flushMicrotasks();
    expect(readOutbox().length).toBe(1);
  });

  // T052
  it('E003: 5xx ⇒ enqueue retry', async () => {
    const deps = baseDeps({
      sendBeacon: vi.fn(() => false),
      fetchFn: vi.fn(() =>
        Promise.resolve({ ok: false, status: 503 } as Response),
      ),
    });
    dispatch(payload(), 'home_shown', deps);
    await flushMicrotasks();
    expect(readOutbox().length).toBe(1);
  });

  // T053
  it('E004: navigator.onLine === false ⇒ KHÔNG chạm mạng, đẩy thẳng outbox', () => {
    const deps = baseDeps({ onLine: () => false });
    dispatch(payload(), 'home_shown', deps);
    expect(deps.sendBeacon).not.toHaveBeenCalled();
    expect(deps.fetchFn).not.toHaveBeenCalled();
    expect(readOutbox().length).toBe(1);
  });

  // T054
  it('E005: fetch reject (CORS TypeError) ⇒ xử như E004, enqueue', async () => {
    const deps = baseDeps({
      sendBeacon: vi.fn(() => false),
      fetchFn: vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    });
    dispatch(payload(), 'home_shown', deps);
    await flushMicrotasks();
    expect(readOutbox().length).toBe(1);
  });

  // T055
  it('E006: sendBeacon trả false (trang chết) ⇒ ghi outbox đồng bộ, attempt bắt đầu từ 1', () => {
    const deps = baseDeps({ sendBeacon: vi.fn(() => false) });
    dispatch(payload(), 'pagehide', deps);
    const items = readOutbox();
    expect(items.length).toBe(1);
    expect(items[0].attempt).toBe(1);
  });

  // T056 (kèm E007)
  it('E007: vẫn vượt 64KB sau khi cắt tối đa ⇒ bỏ gửi, không retry, không outbox', () => {
    const huge = 'x'.repeat(200 * 1024); // 200KB, không thể cắt về dưới 64KB chỉ bằng bỏ http_samples
    const deps = baseDeps();
    dispatch(
      payload({ error: { type: 'Error', message: huge } }),
      'home_shown',
      deps,
    );
    expect(deps.sendBeacon).not.toHaveBeenCalled();
    expect(readOutbox().length).toBe(0);
  });

  // T047
  it('E007: payload vượt 64KB do quá nhiều http_samples ⇒ cắt tại chỗ trước khi gửi', () => {
    const manySamples = Array.from({ length: 20 }, (_, i) => ({
      url: `/api/x/${i}`.padEnd(2000, '0'), // làm mỗi mẫu nặng để tổng vượt 64KB
      host: 'main' as const,
      method: 'GET',
      t_offset: i,
      ms: 1,
      ok: true,
      step_seq: null,
    }));
    const deps = baseDeps();
    dispatch(payload({ http_samples: manySamples }), 'home_shown', deps);
    expect(deps.sendBeacon).toHaveBeenCalledTimes(1);
    const sentBody = (deps.sendBeacon as Mock).mock.calls[0][1] as Blob;
    expect(sentBody).toBeInstanceOf(Blob);
  });
});

describe('URL điểm nhận chưa cấu hình (url rỗng)', () => {
  // sendBeacon('') KHÔNG phải no-op: trình duyệt phân giải chuỗi rỗng theo
  // base URL của tài liệu hiện tại ⇒ POST thẳng về CHÍNH TRANG ĐANG MỞ, và
  // vẫn trả `true` ⇒ nếu không chặn sớm, dispatch() coi như đã gửi và mất
  // phiên trong im lặng (không vào outbox). Ba case dưới bảo đảm chốt chặn
  // nằm NGAY ĐẦU dispatch(), sau ensureWithinBudget (E007) nhưng trước mọi
  // nhánh mạng — dùng baseDeps({ url: '' }) để mô phỏng INGEST_URL rỗng.

  it('url rỗng · trang sống (home_shown) ⇒ không gọi sendBeacon/fetch, outbox có đúng 1 gói', () => {
    const deps = baseDeps({ url: '' });
    dispatch(payload(), 'home_shown', deps);
    expect(deps.sendBeacon).not.toHaveBeenCalled();
    expect(deps.fetchFn).not.toHaveBeenCalled();
    expect(readOutbox().length).toBe(1);
  });

  it('url rỗng · trang đang chết (pagehide) ⇒ không gọi sendBeacon/fetch, outbox có đúng 1 gói', () => {
    const deps = baseDeps({ url: '' });
    dispatch(payload(), 'pagehide', deps);
    expect(deps.sendBeacon).not.toHaveBeenCalled();
    expect(deps.fetchFn).not.toHaveBeenCalled();
    expect(readOutbox().length).toBe(1);
  });

  // E007: chốt chặn url rỗng phải đặt SAU ensureWithinBudget — không được
  // đảo thứ tự ưu tiên. Payload vượt 64KB không cắt nổi vẫn bị bỏ hẳn dù
  // url rỗng, chứng minh nhánh url rỗng không "cứu" một gói đáng lẽ bị E007.
  it('url rỗng nhưng payload vượt 64KB không cắt nổi ⇒ vẫn bỏ theo E007, outbox rỗng', () => {
    const huge = 'x'.repeat(200 * 1024);
    const deps = baseDeps({ url: '' });
    dispatch(
      payload({ error: { type: 'Error', message: huge } }),
      'home_shown',
      deps,
    );
    expect(deps.sendBeacon).not.toHaveBeenCalled();
    expect(deps.fetchFn).not.toHaveBeenCalled();
    expect(readOutbox().length).toBe(0);
  });
});

describe('drainOutbox()', () => {
  // A-C1/R2-C1 (đã vá): cầu nối drainOutbox() là đường ra mạng THỨ HAI (bên
  // cạnh dispatch()) — trước khi vá, nó không có chốt chặn `url` rỗng riêng,
  // nên một gói đã enqueue ở phiên 1 (do url rỗng) sẽ bị resend() qua
  // sendBeacon('') ở phiên 2 khi đến hạn backoff, POST thẳng SessionPayload
  // về chính trang đang mở. Ba describe dưới phủ đúng 3 hành vi bắt buộc
  // theo §1.5/FR-016.

  const ENQUEUE_NOW = 1_700_000_000_000;
  // BACKOFF[0] = 30_000ms (outbox.ts) — item chỉ "đến hạn" khi
  // now >= nextAt = firstAt + 30_000.
  const DUE_NOW = ENQUEUE_NOW + 30_000;

  it('url rỗng ⇒ không gọi mạng, hàng đợi nguyên vẹn (attempt/dropped_n không tăng)', () => {
    enqueue(JSON.stringify([payload()]), ENQUEUE_NOW);
    const before = readOutbox();
    expect(before.length).toBe(1);
    expect(before[0].attempt).toBe(1);

    const deps = baseDeps({ url: '', now: () => DUE_NOW });
    drainOutbox(deps);

    expect(deps.sendBeacon).not.toHaveBeenCalled();
    const after = readOutbox();
    expect(after.length).toBe(1);
    expect(after[0].attempt).toBe(1); // không tăng — không phải "gửi thất bại"
    expect(after[0].body).toBe(before[0].body);
    expect(after[0].nextAt).toBe(before[0].nextAt); // không đặt lại backoff
    // FR-019: dropped_n phải là 0 — đọc qua localStorage trực tiếp vì
    // readAndResetDroppedN() sẽ reset về 0 ngay cả khi đang là 0 sẵn, nên so
    // sánh giá trị thô lưu trữ là đủ và không làm nhiễu trạng thái test khác.
    expect(window.localStorage.getItem('mon_dropped_n')).toBeNull();
  });

  it('trần 2 gói mỗi lần xả: enqueue 3 item đến hạn, url hợp lệ ⇒ sendBeacon gọi đúng 2 lần', () => {
    enqueue(JSON.stringify([payload({ session_id: 'a' })]), ENQUEUE_NOW);
    enqueue(JSON.stringify([payload({ session_id: 'b' })]), ENQUEUE_NOW);
    enqueue(JSON.stringify([payload({ session_id: 'c' })]), ENQUEUE_NOW);
    expect(readOutbox().length).toBe(3);

    const deps = baseDeps({ now: () => DUE_NOW });
    drainOutbox(deps);

    expect(deps.sendBeacon).toHaveBeenCalledTimes(2);
    expect(readOutbox().length).toBe(1); // gói thứ 3 vẫn còn, chưa tới lượt
  });

  it('FR-016: send_attempt = attempt + 1 ghi vào body ĐÃ LỌC, không dựng lại payload', () => {
    const original = payload({ session_id: 'keep-me', send_attempt: 1 });
    // jsdom (jest 29) không hiện thực Blob.prototype.text() — bắt phần tử
    // mảng truyền vào `new Blob([toSend], …)` thay vì đọc lại qua Blob, vẫn
    // đọc đúng CHUỖI THẬT drainOutbox() đưa cho sendBeacon.
    let capturedBody = '';
    const deps = baseDeps({
      now: () => DUE_NOW,
      sendBeacon: vi.fn((_url: string, blob: Blob) => {
        capturedBody = (blob as unknown as { __parts?: string[] }).__parts
          ? ((blob as unknown as { __parts: string[] }).__parts[0] as string)
          : '';
        return true;
      }),
    });
    const OriginalBlob = global.Blob;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Blob = function (parts: string[], opts: unknown) {
      const b = new OriginalBlob(parts, opts as BlobPropertyBag);
      (b as unknown as { __parts: string[] }).__parts = parts;
      return b;
    };

    enqueue(JSON.stringify([original]), ENQUEUE_NOW);
    drainOutbox(deps);
    global.Blob = OriginalBlob;

    expect(deps.sendBeacon).toHaveBeenCalledTimes(1);
    const sentArr = JSON.parse(capturedBody);
    const sent = sentArr[0];
    expect(sent.send_attempt).toBe(2); // attempt(1) + 1
    const { send_attempt: _sentAttempt, ...restSent } = sent;
    const { send_attempt: _origAttempt, ...restOriginal } = original;
    expect(restSent).toEqual(restOriginal); // mọi trường khác giữ nguyên
  });
});

// ─── phase-2 (webview-session-logs §3.2) — dispatchChunks T029-T032 ─────────
// E013/E014/E015/E017 trên đường lô event (EventRow[] phẳng §0.8).
import {
  dispatchChunks,
  isDrainHalted,
  __resetTransportForTest,
} from '../transport';
import { BACKOFF, drain, MAX_ATTEMPT, readAndResetDroppedN } from '../outbox';
import { EventRow, SealedBatch } from '../types';
import { captureBlobParts, makeTwoChannelDeps } from './helpers';

const EVENTS_URL = 'https://obs-qrx.invalid/events';

function chunkRow(i: number): EventRow {
  return {
    record_type: 'event',
    session_id: '11111111-2222-4333-8444-555555555555',
    session_started_at: 1700000000000,
    t_offset: i,
    seq: i,
    type: 'api_call',
    route: '/voucher',
    sample_rate: 1,
    release_version: 'unknown',
    env_name: 'dev',
    device_model: 'SM-S911B',
    endpoint: '/api/pay',
    method: 'POST',
    status: 200,
  };
}

function oneBatch(): SealedBatch {
  const rows = [chunkRow(1)];
  return {
    schema: 'wv-events/1',
    chunk_seq: 1,
    first_seq: 1,
    last_seq: 1,
    event_count: 1,
    rows,
  };
}

function res(status: number, retryAfter?: string): Partial<Response> {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null,
    },
  } as Partial<Response>;
}

describe('dispatchChunks — T029/T030 (E014/E015)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetTransportForTest();
  });

  function chunkDeps(overrides: Partial<TransportDeps> = {}): TransportDeps {
    return baseDeps({
      url: EVENTS_URL,
      target: 'events',
      sendBeacon: vi.fn(() => false), // ép qua fetch fallback
      ...overrides,
    });
  }

  // T029 — 429 có Retry-After ⇒ ưu tiên thay BACKOFF[0].
  it('T029: 429 + Retry-After: 7 ⇒ enqueue attempt=1, nextAt = now + 7s', async () => {
    const deps = chunkDeps({
      fetchFn: vi.fn(() => Promise.resolve(res(429, '7') as Response)),
      now: () => 1000000,
    });
    dispatchChunks([oneBatch()], deps);
    await flushMicrotasks();
    const items = readOutbox();
    expect(items.length).toBe(1);
    expect(items[0].attempt).toBe(1);
    expect(items[0].nextAt).toBe(1000000 + 7000); // E014 ưu tiên Retry-After
    expect(items[0].target).toBe('events');
  });

  // T029 — 429 KHÔNG Retry-After ⇒ backoff mặc định 30s.
  it('T029: 429 không Retry-After ⇒ nextAt = now + BACKOFF[0] (30s)', async () => {
    const deps = chunkDeps({
      fetchFn: vi.fn(() => Promise.resolve(res(429) as Response)),
      now: () => 1000000,
    });
    dispatchChunks([oneBatch()], deps);
    await flushMicrotasks();
    const items = readOutbox();
    expect(items[0].nextAt).toBe(1000000 + BACKOFF[0]);
  });

  // T029 — thang backoff 30s/5m/30m, trần ≤3 lần (E014 policy).
  it('T029: ladder 30s/5m/30m — attempt 2,3 đặt nextAt đúng bậc, quá 3 bỏ', async () => {
    const deps = chunkDeps({
      fetchFn: vi.fn(() => Promise.resolve(res(429) as Response)),
      now: () => 0,
    });
    dispatchChunks([oneBatch()], deps); // enqueue attempt=1, nextAt=30s
    await flushMicrotasks();
    expect(readOutbox()[0].nextAt).toBe(BACKOFF[0]); // 30s
    // lần thử 1 thất bại ở t=30000 ⇒ attempt=2, nextAt=+5m
    const resend1 = vi.fn(() => false);
    drain(30000, resend1, 2, 'events');
    expect(readOutbox()[0].attempt).toBe(2);
    expect(readOutbox()[0].nextAt).toBe(30000 + BACKOFF[1]); // 5m
    // lần thử 2 thất bại ở t=330000 ⇒ attempt=3, nextAt=+30m
    drain(330000, resend1, 2, 'events');
    expect(readOutbox()[0].attempt).toBe(3);
    expect(readOutbox()[0].nextAt).toBe(330000 + BACKOFF[2]); // 30m
    // lần thử 3 (trần MAX_ATTEMPT) thất bại ⇒ bỏ hẳn, dropped_n tăng
    drain(330000 + BACKOFF[2], resend1, 2, 'events');
    expect(readOutbox().length).toBe(0);
    expect(readAndResetDroppedN()).toBe(1);
    void deps;
    void MAX_ATTEMPT;
  });

  // T030 — 5xx ⇒ E015 enqueue, fail-silent (user không thấy gì).
  it('T030: 500 ⇒ enqueue outbox, không throw (fail-silent)', async () => {
    const deps = chunkDeps({
      fetchFn: vi.fn(() => Promise.resolve(res(500) as Response)),
    });
    expect(() => dispatchChunks([oneBatch()], deps)).not.toThrow();
    await flushMicrotasks();
    expect(readOutbox().length).toBe(1);
  });
});

describe('dispatchChunks — T031 (E013 circuit breaker SEC-m6)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetTransportForTest();
  });

  function chunkDeps(overrides: Partial<TransportDeps> = {}): TransportDeps {
    return baseDeps({
      url: EVENTS_URL,
      target: 'events',
      sendBeacon: vi.fn(() => false),
      ...overrides,
    });
  }

  // T031 — 401/403 ⇒ nuốt + dropped_n, KHÔNG retry (không enqueue).
  it('T031: 401/403 ⇒ nuốt + dropped_n, KHÔNG enqueue', async () => {
    const deps = chunkDeps({
      fetchFn: vi.fn(() => Promise.resolve(res(401) as Response)),
    });
    dispatchChunks([oneBatch()], deps);
    await flushMicrotasks();
    expect(readOutbox().length).toBe(0); // không enqueue
    expect(readAndResetDroppedN()).toBe(1); // mất mát thành số (FR-019)
  });

  // T031 — 3 lần 401/403 liên tiếp ⇒ circuit breaker dừng drain phần còn lại.
  it('T031: 3 lần 401 liên tiếp ⇒ drainHalted — drainOutbox không tiêu item', async () => {
    const deps = chunkDeps({
      fetchFn: vi.fn(() => Promise.resolve(res(403) as Response)),
    });
    for (let i = 0; i < 3; i += 1) {
      dispatchChunks([oneBatch()], deps);
      await flushMicrotasks();
    }
    expect(readAndResetDroppedN()).toBe(3);
    // item due trong outbox (kênh events) — drain bị chặn, giữ chờ TTL
    window.localStorage.setItem(
      'mon_outbox',
      JSON.stringify([
        {
          body: '[]',
          target: 'events',
          attempt: 1,
          firstAt: 0,
          nextAt: 0,
        },
      ]),
    );
    const drainDeps = chunkDeps({
      sendBeacon: vi.fn(() => true),
      now: () => 1000000,
    });
    drainOutbox(drainDeps);
    expect(drainDeps.sendBeacon).not.toHaveBeenCalled(); // E013 — dừng drain
    expect(readOutbox().length).toBe(1); // item giữ nguyên
  });

  // T031 — gửi thành công resets chuỗi (không kẹt breaker vĩnh viễn).
  it('T031: 200 giữa chuỗi 401 ⇒ reset chuỗi, drain sống lại', async () => {
    const deps = chunkDeps({
      fetchFn: vi
        .fn()
        .mockResolvedValueOnce(res(401) as Response)
        .mockResolvedValueOnce(res(401) as Response)
        .mockResolvedValueOnce(res(200) as Response),
    });
    for (let i = 0; i < 3; i += 1) {
      dispatchChunks([oneBatch()], deps);
      await flushMicrotasks();
    }
    // chuỗi đã reset — 2 lần 401 kế tiếp chưa tới ngưỡng 3
    const deps2 = chunkDeps({
      fetchFn: vi.fn(() => Promise.resolve(res(401) as Response)),
    });
    dispatchChunks([oneBatch()], deps2);
    dispatchChunks([oneBatch()], deps2);
    await flushMicrotasks();
    window.localStorage.setItem(
      'mon_outbox',
      JSON.stringify([
        { body: '[]', target: 'events', attempt: 1, firstAt: 0, nextAt: 0 },
      ]),
    );
    const drainDeps = chunkDeps({
      sendBeacon: vi.fn(() => true),
      now: () => 1000000,
    });
    drainOutbox(drainDeps);
    expect(drainDeps.sendBeacon).toHaveBeenCalledTimes(1); // drain hoạt động
  });

  // ARC-m1 transport (post-impl r1) — breaker theo TỪNG target: 3× 401 trên
  // kênh 'events' (fetch fallback) ⇒ halt CHỈ events; kênh 'doc' (hai path ⇒
  // hai quyết định ACL/L0 độc lập ở HAProxy; 403 do sai ACL của path mới
  // không được kéo sập kênh doc) không bị kéo theo — drain doc vẫn gửi.
  // Trước đây 2 biến module dùng chung gây cross-channel coupling.
  it('T031b: 3× 401 kênh events ⇒ isDrainHalted(events); drain kênh doc vẫn gửi', async () => {
    const eventsDeps = chunkDeps({
      fetchFn: vi.fn(() => Promise.resolve(res(401) as Response)),
    });
    for (let i = 0; i < 3; i += 1) {
      dispatchChunks([oneBatch()], eventsDeps);
      await flushMicrotasks();
    }
    expect(isDrainHalted('events')).toBe(true);
    expect(isDrainHalted('doc')).toBe(false); // kênh kia không bị chặn

    // item doc due trong outbox — drain theo deps doc VẪN gửi bình thường
    window.localStorage.setItem(
      'mon_outbox',
      JSON.stringify([
        {
          body: JSON.stringify([{ DOC: true }]),
          target: 'doc',
          attempt: 1,
          firstAt: 0,
          nextAt: 0,
        },
      ]),
    );
    const docDeps = baseDeps({
      sendBeacon: vi.fn(() => true),
      now: () => 1000000,
    });
    drainOutbox(docDeps);
    expect(docDeps.sendBeacon).toHaveBeenCalledTimes(1); // doc vẫn drain
    expect(readOutbox().length).toBe(0); // item doc đã gửi xong
  });
});

describe('dispatchChunks — T032 (E017 fallback mid-session)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetTransportForTest();
  });

  // T032 — beacon false mid ⇒ fetch-keepalive ĐÚNG 1 lần rồi outbox.
  it('T032: sendBeacon false mid-session ⇒ fetch-keepalive 1 lần, fetch reject ⇒ outbox', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('net')));
    const deps = baseDeps({
      url: EVENTS_URL,
      target: 'events',
      sendBeacon: vi.fn(() => false),
      fetchFn: fetchMock,
    });
    dispatchChunks([oneBatch()], deps);
    expect(deps.sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // ĐÚNG 1 lần fallback
    expect((fetchMock.mock.calls[0] as any[])[1].keepalive).toBe(true);
    await flushMicrotasks();
    const items = readOutbox();
    expect(items.length).toBe(1);
    expect(items[0].target).toBe('events');
  });

  // T032 — beacon false + fetch OK ⇒ KHÔNG vào outbox (đã gửi).
  it('T032: beacon false + fetch ok ⇒ gửi xong, không outbox', async () => {
    const deps = baseDeps({
      url: EVENTS_URL,
      target: 'events',
      sendBeacon: vi.fn(() => false),
      fetchFn: vi.fn(() => Promise.resolve(res(200) as Response)),
    });
    dispatchChunks([oneBatch()], deps);
    await flushMicrotasks();
    expect(readOutbox().length).toBe(0);
  });
});

// ─── T065 (E013/FR-014) — cặp send_attempt qua đường DRAIN, hai kênh ─────────
// Test cũ 'FR-016: send_attempt = attempt + 1' (trên) chỉ chửa nửa vế doc;
// T065 khoá CẢ ĐÔI qua đúng đường resend của drainOutbox, deps lấy từ
// makeTwoChannelDeps (fixture dùng chung r3-PERF-m2 — tránh nhầm target/url).
describe('T065 — drain/resend: doc có send_attempt = n+1; lô event nguyên trạng', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetTransportForTest();
  });

  const NOW = 1_700_000_000_000;

  it('T065: drain item target doc (attempt 1) ⇒ body gửi có send_attempt === 2', () => {
    const original = payload({ session_id: 't065-doc', send_attempt: 1 });
    window.localStorage.setItem(
      'mon_outbox',
      JSON.stringify([
        {
          body: JSON.stringify([original]),
          target: 'doc',
          attempt: 1,
          firstAt: NOW - 1000, // còn hạn TTL, đã tới giờ thử lại
          nextAt: NOW - 1,
        },
      ]),
    );
    const { doc } = makeTwoChannelDeps();
    const capture = captureBlobParts();
    try {
      drainOutbox({ ...doc, now: () => NOW, sendBeacon: () => true });
      expect(capture.parts().length).toBe(1);
      const sent = JSON.parse(capture.parts()[0])[0];
      expect(sent.send_attempt).toBe(2); // attempt(1) + 1 — FR-016, KHÔNG build lại payload
    } finally {
      capture.restore();
    }
    expect(readOutbox().length).toBe(0); // gửi thành công ⇒ rời hàng đợi
  });

  it('T065: drain item target events ⇒ body gửi KHÔNG có send_attempt và không biến dạng', () => {
    const row = chunkRow(7);
    window.localStorage.setItem(
      'mon_outbox',
      JSON.stringify([
        {
          body: JSON.stringify([row]),
          target: 'events',
          attempt: 1,
          firstAt: NOW - 1000,
          nextAt: NOW - 1,
        },
      ]),
    );
    const { events } = makeTwoChannelDeps();
    const capture = captureBlobParts();
    try {
      drainOutbox({ ...events, now: () => NOW, sendBeacon: () => true });
      expect(capture.parts().length).toBe(1);
      const sent = JSON.parse(capture.parts()[0]);
      expect(Array.isArray(sent)).toBe(true);
      expect(sent[0]).toEqual(row); // không biến dạng — đã lọc từ nguồn (FR-016)
      expect('send_attempt' in sent[0]).toBe(false); // field này chỉ dành cho doc
      expect(sent[0].record_type).toBe('event'); // marker nguyên vẹn
    } finally {
      capture.restore();
    }
    expect(readOutbox().length).toBe(0);
  });
});

// ─── T068 (E013/R2-9) — breaker khoá theo TARGET, không theo url ─────────────
// Ca chưa test nào phủ: mọi ca cũ dùng deps KHÁC url nên pass cả với breaker
// khoá theo url. T068 ép hai kênh CHUNG MỘT url (makeTwoChannelDeps sameUrl)
// — 3× 401 ở events phải halt CHỈ events. Red-check đã chạy tay (không giữ
// trong mã): đổi khoá breakerOf sang url trong attemptFetchFallback ⇒ test
// này ĐỎ (isDrainHalted('events') === false vì khoá là chuỗi url); trả lại
// khoá target ⇒ xanh.
describe('T068 — hai kênh chung url: 3× 401 events ⇒ halt events, doc sống', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetTransportForTest();
  });

  it('T068: deps.url GIỐNG NHAU, 3× 401 target events ⇒ isDrainHalted(events)=true, isDrainHalted(doc)=false', async () => {
    const { events } = makeTwoChannelDeps({ sameUrl: true });
    const events401: TransportDeps = {
      ...events,
      sendBeacon: vi.fn(() => false), // ép qua fetch fallback — breaker chỉ quan sát 401/403 ở đây
      fetchFn: vi.fn(() => Promise.resolve(res(401) as Response)),
    };
    for (let i = 0; i < 3; i += 1) {
      dispatchChunks([oneBatch()], events401);
      await flushMicrotasks();
    }
    expect(isDrainHalted('events')).toBe(true);
    // hai kênh CHUNG url — nếu breaker khoá theo url thì kênh này cũng bị kéo
    expect(isDrainHalted('doc')).toBe(false);
  });
});
