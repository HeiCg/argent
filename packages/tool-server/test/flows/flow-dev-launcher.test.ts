import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError, type DeviceInfo, type Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";
import { adbShell } from "../../src/utils/adb";
import { fetchFlowTree } from "../../src/tools/flows/flow-tree";
import { createRunFlowTool, type StepReport } from "../../src/tools/flows/flow-run";
import { serializeFlow, type FlowStep } from "../../src/tools/flows/flow-utils";
import {
  detectDevLauncher,
  devServerRowAt,
  dismissDevLauncher,
  hasDrawnContent,
  pickDevServerRow,
} from "../../src/tools/flows/flow-dev-launcher";

vi.mock("../../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/adb")>()),
  adbShell: vi.fn(),
}));

vi.mock("../../src/tools/flows/flow-tree", () => ({ fetchFlowTree: vi.fn() }));

beforeEach(() => {
  vi.mocked(adbShell).mockReset();
  vi.mocked(fetchFlowTree).mockReset();
});

// The fixture is the real tree an expo-dev-client chooser produced on an
// Android emulator (Bluesky dev build, android-devtools source), frames
// included. It is the awkward case rather than a tidy one: TWO bundlers were
// live (8081 and 8082), and the history below them remembered a third address
// on the run's own port that had long stopped answering, plus a port (8085) no
// live row offers at all — which is exactly the shape that makes "just tap the
// row with the right port" wrong.

function node(role: string, label: string, frame: number[], children: DescribeNode[] = []) {
  const [x, y, width, height] = frame;
  const own: DescribeNode = { role, label, frame: { x, y, width, height }, children };
  // The flow tree adapters hoist descendant text onto every ancestor; the
  // module has to work against that, so the fixture reproduces it.
  const sub = [label, ...children.map((c) => c.subtreeText ?? c.label ?? "")]
    .filter(Boolean)
    .join(" ");
  if (sub !== label) own.subtreeText = sub;
  return own;
}

const chevron = (y: number) => node("View", "Chevron", [0.847, y, 0.051, 0.025]);

function launcherTree(): DescribeNode {
  return node(
    "ROOT",
    "Screen",
    [0, 0, 1, 1],
    [
      node(
        "ComposeView",
        "",
        [0, 0, 1, 1],
        [
          node("StaticText", "Bluesky", [0.214, 0.062, 0.152, 0.024]),
          node("StaticText", "Development Build", [0.214, 0.091, 0.299, 0.021]),
          node(
            "ScrollView",
            "",
            [0.061, 0.193, 0.878, 0.608],
            [
              node("StaticText", "DEVELOPMENT SERVERS", [0.061, 0.193, 0.352, 0.02]),
              node(
                "View",
                "http://10.0.2.2:8082 / Chevron",
                [0.061, 0.233, 0.878, 0.064],
                [chevron(0.253)]
              ),
              node(
                "View",
                "http://10.0.2.2:8081 / Chevron",
                [0.061, 0.307, 0.878, 0.064],
                [chevron(0.327)]
              ),
              node("View", "Plus / New development server", [0.061, 0.382, 0.878, 0.059]),
              node("StaticText", "RECENTLY OPENED", [0.061, 0.491, 0.278, 0.02]),
              node(
                "View",
                "Bluesky / http://10.0.2.2:8085 / Chevron",
                [0.061, 0.53, 0.878, 0.087],
                [chevron(0.561)]
              ),
              node(
                "View",
                "Bluesky / http://192.168.92.72:8081 / Chevron",
                [0.061, 0.622, 0.878, 0.087],
                [chevron(0.653)]
              ),
              node(
                "View",
                "Bluesky / http://10.0.2.2:8081 / Chevron",
                [0.061, 0.714, 0.878, 0.087],
                [chevron(0.745)]
              ),
            ]
          ),
        ]
      ),
    ]
  );
}

// The chooser's OTHER face, captured the same way on the same build: what the
// dev client draws when it has discovered no running packager. There is no
// server list at all — an instruction card, an address box prefilled with a URL
// and a fetch button stand in its place — and the history below it survives.
// This is the state a run most needs help with, and the one the actionable "no
// reachable server on port N" failure has to come from.
function noServersTree(): DescribeNode {
  return node(
    "ROOT",
    "Screen",
    [0, 0, 1, 1],
    [
      node(
        "ComposeView",
        "",
        [0, 0, 1, 1],
        [
          node("StaticText", "Bluesky", [0.214, 0.062, 0.152, 0.024]),
          node("StaticText", "Development Build", [0.214, 0.091, 0.299, 0.021]),
          node(
            "ScrollView",
            "",
            [0.061, 0.193, 0.878, 0.655],
            [
              node("StaticText", "DEVELOPMENT SERVERS", [0.061, 0.193, 0.352, 0.02]),
              node("StaticText", "INFO", [0.841, 0.173, 0.122, 0.059]),
              node(
                "StaticText",
                "Start a local development server with:",
                [0.102, 0.253, 0.519, 0.018]
              ),
              node("StaticText", "npx expo start", [0.143, 0.31, 0.298, 0.023]),
              node(
                "StaticText",
                "Then, select the local server when it appears here.",
                [0.102, 0.373, 0.692, 0.018]
              ),
              // The box carries no label of its own: the adapters render its URL
              // as a text leaf inside it, which is what an origin match sees.
              node(
                "TextField",
                "",
                [0.143, 0.411, 0.715, 0.059],
                [node("StaticText", "http://localhost:8081", [0.143, 0.431, 0.327, 0.02])]
              ),
              node("View", "Connect", [0.102, 0.481, 0.796, 0.06]),
              node("StaticText", "Or", [0.102, 0.561, 0.796, 0.018]),
              node("View", "Fetch development servers / Download", [0.102, 0.599, 0.796, 0.064]),
              node("StaticText", "RECENTLY OPENED", [0.061, 0.732, 0.278, 0.02]),
              node("StaticText", "RESET", [0.831, 0.713, 0.122, 0.059]),
              node(
                "View",
                "Bluesky / http://10.0.2.2:8082 / Chevron",
                [0.061, 0.772, 0.878, 0.087],
                [chevron(0.803)]
              ),
            ]
          ),
        ]
      ),
    ]
  );
}

/**
 * The no-servers face a CURRENT client draws, captured through `fetchFlowTree`
 * on an Expo SDK 57 dev build (`expo-dev-launcher` 57.0.11) with the app's data
 * cleared. Flat, as the Android adapter emits: whole-screen containers, and each
 * row's parts as separate leaves under an unlabelled card.
 *
 * The address box moved. On the older client it was an unlabelled `TextField`
 * wrapping a `http://localhost:8081` text leaf ({@link noServersTree}); here its
 * own label is the literal "http://" and there is no leaf inside it, so no
 * origin is on screen above the history at all. Both shapes are safe and both
 * are kept — the geometric exclusion has to survive the one that still spells a
 * port, and this one is what a run meets today.
 */
function noServersToday(): DescribeNode {
  return node(
    "ROOT",
    "Screen",
    [0, 0, 1, 1],
    [
      node("Image", "App Icon", [0.058, 0.08, 0.107, 0.048]),
      node("StaticText", "devbuild", [0.205, 0.082, 0.156, 0.021]),
      node("StaticText", "Development Build", [0.205, 0.107, 0.282, 0.019]),
      node("StaticText", "DEVELOPMENT SERVERS", [0.058, 0.198, 0.334, 0.017]),
      node("StaticText", "INFO", [0.848, 0.18, 0.117, 0.052]),
      node("StaticText", "Start a local development server with:", [0.097, 0.25, 0.49, 0.016]),
      node("StaticText", "npx expo start", [0.136, 0.301, 0.285, 0.02]),
      node(
        "StaticText",
        "Then, select the local server when it appears here.",
        [0.097, 0.356, 0.652, 0.016]
      ),
      node("TextField", "http://", [0.136, 0.39, 0.728, 0.052]),
      node("View", "Connect", [0.097, 0.452, 0.806, 0.054]),
      node("StaticText", "Or", [0.097, 0.523, 0.806, 0.016]),
      node("StaticText", "Fetch development servers", [0.136, 0.575, 0.5, 0.016]),
      node("View", "Download", [0.815, 0.574, 0.049, 0.022]),
      node("View", "", [0.097, 0.557, 0.806, 0.057]),
      node("StaticText", "RECENTLY OPENED", [0.058, 0.675, 0.264, 0.017]),
      node("StaticText", "RESET", [0.84, 0.657, 0.117, 0.052]),
      node("StaticText", "devbuild", [0.166, 0.727, 0.156, 0.021]),
      node("StaticText", "http://192.168.0.94:8093", [0.166, 0.753, 0.32, 0.016]),
      node("View", "Chevron", [0.854, 0.737, 0.049, 0.022]),
      node("Button", "", [0.058, 0.71, 0.883, 0.077]),
      node("ScrollView", "", [0.058, 0.198, 0.883, 0.589]),
      node("View", "Settings", [0.792, 0.918, 0.058, 0.026]),
      node("ComposeView", "", [0, 0, 1, 1]),
      node("FrameLayout", "", [0, 0, 1, 1]),
    ]
  );
}

/**
 * The chooser a CURRENT client draws, captured the same way on an Expo SDK 57
 * dev build (`expo-dev-launcher` 57.0.11) with Metro on 8091. Since
 * expo-dev-launcher 56 the Android client finds servers over mDNS and writes
 * each row's URL from the resolved IPv4 of the advertising machine, so the host
 * is a LAN address — not an alias, and not a name. That one difference from the
 * fixtures above is the whole of what a run meets today, and the same server
 * appears in BOTH sections once it has been opened once.
 */
function discoveredTree(): DescribeNode {
  const serverRow = (y: number) =>
    node(
      "View",
      "devclientprobe / http://192.168.0.94:8091 / Chevron",
      [0.058, y, 0.883, 0.077],
      [node("View", "Chevron", [0.854, y + 0.027, 0.049, 0.022])]
    );
  return node(
    "ROOT",
    "Screen",
    [0, 0, 1, 1],
    [
      node(
        "ComposeView",
        "",
        [0, 0, 1, 1],
        [
          node("Image", "App Icon", [0.058, 0.083, 0.107, 0.048]),
          node("StaticText", "devclientprobe", [0.205, 0.085, 0.272, 0.021]),
          node("StaticText", "Development Build", [0.205, 0.111, 0.282, 0.019]),
          node("View", "User", [0.83, 0.081, 0.117, 0.052]),
          node(
            "ScrollView",
            "",
            [0.058, 0.201, 0.883, 0.328],
            [
              node("StaticText", "DEVELOPMENT SERVERS", [0.058, 0.201, 0.334, 0.017]),
              node("StaticText", "INFO", [0.848, 0.184, 0.117, 0.052]),
              serverRow(0.236),
              node("View", "Plus / New development server", [0.058, 0.322, 0.883, 0.052]),
              node("StaticText", "RECENTLY OPENED", [0.058, 0.418, 0.264, 0.017]),
              node("StaticText", "RESET", [0.84, 0.4, 0.117, 0.052]),
              serverRow(0.453),
            ]
          ),
          node("View", "Home", [0.039, 0.909, 0.281, 0.065]),
          node("View", "Updates", [0.359, 0.909, 0.281, 0.065]),
          node("View", "Settings", [0.68, 0.909, 0.281, 0.065]),
        ]
      ),
    ]
  );
}

/**
 * The fixtures above are written nested, which reads better; the Android adapter
 * emits the same screen FLAT — every node a direct child of one synthetic root,
 * with the ancestors surviving as leaves that keep their own frames and carry the
 * hoisted `subtreeText` (measured on the device this was built against: 23 leaves,
 * depth 1). The module reads the flattened list and the frames only, so both
 * shapes must give the same answers; the cases below run against this one.
 */
function asProduced(tree: DescribeNode): DescribeNode {
  const leaves: DescribeNode[] = [];
  const walk = (n: DescribeNode): void => {
    leaves.push({ ...n, children: [] });
    for (const child of n.children) walk(child);
  };
  for (const child of tree.children) walk(child);
  return { ...tree, children: leaves };
}

const emulator: DeviceInfo = { id: "emulator-5556", platform: "android", kind: "emulator" };
const sim: DeviceInfo = { id: "A1E0DF35", platform: "ios", kind: "simulator" };

/** The chooser's history heading y, for the picker cases below. */
function historyY(tree: DescribeNode): number {
  const found = detectDevLauncher(tree);
  if (!found) throw new Error("fixture is no longer recognized as the chooser");
  return found.historyY;
}

/**
 * Every text the tree renders BELOW the history boundary — what the chooser
 * only remembers. Lets a "must not open a remembered row" case prove the
 * boundary did the rejecting, rather than passing because the port it asked for
 * was absent from the fixture entirely.
 */
function rememberedText(tree: DescribeNode): string {
  const boundary = historyY(tree);
  const out: string[] = [];
  const walk = (n: DescribeNode): void => {
    if (n.frame.y >= boundary && n.label) out.push(n.label);
    for (const child of n.children) walk(child);
  };
  walk(tree);
  return out.join(" ");
}

describe("expo dev-client launcher detection", () => {
  it("recognizes the chooser and locates the history boundary below the live rows", () => {
    // 0.491 is the RECENTLY OPENED heading — NOT the 0.193 of the scroll
    // container whose hoisted text also contains those words. A boundary that
    // floated up to the container would put every live row in the history and
    // leave nothing to open.
    expect(detectDevLauncher(launcherTree())).toEqual({ historyY: 0.491 });
  });

  it("recognizes the face the chooser shows with no packager discovered", () => {
    // Requiring the "new server" affordance recognized only the face that
    // already lists servers. On this one the launch reported a pass and every
    // later step then resolved its selectors against the chooser.
    expect(detectDevLauncher(noServersTree())).toEqual({ historyY: 0.732 });
  });

  it("does not fire on an app screen that merely mentions development servers", () => {
    const settings = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [
        node("StaticText", "DEVELOPMENT SERVERS", [0.061, 0.193, 0.352, 0.02]),
        node("View", "http://10.0.2.2:8081", [0.061, 0.233, 0.878, 0.064]),
      ]
    );
    // The heading alone is ordinary app wording; without the chooser's own
    // "new server" affordance this must stay hands-off rather than tap at a
    // screen the flow put there deliberately.
    expect(detectDevLauncher(settings)).toBeNull();
  });

  it("does not fire on an app screen that carries a mark but no heading", () => {
    // The other direction of the same pairing. "Development Build" is ordinary
    // wording for a real app's About screen, and a server URL beside it is
    // ordinary for a debug menu — neither makes the screen the chooser, and
    // taking it for one would tap at a screen the flow put there deliberately.
    const about = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [
        node("StaticText", "Development Build", [0.061, 0.193, 0.352, 0.02]),
        node("StaticText", "Bundler: http://10.0.2.2:8081", [0.061, 0.233, 0.5, 0.02]),
      ]
    );
    expect(detectDevLauncher(about)).toBeNull();
  });

  it("treats a chooser with no history yet as all-live", () => {
    const fresh = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [
        node("StaticText", "DEVELOPMENT SERVERS", [0.061, 0.193, 0.352, 0.02]),
        node("View", "http://10.0.2.2:8081 / Chevron", [0.061, 0.233, 0.878, 0.064]),
        node("View", "Plus / New development server", [0.061, 0.382, 0.878, 0.059]),
      ]
    );
    expect(detectDevLauncher(fresh)).toEqual({ historyY: 1 });
  });
});

describe("waiting for a cold start to become something", () => {
  // The launch step reads ~2s after the relaunch; on a cold start the chooser
  // took 4-10s to draw on the emulator this was built against. Without the
  // splash/content distinction the read lands on the splash every time and
  // concludes there is no chooser — the exact miss this guards.
  it("treats a wordless splash as still starting", () => {
    const splash = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [node("Image", "", [0.4, 0.45, 0.2, 0.1]), node("View", "", [0, 0, 1, 1])]
    );
    expect(hasDrawnContent(splash)).toBe(false);
  });

  it("treats the chooser and a drawn app screen as arrived", () => {
    expect(hasDrawnContent(launcherTree())).toBe(true);
    const app = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [
        node("StaticText", "Home", [0.1, 0.1, 0.2, 0.03]),
        node("StaticText", "Following", [0.1, 0.2, 0.3, 0.03]),
      ]
    );
    expect(hasDrawnContent(app)).toBe(true);
  });

  it("does not count a lone splash word as a drawn screen", () => {
    // One label is what a branded splash carries; the wait should continue.
    const branded = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [node("StaticText", "Bluesky", [0.4, 0.45, 0.2, 0.03])]
    );
    expect(hasDrawnContent(branded)).toBe(false);
  });
});

describe("picking the row for the run's own bundler", () => {
  it("opens the live row on the requested port, not the other live bundler", () => {
    const tree = launcherTree();
    const picked = pickDevServerRow(tree, 8081, historyY(tree));
    expect(picked?.url).toBe("http://10.0.2.2:8081");
    // The row itself, not the scroll container whose hoisted text repeats it.
    expect(picked?.node.label).toBe("http://10.0.2.2:8081 / Chevron");
    expect(picked?.node.frame.y).toBe(0.307);
  });

  it("honors the caller's port when several bundlers are live", () => {
    const tree = launcherTree();
    expect(pickDevServerRow(tree, 8082, historyY(tree))?.node.frame.y).toBe(0.233);
  });

  it("never falls back to a remembered row, even one carrying the right port", () => {
    // Only the history holds 8085 — and history rows are stale by nature (the
    // fixture's own 192.168.92.72:8081 is a dead address on the live port).
    // Reporting beats opening a server that may not answer.
    const tree = launcherTree();
    // The port IS in the tree, on a host this device can reach, so what must
    // reject it is the boundary — not an absence the assertion below could pass
    // on by accident.
    expect(rememberedText(tree)).toContain("http://10.0.2.2:8085");
    expect(pickDevServerRow(tree, 8085, historyY(tree))).toBeNull();
  });

  it("does not settle for the scrolling container that repeats every row's URL", () => {
    // The adapters' hoist puts every row URL — the history's included — onto the
    // scroll container, whose top edge is ABOVE the boundary. Reading that
    // hoisted text made a history-only port match the container, and the launch
    // then tapped the container's centre: an arbitrary point on the chooser,
    // reported as "opened http://10.0.2.2:8085".
    const tree = launcherTree();
    const container = tree.children[0].children[2];
    expect(container.role).toBe("ScrollView");
    expect(container.subtreeText).toContain("http://10.0.2.2:8085");
    expect(container.frame.y).toBeLessThan(historyY(tree));
    expect(pickDevServerRow(tree, 8085, historyY(tree))).toBeNull();
  });

  it("does not mistake the chooser's address box for a live row", () => {
    const tree = noServersTree();
    const box = tree.children[0].children[2].children[5];
    const urlInBox = box.children[0];
    // The URL leaf is above the history boundary and spells the run's own port,
    // so what keeps it out is sitting inside the input. Tapping it opens a
    // keyboard, and the run then fails blaming a bundler it never opened.
    expect(box.role).toBe("TextField");
    expect(urlInBox.label).toContain(":8081");
    expect(urlInBox.frame.y).toBeLessThan(historyY(tree));
    expect(pickDevServerRow(tree, 8081, historyY(tree))).toBeNull();
  });

  it("finds a row whose URL is rendered by a child leaf, not the card's own label", () => {
    // The production shape: the Android adapter labels one view, so the card is
    // unlabelled and a StaticText inside it renders the URL. Own-text matching
    // must still land inside the card.
    const rows = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [
        node("StaticText", "DEVELOPMENT SERVERS", [0.061, 0.193, 0.352, 0.02]),
        node(
          "View",
          "",
          [0.061, 0.233, 0.878, 0.064],
          [node("StaticText", "http://10.0.2.2:8081", [0.143, 0.245, 0.4, 0.02])]
        ),
        node("View", "Plus / New development server", [0.061, 0.382, 0.878, 0.059]),
      ]
    );
    const picked = pickDevServerRow(rows, 8081, historyY(rows));
    expect(picked?.node.role).toBe("StaticText");
    expect(picked?.node.frame.y).toBe(0.245);
  });

  it("does not let a short port match a longer one", () => {
    // `http://10.0.2.2:808` is a prefix of the live 8081 row. Substring
    // matching alone would open the wrong bundler and run the flow against
    // someone else's bundle.
    const tree = launcherTree();
    expect(pickDevServerRow(tree, 808, historyY(tree))).toBeNull();
  });

  it("opens the LAN row a discovered server is listed under", () => {
    // The whole point of the picker on a current client. Nothing argent can
    // compose matches this row, so a host list — any host list — finds nothing
    // and every dev-client launch errors while the bundler it names is running.
    const tree = discoveredTree();
    const picked = pickDevServerRow(tree, 8091, historyY(tree));
    expect(picked?.url).toBe("http://192.168.0.94:8091");
    expect(picked?.node.frame.y).toBe(0.236);
  });

  it("still refuses the remembered copy of the very same server", () => {
    // A client that has opened a server once lists it TWICE — live above, and
    // remembered below. The remembered copy is not the offer: it survives the
    // server that wrote it, so opening it can only reach a dead address.
    const tree = discoveredTree();
    expect(rememberedText(tree)).toContain("http://192.168.0.94:8091");
    expect(pickDevServerRow(tree, 8091, historyY(tree))?.node.frame.y).toBe(0.236);
    expect(pickDevServerRow(tree, 8092, historyY(tree))).toBeNull();
  });

  it("does not let a longer port answer for a shorter one", () => {
    // The mirror of the 808/8081 case, and the one a host wildcard could break:
    // with the host free to match anything, `…:18091` must not read as `:8091`
    // with `…:1` absorbed into the host.
    const tree = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [
        node("StaticText", "DEVELOPMENT SERVERS", [0.061, 0.193, 0.352, 0.02]),
        node("View", "http://192.168.0.94:18091 / Chevron", [0.061, 0.233, 0.878, 0.064]),
        node("View", "Plus / New development server", [0.061, 0.382, 0.878, 0.059]),
      ]
    );
    expect(pickDevServerRow(tree, 8091, historyY(tree))).toBeNull();
  });
});

describe("recognizing a build that can show the chooser", () => {
  // Both dumps are `dumpsys package`, read off an emulator from the SAME Expo
  // SDK 57 project built twice — debug and release — rather than one derived
  // from the other by deleting lines. That is what makes them evidence: the
  // release build really does keep the `exp+<slug>` scheme its config plugin
  // wrote into the main manifest, and really does drop everything
  // expo-dev-launcher contributes from its debug-variant one. Reading the
  // scheme instead would call this release build a dev build.
  const APP = "com.anonymous.devclientprobe";
  const RELEASE_DUMP = `
Activity Resolver Table:
  Schemes:
      exp+devclientprobe:
        1a741a6 com.anonymous.devclientprobe/.MainActivity filter 5ffdf94
          Action: "android.intent.action.VIEW"
          Category: "android.intent.category.DEFAULT"
          Category: "android.intent.category.BROWSABLE"
          Scheme: "exp+devclientprobe"

  Non-Data Actions:
      android.intent.action.MAIN:
        1a741a6 com.anonymous.devclientprobe/.MainActivity filter 69bb7e7
          Action: "android.intent.action.MAIN"
          Category: "android.intent.category.LAUNCHER"
`;
  const DEV_DUMP = `
Activity Resolver Table:
  Schemes:
      expo-dev-launcher:
        20214db com.anonymous.devclientprobe/expo.modules.devlauncher.compose.AuthActivity filter 99fcb78
          Action: "android.intent.action.VIEW"
          Category: "android.intent.category.DEFAULT"
          Category: "android.intent.category.BROWSABLE"
          Scheme: "expo-dev-launcher"
      exp+devclientprobe:
        2de128c com.anonymous.devclientprobe/.MainActivity filter cb1e9ea
          Action: "android.intent.action.VIEW"
          Category: "android.intent.category.DEFAULT"
          Category: "android.intent.category.BROWSABLE"
          Scheme: "exp+devclientprobe"

  Non-Data Actions:
      android.intent.action.MAIN:
        2de128c com.anonymous.devclientprobe/.MainActivity filter 67cbdd5
          Action: "android.intent.action.MAIN"
          Category: "android.intent.category.LAUNCHER"
`;

  /** The probe is only observable through what the launch then does. */
  function env(device: DeviceInfo) {
    const registry = {
      invokeTool: vi.fn(async () => ({ ok: true })),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;
    return { registry, device };
  }

  it("waits for the chooser on a build whose debug manifest installs the launcher", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    let read = 0;
    vi.mocked(fetchFlowTree).mockImplementation(async () => {
      read += 1;
      return {
        tree: read === 1 ? launcherTree() : node("ROOT", "Screen", [0, 0, 1, 1], []),
        source: "android-devtools",
      };
    });

    await expect(dismissDevLauncher(env(emulator), APP, 8081, new Map())).resolves.toMatchObject({
      handled: true,
      ok: true,
    });
    expect(fetchFlowTree).toHaveBeenCalled();
  });

  it("costs a release build of the same project nothing", async () => {
    // The `exp+<slug>` scheme is still there — reading THAT made every release
    // build of any project with expo-dev-client in its dependencies wait out the
    // appear window on every launch step, for a chooser it can never show.
    expect(RELEASE_DUMP).toContain('Scheme: "exp+devclientprobe"');
    expect(RELEASE_DUMP).not.toContain("expo.modules.devlauncher");
    vi.mocked(adbShell).mockResolvedValue(RELEASE_DUMP);

    await expect(dismissDevLauncher(env(emulator), APP, 8081, new Map())).resolves.toEqual({
      handled: false,
    });
    expect(fetchFlowTree).not.toHaveBeenCalled();
  });

  it("leaves a launch alone when the package cannot be probed", async () => {
    vi.mocked(adbShell).mockRejectedValue(new Error("device offline"));

    await expect(dismissDevLauncher(env(emulator), APP, 8081, new Map())).resolves.toEqual({
      handled: false,
    });
    expect(fetchFlowTree).not.toHaveBeenCalled();
  });

  it("never probes a platform whose launcher this is not", async () => {
    // iOS reaches Metro at a stable localhost, so the chooser is a rarity there
    // and nothing is probed — the recovery is Android-only by construction.
    await expect(dismissDevLauncher(env(sim), APP, 8081, new Map())).resolves.toEqual({
      handled: false,
    });
    expect(adbShell).not.toHaveBeenCalled();
  });
});

describe("getting a launch past the chooser", () => {
  // A dev build by the probe, so every case below reaches the tree reads.
  const DEV_DUMP = 'Scheme: "expo-dev-launcher"';

  /** Scripted tree reads: one entry per read, the last one repeating. */
  function reads(...trees: DescribeNode[]): void {
    let at = 0;
    vi.mocked(fetchFlowTree).mockImplementation(async (): Promise<DescribeTreeData> => {
      const tree = trees[Math.min(at, trees.length - 1)];
      at += 1;
      return { tree, source: "android-devtools" };
    });
  }

  function env(
    invoke: (tool: string, args: Record<string, unknown>) => unknown = () => ({ ok: true }),
    signal?: AbortSignal
  ) {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const registry = {
      invokeTool: vi.fn(async (tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args });
        return invoke(tool, args);
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;
    return { calls, actionEnv: { registry, device: emulator, signal } };
  }

  /**
   * The probe cache a run holds after its first launch. Filled by running one
   * against an ordinary screen rather than by writing the key out, so a test
   * pins the module's behaviour and not its bookkeeping.
   */
  async function probedRun(app_: string): Promise<Map<string, boolean>> {
    const seen = new Map<string, boolean>();
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    reads(app);
    await dismissDevLauncher(env().actionEnv, app_, 8081, seen);
    vi.mocked(adbShell).mockReset();
    vi.mocked(fetchFlowTree).mockReset();
    return seen;
  }

  const splash = node("ROOT", "Screen", [0, 0, 1, 1], [node("Image", "", [0.4, 0.45, 0.2, 0.1])]);
  const app = node(
    "ROOT",
    "Screen",
    [0, 0, 1, 1],
    [
      node("StaticText", "Home", [0.1, 0.1, 0.2, 0.03]),
      node("StaticText", "Following", [0.1, 0.2, 0.3, 0.03]),
    ]
  );

  it("opens the run's own row and reports the URL once the chooser is gone", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    reads(launcherTree(), app);
    const { calls, actionEnv } = env();

    await expect(
      dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, new Map())
    ).resolves.toEqual({
      handled: true,
      ok: true,
      url: "http://10.0.2.2:8081",
    });
    // The centre of the live 8081 row (y 0.307, height 0.064) — not the other
    // live bundler's row, and not the container's centre.
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("gesture-tap");
    expect(calls[0].args).toMatchObject({ x: 0.5, udid: "emulator-5556" });
    expect(calls[0].args.y).toBeCloseTo(0.339, 5);
  });

  it("waits out a splash the chooser has not drawn over yet", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    // The launch step reads ~2s after the relaunch; a cold dev client needs
    // several seconds more. Without the wait the first read decides there is no
    // chooser and the run proceeds against one.
    reads(splash, launcherTree(), app);
    const { calls, actionEnv } = env();

    await expect(
      dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, new Map())
    ).resolves.toMatchObject({
      handled: true,
      ok: true,
    });
    expect(calls.map((c) => c.tool)).toEqual(["gesture-tap"]);
  });

  it("leaves a launch that is already showing the app alone", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    reads(app);
    const { calls, actionEnv } = env();

    await expect(
      dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, new Map())
    ).resolves.toEqual({
      handled: false,
    });
    expect(calls).toEqual([]);
  });

  it("does not read the screen at all for a build that has no launcher", async () => {
    vi.mocked(adbShell).mockResolvedValue('Scheme: "exp+bluesky"');
    const { actionEnv } = env();

    await expect(
      dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, new Map())
    ).resolves.toEqual({
      handled: false,
    });
    expect(fetchFlowTree).not.toHaveBeenCalled();
  });

  it("reports the port it wanted when no live row offers it, and taps nothing", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    reads(launcherTree());
    const { calls, actionEnv } = env();

    const outcome = await dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8085, new Map());
    expect(outcome).toMatchObject({ handled: true, ok: false });
    expect(outcome).toHaveProperty(
      "reason",
      expect.stringContaining("lists no live server on port 8085")
    );
    expect(calls).toEqual([]);
  });

  it("retries a pick that landed on the face the chooser shows while discovering", async () => {
    // The discovering face has drawn content, so the appear-wait settles on it
    // — but its list is empty because mDNS has not answered YET, not because
    // nothing is live. One read later Metro is listed, and the launch must open
    // it rather than error against a state that was already resolving itself.
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    reads(noServersTree(), discoveredTree(), app);
    const { calls, actionEnv } = env();

    await expect(
      dismissDevLauncher(actionEnv, "com.anonymous.devclientprobe", 8091, new Map())
    ).resolves.toEqual({
      handled: true,
      ok: true,
      url: "http://192.168.0.94:8091",
    });
    expect(calls).toHaveLength(1);
  });

  it("does not wait once live rows are listed, even for a port none of them carries", async () => {
    // A populated list is a finished discovery: a miss there is real, and the
    // "no live server" verdict comes at once instead of after a second window.
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    reads(launcherTree());
    const { calls, actionEnv } = env();

    const outcome = await dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8085, new Map());
    expect(outcome).toMatchObject({ handled: true, ok: false });
    expect(outcome).toHaveProperty(
      "reason",
      expect.stringContaining("lists no live server on port 8085")
    );
    expect(calls).toEqual([]);
    expect(fetchFlowTree).toHaveBeenCalledTimes(1);
  });

  it("leaves the launch alone when the chooser leaves while still discovering", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    reads(noServersTree(), app);
    const { calls, actionEnv } = env();

    await expect(
      dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, new Map())
    ).resolves.toEqual({ handled: false });
    expect(calls).toEqual([]);
  });

  it("reports a failed tap as a launch failure instead of throwing out of the run", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    reads(launcherTree());
    const { actionEnv } = env((tool) => {
      if (tool === "gesture-tap") throw new Error("device offline");
      return { ok: true };
    });

    // A throw here would leave `flow-execute` itself, losing every step
    // collected so far and booking the failure as a tool failure.
    const outcome = await dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, new Map());
    expect(outcome).toMatchObject({ handled: true, ok: false });
    expect(outcome).toHaveProperty("reason", expect.stringContaining("device offline"));
  });

  it("does not tap when the run is cancelled after the chooser was read", async () => {
    // The deliberate re-check just before the tap. Aborting before the call
    // instead lands inside the probe's own `settleWithin` and the tap is never
    // approached, so the probe is pre-answered and the cancel arrives with the
    // chooser already in hand — the case the re-check exists for.
    const controller = new AbortController();
    const seen = await probedRun("xyz.blueskyweb.app");
    vi.mocked(fetchFlowTree).mockImplementation(async () => {
      controller.abort();
      return { tree: launcherTree(), source: "android-devtools" };
    });
    const { calls, actionEnv } = env(() => ({ ok: true }), controller.signal);

    await expect(dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, seen)).resolves.toEqual({
      handled: false,
    });
    expect(calls).toEqual([]);
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("probes a device and app once per run, however many launches it has", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    reads(app);
    const { actionEnv } = env();
    const seen = new Map<string, boolean>();

    await dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, seen);
    await dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, seen);

    expect(adbShell).toHaveBeenCalledTimes(1);
    // A second app on the same device is its own question.
    await dismissDevLauncher(actionEnv, "com.example.other", 8081, seen);
    expect(adbShell).toHaveBeenCalledTimes(2);
  });

  it("re-probes after a read that answered nothing about the app", async () => {
    // A failed probe means "not a dev build" for that launch, but remembering
    // it would switch the recovery off for the rest of the run.
    vi.mocked(adbShell).mockRejectedValueOnce(new Error("device offline"));
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    reads(app);
    const { actionEnv } = env();
    const seen = new Map<string, boolean>();

    await expect(dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, seen)).resolves.toEqual({
      handled: false,
    });
    await dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, seen);

    expect(adbShell).toHaveBeenCalledTimes(2);
    expect(fetchFlowTree).toHaveBeenCalled();
  });

  it("stops waiting on the probe when the run is cancelled mid-flight", async () => {
    // No AbortSignal reaches adb, so a cancel that lands while `dumpsys` is out
    // cannot kill it — but the launch must stop waiting on it all the same,
    // rather than sitting on the probe's full 10s budget after the run ended.
    const controller = new AbortController();
    vi.mocked(adbShell).mockImplementation(() => new Promise<string>(() => {}));
    const { calls, actionEnv } = env(() => ({ ok: true }), controller.signal);

    const pending = dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, new Map());
    controller.abort();

    await expect(pending).resolves.toEqual({ handled: false });
    expect(fetchFlowTree).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("gives up on a screen that never draws anything", async () => {
    // The appear wait exists for a cold dev client that has not painted yet.
    // An app whose first screen is genuinely wordless never ends it, so the
    // deadline does — and the launch then proceeds as if this module were not
    // here, rather than holding the run open.
    vi.useFakeTimers();
    try {
      vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
      reads(splash);
      const { calls, actionEnv } = env();

      const pending = dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, new Map());
      await vi.advanceTimersByTimeAsync(13_000);

      await expect(pending).resolves.toEqual({ handled: false });
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the appear wait the moment the run is cancelled", async () => {
    // Cancelled while polling a splash: the wait must end on the abort, not on
    // its own 12s deadline. The probe is pre-answered and the cancel fires from
    // the first read, so it lands in the appear loop's own sleep rather than
    // inside the probe.
    const controller = new AbortController();
    const seen = await probedRun("xyz.blueskyweb.app");
    let read = 0;
    vi.mocked(fetchFlowTree).mockImplementation(async () => {
      read += 1;
      controller.abort();
      return { tree: splash, source: "android-devtools" };
    });
    const { calls, actionEnv } = env(() => ({ ok: true }), controller.signal);

    await expect(dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, seen)).resolves.toEqual({
      handled: false,
    });
    // One read, then the sleep the abort cut short — not the whole 12s of them.
    expect(read).toBe(1);
    expect(calls).toEqual([]);
  });

  it("re-probes after a probe that timed out", async () => {
    // The timeout shares the error path's "answer no, remember nothing", and
    // only the error half was covered. A cached timeout would switch the
    // recovery off for the rest of the run.
    vi.useFakeTimers();
    try {
      vi.mocked(adbShell).mockImplementationOnce(() => new Promise<string>(() => {}));
      vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
      reads(app);
      const { actionEnv } = env();
      const seen = new Map<string, boolean>();

      const pending = dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, seen);
      await vi.advanceTimersByTimeAsync(11_000);
      await expect(pending).resolves.toEqual({ handled: false });
      expect(seen.size).toBe(0);

      await dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, seen);
      expect(adbShell).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the server it opened when the run is cancelled during the exit wait", async () => {
    // The chooser IS dismissed at this point, so the outcome is honest — and
    // `runLaunch` re-checks the signal on return, which is what turns it into
    // the run's skip rather than a pass that verified nothing.
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    // The chooser never leaves, so only the abort can end the exit wait.
    reads(launcherTree());
    const controller = new AbortController();
    const { actionEnv } = env((tool) => {
      if (tool === "gesture-tap") controller.abort();
      return { ok: true };
    }, controller.signal);

    await expect(
      dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, new Map())
    ).resolves.toEqual({ handled: true, ok: true, url: "http://10.0.2.2:8081" });
  });

  it("treats a tap that rejects on a cancelled run as the abort, not a failed dismissal", async () => {
    // Cancellation makes the sub-tool itself reject. Reporting that as "the tap
    // failed" would book a cancelled run as a launch error naming the chooser.
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    reads(launcherTree());
    const controller = new AbortController();
    const { actionEnv } = env((tool) => {
      if (tool === "gesture-tap") {
        controller.abort();
        throw new Error("aborted");
      }
      return { ok: true };
    }, controller.signal);

    await expect(
      dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, new Map())
    ).resolves.toEqual({ handled: false });
  });

  it("keeps waiting when a read fails rather than deciding there is no chooser", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    // The launch's own tree-source gate has already vouched for the source, so a
    // failure here is transient. The wait continues, and the chooser the next
    // read does return is still dismissed.
    let at = 0;
    vi.mocked(fetchFlowTree).mockImplementation(async () => {
      at += 1;
      if (at === 1) throw new Error("hierarchy unavailable");
      return { tree: at === 2 ? launcherTree() : app, source: "android-devtools" };
    });
    const { calls, actionEnv } = env();

    await expect(
      dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081, new Map())
    ).resolves.toMatchObject({
      handled: true,
      ok: true,
    });
    expect(calls.map((c) => c.tool)).toEqual(["gesture-tap"]);
  });
});

describe("the shape the adapter really produces", () => {
  it("reads a flattened chooser exactly like the nested fixture", () => {
    const flat = asProduced(launcherTree());
    expect(flat.children.every((n) => n.children.length === 0)).toBe(true);
    expect(detectDevLauncher(flat)).toEqual({ historyY: 0.491 });
    const picked = pickDevServerRow(flat, 8081, 0.491);
    expect(picked?.url).toBe("http://10.0.2.2:8081");
    expect(picked?.node.frame.y).toBe(0.307);
    // The scroll container is a full-width leaf here, carrying every row's URL
    // as hoisted text — the shape that made a history-only port match it.
    expect(pickDevServerRow(flat, 8085, 0.491)).toBeNull();
  });

  it("offers nothing on the no-servers face a current client draws", () => {
    // The box's own label is the bare scheme now, so the only origin on screen
    // is a remembered row below the boundary. Nothing above it is offered, and
    // the launch reports the port it wanted instead of pressing the box.
    const tree = noServersToday();
    const found = detectDevLauncher(tree);
    expect(found).toEqual({ historyY: 0.675 });
    expect(pickDevServerRow(tree, 8093, 0.675)).toBeNull();
    expect(pickDevServerRow(tree, 8081, 0.675)).toBeNull();
  });

  it("records every tap on the no-servers face, having no row to claim", () => {
    // The recorder's half of the same screen: with no live row, no tap on it
    // belongs to the launch — including one on the remembered row, which the
    // launch refuses to open.
    const tree = noServersToday();
    for (const point of [
      { x: 0.5, y: 0.416 }, // the address box
      { x: 0.5, y: 0.584 }, // "Fetch development servers"
      { x: 0.5, y: 0.748 }, // the remembered row
      { x: 0.82, y: 0.93 }, // the launcher's own tab bar
    ]) {
      expect(devServerRowAt(tree, point)).toBeNull();
    }
  });

  it("keeps the address box out of the candidates once flattened", () => {
    // Flattening drops the parent/child link between the input and the text it
    // renders, so only the frames are left to tell them apart — which is why the
    // exclusion is geometric.
    const flat = asProduced(noServersTree());
    expect(detectDevLauncher(flat)).toEqual({ historyY: 0.732 });
    expect(pickDevServerRow(flat, 8081, 0.732)).toBeNull();
  });
});

describe("when the bundler never serves the app", () => {
  it("gives the chooser the full exit budget, then names the URL it opened", async () => {
    // The tap lands, but the chooser is still there a minute later: the bundler at
    // that address is not serving this app. The wait is generous because what
    // follows a tap is a cold bundle, so only the deadline can tell the two apart.
    vi.useFakeTimers();
    try {
      vi.mocked(adbShell).mockResolvedValue('Scheme: "expo-dev-launcher"');
      vi.mocked(fetchFlowTree).mockResolvedValue({
        tree: launcherTree(),
        source: "android-devtools",
      });
      const registry = {
        invokeTool: vi.fn(async () => ({ ok: true })),
        getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      } as unknown as Registry;

      const pending = dismissDevLauncher(
        { registry, device: emulator },
        "xyz.blueskyweb.app",
        8081,
        new Map()
      );
      await vi.advanceTimersByTimeAsync(61_000);
      const outcome = await pending;

      expect(outcome).toMatchObject({ handled: true, ok: false });
      expect(outcome).toHaveProperty(
        "reason",
        expect.stringContaining("opened http://10.0.2.2:8081 from the expo dev-client launcher")
      );
      expect(outcome).toHaveProperty("reason", expect.stringContaining("still showing 60s later"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the unreadable screen rather than the bundler it opened", async () => {
    // The retry is for a TRANSIENT read failure mid-bundle. When every read
    // fails the wait still burns its whole budget, and blaming "the bundler at
    // that address" then points at the one subsystem that was never observed.
    vi.useFakeTimers();
    try {
      vi.mocked(adbShell).mockResolvedValue('Scheme: "expo-dev-launcher"');
      let read = 0;
      vi.mocked(fetchFlowTree).mockImplementation(async () => {
        read += 1;
        if (read === 1) return { tree: launcherTree(), source: "android-devtools" };
        throw new Error("android devtools helper is not reachable");
      });
      const registry = {
        invokeTool: vi.fn(async () => ({ ok: true })),
        getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      } as unknown as Registry;

      const pending = dismissDevLauncher(
        { registry, device: emulator },
        "xyz.blueskyweb.app",
        8081,
        new Map()
      );
      await vi.advanceTimersByTimeAsync(61_000);
      const outcome = await pending;

      expect(outcome).toMatchObject({ handled: true, ok: false });
      expect(outcome).toHaveProperty(
        "reason",
        expect.stringContaining("android devtools helper is not reachable")
      );
      expect(outcome).toHaveProperty("reason", expect.stringContaining("could not be read"));
      expect(outcome).not.toHaveProperty("reason", expect.stringContaining("did not serve"));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what the launch step reports", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-dev-launcher-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** A registry that answers everything a bare Android `launch` step asks for. */
  function launchRegistry(): Registry {
    return {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      // The Android tree-source gate probes the devtools helper once.
      resolveService: vi.fn(async () => ({ isReady: () => true })),
    } as unknown as Registry;
  }

  async function writeFlow(name: string, steps: FlowStep[]): Promise<void> {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${name}.yaml`),
      serializeFlow({ executionPrerequisite: "", steps }),
      "utf8"
    );
  }

  async function runFlow(name: string, params: Record<string, unknown>): Promise<StepReport[]> {
    const result = await createRunFlowTool(launchRegistry()).execute(
      {},
      { name, project_root: tmpDir, device: emulator.id, ...params }
    );
    if (!("steps" in result))
      throw new Error(`expected a run result, got ${JSON.stringify(result)}`);
    return result.steps;
  }

  async function runLaunchOnly(params: Record<string, unknown>): Promise<StepReport[]> {
    await writeFlow("launch-only", [{ kind: "launch", app: "com.example.dev" }]);
    return runFlow("launch-only", params);
  }

  it("passes with a warning naming the server it opened", async () => {
    vi.mocked(adbShell).mockResolvedValue('Scheme: "expo-dev-launcher"');
    let read = 0;
    vi.mocked(fetchFlowTree).mockImplementation(async () => {
      read += 1;
      return {
        tree: read === 1 ? launcherTree() : node("ROOT", "Screen", [0, 0, 1, 1], []),
        source: "android-devtools",
      };
    });

    // The step did pass — but not by starting where the flow assumes, which is
    // the only place the run says so.
    expect(await runLaunchOnly({ metroPort: 8082 })).toMatchObject([
      {
        kind: "launch",
        status: "pass",
        warning:
          "app opened behind the expo dev-client launcher — dismissed it via http://10.0.2.2:8082",
      },
    ]);
  });

  it("errors with the port it wanted when the chooser lists no live row for it", async () => {
    vi.mocked(adbShell).mockResolvedValue('Scheme: "expo-dev-launcher"');
    vi.mocked(fetchFlowTree).mockResolvedValue({
      tree: launcherTree(),
      source: "android-devtools",
    });

    const steps = await runLaunchOnly({ metroPort: 8085 });
    expect(steps[0]).toMatchObject({ kind: "launch", status: "error" });
    expect(steps[0].reason).toContain("lists no live server on port 8085");
  });

  it("takes 8081 when the caller names no port", async () => {
    vi.mocked(adbShell).mockResolvedValue('Scheme: "expo-dev-launcher"');
    let read = 0;
    vi.mocked(fetchFlowTree).mockImplementation(async () => {
      read += 1;
      return {
        tree: read === 1 ? launcherTree() : node("ROOT", "Screen", [0, 0, 1, 1], []),
        source: "android-devtools",
      };
    });

    const steps = await runLaunchOnly({});
    expect(steps[0].warning).toContain("http://10.0.2.2:8081");
  });

  it("keeps a throwing launch inside the report instead of failing the call", async () => {
    // Nothing under `runLaunch` throws today — every arm catches its own. The
    // run's "never lose the collected report" property should not depend on
    // that staying true of each of them.
    vi.mocked(adbShell).mockImplementation(() => {
      throw new Error("adb resolution exploded");
    });
    vi.mocked(fetchFlowTree).mockResolvedValue({
      tree: node("ROOT", "Screen", [0, 0, 1, 1], []),
      source: "android-devtools",
    });

    const steps = await runLaunchOnly({});
    expect(steps[0]).toMatchObject({ kind: "launch", status: "error" });
    expect(steps[0].reason).toContain("adb resolution exploded");
  });

  it("lets a launch's FailureError out with its taxonomy", async () => {
    // The guard above is for an Android dev client; it must not quietly change
    // how a CHROMIUM launch fails. Those paths raise FailureError, and
    // flattening one into a step reason would drop the code and stage a caller
    // reads a tool failure by.
    vi.mocked(adbShell).mockImplementation(() => {
      throw new FailureError("electron app path does not exist", {
        error_code: FAILURE_CODES.INVALID_INPUT,
        failure_stage: "chromium_boot",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    });
    vi.mocked(fetchFlowTree).mockResolvedValue({
      tree: node("ROOT", "Screen", [0, 0, 1, 1], []),
      source: "android-devtools",
    });

    await expect(runLaunchOnly({})).rejects.toMatchObject({
      message: expect.stringContaining("electron app path does not exist"),
    });
  });

  it("says nothing extra when the app starts on its own screen", async () => {
    vi.mocked(adbShell).mockResolvedValue('Scheme: "expo-dev-launcher"');
    vi.mocked(fetchFlowTree).mockResolvedValue({
      tree: node(
        "ROOT",
        "Screen",
        [0, 0, 1, 1],
        [
          node("StaticText", "Home", [0.1, 0.1, 0.2, 0.03]),
          node("StaticText", "Following", [0.1, 0.2, 0.3, 0.03]),
        ]
      ),
      source: "android-devtools",
    });

    const steps = await runLaunchOnly({ metroPort: 8082 });
    expect(steps[0]).toMatchObject({ kind: "launch", status: "pass" });
    expect(steps[0].warning).toBeUndefined();
  });

  it("skips a launch the run cancelled while it waited for the chooser", async () => {
    // A cancelled wait answers "not handled" — the same answer an ordinary app
    // gives — so without the runner's own re-check right after it, the launch
    // would report a pass that verified nothing.
    const controller = new AbortController();
    vi.mocked(adbShell).mockResolvedValue('Scheme: "expo-dev-launcher"');
    vi.mocked(fetchFlowTree).mockImplementation(async () => {
      controller.abort();
      return {
        tree: node("ROOT", "Screen", [0, 0, 1, 1], [node("Image", "", [0.4, 0.45, 0.2, 0.1])]),
        source: "android-devtools",
      };
    });
    await writeFlow("launch-only", [{ kind: "launch", app: "com.example.dev" }]);

    const result = await createRunFlowTool(launchRegistry()).execute(
      {},
      { name: "launch-only", project_root: tmpDir, device: emulator.id },
      { signal: controller.signal } as never
    );

    if (!("steps" in result)) throw new Error("expected a run result");
    expect(result.steps[0]).toMatchObject({ kind: "launch", status: "skip" });
  });

  /** Every launch in the run meets the chooser and opens the same row. */
  function chooserEveryLaunch(): void {
    vi.mocked(adbShell).mockResolvedValue('Scheme: "expo-dev-launcher"');
    let read = 0;
    vi.mocked(fetchFlowTree).mockImplementation(async () => {
      read += 1;
      // Chooser, then gone, then chooser again for the next launch.
      return {
        tree: read % 2 === 1 ? launcherTree() : node("ROOT", "Screen", [0, 0, 1, 1], []),
        source: "android-devtools",
      };
    });
  }

  it("carries the run's probe answer across its launches", async () => {
    // The cache lives on the run's ExecState. Two launches, one probe — and the
    // second launch still gets the recovery off the remembered answer.
    chooserEveryLaunch();
    await writeFlow("twice", [
      { kind: "launch", app: "com.example.dev" },
      { kind: "launch", app: "com.example.dev" },
    ]);

    const steps = await runFlow("twice", {});

    expect(steps.map((s) => s.status)).toEqual(["pass", "pass"]);
    expect(steps[1].warning).toContain("http://10.0.2.2:8081");
    expect(adbShell).toHaveBeenCalledTimes(1);
  });

  it("carries it into a `run:` fragment's launch as well", async () => {
    // A fragment shares the parent's ExecState, so its launch reads the same
    // cache and the same metroPort rather than resolving its own.
    chooserEveryLaunch();
    await writeFlow("frag", [{ kind: "launch", app: "com.example.dev" }]);
    await writeFlow("outer", [
      { kind: "launch", app: "com.example.dev" },
      { kind: "run", flow: "frag.yaml" },
    ]);

    const steps = await runFlow("outer", { metroPort: 8082 });

    expect(steps.every((s) => s.status === "pass")).toBe(true);
    const launches = steps.filter((s) => s.kind === "launch");
    expect(launches).toHaveLength(2);
    expect(launches[1].warning).toContain("http://10.0.2.2:8082");
    expect(adbShell).toHaveBeenCalledTimes(1);
  });

  it("probes again after the run installs a different build", async () => {
    // `reinstall-app` takes an arbitrary appPath, so what is installed CAN move
    // mid-run. A remembered answer would carry a release build's "no" onto the
    // dev build that replaced it, and the second launch would skip the chooser.
    chooserEveryLaunch();
    await writeFlow("reinstall", [
      { kind: "launch", app: "com.example.dev" },
      { kind: "tool", name: "reinstall-app", args: { appPath: "/tmp/other.apk" } },
      { kind: "launch", app: "com.example.dev" },
    ]);

    const steps = await runFlow("reinstall", {});

    expect(steps.map((s) => s.status)).toEqual(["pass", "pass", "pass"]);
    expect(adbShell).toHaveBeenCalledTimes(2);
  });

  it("probes again after a nested composition that could have reinstalled the app", async () => {
    // The nested `tool: flow-execute` run keeps its own state and dispatches its
    // steps through the registry, so a `reinstall-app` in there moves what is
    // installed without the outer run ever seeing a reinstall step. The cache
    // must be dropped after ANY composition step — here the second launch meets
    // a build whose answer the first launch's probe says nothing about.
    chooserEveryLaunch();
    await writeFlow("inner", [
      { kind: "tool", name: "reinstall-app", args: { appPath: "/tmp/dev.apk" } },
    ]);
    await writeFlow("nested", [
      { kind: "launch", app: "com.example.dev" },
      { kind: "tool", name: "flow-execute", args: { name: "inner" } },
      { kind: "launch", app: "com.example.dev" },
    ]);

    const steps = await runFlow("nested", {});

    expect(steps.map((s) => s.status)).toEqual(["pass", "pass", "pass"]);
    expect(adbShell).toHaveBeenCalledTimes(2);
  });
});
