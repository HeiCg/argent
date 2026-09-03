/**
 * scrcpy control-channel touch backend (open-server phase 3f).
 *
 * The default open path injects tap/swipe/gesture through the Kotlin
 * `android-device-server`, i.e. `UiAutomation.injectInputEvent` — two binder
 * round-trips plus a sync. This backend instead drives the SAME public technique
 * scrcpy (Apache-2.0) uses: a `shell`-uid `app_process` on the device receives
 * touch control messages over a socket and calls `InputManager.injectInputEvent`
 * directly, skipping the instrumentation hop. It is reached through
 * `@yume-chan/adb-scrcpy` (`client.controller.injectTouch`, true multi-pointer via
 * a `bigint` pointerId), with the scrcpy server 3.3.1 jar fetched by
 * `@yume-chan/fetch-scrcpy-server` (the scrcpy release — never Argent's tarball).
 *
 * Only tap/swipe/gesture move here; everything else (describe, state, screenshot,
 * typeText, key, await*) stays on the Kotlin NDJSON channel. The two coexist:
 * scrcpy runs as its own shell-uid process alongside the instrumentation server.
 *
 * The gesture SHAPES come from {@link scrcpy-inject-timeline} (a faithful port of
 * the on-device Kotlin timelines) and are paced here against a real wall clock —
 * exactly as `MotionInjector` paces its frames — so fling fidelity is unchanged.
 * Ordering with a following read on the Kotlin channel is the caller's job: it
 * calls the `flushInput` RPC after each action (see the blueprint seam).
 *
 * Lifecycle: lazy connect on first use, reconnect on a dropped control channel,
 * `dispose()` closes the scrcpy client and the adb transport. This module is
 * imported dynamically by the blueprint only when fast-inject is enabled, so the
 * pure timeline module (and its tests) never pull the `@yume-chan` ESM deps.
 */
import { readFile } from "node:fs/promises";
import { Adb, AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import { BIN, VERSION } from "@yume-chan/fetch-scrcpy-server";
import { ReadableStream } from "@yume-chan/stream-extra";
import { AndroidMotionEventAction, type ScrcpyControlMessageWriter } from "@yume-chan/scrcpy";
import {
  buildGestureTimeline,
  buildSwipeTimeline,
  buildTapTimeline,
  TouchAction,
  type GesturePointer,
  type TouchFrame,
} from "./scrcpy-inject-timeline";

/** Same device path scrcpy itself uses; pushed once per device, then reused. */
const DEVICE_SERVER_PATH = "/data/local/tmp/scrcpy-server.jar";

/** Map the pure-timeline action to the scrcpy wire action (same numeric values). */
function wireAction(a: TouchFrame["action"]): AndroidMotionEventAction {
  switch (a) {
    case TouchAction.Down:
      return AndroidMotionEventAction.Down;
    case TouchAction.Up:
      return AndroidMotionEventAction.Up;
    default:
      return AndroidMotionEventAction.Move;
  }
}

export interface ScrcpyTapOpts {
  clickCount?: number;
  holdMs?: number;
  gapMs?: number;
}

/** One pointer's device-pixel path (matches the blueprint's GesturePointerPath). */
export interface ScrcpyGesturePointer {
  id?: number;
  points: Array<{ x: number; y: number; tMs: number }>;
}

export interface ScrcpyInjectBackend {
  tap(x: number, y: number, opts?: ScrcpyTapOpts): Promise<void>;
  swipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    steps: number,
    holdEndMs?: number
  ): Promise<void>;
  gesture(pointers: ScrcpyGesturePointer[]): Promise<void>;
  dispose(): Promise<void>;
}

export interface ScrcpyBackendDeps {
  serial: string;
  /**
   * Rotation-aware display metrics (the Kotlin server's cheap `getScreenSize`).
   * Read on every action to pick the `videoWidth/videoHeight` scrcpy converts
   * against and to self-correct after a rotation (F21), the same way the host
   * gesture path already peeks it.
   */
  getScreenSize: () => Promise<{
    screenWidth: number;
    screenHeight: number;
    displayRotation: number;
  }>;
  adbServerHost?: string;
  adbServerPort?: number;
  log?: (msg: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class ScrcpyInjectBackendImpl implements ScrcpyInjectBackend {
  private readonly serial: string;
  private readonly getScreenSize: ScrcpyBackendDeps["getScreenSize"];
  private readonly adbServerHost: string;
  private readonly adbServerPort: number;
  private readonly log: (msg: string) => void;

  private adb: Adb | null = null;
  private client: AdbScrcpyClient<AdbScrcpyOptionsLatest<false>> | null = null;
  private controller: ScrcpyControlMessageWriter | null = null;
  private starting: Promise<void> | null = null;
  private disposed = false;
  /** Rotation-keyed geometry cache; refreshed when `getScreenSize` reports a new rotation. */
  private geom: { width: number; height: number; rotation: number } | null = null;

  constructor(deps: ScrcpyBackendDeps) {
    this.serial = deps.serial;
    this.getScreenSize = deps.getScreenSize;
    this.adbServerHost = deps.adbServerHost ?? "127.0.0.1";
    this.adbServerPort = deps.adbServerPort ?? 5037;
    this.log = deps.log ?? (() => undefined);
  }

  /** (Re)establish the control-only scrcpy session if it is not currently up. */
  private async ensureStarted(): Promise<void> {
    if (this.disposed) throw new Error("scrcpy inject backend disposed");
    if (this.controller) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    const connector = new AdbServerNodeTcpConnector({
      host: this.adbServerHost,
      port: this.adbServerPort,
    });
    const serverClient = new AdbServerClient(connector);
    const adb = await serverClient.createAdb({ serial: this.serial });
    this.adb = adb;

    await this.ensureServerPushed(adb);

    // Control-only: no video, no audio. tunnelForward mirrors device-farm's setup
    // (a forward tunnel the client dials), and `version` pins the wire protocol to
    // the 3.3.1 jar even though AdbScrcpyOptionsLatest targets a newer default.
    const options = new AdbScrcpyOptionsLatest<false>(
      {
        video: false,
        audio: false,
        control: true,
        tunnelForward: true,
        cleanup: true,
      },
      { version: VERSION }
    );

    const client = await AdbScrcpyClient.start(adb, DEVICE_SERVER_PATH, options);
    const controller = client.controller;
    if (!controller) {
      await client.close().catch(() => undefined);
      throw new Error("scrcpy started without a control channel (controller is undefined)");
    }
    this.client = client;
    this.controller = controller;

    // Drop cached handles if the scrcpy process exits, so the next action redials.
    void client.exited
      .catch(() => undefined)
      .then(() => {
        if (this.client === client) {
          this.client = null;
          this.controller = null;
          this.log(`scrcpy control channel for ${this.serial} closed; will reconnect on next use`);
        }
      });
    this.log(`scrcpy control channel up for ${this.serial} (server ${VERSION})`);
  }

  private async ensureServerPushed(adb: Adb): Promise<void> {
    // Idempotent: only push the jar when it is not already on the device.
    try {
      const out = await adb.subprocess.noneProtocol
        .spawnWaitText(`test -f ${DEVICE_SERVER_PATH} && echo present || echo absent`)
        .catch(() => "absent");
      if (out.trim().endsWith("present")) return;
    } catch {
      /* fall through to push */
    }
    const bytes = new Uint8Array(await readFile(BIN));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    await AdbScrcpyClient.pushServer(adb, stream, DEVICE_SERVER_PATH);
    this.log(`pushed scrcpy server ${VERSION} to ${this.serial}:${DEVICE_SERVER_PATH}`);
  }

  /** Current device geometry to convert coordinates against (rotation-aware). */
  private async displaySize(): Promise<{ width: number; height: number }> {
    const s = await this.getScreenSize();
    const rotation = s.displayRotation;
    if (
      this.geom &&
      this.geom.rotation === rotation &&
      this.geom.width > 0 &&
      this.geom.height > 0
    ) {
      return { width: this.geom.width, height: this.geom.height };
    }
    if (s.screenWidth > 0 && s.screenHeight > 0) {
      this.geom = { width: s.screenWidth, height: s.screenHeight, rotation };
      return { width: s.screenWidth, height: s.screenHeight };
    }
    // Transient 0×0 while reconfiguring: reuse last known-good geometry.
    if (this.geom) return { width: this.geom.width, height: this.geom.height };
    throw new Error(`scrcpy backend: display size unavailable for ${this.serial}`);
  }

  /**
   * Inject a whole timeline, paced against a real wall clock anchored at the
   * gesture start — mirroring `MotionInjector`'s F17 pacing: each frame waits only
   * for the time still remaining until its slot, so a slow write does not push the
   * rest of the gesture late and the VelocityTracker sees true arrival times.
   */
  private async injectTimeline(frames: TouchFrame[]): Promise<void> {
    await this.ensureStarted();
    const controller = this.controller;
    if (!controller) throw new Error("scrcpy control channel unavailable");
    const { width, height } = await this.displaySize();
    const anchor = performance.now();
    for (const f of frames) {
      const wait = anchor + f.tMs - performance.now();
      if (wait > 0) await sleep(wait);
      await controller.injectTouch({
        action: wireAction(f.action),
        pointerId: BigInt(f.pointerId),
        pointerX: Math.round(f.x),
        pointerY: Math.round(f.y),
        videoWidth: width,
        videoHeight: height,
        pressure: f.pressure,
        actionButton: 0,
        buttons: 0,
      });
    }
  }

  async tap(x: number, y: number, opts: ScrcpyTapOpts = {}): Promise<void> {
    await this.injectTimeline(
      buildTapTimeline(x, y, {
        clickCount: opts.clickCount ?? 1,
        holdMs: opts.holdMs ?? 50,
        gapMs: opts.gapMs ?? 100,
      })
    );
  }

  async swipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    steps: number,
    holdEndMs = 0
  ): Promise<void> {
    await this.injectTimeline(buildSwipeTimeline(startX, startY, endX, endY, steps, holdEndMs));
  }

  async gesture(pointers: ScrcpyGesturePointer[]): Promise<void> {
    const normalized: GesturePointer[] = pointers.map((p, i) => ({
      id: p.id ?? i,
      points: p.points,
    }));
    await this.injectTimeline(buildGestureTimeline(normalized));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const client = this.client;
    this.client = null;
    this.controller = null;
    if (client) await client.close().catch(() => undefined);
    const adb = this.adb;
    this.adb = null;
    if (adb) await adb.close().catch(() => undefined);
  }
}

/** Construct (but do not yet connect) a scrcpy touch backend for one device. */
export function createScrcpyInjectBackend(deps: ScrcpyBackendDeps): ScrcpyInjectBackend {
  return new ScrcpyInjectBackendImpl(deps);
}
