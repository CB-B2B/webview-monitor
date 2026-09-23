// StepName widened to `string` (was a closed 6-literal union hardcoded to
// vp's own step names) so a second host can pass its own step set. This is
// a compile-time-only regression check: no runtime behavior to assert
// (StepName is an opaque label — nothing in this package pattern-matches
// its literal value), so the guarantee IS that this file compiles.
import type { StepName } from '../types';

// A host with a step set that has nothing in common with vp's must satisfy
// StepName. Would fail to compile if StepName ever regresses to a closed
// union again.
const tpStepNames: ReadonlyArray<StepName> = [
  'emulator_token',
  'partner_id',
  'search_hint',
  'home_banner',
  'home_float_icon',
  'withdraw_config',
];

test('a second host\'s own step names satisfy StepName (compile-time proof — see import above)', () => {
  expect(tpStepNames.length).toBe(6);
});
