import { expect, test, vi } from 'vitest';

const loaded = vi.hoisted(() => ({ names: [] as string[] }));
for (const name of ['@opentelemetry/api', '@opentelemetry/sdk-trace-base', '@opentelemetry/resources', '@opentelemetry/exporter-trace-otlp-http']) {
  vi.doMock(name, () => {
    loaded.names.push(name);
    return {};
  });
}

test('no OTel module is imported when no endpoint is set', async () => {
  const { createTracer, NOOP_SINK } = await import('../../src/telemetry/otel.js');
  await import('../../src/edge/server.js');
  await import('../../src/telemetry/metrics.js');
  const sink = await createTracer(null);
  expect(sink).toBe(NOOP_SINK);
  await sink.shutdown();
  expect(loaded.names).toEqual([]);
});
