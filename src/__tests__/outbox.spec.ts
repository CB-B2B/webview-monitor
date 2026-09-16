// §1.5 Outbox — T030-T038, E012 (+ phase-2: T027/E018, T033/E019, T070/§8.1 #13)
import {
  BACKOFF,
  drain,
  enqueue,
  enqueueBatch,
  MAX_ATTEMPT,
  MAX_ITEMS,
  OutboxItem,
  OutboxTarget,
  OUTBOX_KEY,
  pruneExpired,
  readAndResetDroppedN,
  readOutbox,
  TTL_MS,
  __resetOutboxForTest,
} from '../outbox';

beforeEach(() => {
  window.localStorage.clear();
});

describe('BVA — dung lượng hàng đợi (T030-T032)', () => {
  // T030
  it('19 gói: cả 19 còn nguyên', () => {
    for (let i = 0; i < 19; i += 1) enqueue(`body-${i}`, 1000 + i);
    expect(readOutbox().length).toBe(19);
  });

  // T031
  it('20 gói (trần): cả 20 còn nguyên', () => {
    for (let i = 0; i < 20; i += 1) enqueue(`body-${i}`, 1000 + i);
    expect(readOutbox().length).toBe(20);
  });

  // T032
  it('21 gói (trần+1): bỏ gói CŨ NHẤT (FIFO), còn 20', () => {
    for (let i = 0; i < 21; i += 1) enqueue(`body-${i}`, 1000 + i);
    const items = readOutbox();
    expect(items.length).toBe(20);
    expect(items.find(it => it.body === 'body-0')).toBeUndefined(); // cũ nhất bị bỏ
    expect(items.find(it => it.body === 'body-20')).toBeDefined();
  });
});

describe('BVA — số lần thử lại (T033-T035)', () => {
  function seedItem(attempt: number, now = 100_000) {
    window.localStorage.setItem(
      OUTBOX_KEY,
      JSON.stringify([{ body: 'x', attempt, firstAt: now, nextAt: now }]),
    );
  }

  // T033
  it('attempt=2: vẫn gửi lại', () => {
    seedItem(2);
    const resend = vi.fn(() => false);
    drain(100_000, resend);
    expect(resend).toHaveBeenCalledTimes(1);
  });

  // T034
  it('attempt=3 (trần): vẫn gửi lại — lần cuối', () => {
    seedItem(MAX_ATTEMPT);
    const resend = vi.fn(() => false);
    drain(100_000, resend);
    expect(resend).toHaveBeenCalledTimes(1);
    // sau khi thử và thất bại ở đúng trần ⇒ bỏ hẳn, không còn trong hàng đợi
    expect(readOutbox().length).toBe(0);
  });

  // T035
  it('attempt=4 (trần+1): bỏ hẳn không thử, dropped_n tăng 1', () => {
    seedItem(MAX_ATTEMPT + 1);
    const resend = vi.fn(() => false);
    drain(100_000, resend);
    expect(resend).not.toHaveBeenCalled();
    expect(readOutbox().length).toBe(0);
    expect(readAndResetDroppedN()).toBe(1);
  });
});

describe('BVA — TTL (T036-T038)', () => {
  function seedAged(ageMs: number) {
    const now = 10_000_000;
    window.localStorage.setItem(
      OUTBOX_KEY,
      JSON.stringify([
        { body: 'x', attempt: 1, firstAt: now - ageMs, nextAt: now - 1 },
      ]),
    );
    return now;
  }

  // T036
  it('tuổi 23h59m: vẫn gửi', () => {
    const now = seedAged(23 * 60 * 60 * 1000 + 59 * 60 * 1000);
    const resend = vi.fn(() => true);
    drain(now, resend);
    expect(resend).toHaveBeenCalledTimes(1);
  });

  // T037
  it('tuổi đúng 24h00m: vẫn gửi (biên đóng — > chứ không >=)', () => {
    const now = seedAged(TTL_MS);
    const resend = vi.fn(() => true);
    drain(now, resend);
    expect(resend).toHaveBeenCalledTimes(1);
  });

  // T038
  it('tuổi 24h01m: bỏ hẳn, dropped_n tăng', () => {
    const now = seedAged(TTL_MS + 60_000);
    const resend = vi.fn(() => true);
    drain(now, resend);
    expect(resend).not.toHaveBeenCalled();
    expect(readOutbox().length).toBe(0);
    expect(readAndResetDroppedN()).toBe(1);
  });
});

describe('Giãn cách backoff', () => {
  it('sau lần thất bại đầu (đã tới nextAt), tăng attempt và đặt nextAt kế theo backoff[1]', () => {
    enqueue('body', 0); // nextAt = BACKOFF[0]
    const resend = vi.fn(() => false);
    drain(BACKOFF[0], resend); // đã tới giờ thử lại lần 1
    const items = readOutbox();
    expect(resend).toHaveBeenCalledTimes(1);
    expect(items.length).toBe(1);
    expect(items[0].attempt).toBe(2);
    expect(items[0].nextAt).toBe(BACKOFF[0] + BACKOFF[1]);
  });

  it('chưa tới nextAt thì không thử lại', () => {
    enqueue('body', 0);
    const resend = vi.fn(() => true);
    drain(1000, resend); // nextAt = BACKOFF[0] = 30_000, chưa tới
    expect(resend).not.toHaveBeenCalled();
    expect(readOutbox().length).toBe(1);
  });
});

describe('Trần 2 gói/lần xả', () => {
  it('chỉ xử lý tối đa maxFlush item mỗi lần gọi drain', () => {
    for (let i = 0; i < 5; i += 1) enqueue(`b${i}`, 0);
    const resend = vi.fn(() => true);
    drain(1_000_000, resend, 2);
    expect(resend).toHaveBeenCalledTimes(2);
    expect(readOutbox().length).toBe(3);
  });
});

describe('E012 — localStorage không ghi được', () => {
  // phase-2 (E019): lần ghi thất bại đưa outbox vào chế độ in-memory sticky
  // cho hết đời module — phải hoàn về chế độ persist sau test để không rò
  // sang các describe khác (semantics các assertion cũ KHÔNG đổi).
  afterEach(() => {
    __resetOutboxForTest();
  });

  it('enqueue/drain không throw dù setItem ném lỗi', () => {
    const spy = vi
      .spyOn(window.localStorage.__proto__, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    expect(() => enqueue('body', 0)).not.toThrow();
    expect(() => drain(0, () => true)).not.toThrow();
    spy.mockRestore();
  });
});

// SEC-4/R3-N1 — dọn TTL thụ động, không mạng. TTL 24h trước đây chỉ được
// thực thi bên trong drain(); drain() không chạy khi monitor tắt ⇒ dữ liệu
// nằm lại vô thời hạn. pruneExpired() phải tự đứng được.
describe('pruneExpired — dọn TTL thụ động (SEC-4)', () => {
  it('item quá hạn 24h bị bỏ, dropped_n tăng đúng số lượng, item còn hạn giữ nguyên', () => {
    const now = 10_000_000_000; // dấu gạch dưới ổn trong test (transform riêng)
    enqueue('old-1', now - TTL_MS - 1); // quá hạn 1ms
    enqueue('old-2', now - TTL_MS - 1); // quá hạn
    enqueue('fresh', now - 1000); // còn hạn
    const removed = pruneExpired(now);
    expect(removed).toBe(2);
    expect(readOutbox().map(i => i.body)).toEqual(['fresh']);
    expect(readAndResetDroppedN()).toBe(2);
  });

  it('biên đóng: đúng 24h00m thì VẪN giữ (nhất quán với drain() — > chứ không >=)', () => {
    const now = 10_000_000_000;
    enqueue('edge', now - TTL_MS);
    expect(pruneExpired(now)).toBe(0);
    expect(readOutbox().length).toBe(1);
  });

  it('outbox rỗng ⇒ no-op, không ghi gì, dropped_n không tăng', () => {
    expect(pruneExpired(Date.now())).toBe(0);
    expect(readAndResetDroppedN()).toBe(0);
  });

  it('không đụng nextAt/attempt — thuần lọc TTL, không phải gửi thử', () => {
    const now = 10_000_000_000;
    enqueue('fresh', now - 1000);
    pruneExpired(now);
    const [item] = readOutbox();
    expect(item.attempt).toBe(1);
    expect(item.nextAt).toBe(now - 1000 + BACKOFF[0]);
  });
});

// ─── phase-2 (webview-session-logs §3.2) — T027/E018, T033/E019 ────────────
describe('T027 — OUTBOX_MAX_ITEMS theo LÔ (E018/FR-014)', () => {
  // T027 — lô 21 ⇒ FIFO drop cũ nhất + mất mát đếm vào mon_dropped_n.
  it('T027: 21 lô ⇒ bỏ lô cũ nhất, dropped_n tăng 1 (hiện số qua doc kế tiếp)', () => {
    for (let i = 0; i < 21; i += 1) enqueueBatch([`batch-${i}`], 1000 + i);
    const items = readOutbox();
    expect(items.length).toBe(20); // trần 20 lô giữ nguyên
    expect(items.find(it => it.body === 'batch-0')).toBeUndefined();
    expect(items.find(it => it.body === 'batch-20')).toBeDefined();
    expect(readAndResetDroppedN()).toBe(1); // E018 — mất mát thành số
  });

  // T027 — 20 lô (trần): giữ đủ, dropped_n không tăng.
  it('T027: 20 lô (trần) ⇒ giữ đủ 20, dropped_n = 0', () => {
    for (let i = 0; i < 20; i += 1) enqueueBatch([`batch-${i}`], 1000 + i);
    expect(readOutbox().length).toBe(20);
    expect(readAndResetDroppedN()).toBe(0);
  });

  // T027 — enqueueBatch gom nhiều lô một lần cũng FIFO đúng (PERF-M4).
  it('T027: enqueueBatch 5 lô khi đã 17 ⇒ giữ 20, bỏ 2 cũ nhất, dropped_n = 2', () => {
    for (let i = 0; i < 17; i += 1) enqueueBatch([`old-${i}`], 1000 + i);
    enqueueBatch(['r1', 'r2', 'r3', 'r4', 'r5'], 2000);
    const items = readOutbox();
    expect(items.length).toBe(20);
    expect(items.find(it => it.body === 'old-0')).toBeUndefined();
    expect(items.find(it => it.body === 'old-1')).toBeUndefined();
    expect(items.find(it => it.body === 'old-2')).toBeDefined();
    expect(readAndResetDroppedN()).toBe(2);
  });

  // PERF-m1 (post-impl r1) — FIFO drop gom MỘT incrementDroppedN: tràn 3
  // item trong MỘT enqueueBatch ⇒ giá trị mon_dropped_n vẫn đúng 3 nhưng
  // chỉ MỘT chu kỳ get+set (trước đây gọi increment trong vòng lặp).
  it('T027b: enqueueBatch tràn 3 ⇒ dropped_n = 3, đúng 1 lần setItem(mon_dropped_n)', () => {
    for (let i = 0; i < 18; i += 1) enqueueBatch([`old-${i}`], 1000 + i);
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    try {
      enqueueBatch(['r1', 'r2', 'r3', 'r4', 'r5'], 2000); // 18+5 = 23 ⇒ bỏ 3
      expect(readOutbox().length).toBe(20);
      const dropWrites = setItemSpy.mock.calls.filter(
        c => c[0] === 'mon_dropped_n' && c[1] !== '0',
      );
      expect(dropWrites.length).toBe(1); // MỘT chu kỳ get+set (PERF-m1)
      expect(dropWrites[0][1]).toBe('3'); // gom đúng 3 vào 1 lần tăng
      expect(readAndResetDroppedN()).toBe(3); // giá trị không đổi ngữ nghĩa
    } finally {
      setItemSpy.mockRestore();
    }
  });
});

describe('T033 — E019: QuotaExceededError ⇒ thoái hoá in-memory (PERF-m3)', () => {
  afterEach(() => {
    __resetOutboxForTest();
  });

  it('T033: persist fail ⇒ nuốt, outbox thoái hoá in-memory giữ MAX_ITEMS=20/FIFO, capture tiếp tục', () => {
    const spy = vi
      .spyOn(window.localStorage.__proto__, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    try {
      // 25 lô vào outbox không-throw — trần 20 FIFO như chế độ persist
      expect(() => {
        for (let i = 0; i < 25; i += 1) enqueueBatch([`m-${i}`], 1000 + i);
      }).not.toThrow(); // E019 — không throw ra app
      const items = readOutbox();
      expect(items.length).toBe(20); // trần MAX_ITEMS giữ nguyên
      expect(items.find(it => it.body === 'm-0')).toBeUndefined(); // FIFO
      expect(items.find(it => it.body === 'm-24')).toBeDefined();
      expect(readAndResetDroppedN()).toBe(5); // mất mát vẫn hiện số

      // capture tiếp tục: enqueue thêm vẫn vào hàng đợi in-memory
      expect(() => enqueueBatch(['m-25'], 9000)).not.toThrow();
      expect(readOutbox().length).toBe(20);

      // drain vẫn gửi được từ in-memory (TTL/FIFO theo cùng logic) — gọi
      // sau nextAt (firstAt + BACKOFF[0]) của mọi item
      const resend = vi.fn(() => true);
      drain(100_000, resend, 2, 'events');
      expect(resend).toHaveBeenCalledTimes(2);
      expect(readOutbox().length).toBe(18);
    } finally {
      spy.mockRestore();
      __resetOutboxForTest();
    }
  });

  it('T033: chế độ suy biến vẫn thực thi TTL (pruneExpired trên in-memory)', () => {
    const spy = vi
      .spyOn(window.localStorage.__proto__, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    try {
      const now = 10_000_000_000;
      enqueueBatch(['stale'], now - TTL_MS - 1, 'events');
      enqueueBatch(['fresh'], now - 1000, 'events');
      const removed = pruneExpired(now);
      expect(removed).toBe(1); // TTL vẫn dọn trong chế độ in-memory
      expect(readOutbox().map(i => i.body)).toEqual(['fresh']);
    } finally {
      spy.mockRestore();
      __resetOutboxForTest();
    }
  });
});

// ─── T070 (§8.1 #13) — hạn ngạch trục xuất theo target ───────────────────────
// R2-9/E018/FR-019: outbox là MỘT khoá dùng chung cho hai kênh, nhưng khi tràn
// phải bỏ lô cũ nhất CÙNG TARGET với lô vừa enqueue (xét trên phần có TRƯỚC lô
// đó — oldEnd, r5-PERF-N1), chỉ rơi về FIFO toàn cục trên phần cũ khi hết item
// cùng target. Mọi item seed mang body đánh số để assert item NÀO bị bỏ, không
// chỉ đếm (r5-ARC-N4 — đếm suông thì findIndex lẫn findLastIndex đều xanh).
describe('T070 — hạn ngạch trục xuất theo target (§8.1 #13, 9 ca)', () => {
  beforeEach(() => {
    __resetOutboxForTest(); // chắc chắn chế độ persist, không dính memOutbox test khác
  });

  /** Seed thẳng vào localStorage — outbox là MỘT khoá dùng chung. */
  function seedRaw(items: Partial<OutboxItem>[]): void {
    window.localStorage.setItem(
      OUTBOX_KEY,
      JSON.stringify(
        items.map(it => ({
          body: it.body ?? 'x',
          attempt: it.attempt ?? 1,
          firstAt: it.firstAt ?? 1000,
          nextAt: it.nextAt ?? 2000,
          // Item legacy phase-1 phải THIẾU HẲN key target trong JSON — không
          // phải `target: undefined` (T070 h1/h2).
          ...(it.target !== undefined ? { target: it.target } : {}),
        })),
      ),
    );
  }

  function docItems(prefix: string, n: number): Partial<OutboxItem>[] {
    return Array.from({ length: n }, (_, i): Partial<OutboxItem> => ({
      body: `${prefix}${i + 1}`,
      target: 'doc' as OutboxTarget,
    }));
  }

  function eventItems(prefix: string, n: number): Partial<OutboxItem>[] {
    return Array.from({ length: n }, (_, i): Partial<OutboxItem> => ({
      body: `${prefix}${i + 1}`,
      target: 'events' as OutboxTarget,
    }));
  }

  function batchBodies(prefix: string, n: number): string[] {
    return Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
  }

  /**
   * Ghi vết THỨ TỰ trục xuất trong MỘT lời gọi enqueueBatch đồng bộ: bọc cả
   * shift() lẫn splice() trên mảng item có dạng OutboxItem (lọc nhiễu từ nội
   * bộ jsdom). Bọc cả hai cơ chế để vết ghi phản ánh NẠN NHÂN chứ không phải
   * cú pháp mã — bản FIFO cũ (shift) và bản hạn ngạch mới (splice) đều để lại
   * vết, khác nhau ở THỨ TỰ/TẬP nạn nhân (r6: ca (f) chỉ phân biệt được qua
   * thứ tự).
   */
  function traceEvictions(run: () => void): string[] {
    const victims: string[] = [];
    const looksLikeItem = (v: unknown): v is OutboxItem =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as OutboxItem).body === 'string' &&
      typeof (v as OutboxItem).attempt === 'number';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = Array.prototype as any;
    const origShift = proto.shift;
    const origSplice = proto.splice;
    proto.shift = function (this: unknown[]): unknown {
      if (looksLikeItem(this[0])) victims.push(this[0].body);
      return origShift.apply(this);
    };
    proto.splice = function (
      this: unknown[],
      start: number,
      deleteCount?: number,
    ): unknown {
      const n = Math.max(
        0,
        Math.min(deleteCount ?? this.length - start, this.length - start),
      );
      for (let k = 0; k < n; k += 1) {
        const v = this[start + k];
        if (looksLikeItem(v)) victims.push(v.body);
      }
      return deleteCount === undefined
        ? origSplice.call(this, start)
        : origSplice.call(this, start, deleteCount);
    };
    try {
      run();
    } finally {
      proto.shift = origShift;
      proto.splice = origSplice;
    }
    return victims;
  }

  // Spy số lần tăng mon_dropped_n — lọc giá trị '0' của readAndResetDroppedN.
  function spyDroppedWrites() {
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    return {
      dropWrites(): Array<[string, string]> {
        return spy.mock.calls.filter(
          c => c[0] === 'mon_dropped_n' && c[1] !== '0',
        ) as Array<[string, string]>;
      },
      restore(): void {
        spy.mockRestore();
      },
    };
  }

  const hasBody = (body: string): boolean =>
    readOutbox().some(it => it.body === body);

  // (a) chiều flood trong ngưỡng cung ứng: M=15 ≤ nguồn cung events cũ (18).
  it('T070: (a) 2 doc + 18 events, MỘT enqueueBatch 15 lô events ⇒ d1,d2 còn nguyên, bỏ e1..e15 theo thứ tự, dropped_n +15', () => {
    seedRaw([...docItems('d', 2), ...eventItems('e', 18)]);
    const victims = traceEvictions(() =>
      enqueueBatch(batchBodies('n', 15), 5000, 'events'),
    );
    expect(readOutbox().length).toBe(MAX_ITEMS); // 20
    expect(hasBody('d1')).toBe(true); // kênh khoẻ không bị kênh kẹt bóp chết
    expect(hasBody('d2')).toBe(true);
    // định danh: events sống sót là MỚI NHẤT — e16..e18 + 15 lô vừa enqueue
    expect(hasBody('e16')).toBe(true);
    expect(hasBody('e17')).toBe(true);
    expect(hasBody('e18')).toBe(true);
    for (let i = 1; i <= 15; i += 1) expect(hasBody(`e${i}`)).toBe(false);
    // e1 là nạn nhân ĐẦU TIÊN (findIndex, không phải findLastIndex — r5-ARC-N4)
    expect(victims).toEqual(batchBodies('e', 15));
    expect(readAndResetDroppedN()).toBe(15); // E018 — mất mát hiện số
  });

  // (b) nhánh fallback TỚI ĐƯỢC: phần cũ hết item cùng target ⇒ bỏ item cũ
  // nhất toàn cục; lô vừa enqueue KHÔNG tự ăn chính nó (oldEnd, r5-PERF-N1).
  it('T070: (b) đầy 20 events không doc; enqueueBatch 1 lô doc ⇒ bỏ e1, lô doc CÒN, dropped_n +1', () => {
    seedRaw(eventItems('e', 20));
    const victims = traceEvictions(() => enqueueBatch(['d-new'], 5000, 'doc'));
    expect(victims).toEqual(['e1']); // fallback i=0 — events cũ nhất
    expect(hasBody('e1')).toBe(false);
    expect(hasBody('d-new')).toBe(true); // bản không oldEnd sẽ tự xoá lô doc này
    expect(readAndResetDroppedN()).toBe(1);
  });

  // (c) chiều đối xứng — fixture ĐỐI XỨNG với (a): kênh kia (events) nằm ở
  // PHẦN CŨ NHẤT và phải sống sót; nguồn cung doc cũ (18) ≥ M (15).
  it('T070: (c) 2 events cũ nhất + 18 doc; MỘT enqueueBatch 15 lô doc ⇒ e1,e2 còn nguyên, bỏ d1..d15 theo thứ tự, dropped_n +15', () => {
    seedRaw([...eventItems('e', 2), ...docItems('d', 18)]);
    const victims = traceEvictions(() =>
      enqueueBatch(batchBodies('n', 15), 5000, 'doc'),
    );
    expect(readOutbox().length).toBe(MAX_ITEMS);
    expect(hasBody('e1')).toBe(true); // chặn ai viết ngược chiều so sánh target
    expect(hasBody('e2')).toBe(true);
    for (let i = 1; i <= 15; i += 1) expect(hasBody(`d${i}`)).toBe(false);
    expect(hasBody('d16')).toBe(true);
    expect(victims).toEqual(batchBodies('d', 15)); // d1..d15 theo thứ tự
    expect(readAndResetDroppedN()).toBe(15);
  });

  // (d) kế toán (r4-PERF-N1): MỘT incrementDroppedN với TỔNG — idiom
  // accumulator; gọi trong vòng lặp là N chu kỳ localStorage lúc pagehide.
  it('T070: (d) đúng ca (a): incrementDroppedN gọi ĐÚNG 1 lần, giá trị tăng 15', () => {
    seedRaw([...docItems('d', 2), ...eventItems('e', 18)]);
    const spy = spyDroppedWrites();
    try {
      enqueueBatch(batchBodies('n', 15), 5000, 'events');
      expect(spy.dropWrites().length).toBe(1); // MỘT chu kỳ get+set
      expect(spy.dropWrites()[0][1]).toBe('15');
    } finally {
      spy.restore();
    }
    expect(readAndResetDroppedN()).toBe(15);
  });

  // (e) suy biến cuối (oldEnd === 0): outbox rỗng + 25 lô trong MỘT lời gọi
  // ⇒ phần cũ cạn, lô mới tự cắt phần cũ nhất của chính nó.
  it('T070: (e) outbox rỗng + MỘT enqueueBatch 25 lô events ⇒ giữ 20 mới nhất, dropped_n +5', () => {
    const victims = traceEvictions(() =>
      enqueueBatch(batchBodies('n', 25), 5000, 'events'),
    );
    expect(readOutbox().map(it => it.body)).toEqual(
      batchBodies('n', 25).slice(5),
    );
    expect(victims).toEqual(batchBodies('n', 5)); // n1..n5 — cũ nhất của lô mới
    expect(readAndResetDroppedN()).toBe(5);
  });

  // (f) chế độ CẠN GIỦA CHỪNG (M=25 > nguồn cung 18): ghim đủ ba tầng ưu tiên
  // cũ-cùng-target → cũ-khác-target (fallback) → mới (suy biến), THEO THỨ TỰ.
  it('T070: (f) 2 doc + 18 events, MỘT enqueueBatch 25 lô events ⇒ trục xuất e1..e18 → d1,d2 → n1..n5; sống sót 20 mới nhất; +25; vẫn 1 increment', () => {
    seedRaw([...docItems('d', 2), ...eventItems('e', 18)]);
    const spy = spyDroppedWrites();
    let victims: string[] = [];
    let dropValues: string[] = [];
    try {
      victims = traceEvictions(() =>
        enqueueBatch(batchBodies('n', 25), 5000, 'events'),
      );
      // chốt giá trị TRƯỚC khi restore — mockRestore xoá sạch mock.calls
      dropValues = spy.dropWrites().map(c => c[1]);
    } finally {
      spy.restore();
    }
    expect(victims).toEqual([
      ...batchBodies('e', 18), // hết cung cùng-target-cũ
      'd1', // fallback i=0: item cũ nhất còn lại, kể cả khác target
      'd2',
      ...batchBodies('n', 5), // suy biến oldEnd === 0
    ]);
    expect(readOutbox().map(it => it.body)).toEqual(
      batchBodies('n', 25).slice(5),
    );
    expect(readAndResetDroppedN()).toBe(25);
    expect(dropValues.length).toBe(1); // vẫn MỘT lần gọi (PERF-m1)
    expect(dropValues[0]).toBe('25');
  });

  // (g) HAI lời gọi trong MỘT pagehide (hình thái E017): kế toán per-invocation
  // + biên oldEnd ở lời gọi thứ hai — 3 lô doc của lời 1 nay thuộc PHẦN CŨ.
  // LƯU Ý (MINOR-2 r11): ca này KHÔNG phân biệt thuật toán target-quota với
  // FIFO toàn cục cũ — cả hai cho cùng nạn nhân (e4..e6); nó khoá ranh giới
  // kế toán per-invocation, không phải tính chọn-lọc-theo-target.
  it('T070: (g) 20 events; enqueueBatch(3 doc) RỒI enqueueBatch(3 events) ⇒ 2 lần tăng (+3, +3); lời 2 bỏ e4..e6, không đụng 3 lô doc', () => {
    seedRaw(eventItems('e', 20));
    const spy = spyDroppedWrites();
    let v1: string[] = [];
    let v2: string[] = [];
    let dropValues: string[] = [];
    try {
      v1 = traceEvictions(() => enqueueBatch(['D1', 'D2', 'D3'], 5000, 'doc'));
      v2 = traceEvictions(() =>
        enqueueBatch(['E1', 'E2', 'E3'], 5000, 'events'),
      );
      // chốt giá trị TRƯỚC khi restore — mockRestore xoá sạch mock.calls
      dropValues = spy.dropWrites().map(c => c[1]);
    } finally {
      spy.restore();
    }
    expect(v1).toEqual(['e1', 'e2', 'e3']); // lời 1: fallback — phần cũ không có doc
    expect(v2).toEqual(['e4', 'e5', 'e6']); // lời 2: hạn ngạch events, doc an toàn
    expect(['D1', 'D2', 'D3'].every(hasBody)).toBe(true); // không bị đụng
    expect(['E1', 'E2', 'E3'].every(hasBody)).toBe(true);
    expect(readOutbox().length).toBe(MAX_ITEMS);
    // đúng 2 lời gọi incrementDroppedN, đối số 3 và 3 (giá trị cộng dồn '3' → '6')
    expect(dropValues).toEqual(['3', '6']);
    expect(readAndResetDroppedN()).toBe(6);
  });

  // (h1) legacy phase-1 THIẾU key target, nằm CUỐI phần cũ: coercion `?? 'doc'`
  // khớp hạn ngạch doc ⇒ nạn nhân là L1,L2 — `it.target` trần sẽ bỏ e1,e2 (ĐỎ).
  it('T070: (h1) 18 events rồi L1,L2 legacy (thiếu key target); enqueueBatch(2 doc) ⇒ nạn nhân L1,L2, e1..e18 nguyên vẹn, +2, 1 increment', () => {
    seedRaw([
      ...eventItems('e', 18),
      { body: 'L1' }, // legacy phase-1 — không có key target trong JSON
      { body: 'L2' },
    ]);
    const spy = spyDroppedWrites();
    let victims: string[] = [];
    let dropValues: string[] = [];
    try {
      victims = traceEvictions(() => enqueueBatch(['n1', 'n2'], 5000, 'doc'));
      // chốt giá trị TRƯỚC khi restore — mockRestore xoá sạch mock.calls
      dropValues = spy.dropWrites().map(c => c[1]);
    } finally {
      spy.restore();
    }
    expect(victims).toEqual(['L1', 'L2']);
    for (let i = 1; i <= 18; i += 1) expect(hasBody(`e${i}`)).toBe(true);
    expect(readAndResetDroppedN()).toBe(2);
    expect(dropValues.length).toBe(1);
    expect(dropValues[0]).toBe('2');
  });

  // (h2) legacy coerce theo 'doc' (KHÔNG theo target của lời gọi): phần cũ
  // không có item 'events' ⇒ fallback bỏ d1,d2; L1,L2 sống sót. Typo
  // `?? target` sẽ coerce L1,L2 thành 'events' và đốt legacy-doc trước (ĐỎ).
  // LƯU Ý (MINOR-2 r11): với FIFO toàn cục cũ nạn nhân cũng là d1,d2 ⇒ ca này
  // KHÔNG phân biệt target-quota với FIFO; nó khoá HƯỚNG coerce legacy
  // (`?? 'doc'`), không phải tính chọn-lọc-theo-target.
  it('T070: (h2) 18 doc rồi L1,L2 legacy; enqueueBatch(2 events) ⇒ fallback bỏ d1,d2, L1,L2 còn nguyên, dropped_n +2', () => {
    seedRaw([...docItems('d', 18), { body: 'L1' }, { body: 'L2' }]);
    const victims = traceEvictions(() =>
      enqueueBatch(['n1', 'n2'], 5000, 'events'),
    );
    expect(victims).toEqual(['d1', 'd2']);
    expect(hasBody('L1')).toBe(true);
    expect(hasBody('L2')).toBe(true);
    expect(readAndResetDroppedN()).toBe(2);
  });
});
