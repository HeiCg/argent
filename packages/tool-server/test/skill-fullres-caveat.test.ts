import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getScreenshotScale } from "../src/utils/simulator-client";
import { readAgentDocs, sentencesClaimingSize } from "./helpers/size-claims";

let docs: Array<{ name: string; text: string }> = [];

beforeAll(async () => {
  docs = await readAgentDocs();
});

// `screenshot` passes `scale` straight through and simulator-client turns the
// emulator's in-band rejection into a hard SIMULATOR_SCREENSHOT_FAILED, so a page
// that sends an agent at a full-resolution capture without naming that failure
// sends it at a call it cannot recover from. The claim keeps being copied into
// new pages, so pin the pairing rather than any one file's wording — the error
// string is the source of truth. Per file; and by sentence, because these pages
// hard-wrap and a claim split across two lines is in neither of them. An
// unrelated match is to be re-read, not narrowed away.
describe("agent docs reaching for a full-resolution screenshot", () => {
  it("finds some, so the per-file check below cannot pass vacuously", () => {
    expect(docs.filter(({ text }) => sentencesClaimingSize(text).length > 0)).not.toHaveLength(0);
  });

  it("every one of them names the emulators that reject it", () => {
    const unescorted = docs
      .filter(({ text }) => sentencesClaimingSize(text).length > 0)
      .filter(({ text }) => !text.includes("wrong data size"))
      .map(({ name, text }) => `${name}: ${sentencesClaimingSize(text)[0]}`);
    expect(unescorted).toEqual([]);
  });
});

describe("agent docs quoting the tool-server's screenshot scale", () => {
  // Spelled as a percentage in prose ("30% of original resolution") rather than
  // as the 0.3 the tool descriptions quote, so it drifts out of reach of the
  // cross-surface check in screenshot-diff-tool.test.ts.
  const quotes = (text: string): string[] =>
    text.split("\n").filter((line) => line.includes("of original resolution"));
  const quoted = (): string => `${getScreenshotScale() * 100}% of original resolution`;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("finds some, so the per-file check below cannot pass vacuously", () => {
    expect(docs.filter(({ text }) => quotes(text).length > 0)).not.toHaveLength(0);
  });

  it("every such line quotes the scale getScreenshotScale falls back to, for named platforms", () => {
    // Markdown ships as a static file, so it can only ever quote the default —
    // read the ambient env instead and the assertion fails on correct prose for
    // every developer who exports the var these same docs tell them about.
    vi.stubEnv("ARGENT_SCREENSHOT_SCALE", "");
    const wrong: string[] = [];
    for (const { name, text } of docs) {
      // Every such line, not the first: a second one is where a stale figure
      // sits unread while the first keeps the check green.
      for (const line of quotes(text)) {
        if (!line.includes(quoted())) {
          wrong.push(`${name}: does not quote "${quoted()}" — ${line.trim()}`);
        }
        // …and it says which platforms that is the default for. Chromium passes
        // no scale of its own, so a claim naming no platform is false there. Any
        // platform, not Chromium specifically: a page about one device class is
        // entitled to describe only that class.
        if (!/iOS|Android|Apple TV|Vega|Chromium/.test(line)) {
          wrong.push(`${name}: names no platform — ${line.trim()}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
