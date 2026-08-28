#!/usr/bin/env bash
# Phase 3.5 — iOS simulator keyboard tier (macOS only).
#
# The iOS clear is a 200-pair HID burst over the simulator-server's stdin pipe,
# and every other tier pins it against an in-memory recorder array: nothing
# anywhere else sends a real HID delete to a real simulator, so an injection
# that stopped landing — a keycode change, a transport regression — would be
# green everywhere. This tier types a known value into a real field and reads it
# back, which is the only check that can go red for that.
#
# Deliberately narrow: keyboard only. It is not an iOS equivalent of the Android
# tier.
#
# The fixture is Settings' own search field, so nothing has to be installed. It
# is a UIKit `UISearchBar`, whose `describe` node carries the typed value as
# `value="…"` — which is what makes "the field emptied" observable from outside
# the tool.
#
# Env overrides:
#   E2E_IOS_UDID   an already-booted simulator; with none, the first booted one
#                  in `list-devices` is used, and the tier skips if there is none.

_ios_booted_udid() {
  run_tool list-devices '{}'
  printf '%s' "$RT_JSON" |
    jq -r 'first(.devices[]? | select(.platform=="ios" and .state=="Booted" and .runtimeKind!="tv") | .udid) // empty' 2>/dev/null
}

# The search field's tap point, from `describe`. Returns "x y" in the normalized
# space the gesture tools take, or nothing when the node is not on screen.
_search_tap_point() { # udid
  run_tool describe "{\"udid\":\"$1\"}"
  printf '%s' "$RT_JSON" | jq -r '
    (.description // "")
    | [splits("\n")]
    | map(select(test("AXGroup \"Search\"")))
    | first // ""
    | capture("\\((?<x>[0-9.]+), (?<y>[0-9.]+), (?<w>[0-9.]+), (?<h>[0-9.]+)\\)")
    | (((.x|tonumber) + (.w|tonumber) / 2) | tostring) + " " + (((.y|tonumber) + (.h|tonumber) / 2) | tostring)
  ' 2>/dev/null
}

run_phase() {
  local P=ios
  if [ "$E2E_OS" != darwin ]; then
    skip "$P" tier all "iOS simulators exist only on macOS"; return 0
  fi
  ensure_server || { skip "$P" tier all "tool-server unavailable"; return 0; }

  local DEV="${E2E_IOS_UDID:-}"
  [ -n "$DEV" ] || DEV="$(_ios_booted_udid)"
  if [ -z "$DEV" ]; then
    skip "$P" tier all "no booted iOS simulator (boot one, or set E2E_IOS_UDID)"; return 0
  fi
  pass "$P" list-devices present "simulator $DEV"

  assert_true "$P" launch-app settings "{\"udid\":\"$DEV\",\"bundleId\":\"com.apple.Preferences\"}" '.launched'
  await_ui "$DEV" "Search"

  local POINT X Y
  POINT="$(_search_tap_point "$DEV")"
  # shellcheck disable=SC2086 # deliberate word split: "x y"
  set -- $POINT
  X="${1:-}"; Y="${2:-}"
  if [ -z "$X" ] || [ -z "$Y" ]; then
    skip "$P" keyboard clear "Settings' search field not found in describe"; return 0
  fi
  assert_true "$P" gesture-tap focus-search "{\"udid\":\"$DEV\",\"x\":$X,\"y\":$Y}" '.tapped'

  # A distinctive marker, so the assertions cannot pass on some other node's text.
  # Every match below folds case first: a UIKit search field auto-capitalises the
  # first character, so the value reads back as "Argentclearmark".
  local MARK=argentclearmark
  assert_ok "$P" keyboard type-marker "{\"udid\":\"$DEV\",\"text\":\"$MARK\",\"delayMs\":30}"
  await_ui "$DEV" "$MARK"
  assert_field "$P" describe clear-baseline "{\"udid\":\"$DEV\"}" \
    "(.description|ascii_downcase|contains(\"$MARK\"))" 'true'

  # The burst itself. `keys` is 200 — the CLEAR_KEY_PAIRS * 2 contract the tool
  # description states to callers — and the describe after it is what proves the
  # HID deletes actually reached the field rather than being dropped.
  assert_field "$P" keyboard clear "{\"udid\":\"$DEV\",\"clear\":true}" '.cleared' 'true'
  assert_field "$P" keyboard clear-keys "{\"udid\":\"$DEV\",\"clear\":true}" '.keys' '200'
  assert_field "$P" describe clear-took-effect "{\"udid\":\"$DEV\"}" \
    "(.description|ascii_downcase|contains(\"$MARK\"))" 'false'

  # One action per call, `clear` included — the same guard the other tiers make.
  assert_reject "$P" keyboard clear-and-text "{\"udid\":\"$DEV\",\"clear\":true,\"text\":\"x\"}"

  # Replace-a-value, the form the tool description prescribes: one round-trip,
  # and the field ends up holding ONLY the new text. The focus tap is its own
  # step with a settle, because `run-sequence` waits 100ms between steps and no
  # backend checks focus — the exact hazard the `clear` docs warn about.
  run_tool keyboard "{\"udid\":\"$DEV\",\"text\":\"$MARK\",\"delayMs\":30}" >/dev/null 2>&1
  await_ui "$DEV" "$MARK"
  assert_field "$P" run-sequence keyboard-clear-then-text \
    "{\"udid\":\"$DEV\",\"steps\":[{\"tool\":\"keyboard\",\"args\":{\"clear\":true}},{\"tool\":\"keyboard\",\"args\":{\"text\":\"replaced\",\"delayMs\":30}}]}" \
    '.completed' '2'
  await_ui "$DEV" "replaced"
  assert_field "$P" describe clear-then-retype "{\"udid\":\"$DEV\"}" \
    "((.description|ascii_downcase|contains(\"replaced\")) and ((.description|ascii_downcase|contains(\"$MARK\"))|not))" 'true'

  # Leave the simulator on a neutral screen rather than in a search with text.
  run_tool keyboard "{\"udid\":\"$DEV\",\"clear\":true}" >/dev/null 2>&1
  run_tool button "{\"udid\":\"$DEV\",\"button\":\"home\"}" >/dev/null 2>&1
}
