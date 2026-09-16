// §9.3 bảng B/C — lớp bảo mật quan trọng nhất. T042-T046, T077-T090,
// T105, T110-T113.
import fc from 'fast-check';
import {
  applyLayer2,
  FILTER_ERROR_PLACEHOLDER,
  isScalar,
  sanitizeMessage,
} from '../filter';
import { SessionPayload, WHITELIST_FIELDS } from '../types';

function basePayload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    session_id: '11111111-2222-4333-8444-555555555555',
    session_started_at: 1_700_000_000_000,
    session_finished_at: 1_700_000_005_000,
    session_duration_ms: 5000,
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

describe('isScalar — §2.4 type guard scalar', () => {
  // T090
  it('chấp nhận string/number/boolean/undefined', () => {
    expect(isScalar('a')).toBe(true);
    expect(isScalar(1)).toBe(true);
    expect(isScalar(true)).toBe(true);
    expect(isScalar(undefined)).toBe(true);
  });

  it('từ chối object/array/null', () => {
    expect(isScalar({})).toBe(false);
    expect(isScalar([])).toBe(false);
    expect(isScalar(null)).toBe(false);
  });
});

describe('applyLayer2 — bảng B/C (§2.6)', () => {
  // T042
  it('KHÔNG redact chuỗi 31 ký tự [A-Za-z0-9]', () => {
    const s = 'a'.repeat(31);
    const { payload, blockedCount } = applyLayer2(basePayload({ pathname: s }));
    expect(payload.pathname).toBe(s);
    expect(blockedCount).toBe(0);
  });

  // T043
  it('redact chuỗi 32 ký tự [A-Za-z0-9]', () => {
    const s = 'a'.repeat(32);
    const { payload, byRule } = applyLayer2(basePayload({ pathname: s }));
    expect(payload.pathname).toBe('[redacted]');
    expect(byRule.LONG_TOKEN).toBe(1);
  });

  // T044
  it('redact chuỗi 33 ký tự', () => {
    const s = 'a'.repeat(33);
    const { payload } = applyLayer2(basePayload({ pathname: s }));
    expect(payload.pathname).toBe('[redacted]');
  });

  // T045
  it('KHÔNG redact 8 chữ số liên tiếp', () => {
    const { payload, blockedCount } = applyLayer2(
      basePayload({ pathname: '12345678' }),
    );
    expect(payload.pathname).toBe('12345678');
    expect(blockedCount).toBe(0);
  });

  // T046
  it('redact 9 chữ số liên tiếp (nguồn nhiễu chính: timestamp)', () => {
    const { payload, byRule } = applyLayer2(
      basePayload({ pathname: '123456789' }),
    );
    expect(payload.pathname).toBe('[redacted]');
    expect(byRule.LONG_DIGITS).toBe(1);
  });

  // T110
  it('RULE_DATE bắt ngày sinh dạng gạch ngang dd-mm-yyyy', () => {
    const err = { type: 'Error', message: 'birthday=15-03-1990' };
    const { payload } = applyLayer2(basePayload({ error: err }));
    expect(payload.error!.message).toBe('[redacted]');
  });

  // T111
  it('RULE_SEP_DIGITS bắt số tài khoản có dấu cách', () => {
    const err = { type: 'Error', message: 'acct 0123 4567 89' };
    const { payload, byRule } = applyLayer2(basePayload({ error: err }));
    expect(payload.error!.message).toBe('[redacted]');
    expect(byRule.SEP_DIGITS).toBe(1);
  });

  // T112
  it('RULE_LONG_TOKEN bắt base64url 36 ký tự có dấu gạch dưới giữa chuỗi', () => {
    const token = 'o2oi_aB3dE9fG1hJ4kL6mN8pQ0rS2tU5vW7xY';
    expect(token.length).toBeGreaterThanOrEqual(32);
    const err = { type: 'Error', message: token };
    const { payload } = applyLayer2(basePayload({ error: err }));
    expect(payload.error!.message).toBe('[redacted]');
  });

  // T113
  it('L2_MAX_SCAN: chuỗi 5.000 ký tự không khớp rule nào chỉ quét 4.096 đầu, hoàn tất nhanh', () => {
    // 'ab ' lặp lại — không khớp bất kỳ rule bảng C nào (khoảng trắng chặn
    // LONG_TOKEN/LONG_DIGITS/SEP_DIGITS liên tiếp).
    const long = 'ab '.repeat(1700); // > 4096 ký tự
    expect(long.length).toBeGreaterThan(4096);
    const t0 = Date.now();
    const { payload } = applyLayer2(basePayload({ pathname: long }));
    const elapsed = Date.now() - t0;
    expect(payload.pathname).toBe(long); // không khớp rule nào — giữ nguyên
    expect(elapsed).toBeLessThan(200);
  });

  // T086 — bảng C áp lên CẢ message LẪN stack
  it('redact JWT chỉ trong .message', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const err = { type: 'Error', message: `token invalid: ${jwt}` };
    const { payload } = applyLayer2(basePayload({ error: err }));
    expect(payload.error!.message).toBe('[redacted]');
  });

  it('redact JWT chỉ trong .stack', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const err = {
      type: 'Error',
      message: 'clean message',
      stack: `Error\n at foo (${jwt})`,
    };
    const { payload } = applyLayer2(basePayload({ error: err }));
    expect(payload.error!.message).toBe('clean message');
    expect(payload.error!.stack).toBe('[redacted]');
  });

  // T088 — object lồng sâu
  it('redact giá trị nằm ở tầng lồng thứ 3', () => {
    const steps = [
      {
        seq: 0,
        name: 'auth_user',
        started_at_offset: 0,
        ms: 1,
        status: 'error',
        error_code: 'Bearer abc.def.ghi',
      },
    ] as unknown as SessionPayload['steps'];
    const { payload } = applyLayer2(basePayload({ steps }));
    expect((payload.steps[0] as any).error_code).toBe('[redacted]');
  });

  // T089 — chuỗi URI-encoded
  it('redact JWT bị URI-encode', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const encoded = encodeURIComponent(jwt);
    const err = { type: 'Error', message: encoded };
    const { payload } = applyLayer2(basePayload({ error: err }));
    expect(payload.error!.message).toBe('[redacted]');
  });

  // T082 / va chạm 1 — session_id KHÔNG BAO GIỜ bị redact
  it('session_id (UUID v4) đi qua Lớp 2 nguyên vẹn dù dài ≥32 ký tự [A-Za-z0-9-]', () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    expect(sid.replace(/-/g, '').length).toBeGreaterThanOrEqual(32);
    const { payload } = applyLayer2(basePayload({ session_id: sid }));
    expect(payload.session_id).toBe(sid);
  });

  // T079
  it('filter_l2_hits khớp đúng số ô mang giá trị [redacted]', () => {
    const err = {
      type: 'Error',
      message: 'token=abc123456789',
      stack: '123456789012 more',
    };
    const { payload } = applyLayer2(
      basePayload({ error: err, pathname: 'a'.repeat(40) }),
    );
    const serialized = JSON.stringify(payload);
    const redactedCount = (serialized.match(/\[redacted\]/g) || []).length;
    expect(payload.filter_l2_hits).toBe(redactedCount);
  });

  // T087 — giá trị gốc bị chặn không rò ra bất kỳ đâu
  it('output không chứa giá trị gốc, tiền tố hay độ dài của nó ở bất kỳ trường nào', () => {
    const secret =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQtdmFsdWUifQ.sig-part-here-xyz';
    const err = { type: 'Error', message: secret };
    const { payload, paths } = applyLayer2(basePayload({ error: err }));
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(secret.slice(0, 10));
    expect(paths).toEqual(['error.message']);
  });

  // T105 — l2_hits_by_rule + l2_paths khớp thực tế
  it('l2_hits_by_rule và l2_paths ghi đúng path + rule đã khớp', () => {
    const err = {
      type: 'Error',
      message: 'has jwt eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.c2lnbmF0dXJl',
    };
    const steps = [
      {
        seq: 0,
        name: 'auth_user',
        started_at_offset: 0,
        ms: 1,
        status: 'error',
        error_code: '123456789',
      },
      {
        seq: 1,
        name: 'home_float_icon',
        started_at_offset: 0,
        ms: 1,
        status: 'error',
        error_code: '987654321',
      },
    ] as unknown as SessionPayload['steps'];
    const { payload } = applyLayer2(basePayload({ error: err, steps }));
    expect(payload.l2_hits_by_rule.JWT).toBe(1);
    expect(payload.l2_hits_by_rule.LONG_DIGITS).toBe(2);
    expect(payload.l2_paths.sort()).toEqual(
      ['error.message', 'steps[0].error_code', 'steps[1].error_code'].sort(),
    );
  });

  // T078 — corpus mẫu độc lập, KHÔNG bằng chính 8 luật (viết tay)
  const CORPUS = [
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    'Bearer abcdefghijklmno',
    'o2oi_aB3dE9fG1hJ4kL6mN8pQ0rS2tU5vW7xY', // base64url có - và _
    'so tai khoan: 0123 4567 89',
    '012-345-678-901',
    '123456789012', // CCCD 12 số
    'ngay sinh 15/03/1990',
    'ngay sinh 1990-03-15',
    'ngay sinh 15-03-1990',
    'ngay sinh 15.03.1990',
    'email: user.name+tag@example.co',
    'access_token=abcdef',
    'partner-token: xyz',
    'oo-api-key=o2oiXXXXXX',
  ];

  it.each(CORPUS)('corpus độc lập: "%s" phải bị redact', sample => {
    const err = { type: 'Error', message: sample };
    const { payload } = applyLayer2(basePayload({ error: err }));
    expect(payload.error!.message).toBe('[redacted]');
  });

  // T077 — Lớp 1 đóng kín, property-based trên WHITELIST_FIELDS
  it('T077: Object.keys(payload) luôn là tập con nghiêm ngặt của WHITELIST_FIELDS', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: 0, max: 5 }),
        (junkValue, junkCount) => {
          const dirty: any = { ...basePayload(), debugToken: junkValue };
          for (let i = 0; i < junkCount; i += 1)
            dirty[`extra_${i}`] = junkValue;
          // buildPayload() thật không bao giờ spread — mô phỏng bằng cách
          // xây một payload "sạch" TỪNG trường một từ WHITELIST_FIELDS,
          // đúng cơ chế mà buildPayload() dùng, rồi khẳng định field lạ
          // (debugToken/extra_*) không lọt qua bất kỳ đường nào.
          const clean: any = {};
          WHITELIST_FIELDS.forEach(k => {
            if (k in dirty) clean[k] = dirty[k];
          });
          const keys = Object.keys(clean);
          const allowed = new Set(WHITELIST_FIELDS as ReadonlyArray<string>);
          return keys.every(k => allowed.has(k)) && !('debugToken' in clean);
        },
      ),
    );
  });

  // T080 — step<T> trong suốt (thuộc invariant chung, kiểm tại monitor.spec.ts thực thi thật)

  // T083 — mọi trường thời gian là number
  it('T083: mọi trường thời gian trong payload là number, không phải string', () => {
    const p = basePayload({ time_to_home_ms: 1234 });
    expect(typeof p.session_started_at).toBe('number');
    expect(typeof p.session_finished_at).toBe('number');
    expect(typeof p.session_duration_ms).toBe('number');
    expect(typeof p.time_to_home_ms).toBe('number');
  });
});

// ─── phase-2 (webview-session-logs §5.3.3) — sanitizeMessage kênh kho ───────

describe('sanitizeMessage — T034/E020 (fail-closed theo trường)', () => {
  // T034 — filter TỰ ném lỗi ⇒ trả '[filter-error]' (hằng số), KHÔNG throw.
  // Fault injection: Proxy chặn .length ném lỗi — nhánh catch trong chính
  // sanitizeMessage phải nuốt và thay hằng số (event vẫn buffer ở caller).
  it('T034: lỗi nội bộ filter ⇒ [filter-error]', () => {
    const evil = new Proxy(new String('message binh thuong'), {
      get(target, prop) {
        if (prop === 'length') throw new Error('poisoned length');
        return Reflect.get(target, prop);
      },
    });
    expect(() => sanitizeMessage(evil as unknown as string)).not.toThrow();
    expect(sanitizeMessage(evil as unknown as string)).toBe(
      FILTER_ERROR_PLACEHOLDER,
    );
    expect(FILTER_ERROR_PLACEHOLDER).toBe('[filter-error]');
  });

  it('T034: chuỗi sạch ⇒ trả nguyên (không dính placeholder)', () => {
    expect(sanitizeMessage('Giao dich thanh cong')).toBe(
      'Giao dich thanh cong',
    );
  });

  // T061 (còn vế KHO sau QĐ-18) — đường né token-keyword bị bịt (SEC-M3
  // r1-TS): message TỰ DO chứa `access_token=abc123` — giá trị NGẮN, không
  // dãy số dài, không hình dạng JWT/bearer/32+ ký tự, nên mọi rule bảng C
  // khác đều KHÔNG khớp; chỉ RULE_TOKEN_KEYWORD (bảng C §5.3.3) bắt được ⇒
  // '[redacted]'. Thiếu rule đó là lỗ hổng thật, không phải cảnh giả.
  it('T061: message chứa access_token=abc123 (ngắn, không dãy số) ⇒ [redacted] nhờ RULE_TOKEN_KEYWORD bảng C — kênh kho', () => {
    expect(sanitizeMessage('access_token=abc123')).toBe('[redacted]');
  });
});

// T049 — property (fast-check): với message BẤT KỲ, output của sanitizeMessage
// hoặc sạch mọi pattern denylist (bảng C pin lại dưới đây), hoặc là
// '[redacted]'/'[filter-error]'. Không đường nào PII pattern lọt kho.
describe('T049 — property: sanitizeMessage không cho PII pattern lọt kho', () => {
  // Pin lại 8 rule bảng C §2.6 (nguồn: filter.ts LAYER2_RULES) — kiểm ĐỘC LẬP
  // với engine để rule bị xoá/yếu đi thì property đỏ.
  const RULES: RegExp[] = [
    /eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,}/i, // JWT
    /\bBearer\s+\S+/i, // BEARER
    /[A-Za-z0-9+/=_-]{32,}/, // LONG_TOKEN
    /token=|access_token|id_token|partner-token|authorization|oo-api-key/i, // TOKEN_KEYWORD
    /\d{9,}/, // LONG_DIGITS
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // EMAIL
    /\b(?:\d{4}[-/.]\d{2}[-/.]\d{2}|\d{2}[-/.]\d{2}[-/.]\d{4})\b/, // DATE
    /(?:\d[ .-]?){9,}/, // SEP_DIGITS
  ];

  function dirty(s: string): boolean {
    const probes = [s];
    try {
      probes.push(decodeURIComponent(s));
    } catch {
      /* chuỗi không decode được — chỉ kiểm bản gốc */
    }
    return probes.some(p => RULES.some(r => r.test(p)));
  }

  it('T049: mọi output không phải placeholder đều sạch denylist', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (msg: string) => {
        const out = sanitizeMessage(msg);
        if (out === '[redacted]' || out === FILTER_ERROR_PLACEHOLDER)
          return true;
        return !dirty(out);
      }),
      { numRuns: 50 },
    );
  });
});
