import { describe, expect, it } from "vitest";
import {
  activityShortName,
  deriveLabel,
  titleText,
  type LabelNode,
} from "../src/screen-graph/label";
import { resolveScreenTarget } from "../src/screen-graph/plan";

const b = (y1: number, y2: number): LabelNode["bounds"] => ({ x1: 0, y1, x2: 1000, y2 });

describe("activityShortName", () => {
  it("takes the last dotted segment", () => {
    expect(activityShortName("com.android.settings.SubSettings")).toBe("SubSettings");
  });
  it("handles a component form pkg/.Inner", () => {
    expect(activityShortName("com.android.settings/.Settings$WifiSettingsActivity")).toBe(
      "Settings$WifiSettingsActivity"
    );
  });
  it("is undefined for empty input", () => {
    expect(activityShortName(undefined)).toBeUndefined();
    expect(activityShortName("")).toBeUndefined();
  });
});

describe("titleText", () => {
  it("prefers an action_bar / toolbar title id", () => {
    const nodes: LabelNode[] = [
      { id: "android:id/action_bar_title", text: "Network & internet", bounds: b(50, 120) },
      { text: "Some body text", bounds: b(400, 460) },
    ];
    expect(titleText(nodes, 1920)).toBe("Network & internet");
  });

  it("falls back to the tallest text near the top", () => {
    const nodes: LabelNode[] = [
      { text: "Big Title", bounds: b(20, 140) },
      { text: "small", bounds: b(30, 60) },
      { text: "footer", bounds: b(1800, 1860) },
    ];
    expect(titleText(nodes, 1920)).toBe("Big Title");
  });

  it("is undefined when there is no text", () => {
    expect(titleText([{ bounds: b(0, 10) }], 1920)).toBeUndefined();
  });
});

describe("deriveLabel", () => {
  it("combines activity short name and title", () => {
    const label = deriveLabel({
      activity: "com.android.settings.SubSettings",
      nodes: [
        {
          id: "com.android.settings:id/action_bar",
          text: "Network & internet",
          bounds: b(40, 120),
        },
      ],
      screenHeight: 1920,
    });
    expect(label).toBe("SubSettings: Network & internet");
  });

  it("uses only the activity when no title is found", () => {
    expect(deriveLabel({ activity: "com.android.settings.Settings", nodes: [] })).toBe("Settings");
  });

  it("uses only the title when no activity is given", () => {
    expect(
      deriveLabel({ nodes: [{ id: "x:id/toolbar_title", text: "Display", bounds: b(0, 100) }] })
    ).toBe("Display");
  });

  it("is undefined when neither half is available", () => {
    expect(deriveLabel({ nodes: [] })).toBeUndefined();
  });
});

describe("a derived label is a navigate-to address", () => {
  it("resolves by the full label and by its title half", () => {
    const label = deriveLabel({
      activity: "com.android.settings.SubSettings",
      nodes: [
        { id: "android:id/action_bar_title", text: "Network & internet", bounds: b(40, 120) },
      ],
      screenHeight: 1920,
    })!;
    const graph = {
      edges: [],
      nodes: {
        "0123456789abcdef": {
          hash: "0123456789abcdef",
          firstSeen: 0,
          lastSeen: 0,
          visits: 1,
          compact: "",
          index: {},
          label,
        },
      },
    };
    const hit = { kind: "node", hash: "0123456789abcdef" };
    expect(resolveScreenTarget(graph, { label })).toEqual(hit);
    expect(resolveScreenTarget(graph, { label: "network & INTERNET" })).toEqual(hit);
  });
});
