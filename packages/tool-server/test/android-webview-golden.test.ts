// Golden coverage over two real `getHierarchy` captures taken on an Android
// emulator at 1080x2400: an in-app `android.webkit.WebView` and a Chrome tab.
// Both dumps used to collapse to a single opaque `WebView` line; they are
// checked in so a future trim rule cannot silently re-hide the web DOM.
//
// The two captures are of DIFFERENT pages, and the WebView build decides how
// much of a page reaches the tree — whether an HTML `id` arrives at all, for
// one. So a refreshed capture needs its expectation refreshed with it.
//
// To refresh the in-app capture, serve this page from the host on port 8765
// (`python3 -m http.server`):
//
//   <!doctype html><html><head><title>Login Page</title></head><body>
//   <h2>Login Page</h2>
//   <p>This is where you can log into the secure area.</p>
//   <form><label for="username">Username</label>
//   <input type="text" id="username" name="username">
//   <label for="password">Password</label>
//   <input type="password" id="password" name="password">
//   <button type="submit" id="login">Login</button></form>
//   <div id="flash"></div>
//   <div>Powered by Elemental Selenium</div></body></html>
//
// then load `http://10.0.2.2:8765/login.html` in any app whose `setContentView`
// is a `WebView` — a bare Activity with `new WebView(this)` is enough. Wait for
// the renderer to publish its DOM (`describe` shows a childless `WebView` until
// then), then save `getHierarchy().xml` from the android-devtools helper here
// verbatim.
//
// The Chrome capture came from the live site, not from that copy: its `url_bar`
// reads `the-internet.herokuapp.com/login`, and the page carries a flash-message
// bar, a "Fork me on GitHub" ribbon and a page footer the copy has no counterpart
// for. Refresh it with `adb shell am start -a android.intent.action.VIEW -d
// https://the-internet.herokuapp.com/login com.android.chrome`, then capture the
// same way.
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

// One line per direct child of a node: role plus whatever identifies it, with
// long body copy cut short so the expectation stays readable (and so a page's
// prose does not get duplicated into this file). Nothing else is filtered — the
// row has to show what an agent reads off the describe line, invisible
// characters included.
function webRows(n: DescribeNode): string[] {
  return n.children.map((c) => {
    const name = (c.identifier ?? c.label ?? "").trim();
    return [c.role, name.length > 32 ? name.slice(0, 32) + "…" : name].filter(Boolean).join(" ");
  });
}

function roleByLabel(nodes: DescribeNode[]): Map<string | undefined, string> {
  return new Map(nodes.map((n) => [n.label, n.role]));
}

function countWebViewNodes(xml: string): number {
  return xml.split('class="android.webkit.WebView"').length - 1;
}

describe("Android WebView describe — real captures", () => {
  it("surfaces the in-app WebView login form", () => {
    const xml = read("android-webview-inapp.xml");
    // This capture is the doubled-node shape: the app's own WebView view plus
    // Chromium's root web area, nested and under the same class name, which the
    // merge collapses into one landmark.
    expect(countWebViewNodes(xml)).toBe(2);

    const tree = parseUiAutomatorDump(xml, SCREEN_W, SCREEN_H);
    const nodes = flatten(tree);

    const webviews = nodes.filter((n) => n.role === "WebView");
    expect(webviews).toHaveLength(1);
    expect(webviews[0]!.label).toBe("Login Page");

    // The whole form is reachable, in page order, and the HTML ids came through
    // as identifiers so every control is selector-addressable. Asserting the
    // shape rather than a node count says what changed when it changes.
    expect(webRows(webviews[0]!)).toEqual([
      "StaticText Login Page",
      "StaticText This is where you can log into t…",
      "StaticText Username",
      "TextField username",
      "StaticText Password",
      "TextField password",
      "Button login",
      "StaticText Powered by Elemental Selenium",
    ]);
    const byId = new Map(nodes.filter((n) => n.identifier).map((n) => [n.identifier!, n]));
    expect(byId.get("login")?.label).toBe("Login");
    expect(byId.get("login")?.clickable).toBe(true);

    // The two form labels are the nodes the contextual remap actually touches:
    // Chromium emits them as bare `android.view.View`. ("Login Page" and the
    // footer are TextViews, which map to StaticText without any remap.)
    const roles = roleByLabel(nodes);
    expect(roles.get("Username")).toBe("StaticText");
    expect(roles.get("Password")).toBe("StaticText");
  });

  it("surfaces the Chrome tab's web DOM alongside Chrome's own toolbar", () => {
    const xml = read("android-webview-chrome.xml");
    // Chrome has no WebView view of its own, so only the root web area carries
    // the class name and this capture covers the un-doubled shape — the merge is
    // exercised by the in-app fixture above.
    expect(countWebViewNodes(xml)).toBe(1);

    const tree = parseUiAutomatorDump(xml, SCREEN_W, SCREEN_H);
    const nodes = flatten(tree);

    const webviews = nodes.filter((n) => n.role === "WebView");
    expect(webviews).toHaveLength(1);
    expect(webviews[0]!.label).toBe("The Internet");

    expect(webRows(webviews[0]!)).toEqual([
      "StaticText flash-messages",
      "View Fork me on GitHub",
      "StaticText Login Page",
      "StaticText This is where you can log into t…",
      "StaticText Username",
      "TextField username",
      "StaticText Password",
      "TextField password",
      "Button \uF090 Login",
      "StaticText Powered by",
      "View Elemental Selenium",
    ]);

    // Chrome's native chrome is unaffected and still sits beside the web DOM.
    const byId = new Map(nodes.filter((n) => n.identifier).map((n) => [n.identifier!, n]));
    expect(byId.has("com.android.chrome:id/url_bar")).toBe(true);
    expect(byId.get("com.android.chrome:id/url_bar")?.label).toBe(
      "the-internet.herokuapp.com/login"
    );
  });

  it("keeps an icon-font glyph in the label, where the agent reads it", () => {
    // Chrome's own icon fonts expose glyphs as Private Use Area code points.
    // They render as nothing, and `escapeForLine` leaves them alone, so the
    // describe line for the login button reads `Button " Login"` while the label
    // is U+F090 followed by " Login". This capture is the first one to put such
    // a code point in an Android describe label, so pin the shape: a `text`
    // selector still finds the button as a substring, and a `textMatch: "equals"`
    // copied off the visible line does not.
    const nodes = flatten(
      parseUiAutomatorDump(read("android-webview-chrome.xml"), SCREEN_W, SCREEN_H)
    );
    const login = nodes.find((n) => n.role === "Button" && n.label?.includes("Login"));
    expect(login?.label).toBe("\uF090 Login");
    expect(login?.label).not.toBe("Login");
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
