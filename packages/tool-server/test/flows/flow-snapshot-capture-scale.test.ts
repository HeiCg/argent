import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { Registry, TypedEventEmitter } from "@argent/registry";
import type { ServiceEvents } from "@argent/registry";
import { createScreenshotTool } from "../../src/tools/screenshot";
import { SIMULATOR_SERVER_NAMESPACE } from "../../src/blueprints/simulator-server";
import { runSnapshot } from "../../src/tools/flows/flow-visual";
import type { ActionEnv } from "../../src/tools/flows/flow-actions";

// Only the settle is stubbed: this test drives the REAL invokeOnDevice, the
// REAL screenshot tool and the REAL differ against a fake simulator-server, so
// the scale the capture lands at is resolved exactly as it is in production.
vi.mock("../../src/tools/flows/flow-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/flow-actions")>();
  return { ...actual, settleTree: vi.fn(async () => ({})) };
});

const SCREEN_W = 1080;
const SCREEN_H = 2424;

let server: http.Server;
let apiUrl: string;
let tmpDir: string;
let shotDir: string;
let registry: Registry;
let env: ActionEnv;
/** Scales the fake server was asked for, in call order. */
let requested: (number | undefined)[];

async function writePng(file: string, w: number, h: number): Promise<void> {
  const png = new PNG({ width: w, height: h });
  png.data.fill(128);
  await fs.writeFile(file, PNG.sync.write(png));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-snap-scale-"));
  shotDir = path.join(tmpDir, "shots");
  await fs.mkdir(shotDir);
  requested = [];

  // Fake simulator-server: an Android emulator that cannot stream a full-res
  // frame. `httpScreenshot` omits `scale` from the body only when it resolves
  // to 1.0, so "no scale" IS the full-res request — answer it the way the
  // emulator does, with an HTTP 200 carrying a framebuffer size mismatch.
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = JSON.parse(raw || "{}") as { scale?: number };
      requested.push(body.scale);
      res.setHeader("Content-Type", "application/json");
      if (body.scale === undefined) {
        res.end(JSON.stringify({ error: "wrong data size, expected 7853760 got 17627328" }));
        return;
      }
      const file = path.join(shotDir, `shot-${requested.length}.png`);
      await writePng(file, Math.round(SCREEN_W * body.scale), Math.round(SCREEN_H * body.scale));
      res.end(JSON.stringify({ url: `http://127.0.0.1/media/${path.basename(file)}`, path: file }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  registry = new Registry();
  registry.registerBlueprint({
    namespace: SIMULATOR_SERVER_NAMESPACE,
    getURN: (id: string) => `${SIMULATOR_SERVER_NAMESPACE}:${id}`,
    factory: async () => ({
      api: { apiUrl, streamUrl: "", pressKey: () => {} },
      dispose: async () => {},
      events: new TypedEventEmitter<ServiceEvents>(),
    }),
  });
  registry.registerTool(createScreenshotTool(registry));

  env = {
    device: { platform: "android", id: "emulator-5554", kind: "emulator" },
    signal: undefined,
    registry,
    ctx: { artifacts: registry.artifacts },
  } as unknown as ActionEnv;
});

afterEach(async () => {
  delete process.env.ARGENT_SCREENSHOT_SCALE;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function opts(overrides: Record<string, unknown> = {}) {
  return {
    flowsDir: tmpDir,
    flowName: "checkout",
    name: "home",
    maxMismatch: 0.5,
    updateBaselines: false,
    appIdentity: "/apps/app-a",
    seenKeys: new Map<string, string>(),
    ...overrides,
  } as Parameters<typeof runSnapshot>[1];
}

describe("snapshot fallback capture scale", () => {
  it("keys a fallback baseline on the device, not on ARGENT_SCREENSHOT_SCALE", async () => {
    process.env.ARGENT_SCREENSHOT_SCALE = "0.3";
    const seeded = await runSnapshot(env, opts({ updateBaselines: true }));
    expect(seeded.status).toBe("pass");

    // Same emulator, same flow, a tool-server started with a different value of
    // an unrelated agent-detail knob.
    process.env.ARGENT_SCREENSHOT_SCALE = "0.5";
    const rerun = await runSnapshot(env, opts());

    // A clean comparison names the key it compared against in its reason.
    expect(rerun.status).toBe("pass");
    expect(rerun.reason).toContain(`(${seeded.snapshotKey}.png)`);
  });

  it("asks for full resolution first, then for a scale of its own", async () => {
    process.env.ARGENT_SCREENSHOT_SCALE = "0.5";

    await runSnapshot(env, opts({ updateBaselines: true }));

    // `httpScreenshot` omits `scale` only for a full-res request, so the first
    // entry is the full-res attempt; the second is the retry's own scale, not
    // the env var's.
    expect(requested).toEqual([undefined, 0.3]);
  });
});
