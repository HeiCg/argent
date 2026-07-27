import type { LogAttributes, Logger } from "@opentelemetry/api-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";

/**
 * Hard-coded OTLP/HTTP logs endpoint so env-var overrides cannot redirect
 * ingestion. Argent telemetry is exported as OpenTelemetry log records to
 * Software Mansion's own collector; because the endpoint is passed to the
 * exporter explicitly in code, the standard OTEL_EXPORTER_OTLP_* environment
 * variables are ignored (see otel-endpoint.test.ts) — the same anti-exfiltration
 * guarantee the previous PostHog transport enforced with its fixed host.
 */
export const OTLP_LOGS_ENDPOINT = "https://otel.swmansion.com/v1/logs"; // TODO(release): confirm the production collector URL.

/**
 * Build-time-injected ingest token (esbuild `define`, mirroring the
 * ARGENT_CLI_VERSION identifier in base-props.ts). It is substituted with a
 * string literal in the shipped bundle; unbundled source (tests / emergency-local
 * builds) leaves it undefined and falls back to "", which leaves the client
 * unconstructed and telemetry inert. A `globalThis.__ARGENT_OTEL_TOKEN_TEST`
 * member read is NOT used here: esbuild only rewrites the bare identifier, not
 * property accesses, so such a read would always be undefined.
 */
declare const ARGENT_OTEL_INGEST_TOKEN: string | undefined;

/** Resource `service.name` attribute value. */
const SERVICE_NAME = "argent";

/** Logger instrumentation-scope name. */
const LOGGER_NAME = "@argent/telemetry";

// Batching parameters: queue up to 20 records and flush every 10s (mirroring the
// previous PostHog client's flushAt/flushInterval). EXPORT_TIMEOUT_MS bounds each
// export AND caps the OTLP exporter's built-in retry loop, which treats a
// connection failure (ECONNREFUSED, timeout, DNS) as retryable and would otherwise
// keep re-sending with backoff. It is deliberately kept at or below index.ts's
// SHORT_FLUSH_TIMEOUT_MS drain budget so a stalled export to an unreachable/slow
// collector can't hold a short-lived command's process open past shutdown()'s
// bounded drain: the exporter's in-flight socket and retry timer are the only
// things keeping the event loop alive, and this deadline is what abandons them —
// but only once the socket is connected, so it is paired with an agent-level
// socket timeout below that covers connection establishment as well. A reachable
// collector answers in well under this bound, so delivery is unaffected.
const MAX_EXPORT_BATCH_SIZE = 20;
const SCHEDULED_DELAY_MS = 10_000;
const EXPORT_TIMEOUT_MS = 1_500;

/** One analytics event, ready to become a single OTLP log record. */
export interface EmitRecord {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
}

interface ResolvedConfig {
  endpoint: string;
  token: string;
  /** True iff `token` is a real ingest token (not "" / "otel_disabled"). */
  isUsable: boolean;
}

function readIngestToken(): string {
  const g = globalThis as { __ARGENT_OTEL_TOKEN_TEST?: unknown };
  const override = g.__ARGENT_OTEL_TOKEN_TEST;
  if (typeof override === "string") return override;
  if (typeof ARGENT_OTEL_INGEST_TOKEN === "string") return ARGENT_OTEL_INGEST_TOKEN;
  return "";
}

export function resolveConfig(): ResolvedConfig {
  const token = readIngestToken();

  // Sentinel guard for tests and emergency local builds.
  const isUsable = token !== "" && token !== "otel_disabled";
  return { endpoint: OTLP_LOGS_ENDPOINT, token, isUsable };
}

/**
 * Thin transport wrapper around the OpenTelemetry Logs SDK. One analytics event
 * becomes one OTLP log record: the event name is the record body, and the
 * per-machine distinct id plus the sanitized/base properties are its attributes.
 */
export interface TelemetryClient {
  emit(record: EmitRecord): void;
  shutdown(timeoutMs: number): Promise<void>;
}

// OTel attribute values may not be null/undefined (PostHog accepted null, and
// e.g. `cloud_agent` is null on the common non-cloud path). Drop those keys —
// absence is semantically identical to the prior explicit null.
function toAttributes(record: EmitRecord): LogAttributes {
  const attributes: LogAttributes = {
    "distinct_id": record.distinctId,
    "event.name": record.event,
  };
  for (const [key, value] of Object.entries(record.properties)) {
    if (value === null || value === undefined) continue;
    attributes[key] = value as LogAttributes[string];
  }
  return attributes;
}

class OtelClient implements TelemetryClient {
  private readonly provider: LoggerProvider;
  private readonly logger: Logger;

  constructor(config: ResolvedConfig) {
    const exporter = new OTLPLogExporter({
      url: config.endpoint,
      headers: { authorization: `Bearer ${config.token}` },
      timeoutMillis: EXPORT_TIMEOUT_MS,
      // The exporter bounds a request with `req.setTimeout()`, which Node only
      // arms once the socket is CONNECTED — so a collector whose address drops
      // packets (corporate egress filter, dead host behind a firewall) leaves a
      // socket stuck in the connecting state that no export deadline can reach,
      // holding the process open for the OS connect timeout (~75s on macOS)
      // after shutdown() has already resolved. The agent's socket timeout is
      // armed when the socket is CREATED, so it also covers connect: it fires,
      // the request emits 'timeout', and the exporter's handler destroys it.
      httpAgentOptions: { timeout: EXPORT_TIMEOUT_MS },
    });
    this.provider = new LoggerProvider({
      resource: resourceFromAttributes({ "service.name": SERVICE_NAME }),
      processors: [
        new BatchLogRecordProcessor({
          exporter,
          maxExportBatchSize: MAX_EXPORT_BATCH_SIZE,
          scheduledDelayMillis: SCHEDULED_DELAY_MS,
          exportTimeoutMillis: EXPORT_TIMEOUT_MS,
        }),
      ],
    });
    this.logger = this.provider.getLogger(LOGGER_NAME);
  }

  emit(record: EmitRecord): void {
    this.logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: record.event,
      attributes: toAttributes(record),
    });
  }

  async shutdown(_timeoutMs: number): Promise<void> {
    // LoggerProvider.shutdown() force-flushes the batch processor and then tears
    // it down. The overall time bound is enforced by the caller's Promise.race
    // and by the processor's exportTimeoutMillis; the arg is kept for signature
    // parity with the previous PostHog client.
    await this.provider.shutdown();
  }
}

let client: TelemetryClient | null | undefined;

export function getClient(): TelemetryClient | null {
  if (client !== undefined) return client;
  const config = resolveConfig();
  if (!config.isUsable) {
    client = null;
    return null;
  }

  try {
    client = new OtelClient(config);
  } catch {
    client = null;
    return null;
  }

  return client;
}

export function getConstructedClient(): TelemetryClient | null {
  return client ?? null;
}

export function resetClient(): void {
  client = undefined;
}
