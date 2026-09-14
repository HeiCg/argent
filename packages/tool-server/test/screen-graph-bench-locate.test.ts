import { describe, expect, it } from "vitest";
import { pickUniqueNode, normLc, type QueryNodeLite } from "../src/screen-graph/bench/locate";
import { parseDescribeLocate, describeLinesToNodes } from "../src/screen-graph/bench/describe-locate";
import { isPreActionInfraError } from "../src/screen-graph/bench/oracle";

const b = (y: number) => ({ x1: 0, y1: y, x2: 500, y2: y + 60 });

describe("phase D.3 (D2-H3) — pickUniqueNode resolves EXACT before contains", () => {
  it("t('Internet') taps the Internet row, NOT the toolbar 'Network & internet'", () => {
    const nodes: QueryNodeLite[] = [
      { id: "collapsing_toolbar", text: "Network & internet", bounds: b(0) },
      { id: "title", text: "Internet", bounds: b(200) },
      { id: "title", text: "Calls & SMS", bounds: b(300) },
    ];
    const r = pickUniqueNode(nodes, { text: "Internet" });
    expect(r.node?.text).toBe("Internet");
    expect(r.ambiguous).toBe(false);
  });

  it("is AMBIGUOUS when two nodes share the exact text and no id disambiguates", () => {
    const nodes: QueryNodeLite[] = [
      { id: "title", text: "Internet", bounds: b(0) },
      { id: "title", text: "Internet", bounds: b(200) },
    ];
    const r = pickUniqueNode(nodes, { text: "Internet" });
    expect(r.node).toBeUndefined();
    expect(r.ambiguous).toBe(true);
  });

  it("falls to a UNIQUE contains match when no exact match exists", () => {
    const nodes: QueryNodeLite[] = [{ id: "title", text: "Media volume", bounds: b(0) }];
    const r = pickUniqueNode(nodes, { text: "Media" });
    expect(r.node?.text).toBe("Media volume");
  });

  it("is AMBIGUOUS when >1 node contains the text and none matches exactly", () => {
    const nodes: QueryNodeLite[] = [
      { id: "title", text: "Network & internet", bounds: b(0) },
      { id: "title", text: "Internet usage", bounds: b(200) },
    ];
    const r = pickUniqueNode(nodes, { text: "internet" });
    expect(r.node).toBeUndefined();
    expect(r.ambiguous).toBe(true);
  });

  it("resolves an exact resource-id first", () => {
    const nodes: QueryNodeLite[] = [
      { id: "search", text: "Search", bounds: b(0) },
      { id: "title", text: "Search settings", bounds: b(200) },
    ];
    const r = pickUniqueNode(nodes, { id: "search" });
    expect(r.node?.id).toBe("search");
  });

  it("normLc trims and lowercases", () => {
    expect(normLc("  Foo Bar ")).toBe("foo bar");
    expect(normLc(undefined)).toBe("");
  });
});

describe("phase D.3 (D2-M6) — isPreActionInfraError", () => {
  it("flags device/adb/server connectivity faults", () => {
    for (const m of [
      "connect ECONNREFUSED 127.0.0.1:9008",
      "adb: device offline",
      "no devices/emulators found",
      "open device server not ready",
      "socket hang up",
      "ETIMEDOUT",
    ]) {
      expect(isPreActionInfraError(m), m).toBe(true);
    }
  });

  it("does NOT flag ordinary task/assertion failures", () => {
    for (const m of [
      "assertion failed: needle not present",
      "TypeError: cannot read property 'bounds' of undefined",
      "locate failed for {text:'Display'}",
      "unexpected token in JSON",
      "",
    ]) {
      expect(isPreActionInfraError(m), m).toBe(false);
    }
  });
});


/* --------------------------------------------------------------------------
 * Phase D.4.1 (D4-H3) — the collapsed describe row is split into text/cd.
 *
 * B1's proprietary `describe` renders a Settings list row as ONE quoted string
 * "<title> / <summary>". Before the split, `describeLinesToNodes` left `cd`
 * undefined and put the whole label in `text`, so the EXACT-text and EXACT-cd
 * tiers of `pickUniqueNode` were unreachable for every collapsed row and
 * t("Display") could only reach the contains tier — where a SECOND row also
 * contained "display" ("Accessibility / Display, interaction, audio"), so B1
 * refused AMBIGUOUS (see run 34794414764 logs/sg-matrix.log line 25). The open
 * tree carries title and summary as SEPARATE nodes and got the EXACT-text hit
 * for free. The split feeds `pickUniqueNode` the same title/summary fields in
 * both renderings. All rows below are quoted verbatim from the artifact.
 * -------------------------------------------------------------------------- */
describe("phase D.4.1 (D4-H3) — collapsed describe rows split into text/cd", () => {
  // Verbatim from run 34794414764 logs/sg-matrix.log line 27 (settings-network-internet step 1).
  const rowNetwork = `  LinearLayout "Network & internet / Mobile, Wi‑Fi, hotspot" [clickable]  (0.000, 0.321, 1.000, 0.096)`;
  // Verbatim from run 34794414764 logs/sg-matrix.log line 25 (settings-display step 2, both rows).
  const rowDisplay = `  LinearLayout "Display / Dark theme, font size, brightness" [clickable]  (0.000, 0.457, 1.000, 0.096)`;
  const rowAccessibility = `  LinearLayout "Accessibility / Display, interaction, audio" [clickable]  (0.000, 0.650, 1.000, 0.096)`;
  // Verbatim from run 34794414764 logs/sg-matrix.log line 38 (same-settings-search step 1) — no " / ".
  const rowSearch = `  ViewGroup "Search settings" id="com.android.settings:id/search_action_bar" [clickable]  (0.039, 0.246, 0.922, 0.057)`;

  it("splits '<title> / <summary>' into text=title, cd=summary", () => {
    const [n] = describeLinesToNodes(rowNetwork);
    expect(n?.text).toBe("Network & internet");
    expect(n?.cd).toBe("Mobile, Wi‑Fi, hotspot");
    const [d] = describeLinesToNodes(rowDisplay);
    expect(d?.text).toBe("Display");
    expect(d?.cd).toBe("Dark theme, font size, brightness");
  });

  it("a row with no ' / ' is left unchanged — its whole label stays in text, no title/summary split", () => {
    const [s] = describeLinesToNodes(rowSearch);
    // No " / " in the label, so the split does NOT fire: text is the full label,
    // not a truncated prefix.
    expect(s?.text).toBe("Search settings");
    expect(s?.id).toBe("com.android.settings:id/search_action_bar");
  });

  it("after the split t('Display') hits EXACT text and RESOLVES the Display row (was AMBIGUOUS pre-split, log line 25)", () => {
    const describeText = [rowDisplay, rowAccessibility].join("\n");
    const nodes = describeLinesToNodes(describeText);
    // Two rows still both CONTAIN "display" (the contains tier is ambiguous),
    // but the split gives the first row EXACT text "Display" → tier 2 resolves it.
    const picked = pickUniqueNode(nodes, { text: "Display" });
    expect(picked.ambiguous).toBe(false);
    expect(picked.node?.text).toBe("Display");
    const b1 = parseDescribeLocate(describeText, { text: "Display" });
    expect(b1.found).toBe(true);
    // Centre of the Display row: 0.457 + 0.096/2 = 0.505.
    expect(b1.yNorm).toBeCloseTo(0.505, 3);
  });
});

/* --------------------------------------------------------------------------
 * Phase D.4.1 (D4-H2) — the ROOT Settings screen in BOTH renderings, every row
 * taken verbatim from the artifacts of run 34794414764. No hand-built or invented
 * rows. Open tree: preflight-launch-screens.json `settingsRoot` (discrete
 * title/summary nodes). Proprietary text: the [D4] describe rows from
 * logs/sg-matrix.log. With the D4-H3 split in place, the ONE `pickUniqueNode`
 * policy resolves the SAME logical node in both renderings.
 * -------------------------------------------------------------------------- */
describe("phase D.4.1 (D4-H2) — root Settings screen, both renderings (verbatim artifact rows)", () => {
  // Open query nodes — verbatim from run 34794414764 preflight-launch-screens.json
  // `settingsRoot.nodes` (pixel bounds as captured; the resolver ignores bounds for
  // matching and only returns the winner's centre).
  const openRoot: QueryNodeLite[] = [
    { id: "title", text: "Network & internet", bounds: { x1: 189, y1: 824, x2: 625, y2: 895 } },
    { id: "summary", text: "Mobile, Wi‑Fi, hotspot", bounds: { x1: 189, y1: 895, x2: 540, y2: 946 } },
    { id: "title", text: "Display", bounds: { x1: 189, y1: 2441, x2: 361, y2: 2512 } },
    { id: "summary", text: "Dark theme, font size, brightness", bounds: { x1: 189, y1: 2512, x2: 725, y2: 2583 } },
    { id: "title", text: "Accessibility", bounds: { x1: 189, y1: 2903, x2: 486, y2: 2974 } },
    { id: "summary", text: "Display, interaction, audio", bounds: { x1: 189, y1: 2974, x2: 605, y2: 3025 } },
  ];
  // Proprietary describe — verbatim [D4] rows: the root list (log lines 27/2, top of
  // the unscrolled root) plus the two "display"-bearing rows (log line 25, scrolled).
  const b1RootTop = [
    `  LinearLayout "Network & internet / Mobile, Wi‑Fi, hotspot" [clickable]  (0.000, 0.321, 1.000, 0.096)`,
    `  LinearLayout "Connected devices / Bluetooth, pairing" [clickable]  (0.000, 0.417, 1.000, 0.096)`,
  ].join("\n");
  const b1DisplayRows = [
    `  LinearLayout "Display / Dark theme, font size, brightness" [clickable]  (0.000, 0.457, 1.000, 0.096)`,
    `  LinearLayout "Accessibility / Display, interaction, audio" [clickable]  (0.000, 0.650, 1.000, 0.096)`,
  ].join("\n");

  it("t('Network & internet') resolves to the SAME node in both renderings", () => {
    const open = pickUniqueNode(openRoot, { text: "Network & internet" });
    expect(open.node?.text).toBe("Network & internet");
    expect(open.node?.id).toBe("title");
    const b1Node = pickUniqueNode(describeLinesToNodes(b1RootTop), { text: "Network & internet" });
    expect(b1Node.node?.text).toBe("Network & internet");
    expect(b1Node.ambiguous).toBe(false);
    // Same logical row → same normalized-x centre band (left-aligned list row).
    const b1 = parseDescribeLocate(b1RootTop, { text: "Network & internet" });
    expect(b1.found).toBe(true);
  });

  it("t('Display') resolves to the SAME 'Display' node in both renderings (after the D4-H3 split)", () => {
    // Open: EXACT text "Display" over the "Display" title; the "Accessibility"
    // summary "Display, interaction, audio" only CONTAINS it, so tier 2 is unique.
    const open = pickUniqueNode(openRoot, { text: "Display" });
    expect(open.node?.text).toBe("Display");
    expect(open.node?.id).toBe("title");
    // B1: after the split the collapsed "Display / …" row has EXACT text "Display".
    const b1Node = pickUniqueNode(describeLinesToNodes(b1DisplayRows), { text: "Display" });
    expect(b1Node.node?.text).toBe("Display");
    expect(b1Node.ambiguous).toBe(false);
  });
});

/* --------------------------------------------------------------------------
 * Phase D.4.1 (D4-H2 b / D4-H1, item 4) — the DESTINATION Network & internet
 * screen in BOTH renderings, quoted verbatim from run 34801849653. This is the
 * screen B1 now observes AFTER the symmetric settle (D4-H1): its step-2 describe
 * on settings-network-internet is 598 tok (the destination), not the 657-tok root
 * it read before the fix. The screen carries a DISCRETE "Internet" row, so
 * t("Internet") resolves the same row in both renderings — refuting the D.4
 * report's "no discrete Internet row" claim, which had quoted the ROOT screen
 * (review D4-H1). All rows verbatim: open from graph-store node 284ef0302b28c5de
 * (com.android.settings/34.json); proprietary from logs/sg-matrix.log line 29.
 * -------------------------------------------------------------------------- */
describe("phase D.4.1 (D4-H2/H1, item 4) — DESTINATION Network & internet screen, both renderings (run 34801849653)", () => {
  // Open query nodes — verbatim from graph-store node 284ef0302b28c5de ("Network &
  // internet: Internet"), normalized bounds as captured (x, y, w, h -> x1,y1,x2,y2).
  const openDest: QueryNodeLite[] = [
    { id: "collapsing_toolbar", text: "Network & internet", bounds: { x1: 0.0, y1: 0.0, x2: 1.0, y2: 0.249 } },
    { id: "title", text: "Internet", bounds: { x1: 0.175, y1: 0.267, x2: 0.342, y2: 0.297 } },
    { id: "summary", text: "T-Mobile", bounds: { x1: 0.175, y1: 0.296, x2: 0.305, y2: 0.317 } },
  ];
  // Proprietary describe of the SAME screen — verbatim logs/sg-matrix.log line 29
  // ("describe rows containing 'internet'", B1 settings-network-internet step 2).
  const b1Dest = [
    `  FrameLayout "Network & internet" id="com.android.settings:id/collapsing_toolbar"  (0.000, 0.000, 1.000, 0.249)`,
    `  LinearLayout "Internet / T-Mobile" [clickable]  (0.000, 0.249, 1.000, 0.086)`,
  ].join("\n");

  it("t('Internet') resolves the DISCRETE Internet row in BOTH renderings (not the 'Network & internet' toolbar)", () => {
    // Open: EXACT text "Internet" over the discrete title; the toolbar
    // "Network & internet" only CONTAINS "internet", so tier 2 is unique.
    const open = pickUniqueNode(openDest, { text: "Internet" });
    expect(open.node?.text).toBe("Internet");
    expect(open.node?.id).toBe("title");
    // B1: after the D4-H3 split the collapsed "Internet / T-Mobile" row has EXACT
    // text "Internet"; the toolbar again only contains it → tier 2 resolves the row.
    const b1Node = pickUniqueNode(describeLinesToNodes(b1Dest), { text: "Internet" });
    expect(b1Node.node?.text).toBe("Internet");
    expect(b1Node.ambiguous).toBe(false);
    const b1 = parseDescribeLocate(b1Dest, { text: "Internet" });
    expect(b1.found).toBe(true);
    // Centre of the discrete "Internet / T-Mobile" row: 0.249 + 0.086/2 = 0.292 —
    // NOT the toolbar centre (0.1245).
    expect(b1.yNorm).toBeCloseTo(0.292, 3);
  });
});
