// §2.2/§2.4 pickSamples, toTechError — T013, T025-T029
import { __resetConfigForTest, initConfig } from '../config';
import { buildEnv, detectDeviceModel } from '../env';
import { pickSamples, toTechError } from '../payload';
import { HttpSample } from '../types';
import { installNavigationTiming } from './testUtils';
import { fixtureConfig } from './configFixture';

function sample(i: number): HttpSample {
  return {
    url: `/api/x/${i}`,
    host: 'main',
    method: 'GET',
    t_offset: i,
    ms: 1,
    ok: true,
    step_seq: null,
  };
}

describe('buildEnv — T013', () => {
  beforeEach(() => {
    installNavigationTiming();
    initConfig(fixtureConfig());
  });
  afterEach(() => __resetConfigForTest());

  it('trả về đúng 7 khoá bảng A, os_version dạng dải', () => {
    const env = buildEnv();
    expect(Object.keys(env).sort()).toEqual(
      [
        'connection_type',
        'device_type',
        'language',
        'os',
        'os_version',
        'release_version',
        'webview_version',
      ].sort(),
    );
    // không phải chuỗi UA đầy đủ (không chứa dấu ngoặc build number)
    expect(env.os_version).not.toMatch(/\(/);
  });
});

describe('pickSamples — T027-T029', () => {
  // T027
  it('19 mẫu: giữ đủ 19, overflow=0', () => {
    const samples = Array.from({ length: 19 }, (_, i) => sample(i));
    const { samples: kept, overflow } = pickSamples(samples);
    expect(kept.length).toBe(19);
    expect(overflow).toBe(0);
  });

  // T028
  it('20 mẫu (trần): giữ đủ 20, overflow=0', () => {
    const samples = Array.from({ length: 20 }, (_, i) => sample(i));
    const { samples: kept, overflow } = pickSamples(samples);
    expect(kept.length).toBe(20);
    expect(overflow).toBe(0);
  });

  // T029
  it('21 mẫu (trần+1): giữ 10 đầu + 10 cuối, overflow=1, không mất mẫu đầu tiên', () => {
    const samples = Array.from({ length: 21 }, (_, i) => sample(i));
    const { samples: kept, overflow } = pickSamples(samples);
    expect(kept.length).toBe(20);
    expect(overflow).toBe(1);
    expect(kept[0].url).toBe('/api/x/0'); // request hỏng đầu tiên không bị bỏ
    expect(kept.some(s => s.url === '/api/x/20')).toBe(true); // mẫu cuối vẫn còn
    expect(kept.some(s => s.url === '/api/x/10')).toBe(false); // mẫu giữa bị cắt
  });
});

describe('toTechError — T025, T060 (E010)', () => {
  // T025 / T060
  it('lỗi có getter ném (mô phỏng circular/serialize fail) ⇒ hằng số cố định', () => {
    const err: any = {};
    Object.defineProperty(err, 'message', {
      get() {
        throw new Error('boom during access');
      },
    });
    const result = toTechError(err);
    expect(result).toEqual({
      type: 'SerializeError',
      message: 'unserializable',
    });
  });

  it('cắt message còn 512 ký tự, stack còn 2.000 ký tự', () => {
    const err = {
      name: 'Error',
      message: 'a'.repeat(600),
      stack: 'b'.repeat(2500),
    };
    const result = toTechError(err);
    expect(result.message.length).toBe(512);
    expect(result.stack!.length).toBe(2000);
  });

  it('type lấy từ constructor.name, không phải err.toString() thô', () => {
    class MyCustomError extends Error {}
    const err = new MyCustomError('oops');
    const result = toTechError(err);
    expect(result.type).toBe('MyCustomError');
    expect(result.message).not.toContain('MyCustomError:'); // không phải toString() thô
  });

  it('không có stack ⇒ trường stack vắng mặt (không phải undefined string)', () => {
    const result = toTechError({ name: 'Error', message: 'no stack here' });
    expect(result.stack).toBeUndefined();
    expect('stack' in result).toBe(false);
  });
});

// ─── phase-2 (webview-session-logs §2.5/FR-006) — detectDeviceModel ─────────
describe('detectDeviceModel — T009 (FR-006)', () => {
  // Android webview: token model đứng giữa "; Android x;" và " Build/")".
  it('T009: UA Android webview ⇒ suy ra đúng dòng máy (SM-S911B)', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007; wv) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.163 Mobile Safari/537.36';
    expect(detectDeviceModel(ua)).toBe('SM-S911B');
  });

  it('T009: UA Android model khác ⇒ đúng model tương ứng', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 13; 2210132C Build/TKQ1.220829.002; wv) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Mobile Safari/537.36';
    expect(detectDeviceModel(ua)).toBe('2210132C');
  });

  it('T009: UA iOS ⇒ iPhone (iOS không lộ model trong UA)', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
    expect(detectDeviceModel(ua)).toBe('iPhone');
    const ipad =
      'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Mobile/15E148';
    expect(detectDeviceModel(ipad)).toBe('iPad');
  });

  it('T009: UA Reduction ("K" placeholder) / rỗng / desktop ⇒ "" (không suy ra)', () => {
    const k =
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/119 ' +
      'Mobile Safari/537.36';
    expect(detectDeviceModel(k)).toBe('');
    expect(detectDeviceModel('')).toBe('');
    expect(
      detectDeviceModel(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/119 Safari/537.36',
      ),
    ).toBe('');
  });
});
