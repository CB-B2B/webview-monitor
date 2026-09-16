// Vitest's Node runtime ships a native `fetch` global (unlike the older
// jsdom bundled with Jest, which had none). Several tests intentionally rely
// on `typeof fetch === 'undefined'` to exercise the "fetch not supported"
// fallback (see transport.ts fetchNotSupported) without mocking fetch
// themselves — under Node's native fetch, that assumption silently breaks:
// an un-awaited real network call fires, resolves after the test ends, and
// pollutes later tests (outbox state) with a real HTTP round-trip.
//
// Delete global fetch before each test to restore the environment vp's
// original Jest suite actually ran against; tests that need fetch install
// their own mock explicitly via `(globalThis as any).fetch = ...`.
beforeEach(() => {
  delete (globalThis as { fetch?: typeof fetch }).fetch;
});
