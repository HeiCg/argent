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
    description: "Open Display",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Display") }, knownTarget: true },
    ],
    assertion: t("brightness"),
    navTarget: t("Display"),
  },
  {
    id: "settings-search-battery",
    app: "settings",
    description: "Search 'battery' from the Settings root",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: { id: "search", text: "Search settings" } } },
      { action: { kind: "type", selector: { id: "search_src_text", text: "Search" }, text: "battery" } },
    ],
    assertion: t("battery"),
  },
  {
    id: "settings-display-then-back",
    app: "settings",
    description: "Open Display, go back to the root (revisit)",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("Display") }, knownTarget: true },
      { action: { kind: "back" } },
    ],
    assertion: t("Network & internet"),
    navTarget: t("Display"),
  },
];

export const CHROME_TASKS: BenchTask[] = [
  {
    id: "chrome-open-page",
    app: "chrome",
    description: "Load example.com and confirm content",
    steps: [{ action: { kind: "launch" } }],
    assertion: t("Example Domain"),
  },
  {
    id: "chrome-url-bar",
    app: "chrome",
    description: "Confirm the URL bar is present",
    steps: [{ action: { kind: "launch" } }],
    assertion: { id: "url_bar", text: "example" },
  },
  {
    id: "chrome-menu",
    app: "chrome",
    description: "Open the Chrome overflow menu",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: { id: "menu_button", text: "More options" } }, knownTarget: true },
    ],
    assertion: t("New tab"),
    navTarget: { id: "menu_button", text: "More options" },
  },
  {
    id: "chrome-menu-close",
    app: "chrome",
    description: "Open the menu, dismiss it (revisit the page)",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: { id: "menu_button", text: "More options" } }, knownTarget: true },
      { action: { kind: "back" } },
    ],
    assertion: t("Example Domain"),
    navTarget: { id: "menu_button", text: "More options" },
  },
  {
    id: "chrome-more-info",
    app: "chrome",
    description: "Tap the 'More information...' link on example.com",
    steps: [
      { action: { kind: "launch" } },
      { action: { kind: "tap", selector: t("More information") } },
    ],
    assertion: t("iana"),
  },
];

export const ALL_TASKS: BenchTask[] = [...SETTINGS_TASKS, ...CHROME_TASKS];

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
    }
    if (task.navTarget && !selectorOk(task.navTarget)) {
      throw new Error(`task ${task.id} navTarget names neither id nor text`);
    }
  }
}
