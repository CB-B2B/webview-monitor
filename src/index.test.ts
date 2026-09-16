import { describe, expect, it } from 'vitest';
import { VERSION, init } from './index';

// Trivial placeholder suite — proves the test/build pipeline works end to
// end. Replace with real coverage in ticket 04 when actual monitor logic
// lands (outbox retry, redaction, sampling, chunker, config validation...).
describe('placeholder', () => {
  it('exports a version string', () => {
    expect(VERSION).toBe('0.0.1');
  });

  it('init() does not throw', () => {
    expect(() => init({})).not.toThrow();
  });
});
