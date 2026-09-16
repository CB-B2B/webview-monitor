// src/utils/monitor/__tests__/configFixture.ts
//
// Fixture MonitorConfig dùng chung cho test sau ticket 03
// (webview-monitor-package-extraction) — module không còn tự đọc
// process.env.* (ADR-0001), nên mọi test chạm getConfig() (trực tiếp hoặc
// gián tiếp qua env.ts/flag.ts/events.ts/chunker.ts/index.ts) phải gọi
// initConfig()/monitor.init() trước. Giá trị mặc định khớp với
// jest.setup-env.js cũ để giữ hành vi test không đổi.

import { MonitorConfig } from '../config';
import { STATIC_ROUTES, TEMPLATE_ROUTES } from '../routes';
import { STEP_NAMES } from '../types';

export function fixtureConfig(
  overrides: Partial<MonitorConfig> = {},
): MonitorConfig {
  return {
    steps: STEP_NAMES,
    staticRoutes: STATIC_ROUTES,
    templateRoutes: TEMPLATE_ROUTES,
    partnerId: 'vpbank',
    ingestUrl: 'https://obs-qrx.invalid/ingest',
    flagUrl: 'https://obs-qrx.invalid/flag',
    eventsIngestUrl: '',
    mainEndpoint: 'https://vpbank-svc.atcashback.com',
    sysEndpoint: 'https://sys.atcashback.com',
    releaseVersion: 'unknown',
    envName: 'dev',
    ...overrides,
  };
}
