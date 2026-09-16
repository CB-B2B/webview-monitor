// src/__tests__/testUtils.ts
//
// Fixture dùng chung mọi test của module monitor — theo bảng fixture bắt
// buộc trong TDD Plan (jsdom 14 KHÔNG có sẵn các API dưới đây).

import type { Mock } from 'vitest';

export function installSendBeacon(result: boolean | (() => boolean) = true) {
  const impl = typeof result === 'function' ? result : () => result;
  const fn = vi.fn(impl);
  Object.defineProperty(window.navigator, 'sendBeacon', {
    configurable: true,
    writable: true,
    value: fn,
  });
  return fn;
}

export function removeSendBeacon() {
  Object.defineProperty(window.navigator, 'sendBeacon', {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

// UUID v4 xác định theo seed — đủ cho test, KHÔNG dùng ở mã sản xuất.
function seededUuid(seed: number): string {
  let x = (seed * 2654435761) % 4294967296;
  const rnd = () => {
    x = (x * 1103515245 + 12345) % 4294967296;
    return Math.abs(x) / 4294967296;
  };
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join(
      '',
    );
  const variantNibble = (8 + Math.floor(rnd() * 4)).toString(16);
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variantNibble}${hex(3)}-${hex(12)}`;
}

let uuidCounter = 0;

export function installRandomUUID(available = true) {
  uuidCounter = 0;
  Object.defineProperty(global, 'crypto', {
    configurable: true,
    writable: true,
    value: available
      ? {
          randomUUID: vi.fn(() => seededUuid(++uuidCounter)),
          getRandomValues: (arr: Uint8Array) => {
            for (let i = 0; i < arr.length; i += 1)
              arr[i] = (i * 37 + 11) % 256;
            return arr;
          },
        }
      : undefined,
  });
}

export function installOnlyGetRandomValues() {
  Object.defineProperty(global, 'crypto', {
    configurable: true,
    writable: true,
    value: {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i += 1) arr[i] = (i * 37 + 11) % 256;
        return arr;
      },
    },
  });
}

export function removeCrypto() {
  Object.defineProperty(global, 'crypto', {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

export function installNavigationTiming(
  startTime = 0,
  timeOrigin = 1_700_000_000_000,
) {
  Object.defineProperty(performance, 'getEntriesByType', {
    configurable: true,
    writable: true,
    value: vi.fn((type: string) =>
      type === 'navigation' ? [{ startTime }] : [],
    ),
  });
  Object.defineProperty(performance, 'timeOrigin', {
    configurable: true,
    writable: true,
    value: timeOrigin,
  });
}

export function removeNavigationTiming() {
  Object.defineProperty(performance, 'getEntriesByType', {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

export function installOnLine(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

/** Đồng hồ tiêm được cho performance.now() — tăng đơn điệu, seed cố định. */
export function installFakeMonotonicClock(startAt = 0) {
  let now = startAt;
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => now);
  return {
    advance(ms: number) {
      now += ms;
    },
    set(ms: number) {
      now = ms;
    },
    value() {
      return now;
    },
    restore() {
      spy.mockRestore();
    },
  };
}

export function clearLocalStorage() {
  window.localStorage.clear();
}

// ─── hạ tầng cho suite dùng state module-level (events/chunker/config) ──────
//
// index.ts/events.ts/chunker.ts/flag.ts giữ state qua biến `let` cấp module
// (session/buffer/currentConfig/cachedFlag) — không reset thủ công thì test
// sau ăn state của test trước. Bản Jest cũ dùng `jest.isolateModules` để nạp
// bản sao module MỚI mỗi lần; Vitest không có API đồng bộ tương đương, nên
// dùng `vi.resetModules()` + `await import()` (bất đồng bộ, nhưng cùng hiệu
// quả: registry module bị xoá, `import()` kế tiếp chạy lại từ đầu).

export interface MonitorSandbox {
  monitor: typeof import('../index').default;
  index: typeof import('../index');
  events: typeof import('../events');
  chunker: typeof import('../chunker');
  flag: typeof import('../flag');
  filter: typeof import('../filter');
  outbox: typeof import('../outbox');
  transport: typeof import('../transport');
  routes: typeof import('../routes');
  env: typeof import('../env');
  config: typeof import('../config');
}

export async function loadMonitorSandbox(
  opts: { eventsUrl?: string } = {},
): Promise<MonitorSandbox> {
  vi.resetModules();
  const [index, events, chunker, flag, filter, outbox, transport, routes, env, config] =
    await Promise.all([
      import('../index'),
      import('../events'),
      import('../chunker'),
      import('../flag'),
      import('../filter'),
      import('../outbox'),
      import('../transport'),
      import('../routes'),
      import('../env'),
      import('../config'),
    ]);
  const sb: MonitorSandbox = {
    monitor: index.default,
    index,
    events,
    chunker,
    flag,
    filter,
    outbox,
    transport,
    routes,
    env,
    config,
  };
  // module host-supplied config (ADR-0001) — mỗi sandbox mới phải init() lại.
  const { fixtureConfig } = await import('./configFixture');
  sb.monitor.init(fixtureConfig({ eventsIngestUrl: opts.eventsUrl ?? '' }));
  return sb;
}

/** Đọc nội dung text của MỌI blob sendBeacon mock đã nhận (giúp parse body). */
export async function allBeaconBodies(mock: Mock): Promise<string[]> {
  const out: string[] = [];
  for (const call of mock.mock.calls) {
    const blob = call[1] as Blob;
    out.push(await blobText(blob));
  }
  return out;
}

async function blobText(blob: Blob): Promise<string> {
  if (typeof (blob as { text?: () => Promise<string> }).text === 'function') {
    return (blob as { text: () => Promise<string> }).text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}

/** Gom mọi EventRow đã gửi beacon (parse từng body, ghép theo thứ tự gọi). */
export async function allBeaconRows(mock: Mock): Promise<any[]> {
  const bodies = await allBeaconBodies(mock);
  const rows: any[] = [];
  for (const body of bodies) {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) rows.push(...parsed);
  }
  return rows;
}

/** URL của từng lời sendBeacon mock — phân loại kênh doc (INGEST) vs events. */
export function beaconUrls(mock: Mock): string[] {
  return mock.mock.calls.map(c => String(c[0]));
}
