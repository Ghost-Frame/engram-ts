// ============================================================================
// TRACING - OpenTelemetry distributed tracing for Engram
// Must be imported BEFORE all other modules in server-split.ts
// ============================================================================

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, SEMRESATTRS_DEPLOYMENT_ENVIRONMENT } from "@opentelemetry/semantic-conventions";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import type { IncomingMessage } from "node:http";

const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.ENGRAM_OTLP_ENDPOINT || "";
const SERVICE_ENV = process.env.OTEL_DEPLOYMENT_ENVIRONMENT || process.env.ENGRAM_ENV || "production";

const IGNORED_PATHS = new Set(["/health", "/live", "/ready", "/metrics"]);

let sdk: NodeSDK | null = null;

if (OTLP_ENDPOINT) {
  const version = process.env.npm_package_version || "unknown";
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "engram",
      [ATTR_SERVICE_VERSION]: version,
      [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: SERVICE_ENV,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${OTLP_ENDPOINT}/v1/traces`,
    }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req: IncomingMessage) => IGNORED_PATHS.has(req.url || ""),
      }),
    ],
  });
  sdk.start();
  console.log(JSON.stringify({ level: "info", ts: new Date().toISOString(), msg: "otel_tracing_enabled", endpoint: OTLP_ENDPOINT, service: "engram" }));

  process.on("SIGTERM", () => { sdk?.shutdown(); });
  process.on("SIGINT", () => { sdk?.shutdown(); });
}

// ---- Tracing helpers for manual instrumentation ----

const tracer = trace.getTracer("engram");

export function startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span {
  return tracer.startSpan(name, { attributes });
}

export function withSpan<T>(name: string, attributes: Record<string, string | number | boolean>, fn: (span: Span) => T): T {
  return tracer.startActiveSpan(name, { attributes }, (span) => {
    try {
      const result = fn(span);
      if (result instanceof Promise) {
        return (result as any).then((v: T) => {
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return v;
        }).catch((e: Error) => {
          span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
          span.recordException(e);
          span.end();
          throw e;
        });
      }
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (e: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
      span.recordException(e);
      span.end();
      throw e;
    }
  });
}

export function spanEvent(span: Span, name: string, attributes?: Record<string, string | number>) {
  span.addEvent(name, attributes);
}

export { tracer, SpanStatusCode };
export type { Span };
