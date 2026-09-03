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
    // Destination-unique (C.3): "Calls & SMS" is on the Network & internet
    // sub-screen and NOT on the Settings root (capture run 33767073864). The old
    // "Internet" matched the root's "Network & internet" — a missed tap would
    // false-pass. navTarget is the same exact text so O5 routes root→sub-screen.
    assertion: t("Calls & SMS"),
    navTarget: t("Calls & SMS"),
  },
  {
    id: "settings-connected",
    app: "settings",
    description: "Open Connected devices",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Connected devices") }, knownTarget: true },
    ],
    // "Pair new device" is on the Connected devices screen, not the root.
    assertion: t("Pair new device"),
    navTarget: t("Pair new device"),
  },
  {
    id: "settings-apps",
    app: "settings",
    description: "Open Apps",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Apps") }, knownTarget: true },
    ],
    // "Special app access" is on the Apps screen, not the root (whose "Apps"
    // item made the old bare-"app" needle a guaranteed false-pass).
    assertion: t("Special app access"),
    navTarget: t("Special app access"),
  },
  {
    id: "settings-notifications",
    app: "settings",
    description: "Open Notifications",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Notifications") }, knownTarget: true },
    ],
    // "App notifications" is on the Notifications screen, not the root.
    assertion: t("App notifications"),
    navTarget: t("App notifications"),
  },
  {
    id: "settings-battery",
    app: "settings",
    description: "Open Battery",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Battery") }, knownTarget: true },
    ],
    // "Battery usage" is on the Battery screen, not the root (whose "Battery"
    // item made the old bare-"battery" needle a false-pass).
    assertion: t("Battery usage"),
    navTarget: t("Battery usage"),
  },
  {
    id: "settings-storage",
    app: "settings",
    description: "Open Storage",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Storage") }, knownTarget: true },
    ],
    // "Free up space" is on the Storage screen, not the root.
    assertion: t("Free up space"),
    navTarget: t("Free up space"),
  },
  {
    id: "settings-sound",
    app: "settings",
    description: "Open Sound & vibration",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Sound & vibration") }, knownTarget: true },
    ],
    // "Media volume" is on the Sound & vibration screen, not the root (whose
    // "Volume, haptics, Do Not Disturb" made the old "volume" needle a false-pass).
    assertion: t("Media volume"),
    navTarget: t("Media volume"),
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
    // "brightness" is already destination-unique (not on the root). navTarget is
    // a Display-screen exact text ("Brightness level"), NOT "Display" — "Display"
    // is on the root too, so it would route O5 0 steps and never open the screen.
    assertion: t("brightness"),
    navTarget: t("Brightness level"),
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
    // "SIMs" is destination-unique vs the root (existing pre-flight ok). navTarget
    // "SIMs" routes O5 to the nearest screen holding it (Network & internet).
    assertion: t("SIMs"),
    navTarget: t("SIMs"),
  },
  {
    id: "settings-battery-then-back",
    app: "settings",
    // C.3: a task that goes Battery→back→root ENDS on its launch screen, so no
    // needle can be present on the destination yet absent on the launch — the old
    // "Network & internet" needle matched the root and false-passed on a missed
    // Battery tap. Reopen Battery after the back instead: the root is still
    // revisited (warm-graph reuse), the Battery screen is revisited too, and the
    // task ends on a screen with a destination-unique needle ("Battery usage").
    description: "Open Battery, go back to root, reopen Battery (revisit, warm graph)",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Battery") }, knownTarget: true },
      { action: { kind: "back" } },
      { action: { kind: "tap", selector: t("Battery") }, knownTarget: true },
    ],
    assertion: t("Battery usage"),
    navTarget: t("Battery usage"),
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
    // "documentation" is confirmed on example.com's real body ("...for use in
    // documentation examples without needing permission." — capture 33767073864).
    // example.com is a single short page a swipe cannot add content to, so launch
    // == destination and the pre-flight treats this as a launch-destination task
    // (needle present, no false-pass risk — there is no tap to miss).
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
    // "Clear text" is the content-description of the search field's clear (X)
    // button, which appears ONLY once text has been typed and sits at the top of
    // the field (never under the keyboard). It is absent from the root, so it
    // confirms BOTH that the search-field tap navigated AND that text was entered
    // — without false-passing on the root's "Bluetooth, pairing" (the old needle).
    // The Settings search RESULT rows do not surface as queryable nodes over the
    // open server, and the "Settings Services" footer is covered by the keyboard
    // (matrix run 33779983434: it read N for every config) — capture 33767073864.
    assertion: t("Clear text"),
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
    // "Media volume" is on the Sound & vibration screen, not the root.
    assertion: t("Media volume"),
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
    // "Special app access" is on the Apps screen, not the root.
    assertion: t("Special app access"),
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
