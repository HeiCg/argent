import { describe, expect, it } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import type { DescribeNode } from "../../src/tools/describe/contract";
import {
  detectDevLauncher,
  hasDrawnContent,
  pickDevServerRow,
} from "../../src/tools/flows/flow-dev-launcher";

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

const emulator: DeviceInfo = { id: "emulator-5556", platform: "android", kind: "emulator" };
const phone: DeviceInfo = { id: "R5CT30", platform: "android", kind: "device" };
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
    const picked = pickDevServerRow(tree, emulator, 8081, historyY(tree));
    expect(picked?.url).toBe("http://10.0.2.2:8081");
    // The row itself, not the scroll container whose hoisted text repeats it.
    expect(picked?.node.label).toBe("http://10.0.2.2:8081 / Chevron");
    expect(picked?.node.frame.y).toBe(0.307);
  });

  it("honors the caller's port when several bundlers are live", () => {
    const tree = launcherTree();
    expect(pickDevServerRow(tree, emulator, 8082, historyY(tree))?.node.frame.y).toBe(0.233);
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
    expect(pickDevServerRow(tree, emulator, 8085, historyY(tree))).toBeNull();
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
    expect(pickDevServerRow(tree, emulator, 8085, historyY(tree))).toBeNull();
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
    const picked = pickDevServerRow(rows, emulator, 8081, historyY(rows));
    expect(picked?.node.role).toBe("StaticText");
    expect(picked?.node.frame.y).toBe(0.245);
  });

  it("does not let a short port match a longer one", () => {
    // `http://10.0.2.2:808` is a prefix of the live 8081 row. Substring
    // matching alone would open the wrong bundler and run the flow against
    // someone else's bundle.
    const tree = launcherTree();
    expect(pickDevServerRow(tree, emulator, 808, historyY(tree))).toBeNull();
  });

  it("prefers the emulator's host-loopback alias over localhost", () => {
    const both = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [
        node("StaticText", "DEVELOPMENT SERVERS", [0.061, 0.193, 0.352, 0.02]),
        node("View", "http://localhost:8081", [0.061, 0.233, 0.878, 0.064]),
        node("View", "http://10.0.2.2:8081", [0.061, 0.307, 0.878, 0.064]),
        node("View", "Plus / New development server", [0.061, 0.382, 0.878, 0.059]),
      ]
    );
    // On an emulator `localhost` is the emulator itself and only reaches Metro
    // through an adb reverse tunnel; 10.0.2.2 is the host by construction.
    expect(pickDevServerRow(both, emulator, 8081, historyY(both))?.url).toBe(
      "http://10.0.2.2:8081"
    );
    // A physical device has no such alias — there the tunnel is the only route.
    expect(pickDevServerRow(both, phone, 8081, historyY(both))?.url).toBe("http://localhost:8081");
  });

  it("uses loopback on an iOS simulator, which shares the host network stack", () => {
    const ios = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [
        node("StaticText", "DEVELOPMENT SERVERS", [0.061, 0.193, 0.352, 0.02]),
        node("View", "http://localhost:8081", [0.061, 0.233, 0.878, 0.064]),
        node("View", "Plus / New development server", [0.061, 0.382, 0.878, 0.059]),
      ]
    );
    expect(pickDevServerRow(ios, sim, 8081, historyY(ios))?.url).toBe("http://localhost:8081");
  });
});
