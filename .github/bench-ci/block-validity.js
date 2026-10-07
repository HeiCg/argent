// Per-block validity record for the latency bench (review 2026-10-07 finding 6).
//
// The workflow's run_block writes one entry per block into $BENCH_OUT/validity.json:
// the block's start time, whether the blocking ready-gate passed, the bench process
// exit code, and (OFF blocks) whether the proprietary provenance stamp succeeded.
// merge-blocks.js and scoreboard.js read it, so a block that failed, never ran past
// its ready-gate, or was left unstamped can no longer merge into a valid-looking
// scoreboard.
//
// CLI (workflow):
//   node block-validity.js record <validity.json> --block OFF-1 --ready-gate pass|fail \
//     [--exit-code N] [--stamped yes|no|n/a] [--started-at ISO]
// --exit-code is omitted when the block never ran (ready-gate failure).
const fs = require("fs");
const path = require("path");

const FILE = "validity.json";

function readValidity(out) {
  const p = path.join(out, FILE);
  if (!fs.existsSync(p)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(p, "utf8"));
    return v && typeof v === "object" && v.blocks ? v : null;
  } catch {
    return null;
  }
}

/** Reasons a recorded block is INVALID (empty array = valid). */
function entryReasons(e) {
  if (!e) return [];
  const r = [];
  if (e.readyGate === "fail") r.push("ready-gate failed (block not run)");
  if (e.exitCode != null && e.exitCode !== 0) r.push(`bench exited ${e.exitCode}`);
  if (e.readyGate !== "fail" && e.exitCode == null) r.push("no exit code recorded");
  if (e.stamped === "no") r.push("proprietary provenance not stamped");
  return r;
}

function record(file, entry) {
  let v = { blocks: {} };
  if (fs.existsSync(file)) {
    try {
      const cur = JSON.parse(fs.readFileSync(file, "utf8"));
      if (cur && cur.blocks) v = cur;
    } catch {
      /* rewrite a corrupt file */
    }
  }
  v.blocks[entry.block] = { ...entry, recordedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(v, null, 2) + "\n");
  return v;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    o[k.slice(2)] = argv[i + 1];
    i++;
  }
  return o;
}

if (require.main === module) {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (cmd !== "record" || !file) {
    console.error(
      "usage: block-validity.js record <validity.json> --block B --ready-gate pass|fail " +
        "[--exit-code N] [--stamped yes|no|n/a] [--started-at ISO]"
    );
    process.exit(2);
  }
  const a = parseArgs(rest);
  if (!a.block || !["pass", "fail"].includes(a["ready-gate"])) {
    console.error("block-validity: --block and --ready-gate pass|fail are required");
    process.exit(2);
  }
  const exitCode =
    a["exit-code"] === undefined || a["exit-code"] === "" ? null : Number(a["exit-code"]);
  const entry = {
    block: a.block,
    startedAt: a["started-at"] || null,
    readyGate: a["ready-gate"],
    exitCode: Number.isNaN(exitCode) ? -1 : exitCode,
    stamped: a.stamped || "n/a",
  };
  record(file, entry);
  const reasons = entryReasons(entry);
  console.log(
    `[validity] ${entry.block}: ${reasons.length ? `INVALID (${reasons.join("; ")})` : "valid"}`
  );
}

module.exports = { FILE, readValidity, entryReasons, record };
