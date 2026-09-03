import { describe, it, expect } from "vitest";
import {
  isEmulatorSerial,
  emulatorConsolePort,
  decideTransport,
} from "../src/utils/open-server-transport";

// Phase 3j: the host transport selection (serial + token + redir result -> transport).
// Pure, so it is pinned directly here; the on-device bind decision has its own
// Kotlin golden (EmulatorDetectTest).

describe("open-server transport selection (phase 3j)", () => {
  describe("isEmulatorSerial / emulatorConsolePort", () => {
    it("recognises emulator serials and derives the console port", () => {
      expect(isEmulatorSerial("emulator-5554")).toBe(true);
      expect(emulatorConsolePort("emulator-5554")).toBe(5554);
      expect(isEmulatorSerial("emulator-5556")).toBe(true);
      expect(emulatorConsolePort("emulator-5556")).toBe(5556);
    });
    it("rejects physical / wireless serials", () => {
      expect(isEmulatorSerial("ZF524RZBHD")).toBe(false);
      expect(emulatorConsolePort("ZF524RZBHD")).toBeNull();
      expect(isEmulatorSerial("192.168.1.10:5555")).toBe(false);
      expect(emulatorConsolePort("192.168.1.10:5555")).toBeNull();
      expect(isEmulatorSerial("emulator-")).toBe(false);
    });
  });

  describe("decideTransport", () => {
    it("uses redir when it is an emulator with a 0.0.0.0 listener, token, and redir ok", () => {
      const d = decideTransport({ serial: "emulator-5554", tokenExists: true, allPort: 40953, redirOk: true });
      expect(d.transport).toBe("redir");
    });
    it("falls back to adb-forward on a physical device", () => {
      const d = decideTransport({ serial: "ZF524RZBHD", tokenExists: true, allPort: 40953, redirOk: true });
      expect(d.transport).toBe("adb-forward");
      expect(d.reason).toContain("physical");
    });
    it("falls back when there is no 0.0.0.0 listener", () => {
      const d = decideTransport({ serial: "emulator-5554", tokenExists: true, allPort: undefined, redirOk: false });
      expect(d.transport).toBe("adb-forward");
      expect(d.reason).toContain("0.0.0.0");
    });
    it("falls back when the console auth token is missing", () => {
      const d = decideTransport({ serial: "emulator-5554", tokenExists: false, allPort: 40953, redirOk: false });
      expect(d.transport).toBe("adb-forward");
      expect(d.reason).toContain("token");
    });
    it("falls back when redir setup failed", () => {
      const d = decideTransport({ serial: "emulator-5554", tokenExists: true, allPort: 40953, redirOk: false });
      expect(d.transport).toBe("adb-forward");
      expect(d.reason).toContain("redir");
    });
  });
});
