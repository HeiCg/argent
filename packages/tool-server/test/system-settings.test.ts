import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

vi.mock("../src/utils/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/adb")>();
  return {
    adbShell: vi.fn(async () => ""),
    shellQuote: actual.shellQuote,
  };
});

import { FAILURE_CODES, getFailureSignal, zodObjectToJsonSchema } from "@argent/registry";
import { systemSettingsTool } from "../src/tools/system-settings";
import { iosImpl } from "../src/tools/system-settings/platforms/ios";
import { androidImpl } from "../src/tools/system-settings/platforms/android";
import { TEXT_SIZE_VALUES } from "../src/tools/system-settings/types";
import type { SystemSettingsParams } from "../src/tools/system-settings/types";
import { adbShell } from "../src/utils/adb";
import { InvalidToolInputError } from "../src/utils/capability";

const mockAdbShell = vi.mocked(adbShell);

const IOS_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const ANDROID_SERIAL = "emulator-5554";

// FailureError attaches its FailureSignal under a non-enumerable symbol, so
// assert through the public accessor. The `typeof code === "string"` guard is
// load-bearing: if a FAILURE_CODES member ever resolves to `undefined` (e.g. a
// stale @argent/registry dist that predates a new code), the matcher would
// otherwise degrade to `undefined === undefined` and pass for any rejection.
function failsWith(code: string): (err: unknown) => boolean {
  return (err) => typeof code === "string" && getFailureSignal(err)?.error_code === code;
}

// promisify(execFile) with the mocked (symbol-less) execFile falls back to
// standard callback promisification: resolve = success, cb(err) = failure.
function execFileSucceeds(): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, out?: unknown) => void) => {
      cb(null, { stdout: "", stderr: "" });
    }
  );
}

function execFileFails(message: string): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => {
      cb(Object.assign(new Error(message), { code: 1, stderr: message }));
    }
  );
}

beforeEach(() => {
  execFileMock.mockReset();
  mockAdbShell.mockReset();
  mockAdbShell.mockImplementation(async () => "");
});

describe("system-settings failure codes are defined", () => {
  // Guards the whole suite: `failsWith` compares against these constants, and a
  // stale @argent/registry dist that predates them resolves them to `undefined`,
  // silently defanging every assertion. Assert they are real strings.
  it("resolves the three system-settings codes to strings", () => {
    for (const code of [
      "SYSTEM_SETTING_UNSUPPORTED",
      "IOS_SYSTEM_SETTING_FAILED",
      "ANDROID_SYSTEM_SETTING_FAILED",
    ] as const) {
      expect(typeof FAILURE_CODES[code], code).toBe("string");
    }
  });
});

describe("system-settings schema", () => {
  const schema = systemSettingsTool.zodSchema!;

  it("accepts each supported setting", () => {
    expect(schema.safeParse({ udid: IOS_UDID, setting: "appearance", value: "dark" }).success).toBe(
      true
    );
    expect(
      schema.safeParse({ udid: IOS_UDID, setting: "increase-contrast", value: "enabled" }).success
    ).toBe(true);
    expect(schema.safeParse({ udid: IOS_UDID, setting: "text-size", value: "large" }).success).toBe(
      true
    );
  });

  it("rejects an unknown setting", () => {
    expect(schema.safeParse({ udid: IOS_UDID, setting: "brightness", value: "50" }).success).toBe(
      false
    );
  });

  it("rejects an empty udid or empty value", () => {
    expect(schema.safeParse({ udid: "", setting: "appearance", value: "dark" }).success).toBe(
      false
    );
    expect(schema.safeParse({ udid: IOS_UDID, setting: "appearance", value: "" }).success).toBe(
      false
    );
  });

  it("derives a JSON schema with the setting enum and all three fields required", () => {
    const json = zodObjectToJsonSchema(schema) as {
      required?: string[];
      properties?: Record<string, { enum?: string[]; type?: string }>;
    };
    expect(json.required).toEqual(["udid", "setting", "value"]);
    expect(json.properties?.setting?.enum).toEqual([
      "appearance",
      "increase-contrast",
      "text-size",
    ]);
    // `value` is validated per-setting in the handler, not the schema, so it is a
    // plain string here — pin that so a later refactor doesn't over-constrain it.
    expect(json.properties?.value?.type).toBe("string");
  });
});

describe("system-settings value validation (platform-agnostic, runs before dispatch)", () => {
  it("rejects a value not legal for the setting and lists the valid ones", async () => {
    const rejection = expect(
      systemSettingsTool.execute!({}, { udid: IOS_UDID, setting: "appearance", value: "sepia" })
    ).rejects;
    await rejection.toSatisfy(failsWith(FAILURE_CODES.SYSTEM_SETTING_UNSUPPORTED));
    await rejection.toThrow(/Valid values: light, dark/);
    // An out-of-set value is a caller input error → InvalidToolInputError, which
    // the HTTP layer maps to 400 (not a generic 500).
    await rejection.toBeInstanceOf(InvalidToolInputError);
    // Short-circuits before any platform command runs.
    expect(execFileMock).not.toHaveBeenCalled();
    expect(mockAdbShell).not.toHaveBeenCalled();
  });

  it("lists the Dynamic Type categories when a text-size value is invalid", async () => {
    await expect(
      systemSettingsTool.execute!({}, { udid: IOS_UDID, setting: "text-size", value: "huge" })
    ).rejects.toThrow(/accessibility-extra-extra-extra-large/);
  });
});

describe("system-settings iOS branch", () => {
  function params(overrides: Partial<SystemSettingsParams>): SystemSettingsParams {
    return { udid: IOS_UDID, setting: "appearance", value: "dark", ...overrides };
  }

  it("appearance runs `simctl ui <udid> appearance <value>`", async () => {
    execFileSucceeds();
    const result = await iosImpl.handler({}, params({ setting: "appearance", value: "dark" }), {
      id: IOS_UDID,
      platform: "ios",
      kind: "simulator",
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe("xcrun");
    expect(args).toEqual(["simctl", "ui", IOS_UDID, "appearance", "dark"]);
    expect(result).toEqual({ setting: "appearance", value: "dark", applied: "appearance=dark" });
  });

  it("increase-contrast maps to simctl's `increase_contrast` option", async () => {
    execFileSucceeds();
    const result = await iosImpl.handler(
      {},
      params({ setting: "increase-contrast", value: "enabled" }),
      { id: IOS_UDID, platform: "ios", kind: "simulator" }
    );
    expect(execFileMock.mock.calls[0]![1]).toEqual([
      "simctl",
      "ui",
      IOS_UDID,
      "increase_contrast",
      "enabled",
    ]);
    expect(result.applied).toBe("increase_contrast=enabled");
  });

  it("text-size maps to simctl's `content_size` option and passes the category through", async () => {
    execFileSucceeds();
    const result = await iosImpl.handler(
      {},
      params({ setting: "text-size", value: "accessibility-large" }),
      { id: IOS_UDID, platform: "ios", kind: "simulator" }
    );
    expect(execFileMock.mock.calls[0]![1]).toEqual([
      "simctl",
      "ui",
      IOS_UDID,
      "content_size",
      "accessibility-large",
    ]);
    expect(result.applied).toBe("content_size=accessibility-large");
  });

  it("a shutdown-simulator failure carries a boot-device hint + IOS_SYSTEM_SETTING_FAILED", async () => {
    execFileFails(
      "An error was encountered processing the command (domain=NSCocoaErrorDomain, code=405):\nUnable to lookup in current state: Shutdown"
    );
    const rejection = expect(
      iosImpl.handler({}, params({}), { id: IOS_UDID, platform: "ios", kind: "simulator" })
    ).rejects;
    await rejection.toSatisfy(failsWith(FAILURE_CODES.IOS_SYSTEM_SETTING_FAILED));
    await rejection.toThrow(/must be booted first — use boot-device/);
  });

  it("an `unsupported` runtime failure carries a newer-runtime hint", async () => {
    execFileFails("increase_contrast: unsupported");
    await expect(
      iosImpl.handler({}, params({ setting: "increase-contrast", value: "enabled" }), {
        id: IOS_UDID,
        platform: "ios",
        kind: "simulator",
      })
    ).rejects.toThrow(/isn't supported by this simulator's iOS runtime/);
  });

  it("other simctl failures surface as IOS_SYSTEM_SETTING_FAILED without a spurious hint", async () => {
    execFileFails("Invalid device: nope");
    const rejection = expect(
      iosImpl.handler({}, params({}), { id: IOS_UDID, platform: "ios", kind: "simulator" })
    ).rejects;
    await rejection.toSatisfy(failsWith(FAILURE_CODES.IOS_SYSTEM_SETTING_FAILED));
    await rejection.not.toThrow(/must be booted first|isn't supported/);
  });
});

describe("system-settings Android branch", () => {
  const androidDevice = { id: ANDROID_SERIAL, platform: "android", kind: "emulator" } as const;

  function params(overrides: Partial<SystemSettingsParams>): SystemSettingsParams {
    return { udid: ANDROID_SERIAL, setting: "appearance", value: "dark", ...overrides };
  }

  it("appearance dark runs `cmd uimode night yes`", async () => {
    const result = await androidImpl.handler({}, params({ value: "dark" }), androidDevice);
    expect(mockAdbShell).toHaveBeenCalledTimes(1);
    const [serial, shellCmd] = mockAdbShell.mock.calls[0]!;
    expect(serial).toBe(ANDROID_SERIAL);
    expect(shellCmd).toBe("cmd uimode night yes");
    expect(result).toEqual({ setting: "appearance", value: "dark", applied: "night_mode=yes" });
  });

  it("appearance light runs `cmd uimode night no`", async () => {
    await androidImpl.handler({}, params({ value: "light" }), androidDevice);
    expect(mockAdbShell.mock.calls[0]![1]).toBe("cmd uimode night no");
  });

  it("increase-contrast disabled clears the high_text_contrast_enabled flag", async () => {
    const result = await androidImpl.handler(
      {},
      params({ setting: "increase-contrast", value: "disabled" }),
      androidDevice
    );
    expect(mockAdbShell.mock.calls[0]![1]).toBe("settings put secure high_text_contrast_enabled 0");
    expect(result.applied).toBe("high_text_contrast_enabled=0");
  });

  it("text-size sets a font_scale float for the mapped category", async () => {
    const result = await androidImpl.handler(
      {},
      params({ setting: "text-size", value: "accessibility-large" }),
      androidDevice
    );
    expect(mockAdbShell.mock.calls[0]![1]).toBe("settings put system font_scale 1.94");
    expect(result.applied).toBe("font_scale=1.94");
  });

  it("every text-size category maps to a defined font_scale (no `undefined` reaches adb)", async () => {
    for (const size of TEXT_SIZE_VALUES) {
      mockAdbShell.mockClear();
      const result = await androidImpl.handler(
        {},
        params({ setting: "text-size", value: size }),
        androidDevice
      );
      const shellCmd = mockAdbShell.mock.calls[0]![1] as string;
      expect(shellCmd, size).toMatch(/^settings put system font_scale \d/);
      expect(shellCmd, size).not.toContain("undefined");
      expect(result.applied, size).toMatch(/^font_scale=\d/);
    }
  });

  it("an adb failure surfaces as ANDROID_SYSTEM_SETTING_FAILED", async () => {
    mockAdbShell.mockRejectedValueOnce(new Error("error: device offline"));
    await expect(androidImpl.handler({}, params({}), androidDevice)).rejects.toSatisfy(
      failsWith(FAILURE_CODES.ANDROID_SYSTEM_SETTING_FAILED)
    );
  });
});
