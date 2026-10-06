/**
 * OpenTelemetry bootstrap. The SDK packages (`@opentelemetry/sdk-node`,
 * `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/instrumentation-http`) are loaded
 * lazily so services run without them in local development; deployed images install them and set
 * OTEL_EXPORTER_OTLP_ENDPOINT. HTTP instrumentation propagates W3C trace context across service
 * calls, and broker messages carry `traceparent` in the event envelope.
 */

interface StartableSdk {
  start(): void;
  shutdown(): Promise<void>;
}

let sdk: StartableSdk | null = null;

type Loader = (name: string) => unknown;

export type TracingStartResult = 'started' | 'disabled' | 'sdk-not-installed' | 'already-started';

export function startTracing(
  serviceName: string,
  otlpEndpoint: string | undefined,
  // Lazy, optional dependency: the SDK is absent in local development builds.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  load: Loader = (name) => require(name) as unknown,
): TracingStartResult {
  if (otlpEndpoint === undefined) return 'disabled';
  if (sdk !== null) return 'already-started';
  try {
    const { NodeSDK } = load('@opentelemetry/sdk-node') as {
      NodeSDK: new (options: unknown) => StartableSdk;
    };
    const { OTLPTraceExporter } = load('@opentelemetry/exporter-trace-otlp-http') as {
      OTLPTraceExporter: new (options: { url: string }) => unknown;
    };
    const { HttpInstrumentation } = load('@opentelemetry/instrumentation-http') as {
      HttpInstrumentation: new (options: unknown) => unknown;
    };
    sdk = new NodeSDK({
      serviceName,
      traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint.replace(/\/$/, '')}/v1/traces` }),
      // Never record headers or bodies as span attributes.
      instrumentations: [
        new HttpInstrumentation({
          headersToSpanAttributes: {
            client: { requestHeaders: [] },
            server: { requestHeaders: [] },
          },
        }),
      ],
    });
    sdk.start();
    return 'started';
  } catch {
    return 'sdk-not-installed';
  }
}

export async function stopTracing(): Promise<void> {
  if (sdk !== null) {
    await sdk.shutdown();
    sdk = null;
  }
}
