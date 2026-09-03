/**
 * Screen-graph Phase C — the scripted tasks (design §4).
 *
 * 10 Settings + 5 Chrome navigation/form flows, the SAME for every config. The
 * "agent" is a scripted policy (no LLM in this phase): it issues the observation
 * calls each config allows, then the next action. Every task ends with an
 * assertion selector that must be present on the final screen (success).
 *
 * Selectors are deliberately loose (case-insensitive text / unqualified id) and
 * revisit shared screens (the Settings root, the Chrome menu) so cold-vs-warm
 * graph reuse (O3 vs O4) is actually exercised. Labels target Android 15
 * (API 35) Settings and Chrome as booted on AVD `bench-api35`.
 */
import type { BenchTask } from "./types";

const t = (text: string) => ({ text });

export const SETTINGS_TASKS: BenchTask[] = [
  {
    id: "settings-network",
    app: "settings",
    description: "Open Network & internet",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Network & internet") }, knownTarget: true },
    ],
    assertion: t("Internet"),
    navTarget: t("Network & internet"),
  },
  {
    id: "settings-connected",
    app: "settings",
    description: "Open Connected devices",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Connected devices") }, knownTarget: true },
    ],
    assertion: t("Bluetooth"),
    navTarget: t("Connected devices"),
  },
  {
    id: "settings-apps",
    app: "settings",
    description: "Open Apps",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Apps") }, knownTarget: true },
    ],
    assertion: t("app"),
    navTarget: t("Apps"),
  },
  {
    id: "settings-notifications",
    app: "settings",
    description: "Open Notifications",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Notifications") }, knownTarget: true },
    ],
    assertion: t("notification"),
    navTarget: t("Notifications"),
  },
  {
    id: "settings-battery",
    app: "settings",
    description: "Open Battery",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Battery") }, knownTarget: true },
    ],
    assertion: t("battery"),
    navTarget: t("Battery"),
  },
  {
    id: "settings-storage",
    app: "settings",
    description: "Open Storage",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Storage") }, knownTarget: true },
    ],
    assertion: t("storage"),
    navTarget: t("Storage"),
  },
  {
    id: "settings-sound",
    app: "settings",
    description: "Open Sound & vibration",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Sound & vibration") }, knownTarget: true },
    ],
    assertion: t("volume"),
    navTarget: t("Sound & vibration"),
  },
  {
    id: "settings-display",
    app: "settings",
    description: "Scroll to and open Display",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "swipe", direction: "up" } },
      { action: { kind: "tap", selector: t("Display") }, knownTarget: true },
    ],
    assertion: t("brightness"),
    navTarget: t("Display"),
  },
  {
    id: "settings-network-internet",
    app: "settings",
    description: "Two-level nav: Network & internet then Internet",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Network & internet") }, knownTarget: true },
      { action: { kind: "tap", selector: t("Internet") }, knownTarget: true },
    ],
    assertion: t("SIMs"),
    navTarget: t("Internet"),
  },
  {
    id: "settings-battery-then-back",
    app: "settings",
    description: "Open Battery, go back to the root (revisit)",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Battery") }, knownTarget: true },
      { action: { kind: "back" } },
    ],
    assertion: t("Network & internet"),
    navTarget: t("Battery"),
  },
];

export const CHROME_TASKS: BenchTask[] = [
  {
    id: "chrome-open-page",
    app: "chrome",
    description: "Load example.com and confirm the heading",
    steps: [{ action: { kind: "launch" } }],
    assertion: t("Example Domain"),
  },
  {
    id: "chrome-heading-word",
    app: "chrome",
    description: "Confirm the 'Domain' heading word",
    steps: [{ action: { kind: "launch" } }],
    assertion: t("Domain"),
  },
  {
    id: "chrome-example-word",
    app: "chrome",
    description: "Confirm 'example' is present on the page",
    steps: [{ action: { kind: "launch" } }],
    assertion: t("example"),
  },
  {
    id: "chrome-scroll-body",
    app: "chrome",
    description: "Scroll the page and confirm the body text",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "swipe", direction: "up" } },
    ],
    assertion: t("permission"),
  },
  {
    id: "chrome-scroll-doc",
    app: "chrome",
    // Needle to be confirmed against the real example.com AX-tree dump by the
    // C.1 pre-flight (BLOCKER-2) before the matrix — not assumption.
    description: "Scroll the page and confirm a real body word",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "swipe", direction: "up" } },
    ],
    assertion: t("documentation"),
  },
];

/**
 * SAME-SCREEN tasks (review addendum for H2). Each ends up on one screen and
 * then issues steps that do NOT navigate away, so O2's outcome has an unchanged
 * step to skip the read on (H2 is measured over `sameScreen` steps only — the
 * navigation tasks change the screen every step). No-op taps land on inert areas
 * (page whitespace, a screen title, empty list gutter); the search task types
 * two words into one search field; the slider task nudges the brightness bar.
 *
 * Coordinates and the exact inert areas are confirmed against the API-35 AVD by
 * the C.1 pre-flight BEFORE the matrix (the dump verifies the no-op taps report
 * `changed:false` and the needle is unique to the destination screen state, not
 * the launch screen). Placeholder coordinates until the pre-flight finalizes them.
 */
export const SAME_SCREEN_TASKS: BenchTask[] = [
  {
    id: "same-settings-search",
    app: "settings",
    description: "Settings search: type two words into the one search field (same screen)",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Search settings") } },
      { action: { kind: "type", selector: t("Search"), text: "blue" }, sameScreen: true },
      { action: { kind: "type", selector: t("Search"), text: "tooth" }, sameScreen: true },
    ],
    assertion: t("Bluetooth"),
  },
  {
    id: "same-sound-noop",
    app: "settings",
    description: "Sound & vibration: two no-op taps on inert area (same screen)",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Sound & vibration") } },
      { action: { kind: "tapXY", x: 0.5, y: 0.12, label: "screen-title" }, sameScreen: true },
      { action: { kind: "tapXY", x: 0.5, y: 0.12, label: "screen-title" }, sameScreen: true },
    ],
    assertion: t("volume"),
  },
  {
    id: "same-chrome-noop",
    app: "chrome",
    description: "example.com: two no-op taps on page whitespace (same screen)",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tapXY", x: 0.5, y: 0.5, label: "page-body" }, sameScreen: true },
      { action: { kind: "tapXY", x: 0.5, y: 0.5, label: "page-body" }, sameScreen: true },
    ],
    assertion: t("Example Domain"),
  },
  {
    id: "same-display-slider",
    app: "settings",
    description: "Display: nudge the brightness slider twice (same screen, content changes)",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "swipe", direction: "up" } },
      { action: { kind: "tap", selector: t("Display") } },
      { action: { kind: "tapXY", x: 0.4, y: 0.2, label: "brightness-slider" }, sameScreen: true },
      { action: { kind: "tapXY", x: 0.7, y: 0.2, label: "brightness-slider" }, sameScreen: true },
    ],
    assertion: t("brightness"),
  },
  {
    id: "same-apps-noop",
    app: "settings",
    description: "Apps: two no-op taps on the screen title/header (same screen)",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Apps") } },
      { action: { kind: "tapXY", x: 0.5, y: 0.12, label: "screen-title" }, sameScreen: true },
      { action: { kind: "tapXY", x: 0.5, y: 0.12, label: "screen-title" }, sameScreen: true },
    ],
    assertion: t("app"),
  },
];

export const ALL_TASKS: BenchTask[] = [...SETTINGS_TASKS, ...CHROME_TASKS, ...SAME_SCREEN_TASKS];

/**
 * Structural validation of a task list (device-free): every task has a unique
 * id, starts with a `launch`, carries at least one step, ends with a usable
 * assertion selector, and every selector names at least one of id/text. Throws
 * on the first violation so a malformed task set fails the harness loudly.
 */
export function validateTasks(tasks: BenchTask[] = ALL_TASKS): void {
  const seen = new Set<string>();
  const selectorOk = (s: { id?: string; text?: string }): boolean =>
    Boolean((s.id && s.id.length) || (s.text && s.text.length));
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    seen.add(task.id);
    if (task.steps.length === 0) throw new Error(`task ${task.id} has no steps`);
    if (task.steps[0]!.action.kind !== "launch") {
      throw new Error(`task ${task.id} must start with a launch step`);
    }
    if (!selectorOk(task.assertion)) {
      throw new Error(`task ${task.id} assertion selector names neither id nor text`);
    }
    for (const step of task.steps) {
      const a = step.action;
      if (a.kind === "tap" && !selectorOk(a.selector)) {
        throw new Error(`task ${task.id} tap selector names neither id nor text`);
      }
      if (a.kind === "type" && (!selectorOk(a.selector) || a.text.length === 0)) {
        throw new Error(`task ${task.id} type step is missing a selector or text`);
      }
      if (a.kind === "tapXY") {
        const inUnit = (v: number): boolean => Number.isFinite(v) && v >= 0 && v <= 1;
        if (!inUnit(a.x) || !inUnit(a.y)) {
          throw new Error(`task ${task.id} tapXY x/y must be normalized 0–1 (got ${a.x},${a.y})`);
        }
      }
      // A same-screen step must be an action that can plausibly stay on-screen
      // (never a launch/back, which navigate by definition).
      if (step.sameScreen && (a.kind === "launch" || a.kind === "back")) {
        throw new Error(`task ${task.id} sameScreen step cannot be a ${a.kind} action`);
      }
    }
    if (task.navTarget && !selectorOk(task.navTarget)) {
      throw new Error(`task ${task.id} navTarget names neither id nor text`);
    }
  }
}
