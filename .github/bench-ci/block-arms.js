// Block name → arm, for the Android latency bench merge and scoreboard (Review 2026-10-07
// run 37591260027, "Next run": interleaved ABBA, three blocks per main arm).
//
// ABBA run order: OFF-1, ON-im-1, ON-uia, OFF-2, ON-im-2, OFF-3, ON-im-3, OFF-legacy.
//  - OFF-<n>: the current proprietary release (pooled arm; drift floor; P2-P5 comparator)
//  - ON-im-<n>: the open server with the input-manager injector (the candidate)
//  - ON-uia: the open server with the UiAutomation default (the P6 control, one block)
//  - OFF-legacy: an older proprietary release (its own arm, report only)
// The pre-ABBA names map to the same arms: ON-input-manager → candidate, ON-uiautomation →
// control (one block each).
"use strict";

const isCurrentOff = (n) => /^OFF-\d+$/.test(String(n));
const isOnIm = (n) => n === "ON-input-manager" || /^ON-im-\d+$/.test(String(n));
const isOnUia = (n) => n === "ON-uiautomation" || n === "ON-uia";
/** A name only the ABBA design uses (selects the ABBA order check and labels). */
const isAbbaName = (n) => /^ON-im-\d+$/.test(String(n)) || n === "ON-uia" || n === "OFF-3";

module.exports = { isCurrentOff, isOnIm, isOnUia, isAbbaName };
