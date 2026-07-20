/**
 * OpenTelemetry bootstrap — must be imported before anything else so
 * auto-instrumentation can patch http/express/pg/ioredis. No-op unless an
 * OTLP endpoint is configured.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

let sdk: NodeSDK | null = null;

if (process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) {
  sdk = new NodeSDK({
    serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'justgo-api',
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs instrumentation is noisy and rarely useful for an HTTP API
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
  sdk.start();
}

export async function shutdownOtel(): Promise<void> {
  await sdk?.shutdown();
}
