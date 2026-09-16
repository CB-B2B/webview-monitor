// chunker.spec.ts — phase-2 (webview-session-logs §2.4c/§2.4e)
// T020, T021, T022, T028, T037, T052, T059 (+ T028b cross-drain bổ sung sau
// impl): seal lô ≤32KB THEO BYTE, flush 32|30s|hidden|pagehide, ≤2 beacon
// pagehide + enqueueBatch 1 lần ghi, E023 re-entrant, E018/E016 counters.

import fc from 'fast-check';
import type { Mock } from 'vitest';
import {
  allBeaconBodies,
  beaconUrls,
  installNavigationTiming,
  installOnLine,
  installRandomUUID,
  installSendBeacon,
  loadMonitorSandbox,
  MonitorSandbox,
} from './testUtils';
import type { EventRow } from '../types';

const EVENTS_URL = 'https://obs-qrx.invalid/events';

let seq = 0;
function makeRow(
  opts: { messageLen?: number; type?: string; ascii?: boolean } = {},
): EventRow {
  seq += 1;
  const row: EventRow = {
    record_type: 'event',
    session_id: '11111111-2222-4333-8444-555555555555',
    session_started_at: 1700000000000,
    t_offset: seq,
    seq,
    type: (opts.type || 'api_call') as EventRow['type'],
    route: '/withdraw/confirm',
    sample_rate: 1,
    release_version: 'unknown',
    env_name: 'dev',
    device_model: 'SM-S911B',
    endpoint: '/api/withdraw/confirm',
    method: 'POST',
    status: 200,
  };
  if (opts.messageLen !== undefined) {
    // Row "thật theo schema": message tiếng Việt UTF-8 (T020) hoặc ASCII
    // pseudo-token dài để chạm ngân sách byte của lô với kích thước đo được.
    const unit = opts.ascii ? 'X' : 'Giao dịch thành công vui lòng ';
    row.message =
      opts.messageLen === 0
        ? undefined
        : unit
            .repeat(Math.ceil(opts.messageLen / unit.length))
            .slice(0, opts.messageLen);
  }
  return row;
}

function bytes(s: string): number {
  // Cùng xấp xỉ fallback của transport.ts khi thiếu TextEncoder
  try {
    if (typeof TextEncoder !== 'undefined')
      return new TextEncoder().encode(s).length;
  } catch {
    /* fallthrough */
  }
  return unescape(encodeURIComponent(s)).length;
}

async function sentRows(mock: Mock): Promise<any[][]> {
  const bodies = await allBeaconBodies(mock);
  return bodies.map(b => JSON.parse(b));
}

describe('chunker — seal/flush (T020-T022, T028, T037, T059)', () => {
  let sb: MonitorSandbox;
  let beacon: Mock;

  beforeEach(async () => {
    window.localStorage.clear();
    seq = 0;
    installNavigationTiming(0);
    installRandomUUID(true);
    installOnLine(true);
    beacon = installSendBeacon(true);
    sb = await loadMonitorSandbox({ eventsUrl: EVENTS_URL });
    sb.chunker.arm();
  });

  afterEach(() => {
    sb.index.__resetMonitorForTest();
  });

  // T020 (FR-014/PERF-m5) — row thật theo schema, buffer 40 event: mọi lô
  // ≤32768 bytes THEO BYTE, row không cắt đôi, union = buffer.
  it('T020: 40 event row thật ⇒ mọi lô ≤32768 byte, không row cắt đôi, union đủ 40', async () => {
    const rows: EventRow[] = [];
    for (let i = 0; i < 40; i += 1) rows.push(makeRow({ messageLen: 100 }));
    rows.forEach(r => sb.chunker.pushEvent(r)); // tự flush('count') tại 32
    sb.chunker.flush('timer'); // phần còn lại (8 row)
    const batches = await sentRows(beacon);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    const all = batches.flat();
    expect(all.length).toBe(40); // không mất, không nhân bản
    expect(all.map((r: any) => r.seq)).toEqual(rows.map(r => r.seq)); // đúng thứ tự
    for (const batch of batches) {
      expect(bytes(JSON.stringify(batch))).toBeLessThanOrEqual(32768);
    }
    // row không cắt đôi: mỗi row lên dây NGUYÊN VẸN (so message đầy đủ)
    all.forEach((r: any, i: number) => {
      expect(r.message).toBe(rows[i].message);
    });
  });

  // T020 — mật độ: FLUSH_EVENT_COUNT=32 chốt số row/lô TRƯỚC khi byte kịp
  // đầy — row thường ~460B ⇒ lô đầy đúng 32 row (~15KB ≤ 32KB). (Ghi chú
  // plan-gap: kỳ vọng "~90±10 row/lô" của plan không tới được qua cổng 32
  // event/flush — xem báo cáo cuối.)
  it('T020: row thường ~460B ⇒ lô đầy đúng 32 row, ≤32768 byte', async () => {
    const rows: EventRow[] = [];
    for (let i = 0; i < 96; i += 1) rows.push(makeRow({ messageLen: 100 }));
    rows.forEach(r => sb.chunker.pushEvent(r));
    const batches = await sentRows(beacon);
    expect(batches.length).toBe(3); // 96 = 3 count-flush
    batches.forEach(b => {
      expect(b.length).toBe(32); // lô đầy đúng ngưỡng đếm
      expect(bytes(JSON.stringify(b))).toBeLessThanOrEqual(32768);
    });
  });

  // T020 — row mập (~1.2KB/row — fixture phòng thủ: message thật đã cắt 512
  // ở nguồn, E016/E007 defense-in-depth): 32 row VƯỢT 32KB ⇒ byte seal TÁCH
  // lô ngay trong một count-flush (không cắt đôi row).
  it('T020: row ~1.2KB × 32 ⇒ byte seal tách 2 lô trong 1 flush', async () => {
    const rows: EventRow[] = [];
    for (let i = 0; i < 32; i += 1) rows.push(makeRow({ messageLen: 700 }));
    rows.forEach(r => sb.chunker.pushEvent(r)); // count-flush tại 32
    const batches = await sentRows(beacon);
    expect(batches.length).toBe(2); // 32 × ~1.17KB ≈ 37KB > 32KB
    batches.forEach(b => {
      expect(bytes(JSON.stringify(b))).toBeLessThanOrEqual(32768);
      expect(b.length).toBeGreaterThan(0);
    });
    expect(batches.flat().length).toBe(32);
  });

  // T020 — greedy: 31 row (dưới ngưỡng count-flush ⇒ MỘT flush duy nhất):
  // mọi lô trừ lô cuối phải ch kín ngân sách byte (đóng gói tham).
  it('T020: seal greedy theo byte — một flush, mọi lô trừ cuối ch kín ngân sách', async () => {
    const rows: EventRow[] = [];
    for (let i = 0; i < 31; i += 1) rows.push(makeRow({ messageLen: 2000 }));
    rows.forEach(r => sb.chunker.pushEvent(r));
    sb.chunker.flush('timer');
    const batches = await sentRows(beacon);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < batches.length - 1; i += 1) {
      const bodyBytes = bytes(JSON.stringify(batches[i]));
      const nextRowBytes = bytes(JSON.stringify(batches[i + 1][0])) + 1;
      expect(bodyBytes).toBeLessThanOrEqual(32768);
      expect(bodyBytes + nextRowBytes).toBeGreaterThan(32768 - 250);
    }
    expect(
      bytes(JSON.stringify(batches[batches.length - 1])),
    ).toBeLessThanOrEqual(32768);
    expect(batches.flat().length).toBe(31);
  });

  // T021 (E016) — row đơn lẻ >32KB ⇒ bỏ đúng row, đếm overflow, lô + row khác
  // vẫn đi (KHÔNG bỏ cả chunk).
  it('T021: row >32KB ⇒ E016 bỏ đúng row + đếm, row khác vẫn đi', async () => {
    const small1 = makeRow({ messageLen: 50 });
    const huge = makeRow({ messageLen: 40000 }); // > 32768 sau mọi cắt tại nguồn
    const small2 = makeRow({ messageLen: 50 });
    sb.chunker.pushEvent(small1);
    sb.chunker.pushEvent(huge);
    sb.chunker.pushEvent(small2);
    sb.chunker.flush('timer');
    const batches = await sentRows(beacon);
    const all = batches.flat();
    expect(all.map((r: any) => r.seq)).toEqual([small1.seq, small2.seq]);
    // CR-m1 post-impl r1 — getDroppedRows() đổi thành getDroppedByKind():
    // row api_call KHÔNG err_kind là row MẪU ⇒ bucket sampled (E016).
    expect(sb.chunker.getDroppedByKind()).toEqual({ error: 0, sampled: 1 });
    expect(batches.length).toBeGreaterThan(0); // chunk khác vẫn đi
  });

  // CR-m1 (post-impl r1, E016) — row >32KB bị bỏ đếm THEO LOẠI ROW: row lỗi
  // (api_call err_kind / business_error / js_error) ⇒ bucket error ⇒
  // error_events_overflow của session_end; row mẫu ⇒ bucket sampled ⇒
  // events_overflow (trước đây một counter chung, attribution sai loại).
  it('CR-m1: row lỗi >32KB ⇒ bucket error; row mẫu >32KB ⇒ bucket sampled', () => {
    const errRow = makeRow({ messageLen: 40000, type: 'api_call' });
    errRow.err_kind = 'http'; // row lỗi theo nghĩa E016
    const sampledRow = makeRow({ messageLen: 40000, type: 'route_view' });
    sb.chunker.pushEvent(errRow);
    sb.chunker.pushEvent(sampledRow);
    sb.chunker.flush('timer');
    expect(sb.chunker.getDroppedByKind()).toEqual({ error: 1, sampled: 1 });
    // 2 row bị bỏ ⇒ không beacon nào (không row hợp lệ còn lại trong lô)
    expect(beacon).not.toHaveBeenCalled();
  });

  // CR-m1 — row bị drop trong CHÍNH lần flush pagehide cuối (sau khi
  // session_end row đã seal) ⇒ cộng mon_dropped_n — hiện số qua doc phiên
  // kế tiếp (E016; trước đây mất im lặng).
  it('CR-m1: row >32KB drop trong flush pagehide cuối ⇒ mon_dropped_n tăng', () => {
    const errRow = makeRow({ messageLen: 40000, type: 'js_error' });
    sb.chunker.pushEvent(errRow);
    sb.chunker.flush('pagehide');
    expect(sb.chunker.getDroppedByKind()).toEqual({ error: 1, sampled: 0 });
    expect(Number(window.localStorage.getItem('mon_dropped_n'))).toBe(1);
  });

  // CR-n1 (post-impl r1) — pagehide flush với buffer RỖNG vẫn phải terminal:
  // trước đây `terminal = true` nằm trong `if (rows.length > 0)` nên chunker
  // còn "sống" sau khi trang đã chết (nhận pushEvent, cài lại timer được).
  it('CR-n1: pagehide flush rỗng ⇒ terminal — pushEvent sau đó bị chặn', () => {
    sb.chunker.flush('pagehide');
    expect(beacon).not.toHaveBeenCalled();
    sb.chunker.pushEvent(makeRow()); // terminal ⇒ không nhận
    sb.chunker.flush('timer');
    expect(beacon).not.toHaveBeenCalled(); // không row nào rời khỏi trang
  });

  // T022 (FR-014) — BVA flush theo số: 31 KHÔNG flush.
  it('T022: buffer 31 event ⇒ CHƯA flush (không beacon)', () => {
    for (let i = 0; i < 31; i += 1) sb.chunker.pushEvent(makeRow());
    expect(beacon).not.toHaveBeenCalled();
  });

  // T022 — 32 flush.
  it('T022: buffer đủ 32 event ⇒ flush ngay (beacon gọi)', () => {
    for (let i = 0; i < 32; i += 1) sb.chunker.pushEvent(makeRow());
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beaconUrls(beacon)).toEqual([EVENTS_URL]);
  });

  // T028 (FR-014/E017/PERF-M4) — pagehide với ≥5 lô sẵn (row mập ~5KB, vẫn
  // dưới ngưỡng E016 của row đơn): 2 beacon ĐẦU FIFO, còn lại enqueueBatch —
  // đúng 1 lần localStorage.setItem cho cả phần rest.
  it('T028: pagehide 5 lô ⇒ đúng 2 sendBeacon, rest enqueueBatch 1 lần setItem', async () => {
    // 30 row ASCII ~5.1KB (dưới ngưỡng 32 — không count-flush) ⇒ seal đúng
    // 5 lô × 6 row (6×5.13KB=30.8KB ≤ ngân sách; 7 row = 35.9KB vượt).
    for (let i = 0; i < 30; i += 1)
      sb.chunker.pushEvent(makeRow({ messageLen: 4900, ascii: true }));
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    try {
      sb.chunker.flush('pagehide');
      expect(beacon).toHaveBeenCalledTimes(2); // PAGEHIDE_MAX_BEACONS = 2
      const items = sb.outbox.readOutbox();
      expect(items.length).toBe(3); // 5 lô - 2 beacon = 3 lô rest
      expect(items.every(i => i.target === 'events')).toBe(true);
      expect(items.every(i => i.attempt === 1)).toBe(true);
      // PERF-M4: MỘT chu trình đọc/ghi — đúng 1 lời setItem('mon_outbox', ...)
      const outboxWrites = setItemSpy.mock.calls.filter(
        c => c[0] === 'mon_outbox',
      );
      expect(outboxWrites.length).toBe(1);
      // 2 beacon đầu là FIFO — đúng 2 row đầu tiên của buffer
      const batches = await sentRows(beacon);
      expect(batches.flat().length).toBeGreaterThan(0);
    } finally {
      setItemSpy.mockRestore();
    }
  });

  // PERF-m2 (post-impl r1) — pagehide worst-case: beacon fail TOÀN BỘ. Trước
  // đây dispatchChunks tự enqueue TỪNG lô beacon-fail (2 chu kỳ) + enqueueBatch
  // rest (1 chu kỳ) ⇒ 3 lần ghi mon_outbox đúng lúc trang chết. Giờ mọi body
  // (beacon-fail + rest) gom vào MỘT enqueueBatch — đúng 1 setItem.
  it('PERF-m2: pagehide beacon fail cả 2 lô đầu + rest ⇒ MỌI body vào outbox, setItem(mon_outbox) đúng 1 lần', () => {
    for (let i = 0; i < 30; i += 1)
      sb.chunker.pushEvent(makeRow({ messageLen: 4900, ascii: true })); // 5 lô
    const failBeacon = installSendBeacon(false);
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    try {
      sb.chunker.flush('pagehide');
      // đúng 2 beacon ATTEMPT (R2-7), tất cả fail ⇒ 5 body vào outbox
      expect(failBeacon).toHaveBeenCalledTimes(2);
      const items = sb.outbox.readOutbox();
      expect(items.length).toBe(5);
      expect(items.every(i => i.target === 'events')).toBe(true);
      expect(items.every(i => i.attempt === 1)).toBe(true);
      // MỘT chu trình đọc/ghi cho TOÀN BỘ pagehide (PERF-m2/PERF-M4)
      const outboxWrites = setItemSpy.mock.calls.filter(
        c => c[0] === 'mon_outbox',
      );
      expect(outboxWrites.length).toBe(1);
    } finally {
      setItemSpy.mockRestore();
    }
  });

  // T028b — cross-drain — bổ sung sau impl (không có trong plan gốc):
  // chunker mid-flush beacon thành công ⇒ drainOutbox gửi CHỈ item
  // target='events' tới EVENTS_INGEST_URL — body doc của phiên TRƯỚC (queued
  // trong outbox) KHÔNG được gửi sang URL events (outbox.ts OutboxTarget).
  it('T028b: mid-flush thành công ⇒ drain chỉ item events — body doc phiên trước KHÔNG sang URL events', async () => {
    const now = Date.now();
    window.localStorage.setItem(
      'mon_outbox',
      JSON.stringify([
        {
          body: JSON.stringify([{ DOC_BODY_FROM_PREVIOUS_SESSION: true }]),
          target: 'doc',
          attempt: 1,
          firstAt: now - 60000,
          nextAt: now - 1, // đã đến giờ retry
        },
        {
          body: JSON.stringify([{ record_type: 'event', seq: 991 }]),
          target: 'events',
          attempt: 1,
          firstAt: now - 60000,
          nextAt: now - 1,
        },
      ]),
    );
    for (let i = 0; i < 5; i += 1) sb.chunker.pushEvent(makeRow());
    sb.chunker.flush('timer'); // beacon true ⇒ sent>0 ⇒ drainOutbox (events)
    // Mọi beacon đều tới EVENTS_URL — không beacon nào chạm body doc
    expect(beaconUrls(beacon).length).toBeGreaterThanOrEqual(2);
    beaconUrls(beacon).forEach(u => expect(u).toBe(EVENTS_URL));
    const bodies = await allBeaconBodies(beacon);
    bodies.forEach(b =>
      expect(b).not.toContain('DOC_BODY_FROM_PREVIOUS_SESSION'),
    );
    // Item events đã drain xong; item doc CÒN NGUYÊN chờ đường doc
    const remaining = sb.outbox.readOutbox();
    expect(remaining.length).toBe(1);
    expect(remaining[0].target).toBe('doc');
    // drain đã gửi item events (beacon thứ 2 trở đi chứa seq 991)
    expect(bodies.some(b => b.includes('"seq":991'))).toBe(true);
  });

  // T037 (E023) — double flush: flush đè NGAY TRONG flush (re-entrant qua
  // sendBeacon mock) + flush nối tiếp — swap buffer nguyên tử, không nhân bản.
  it('T037: double flush (timer đụng hidden) ⇒ không row nhân bản, không seq trùng', async () => {
    const chunkerRef = sb.chunker;
    const reentrant = installSendBeacon(() => {
      chunkerRef.flush('hidden'); // cố gắng flush CHỖ ĐANG flush (E023)
      return true;
    });
    const rows: EventRow[] = [];
    for (let i = 0; i < 10; i += 1) rows.push(makeRow());
    rows.forEach(r => chunkerRef.pushEvent(r));
    chunkerRef.flush('timer');
    chunkerRef.flush('hidden'); // buffer đã swap — no-op, KHÔNG gửi lại
    const batches = await sentRows(reentrant);
    const all = batches.flat();
    expect(all.length).toBe(10); // tập union KHÔNG đổi
    const seqs = all.map((r: any) => r.seq);
    expect(new Set(seqs).size).toBe(10); // không seq trùng
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // thứ tự giữ
  });

  // T059 (E018/FR-014/PERF-m5) — buffer bound: outbox đầy 20 lô + beacon fail
  // liên tục + 100 event tiếp ⇒ trần được giữ (flush seal regardless + FIFO
  // drop + mất mát hiện số mon_dropped_n).
  it('T059: outbox đầy + beacon fail + 100 event ⇒ outbox vẫn 20, FIFO drop đếm dropped_n', async () => {
    const now = Date.now();
    const seed = [];
    for (let i = 0; i < 20; i += 1) {
      seed.push({
        body: JSON.stringify([{ record_type: 'event', seq: i }]),
        target: 'events',
        attempt: 1,
        firstAt: now - 60000,
        nextAt: now - 1,
      });
    }
    window.localStorage.setItem('mon_outbox', JSON.stringify(seed));
    const failBeacon = installSendBeacon(false);
    const fetchMock = vi.fn(() => Promise.reject(new Error('net down')));
    (globalThis as any).fetch = fetchMock;
    try {
      expect(() => {
        for (let i = 0; i < 100; i += 1) sb.chunker.pushEvent(makeRow());
        sb.chunker.flush('timer'); // 4 row cuối
      }).not.toThrow(); // NFR-001 — mạng chết không làm vỡ capture
      // chờ chuỗi fetch .catch ⇒ enqueue của các lô mid-session
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      const items = sb.outbox.readOutbox();
      expect(items.length).toBe(20); // trần MAX_ITEMS giữ nguyên
      expect(items.every(i => i.target === 'events')).toBe(true);
      // 20 item cũ + 4 lô mới (100 row / 32 = 3 flush + 1 flush cuối) ⇒
      // FIFO bỏ 4 lô cũ nhất — mất mát hiện số (E018)
      expect(
        Number(window.localStorage.getItem('mon_dropped_n')),
      ).toBeGreaterThanOrEqual(4);
      expect(failBeacon.mock.calls.length).toBe(4); // mỗi flush seal 1 lô
      // item cũ nhất (seq 0) đã bị FIFO bỏ; seq 3 vẫn còn (giữa 20 giữ lại)
      const bodies = items.map(i => i.body).join(',');
      expect(bodies).not.toContain('"seq":0,');
      expect(bodies).toContain('"seq":3');
    } finally {
      delete (globalThis as any).fetch;
    }
  });
});

// T052 — property: seal/flush không biến đổi tập sự kiện.
describe('chunker — property T052 (E023/FR-014)', () => {
  let sb: MonitorSandbox;
  let beacon: Mock;

  beforeEach(async () => {
    window.localStorage.clear();
    seq = 0;
    installNavigationTiming(0);
    installRandomUUID(true);
    installOnLine(true);
    beacon = installSendBeacon(true);
    sb = await loadMonitorSandbox({ eventsUrl: EVENTS_URL });
    sb.chunker.arm();
  });

  afterEach(() => {
    sb.index.__resetMonitorForTest();
  });

  it('T052: union(events các lô) == buffer gốc theo đúng thứ tự, không mất không nhân bản', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 3000 }), {
          minLength: 0,
          maxLength: 80,
        }),
        async (msgLens: number[]) => {
          window.localStorage.clear();
          beacon.mockClear();
          const rows = msgLens.map(len => makeRow({ messageLen: len }));
          rows.forEach(r => sb.chunker.pushEvent(r));
          sb.chunker.flush('timer');
          const batches = await sentRows(beacon);
          const all = batches.flat();
          expect(all.length).toBe(rows.length);
          expect(all.map((r: any) => r.seq)).toEqual(rows.map(r => r.seq));
          expect(all.map((r: any) => r.message)).toEqual(
            rows.map(r => r.message),
          );
          return true;
        },
      ),
      { numRuns: 25 },
    );
  });
});

// ─── CR-m4 (post-impl r1) — flush scheduler: timer 30s / rIC / hidden ───────
// §2.4e: flush 30s dời sang idle qua requestIdleCallback({timeout:2000}),
// không có rIC ⇒ chạy thẳng; hidden flush đồng bộ DỪNG timer, visible lại
// cài lại (R2-6) — đường timer chưa từng có test (fake timers cần thiết).
describe('chunker — scheduler timer/rIC/hidden (CR-m4, §2.4e)', () => {
  let sb: MonitorSandbox;
  let beacon: Mock;

  beforeEach(async () => {
    window.localStorage.clear();
    seq = 0;
    installNavigationTiming(0);
    installRandomUUID(true);
    installOnLine(true);
    beacon = installSendBeacon(true);
    vi.useFakeTimers();
    sb = await loadMonitorSandbox({ eventsUrl: EVENTS_URL });
    sb.chunker.arm();
  });

  afterEach(() => {
    sb.index.__resetMonitorForTest();
    vi.useRealTimers();
    delete (window as any).requestIdleCallback;
  });

  // (a) rIC có sẵn — cb được gọi đồng bộ ⇒ beacon đúng 1 lần sau 30s.
  it('CR-m4: timer 30s + requestIdleCallback (cb đồng bộ) ⇒ beacon 1 lần', () => {
    (window as any).requestIdleCallback = (cb: () => void) => {
      cb();
      return 0;
    };
    sb.chunker.pushEvent(makeRow());
    vi.advanceTimersByTime(30000);
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  // (b) thiếu rIC (iOS WKWebView thường thiếu) ⇒ timer chạy flush thẳng.
  it('CR-m4: timer 30s KHÔNG có rIC ⇒ flush thẳng, beacon 1 lần', () => {
    delete (window as any).requestIdleCallback; // jsdom mặc định không có
    sb.chunker.pushEvent(makeRow());
    vi.advanceTimersByTime(30000);
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  // (c) hidden dừng timer (30s sau KHÔNG beacon thêm); visibilitychange
  // visible cài lại timer ⇒ chu kỳ tiếp theo beacon tiếp. Đi qua LISTENER
  // thật của onVisibility (nơi stopTimer sống — flush('hidden') gốc không
  // tự dừng timer, việc dừng thuộc §2.4e/R2-6 của handler).
  it('CR-m4: hidden dừng timer — visible lại cài lại (R2-6)', () => {
    sb.chunker.pushEvent(makeRow());
    vi.advanceTimersByTime(30000); // chu kỳ timer đầu (tự cài lại timer2)
    expect(beacon).toHaveBeenCalledTimes(1);
    // hidden ⇒ onVisibility: stopTimer + flush đồng bộ checkpoint
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    sb.chunker.pushEvent(makeRow());
    vi.advanceTimersByTime(30000); // timer2 đã dừng ⇒ KHÔNG beacon thứ 2
    expect(beacon).toHaveBeenCalledTimes(1);
    // visible lại ⇒ onVisibility armTimer — chu kỳ 30s sống lại
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(30000);
      expect(beacon).toHaveBeenCalledTimes(2);
    } finally {
      delete (document as any).visibilityState;
    }
  });
});
