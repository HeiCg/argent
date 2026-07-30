/**
 * The endpoint invariance that `otel.ts` relies on, proven against the REAL
 * OpenTelemetry exporter.
 *
 * `otel-endpoint.test.ts` mocks `@opentelemetry/exporter-logs-otlp-http`, so it
 * can only show that `otel.ts` passes `url` and `headers` to the constructor —
 * it cannot show that the SDK honours them over `OTEL_EXPORTER_OTLP_*`. An SDK
 * upgrade that flipped that precedence would keep every assertion there green
 * while telemetry silently started going wherever an env var pointed.
 *
 * So this drives the actual exporter against two loopback servers: one standing
 * in for the hard-coded collector, one for what a hostile env var would name.
 * Which server receives the export is the answer. No network is involved.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SeverityNumber } from "@opentelemetry/api-logs";

interface Capture {
  server: http.Server;
  url: string;
  requests: Array<{ path: string; headers: http.IncomingHttpHeaders }>;
}

async function startCapture(): Promise<Capture> {
  const requests: Capture["requests"] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push({ path: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { server, url: `http://127.0.0.1:${address.port}/v1/logs`, requests };
}

const OTLP_ENV_VARS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
] as const;

let saved: Record<string, string | undefined> = {};
let code: Capture;
let hostile: Capture;

beforeEach(async () => {
  saved = Object.fromEntries(OTLP_ENV_VARS.map((name) => [name, process.env[name]]));
  code = await startCapture();
  hostile = await startCapture();
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all(
    [code, hostile].map((c) => new Promise<void>((resolve) => c.server.close(() => resolve())))
  );
});

/** Emit one record through the same exporter/provider wiring `otel.ts` builds. */
async function exportOneRecord(url: string, token: string): Promise<void> {
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ "service.name": "argent" }),
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url,
          headers: { authorization: `Bearer ${token}` },
          timeoutMillis: 1_500,
          httpAgentOptions: { timeout: 1_500 },
        }),
        maxExportBatchSize: 20,
        scheduledDelayMillis: 10_000,
        exportTimeoutMillis: 1_500,
      }),
    ],
  });
  provider.getLogger("@argent/telemetry").emit({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    body: "endpoint_invariance_probe",
    attributes: { "distinct_id": "probe", "event.name": "endpoint_invariance_probe" },
  });
  // shutdown() force-flushes the batch and then tears the provider down, so the
  // export has been attempted by the time it resolves.
  await provider.shutdown();
}

describe("endpoint invariance against the real OTLP exporter", () => {
  it("delivers to the url passed in code while every OTLP env var names another host", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = hostile.url.replace("/v1/logs", "");
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = hostile.url;
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";

    await exportOneRecord(code.url, "real-ingest-token");

    expect(hostile.requests).toHaveLength(0);
    expect(code.requests).toHaveLength(1);
    expect(code.requests[0]!.path).toBe("/v1/logs");
  }, 15_000);

  it("keeps the code-supplied bearer token when an env var supplies another", async () => {
    // Getting redirected is one failure; shipping to the right collector under
    // an attacker's token is another. The explicit header has to win.
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer steal-me";
    process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = "authorization=Bearer steal-me-logs";

    await exportOneRecord(code.url, "real-ingest-token");

    expect(code.requests).toHaveLength(1);
    expect(code.requests[0]!.headers.authorization).toBe("Bearer real-ingest-token");
  }, 15_000);
});
