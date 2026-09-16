// Test cho công tắc L1 (§1.6) — CỐ Ý không dùng `__setCachedFlagForTest()`.
//
// Mọi test cờ trước đây đều seed thẳng vào `cachedFlag` bằng helper đó. Chúng
// khẳng định "`_start()` đọc đúng cờ" — đúng, và vô nghĩa, vì trong đời thật
// KHÔNG GÌ từng ghi được vào biến ấy: nó là biến module, mà mỗi lần mở webview
// (miniapp trong app bank) là một document mới hoàn toàn. Con bug L-C1 nằm ở
// VÒNG ĐỜI của state, nên test nào seed state đều mù với nó.
//
// Vì vậy các test dưới đây đi qua đúng ranh giới đó: `vi.resetModules()` +
// `require` lại, mô phỏng lần mở webview kế tiếp.

const FLAG_KEY = 'mon_flag';

async function loadFlagModule() {
  // Mỗi lần gọi = một document mới: module được đánh giá lại từ đầu.
  // Ticket 03 — flag.ts đọc flagUrl qua getConfig() (ADR-0001), nên mỗi
  // "document mới" cũng cần init() lại config, cùng cách app.ts thật làm.
  // Vitest không có API isolateModules đồng bộ — vi.resetModules() (ở
  // beforeEach) xóa registry, rồi import() động ở đây nạp lại module sạch.
  vi.resetModules();
  const { initConfig } = await import('../config');
  const { fixtureConfig } = await import('./configFixture');
  initConfig(fixtureConfig());
  return import('../flag');
}

// Chuỗi trong fetchFlag() là fetch → .then(res.json()) → .then(gán+persist),
// cần nhiều tick hơn vài `await Promise.resolve()`. Dùng macrotask cho chắc —
// jsdom KHÔNG có `setImmediate`, nên setTimeout(0).
function flush(): Promise<void> {
  return new Promise(r => setTimeout(r, 0));
}

function fetchReturning(json: unknown): typeof fetch {
  return vi.fn(() =>
    Promise.resolve({ json: () => Promise.resolve(json) } as Response),
  ) as unknown as typeof fetch;
}

describe('cờ L1 — persist qua ranh giới phiên', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  it('mặc định bật khi chưa có gì persist (E011 — chưa đọc được lần nào)', async () => {
    const flag = await loadFlagModule();
    expect(flag.getCachedFlag()).toEqual({
      enabled: true,
      rate: 1,
      http: true,
      steps: true,
    });
  });

  it('fetchFlag() ghi giá trị đọc được xuống localStorage', async () => {
    const flag = await loadFlagModule();
    flag.fetchFlag(fetchReturning({ enabled: false, rate: 0.1 }));
    await flush();

    const raw = window.localStorage.getItem(FLAG_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({
      enabled: false,
      rate: 0.1,
      http: true,
      steps: true,
    });
  });

  // ĐÂY LÀ TEST QUAN TRỌNG NHẤT FILE NÀY: nó đỏ với bản trước bản vá L-C1.
  it('LẦN MỞ KẾ TIẾP đọc được cờ tắt — công tắc L1 thật sự tắt được', async () => {
    const first = await loadFlagModule();
    first.fetchFlag(fetchReturning({ enabled: false }));
    await flush();
    expect(first.getCachedFlag().enabled).toBe(false);

    // Ranh giới phiên: document mới, biến module biến mất.
    const next = await loadFlagModule();
    expect(next.getCachedFlag().enabled).toBe(false);
  });

  it('KHÔNG fail-open: đọc cờ lỗi ở phiên sau vẫn giữ trạng thái tắt', async () => {
    const first = await loadFlagModule();
    first.fetchFlag(fetchReturning({ enabled: false }));
    await flush();

    const next = await loadFlagModule();
    // E011 — mạng hỏng ở lần mở sau. KHÔNG được rơi về enabled=true, nếu không
    // thì công tắc khẩn cấp tự bật lại giữa lúc sự cố.
    next.fetchFlag(
      vi.fn(() =>
        Promise.reject(new Error('offline')),
      ) as unknown as typeof fetch,
    );
    await flush();
    expect(next.getCachedFlag().enabled).toBe(false);
  });

  it('bật lại được: cờ trả enabled=true ghi đè trạng thái tắt đã persist', async () => {
    window.localStorage.setItem(
      FLAG_KEY,
      JSON.stringify({ enabled: false, rate: 1, http: true, steps: true }),
    );
    const flag = await loadFlagModule();
    expect(flag.getCachedFlag().enabled).toBe(false);

    flag.fetchFlag(fetchReturning({ enabled: true }));
    await flush();

    const next = await loadFlagModule();
    expect(next.getCachedFlag().enabled).toBe(true);
  });

  it('localStorage chứa rác ⇒ không throw, rơi về mặc định (NFR-001)', async () => {
    window.localStorage.setItem(FLAG_KEY, '{ không phải json');
    let flag: Awaited<ReturnType<typeof loadFlagModule>> | undefined;
    await expect(
      (async () => {
        flag = await loadFlagModule();
      })(),
    ).resolves.not.toThrow();
    expect(flag!.getCachedFlag().enabled).toBe(true);
  });

  it('bỏ qua phản hồi sai kiểu, giữ nguyên cache (E011)', async () => {
    const flag = await loadFlagModule();
    flag.fetchFlag(fetchReturning({ enabled: 'nope', rate: 'nope' }));
    await flush();

    expect(flag.getCachedFlag()).toEqual({
      enabled: true,
      rate: 1,
      http: true,
      steps: true,
    });
  });
});

// ─── phase-2 (webview-session-logs §3.2) — T036/E022: flag JSON rác ─────────
describe('T036 — E022: 200 nhưng body rác ⇒ giữ cache tốt, KHÔNG persist rác, KHÔNG set marker', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  function fetchRaw(text: string): typeof fetch {
    return vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('Unexpected token in JSON')),
        text: () => Promise.resolve(text),
      } as unknown as Response),
    ) as unknown as typeof fetch;
  }

  // T036 — body 200 không parse được ⇒ coi như không đọc được: cache nguyên vẹn.
  it('T036: body 200 không parse được ⇒ cache nguyên vẹn', async () => {
    const flag = await loadFlagModule();
    flag.fetchFlag(fetchRaw('not-json-at-all'));
    await flush();
    expect(flag.getCachedFlag()).toEqual({
      enabled: true,
      rate: 1,
      http: true,
      steps: true,
    }); // E011 semantics — giữ cache tốt
    expect(window.localStorage.getItem('mon_flag')).toBeNull(); // không persist rác
  });

  // T036 — sai shape (object nhưng không field nào đúng kiểu) ⇒ không đụng cache.
  it('T036: body parse được nhưng sai shape ⇒ không ghi đè cache tốt', async () => {
    const flag = await loadFlagModule();
    flag.fetchFlag(fetchReturning({ enabled: false })); // cache tốt ban đầu
    await flush();
    expect(flag.getCachedFlag().enabled).toBe(false);
    flag.fetchFlag(fetchReturning({ enabled: 'nope', rate: [], http: 1 }));
    await flush();
    expect(flag.getCachedFlag().enabled).toBe(false); // KHÔNG fail-open lại
  });

  // E022 — body rác KHÔNG được ghi đè khoá persist của một lần đọc tốt trước đó.
  it('T036: body rác ⇒ mon_flag giữ nguyên giá trị lần đọc tốt', async () => {
    const flag = await loadFlagModule();
    flag.fetchFlag(fetchReturning({ enabled: false }));
    await flush();
    const good = window.localStorage.getItem('mon_flag');
    flag.fetchFlag(fetchRaw('garbage'));
    await flush();
    expect(window.localStorage.getItem('mon_flag')).toBe(good);
  });
});
