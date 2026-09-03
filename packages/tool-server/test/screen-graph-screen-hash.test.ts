import { describe, expect, it } from "vitest";
import {
  identityHash,
  isIdentityTitle,
  isToolbarContainer,
  structuralHash,
  type HashNode,
} from "../src/utils/screen-hash";

/**
 * Screen-graph Phase D §1 — `H_id` (screen identity) unit tests.
 *
 * The trees below are authored from the graph store UPLOADED by CI run
 * 33806639520 (`graph-store/com.android.settings/34.json`): node 77a189ce (the
 * Settings homepage, app-bar EXPANDED), 299378e0 (the same homepage after a
 * scroll — the app bar has COLLAPSED and dropped its `homepage_title`, and later
 * rows are shown), 2bf46d4f (`Network & internet`, the single node every Settings
 * detail screen collapsed onto), and 82827b4a (`Apps`). Battery / Sound / Display
 * are authored from 2bf46d4f's skeleton with only the collapsing-toolbar title and
 * the row texts changed — the C.4 store collapsed and OVERWROTE their real nodes
 * (that collapse is the bug `H_id` fixes), so they cannot be captured directly.
 *
 * Only the fields `H_id` reads (package, class, resource-id, text/cd, scrollable,
 * children) are modelled; bounds are irrelevant to `H_id` and set to the unit box.
 */

const PKG = "com.android.settings";
const B = { x1: 0, y1: 0, x2: 1, y2: 1 };

interface Opt {
  text?: string;
  cd?: string;
  scrollable?: boolean;
  clickable?: boolean;
  focused?: boolean;
}
function n(cls: string, id: string, opt: Opt = {}, children: HashNode[] = []): HashNode {
  return {
    class: cls,
    id,
    text: opt.text ?? "",
    cd: opt.cd ?? "",
    bounds: B,
    scrollable: opt.scrollable ?? false,
    clickable: opt.clickable ?? false,
    focused: opt.focused ?? false,
    children,
  };
}

/** One preference row (icon + title + summary) under a RecyclerView. */
function prefRow(title: string, summary = ""): HashNode {
  return n("LinearLayout", "", { clickable: true }, [
    n("LinearLayout", "icon_frame", {}, [n("Image", "icon")]),
    n("RelativeLayout", "text_frame", {}, [
      n("StaticText", "title", { text: title }),
      ...(summary ? [n("StaticText", "summary", { text: summary })] : []),
    ]),
  ]);
}

/** The Settings HOMEPAGE skeleton. `expanded` controls the large-title app bar. */
function settingsHome(expanded: boolean, rows: string[]): HashNode[] {
  const appBarChildren: HashNode[] = [];
  if (expanded) {
    appBarChildren.push(
      n("LinearLayout", "homepage_app_bar_regular_phone_view", {}, [
        // The oversized homepage title that COLLAPSES out of the tree on scroll.
        n("StaticText", "homepage_title", { text: "Settings" }),
      ])
    );
  }
  appBarChildren.push(
    n("CardView", "search_bar", {}, [
      n("ViewGroup", "search_action_bar", { clickable: true }, [
        n("StaticText", "search_action_bar_title", { text: "Search settings" }),
      ]),
    ])
  );
  return [
    n("View", "statusBarBackground"), // window decor — excluded from H_id
    n("FrameLayout", "content", {}, [
      n("ScrollView", "settings_homepage_container", { scrollable: expanded }, [
        n("LinearLayout", "app_bar", {}, [n("LinearLayout", "app_bar_container", {}, appBarChildren)]),
        n("ScrollView", "main_content_scrollable_container", { scrollable: true }, [
          n("LinearLayout", "homepage_container", {}, [
            n("FrameLayout", "main_content", {}, [
              n("LinearLayout", "container_material", {}, [
                n("FrameLayout", "list_container", {}, [
                  n("ScrollView", "recycler_view", {}, rows.map((r) => prefRow(r))),
                ]),
              ]),
            ]),
          ]),
        ]),
      ]),
    ]),
  ];
}

/** A Settings DETAIL sub-screen: AppBar + CollapsingToolbar(title) + RecyclerView. */
function settingsDetail(title: string, rows: Array<[string, string]>): HashNode[] {
  return [
    n("View", "statusBarBackground"),
    n("FrameLayout", "content", {}, [
      n("ScrollView", "content_parent", { scrollable: true }, [
        n("LinearLayout", "app_bar", {}, [
          // CollapsingToolbarLayout carries the screen title as its contentDesc.
          n("FrameLayout", "collapsing_toolbar", { cd: title }, [
            n("ViewGroup", "action_bar", {}, [n("Button", "", { cd: "Navigate up", clickable: true })]),
          ]),
        ]),
        n("FrameLayout", "content_frame", {}, [
          n("FrameLayout", "main_content", {}, [
            n("LinearLayout", "container_material", {}, [
              n("FrameLayout", "list_container", {}, [
                n("ScrollView", "recycler_view", {}, rows.map(([t, s]) => prefRow(t, s))),
              ]),
            ]),
          ]),
        ]),
      ]),
    ]),
  ];
}

// ── The captured roots ──────────────────────────────────────────────────────
const root77a = settingsHome(true, [
  "Network & internet",
  "Connected devices",
  "Apps",
  "Notifications",
  "Battery",
]);
const root299 = settingsHome(false, [
  "Sound & vibration",
  "Display",
  "Wallpaper & style",
  "Accessibility",
  "Security & privacy",
]);
const network = settingsDetail("Network & internet", [
  ["Internet", "AndroidWifi"],
  ["Calls & SMS", "T-Mobile"],
  ["SIMs", "T-Mobile"],
  ["Airplane mode", ""],
]);
const apps = settingsDetail("Apps", [
  ["Recently opened apps", ""],
  ["Default apps", ""],
]);
const battery = settingsDetail("Battery", [
  // Same row shape (icon + title + summary) as Network's first row, so the
  // text-free `H` recycler rule collapses the two — see test (b').
  ["Battery usage", "5h 30m left"],
  ["Battery Saver", "Off"],
]);
const sound = settingsDetail("Sound & vibration", [
  ["Media volume", ""],
  ["Do Not Disturb", "Off"],
]);
const display = settingsDetail("Display", [
  ["Brightness level", ""],
  ["Dark theme", "Off"],
]);
// The same Network screen after a scroll: first row gone, later rows shown, the
// outer scroller's `scrollable` flag flipped, and the toolbar focused.
const networkScrolled = settingsDetail("Network & internet", [
  ["Airplane mode", ""],
  ["Hotspot & tethering", "Off"],
  ["Data Saver", "Off"],
  ["VPN", "None"],
]);

describe("H_id predicates", () => {
  it("treats collapsing_toolbar / action-bar / dialog ids as identity titles", () => {
    expect(isIdentityTitle("collapsing_toolbar", false)).toBe(true);
    expect(isIdentityTitle("action_bar_title", false)).toBe(true);
    expect(isIdentityTitle("alertTitle", false)).toBe(true);
    expect(isIdentityTitle("title", true)).toBe(true); // under a toolbar
  });
  it("does NOT treat a bare list `title`, a search hint, or homepage_title as identity", () => {
    expect(isIdentityTitle("title", false)).toBe(false); // a row title
    expect(isIdentityTitle("search_action_bar_title", false)).toBe(false);
    expect(isIdentityTitle("homepage_title", false)).toBe(false); // collapses on scroll
  });
  it("marks toolbar/app_bar containers", () => {
    expect(isToolbarContainer("collapsing_toolbar")).toBe(true);
    expect(isToolbarContainer("app_bar")).toBe(true);
    expect(isToolbarContainer("recycler_view")).toBe(false);
  });
});

describe("H_id — screen identity (design D §1)", () => {
  it("(a) merges the two homepage roots 77a189ce and 299378e0 into ONE H_id", () => {
    // Same screen captured expanded vs scroll-collapsed: the vanished
    // homepage_title, the flipped scroll flag and the different rows must NOT
    // move H_id. (Their `H` differs — that is the two-hashes-per-screen bug.)
    expect(identityHash(root299, PKG)).toBe(identityHash(root77a, PKG));
    expect(structuralHash(root299, 1080, 2400)).not.toBe(structuralHash(root77a, 1080, 2400));
  });

  it("(b) gives Network / Battery / Sound / Display / Apps five DISTINCT H_id", () => {
    const ids = [network, battery, sound, display, apps].map((t) => identityHash(t, PKG));
    expect(new Set(ids).size).toBe(5);
  });

  it("(b') the detail screens collapse under H but SEPARATE under H_id", () => {
    // Network and Battery share the exact AppBar+CollapsingToolbar+RecyclerView
    // skeleton, so `H` (text-free, first-child recycler rule, bounds) is identical
    // — the collapse that made navigate-to unroutable. H_id separates them.
    expect(structuralHash(network, 1080, 2400)).toBe(structuralHash(battery, 1080, 2400));
    expect(identityHash(network, PKG)).not.toBe(identityHash(battery, PKG));
  });

  it("(c) the same sub-screen scrolled keeps the SAME H_id", () => {
    expect(identityHash(networkScrolled, PKG)).toBe(identityHash(network, PKG));
  });

  it("a sub-screen H_id differs from the homepage H_id", () => {
    expect(identityHash(network, PKG)).not.toBe(identityHash(root77a, PKG));
  });

  it("focus and the scroll flag never move H_id", () => {
    const focused = settingsDetail("Network & internet", [["Internet", "AndroidWifi"]]);
    // deep-poke a focus flag + flip the outer scroller flag
    (focused[1]!.children![0] as HashNode).scrollable = false;
    (focused[1]!.children![0]!.children![0] as HashNode).focused = true;
    const plain = settingsDetail("Network & internet", [["Internet", "AndroidWifi"]]);
    expect(identityHash(focused, PKG)).toBe(identityHash(plain, PKG));
  });
});
