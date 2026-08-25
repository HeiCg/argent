// Golden coverage over two real `getHierarchy` captures taken on an Android 14
// emulator (1080x2400): an in-app `android.webkit.WebView` (a fixture APK that
// loads a local login page) and a Chrome tab on the same form. Both dumps used
// to collapse to a single opaque `WebView` line; they are checked in so a
// future trim rule cannot silently re-hide the web DOM.
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseUiAutomatorDump } from "../src/tools/describe/platforms/android/uiautomator-parser";
import type { DescribeNode } from "../src/tools/describe/contract";

const SCREEN_W = 1080;
const SCREEN_H = 2400;

function read(name: string): string {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

function flatten(tree: DescribeNode): DescribeNode[] {
  const out: DescribeNode[] = [];
  const stack: DescribeNode[] = [tree];
  while (stack.length > 0) {
    const n = stack.pop()!;
    out.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return out;
}

describe("Android WebView describe — real captures", () => {
  it("surfaces the in-app WebView login form", () => {
    const tree = parseUiAutomatorDump(read("android-webview-inapp.xml"), SCREEN_W, SCREEN_H);
    const nodes = flatten(tree);

    // One WebView landmark (Chromium's doubled node is collapsed), labelled
    // with the page <title>.
    const webviews = nodes.filter((n) => n.role === "WebView");
    expect(webviews).toHaveLength(1);
    expect(webviews[0]!.label).toBe("Login Page");

    // The whole form is reachable, and the HTML ids came through as
    // identifiers, so every control is selector-addressable.
    const byId = new Map(nodes.filter((n) => n.identifier).map((n) => [n.identifier!, n]));
    expect(byId.get("username")?.role).toBe("TextField");
    expect(byId.get("password")?.role).toBe("TextField");
    expect(byId.get("login")?.role).toBe("Button");
    expect(byId.get("login")?.label).toBe("Login");
    expect(byId.get("login")?.clickable).toBe(true);

    // Web text runs read as text, not as bare "View" scaffolding.
    const labels = nodes.filter((n) => n.role === "StaticText").map((n) => n.label);
    expect(labels).toContain("Login Page");
    expect(labels).toContain("Powered by Elemental Selenium");

    // Locks the node budget: the sentinel emitted 2 nodes for this screen.
    expect(nodes.length - 1).toBe(10);
  });

  it("surfaces the Chrome tab's web DOM alongside Chrome's own toolbar", () => {
    const tree = parseUiAutomatorDump(read("android-webview-chrome.xml"), SCREEN_W, SCREEN_H);
    const nodes = flatten(tree);

    const webviews = nodes.filter((n) => n.role === "WebView");
    expect(webviews).toHaveLength(1);
    expect(webviews[0]!.label).toBe("The Internet");

    const byId = new Map(nodes.filter((n) => n.identifier).map((n) => [n.identifier!, n]));
    expect(byId.get("username")?.role).toBe("TextField");
    expect(byId.get("password")?.role).toBe("TextField");
    // Chrome's native chrome is unaffected and still sits beside the web DOM.
    expect(byId.has("com.android.chrome:id/url_bar")).toBe(true);

    expect(nodes.length - 1).toBe(22);
  });

  it("never lets a WebView password input's plaintext escape", () => {
    for (const fixture of ["android-webview-inapp.xml", "android-webview-chrome.xml"]) {
      const nodes = flatten(parseUiAutomatorDump(read(fixture), SCREEN_W, SCREEN_H));
      const field = nodes.find((n) => n.identifier === "password");
      expect(field?.password).toBe(true);
      expect(field?.label).toBe("[password]");
      expect(field?.value).toBeUndefined();
    }
  });
});
