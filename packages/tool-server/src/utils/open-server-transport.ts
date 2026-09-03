import * as net from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Transport selection for the open device-server host client (phase 3j).
 *
 * The default `adb forward` path routes the reply through the host `adb server`,
 * which holds the final partial TCP segment ~40 ms (a delayed-ACK-class stall that
 * padding the reply to a full MSS does NOT clear — the experiment in
 * `bench-open-vs-proprietary.ts` proved it is the adb server hop, not our receiver).
 * The emulator console's `redir` forwards a host port straight to the guest via
 * qemu's user-mode network, bypassing adbd and the adb server; on the phase-3j
 * bench that dropped the recv-gap tail from ~40 ms p95 to <1 ms.
 *
 * `redir` is therefore preferred FOR EMULATORS ONLY, and only when it actually
 * connects; anything else falls back to `adb forward`. Physical devices have no
 * emulator console and always use `adb forward`.
 */

export type Transport = "redir" | "adb-forward";

/** Whether a serial is an Android emulator (`emulator-NNNN`), which has a console. */
export function isEmulatorSerial(serial: string): boolean {
  return /^emulator-\d+$/.test(serial);
}

/** Console TCP port for an emulator serial: `emulator-NNNN` -> NNNN. Null otherwise. */
export function emulatorConsolePort(serial: string): number | null {
  const m = /^emulator-(\d+)$/.exec(serial);
  return m ? parseInt(m[1]!, 10) : null;
}

/** Path to the emulator console auth token file (`~/.emulator_console_auth_token`). */
export function consoleAuthTokenPath(): string {
  return join(homedir(), ".emulator_console_auth_token");
}

/** The emulator console auth token, or null when the file is absent/empty/unreadable. */
export function readConsoleAuthToken(): string | null {
  try {
    const p = consoleAuthTokenPath();
    if (!existsSync(p)) return null;
    const t = readFileSync(p, "utf8").trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

export interface TransportDecision {
  transport: Transport;
  reason: string;
}

/**
 * The single source of truth for which transport a session uses (phase 3j), given
 * the facts gathered at startup. Pure so it is unit-tested directly:
 * - non-emulator serial               -> adb-forward (no console)
 * - emulator but no 0.0.0.0 listener  -> adb-forward (redir can't reach loopback)
 * - emulator but no console token      -> adb-forward (can't drive the console)
 * - emulator, all present, redir failed-> adb-forward (fallback)
 * - emulator, all present, redir ok    -> redir
 */
export function decideTransport(opts: {
  serial: string;
  tokenExists: boolean;
  allPort: number | undefined;
  redirOk: boolean;
}): TransportDecision {
  if (!isEmulatorSerial(opts.serial)) {
    return { transport: "adb-forward", reason: `physical device (serial '${opts.serial}' is not emulator-N)` };
  }
  if (opts.allPort === undefined) {
    return { transport: "adb-forward", reason: "server has no 0.0.0.0 listener (emulator bind not active)" };
  }
  if (!opts.tokenExists) {
    return { transport: "adb-forward", reason: "no emulator console auth token file" };
  }
  if (!opts.redirOk) {
    return { transport: "adb-forward", reason: "emulator console redir setup failed" };
  }
  return { transport: "redir", reason: "emulator + console token + redir add ok" };
}

/** Grab a free host TCP loopback port (for the redir host side). */
export async function freeHostPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * Drive the emulator console (127.0.0.1:consolePort): authenticate with `token`,
 * run each command, resolve once the last is acknowledged. The console prints `OK`
 * after the banner, after `auth`, and after each command (or `KO` on error), so
 * progress is tracked by counting `OK` lines. Best-effort: rejects on timeout / KO.
 */
export async function emulatorConsole(
  consolePort: number,
  commands: string[],
  token: string,
  timeoutMs = 6000
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: consolePort });
    let buf = "";
    let authed = false;
    let sent = 0;
    const okTarget = 1 /* banner */ + 1 /* auth */ + commands.length;
    const okCount = (): number => (buf.match(/^OK\s*$/gm) || []).length;
    const cleanup = (): void => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
    };
    sock.setTimeout(timeoutMs, () => {
      cleanup();
      reject(new Error("emulator console timed out"));
    });
    sock.on("error", (e) => {
      cleanup();
      reject(e);
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      if (/^KO\b/m.test(buf)) {
        cleanup();
        reject(new Error(`console KO: ${buf.trim().slice(-200)}`));
        return;
      }
      const oks = okCount();
      if (!authed && oks >= 1) {
        authed = true;
        sock.write(`auth ${token}\n`);
        return;
      }
      while (authed && sent < commands.length && oks >= 2 + sent) {
        sock.write(commands[sent] + "\n");
        sent++;
      }
      if (authed && sent === commands.length && oks >= okTarget) {
        sock.write("quit\n");
        cleanup();
        resolve();
      }
    });
  });
}

/** `redir add tcp:<hostPort>:<guestPort>` over the emulator console. */
export async function redirAdd(
  consolePort: number,
  hostPort: number,
  guestPort: number,
  token: string
): Promise<void> {
  await emulatorConsole(consolePort, [`redir add tcp:${hostPort}:${guestPort}`], token);
}

/** `redir del tcp:<hostPort>` over the emulator console (best-effort cleanup). */
export async function redirDel(consolePort: number, hostPort: number, token: string): Promise<void> {
  await emulatorConsole(consolePort, [`redir del tcp:${hostPort}`], token);
}
