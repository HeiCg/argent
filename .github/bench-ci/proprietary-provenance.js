// Proprietary-baseline provenance for the open-vs-proprietary benches: WHICH
// upstream release the proprietary (OFF) arm ran, identified by its release name
// and the sha256 of every binary/APK it actually used. Without it a "vs
// proprietary" number cannot say what it was compared against (the Android arm sat
// on 0.22.1 for five releases; the iOS arm floated on `radon-main` unrecorded).
//
// Two record kinds:
//   - npm             Android: an extracted `npm pack @swmansion/argent@<v>` tree.
//                     Version read from the tarball's own package.json (never a
//                     claimed input); files = simulator-server for the host, the
//                     helper APK the tool-server installs, and the screen-sharing
//                     agent under the resolved resources/android run dir.
//   - github-release  iOS: `scripts/download-simulator-server.sh <tag>` output plus
//                     the `gh release view <tag> --json …` identity of that tag.
//
// CLI (used by the bench workflows):
//   node proprietary-provenance.js stamp <bench-block-OFF-*.json> [--expect-version V]
//        [--platform-key K] [--apk-version-name N]
//     Hash the dirs the block itself recorded (env.simulatorServerDir /
//     env.devtoolsAndroidBinDir) and write block.proprietaryProvenance in place.
//   node proprietary-provenance.js npm --bin-dir <pkg>/bin [--adt-dir D]
//        [--expect-version V] [--platform-key K] [--apk-version-name N] --out <file>
//   node proprietary-provenance.js gh-release --requested-tag T --script-default-tag D
//        --resolved-tag R --repo O/N --release-json <file> --asset <name>
//        --file <binary> [--file <other>…] --out <file>
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const UNKNOWN = "unknown";

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// Mirrors hostPlatformKey() in @argent/native-devtools-ios.
function hostPlatformKey(platform = process.platform, arch = process.arch) {
  return platform === "linux" && arch === "arm64" ? "linux-arm64" : platform;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

// The helper APK name the tool-server resolves (bundledHelperApkPath): the repo's
// own manifest versionName, not the package's.
function repoApkVersionName(cwd = process.cwd()) {
  const m = path.join(cwd, "packages", "native-devtools-android", "assets", "manifest.json");
  try {
    return JSON.parse(fs.readFileSync(m, "utf8")).versionName || null;
  } catch {
    return null;
  }
}

/**
 * Provenance of an extracted @swmansion/argent npm tarball whose `bin/` is
 * `simDir` (the ARGENT_SIMULATOR_SERVER_DIR the proprietary arm ran with). Throws
 * if the simulator-server binary is missing or the version is not `expectVersion`.
 */
function npmProvenance({
  simDir,
  adtDir = simDir,
  platformKey = hostPlatformKey(),
  apkVersionName = repoApkVersionName(),
  expectVersion = null,
}) {
  if (!simDir) throw new Error("npmProvenance: simulator-server dir is not set");
  const files = {};
  const rel = (p) => path.relative(simDir, p).split(path.sep).join("/");
  const add = (p) => {
    files[rel(p)] = sha256File(p);
  };

  const binName = platformKey === "win32" ? "simulator-server.exe" : "simulator-server";
  const sim = [path.join(simDir, platformKey, binName), path.join(simDir, binName)].find((p) =>
    fs.existsSync(p)
  );
  if (!sim) throw new Error(`npmProvenance: no ${platformKey}/${binName} under ${simDir}`);
  add(sim);

  // Same precedence as simulatorServerRunDir(): shared bin/resources first, then
  // the pre-dedup per-platform copy (0.22.x layout).
  const res = [
    path.join(simDir, "resources", "android"),
    path.join(simDir, platformKey, "resources", "android"),
  ].find((p) => fs.existsSync(p));
  if (res) for (const f of walk(res)) add(f);

  const apks = apkVersionName
    ? [path.join(adtDir, `argent-android-devtools-${apkVersionName}.apk`)].filter((p) =>
        fs.existsSync(p)
      )
    : fs.existsSync(adtDir)
      ? fs
          .readdirSync(adtDir)
          .filter((f) => /^argent-android-devtools-.*\.apk$/.test(f))
          .map((f) => path.join(adtDir, f))
      : [];
  for (const a of apks) {
    const key = path.resolve(path.dirname(a)) === path.resolve(simDir) ? rel(a) : a;
    files[key] = sha256File(a);
  }

  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(simDir, "..", "package.json"), "utf8"));
  } catch {
    /* version stays null → provenance label reads "?" */
  }
  const version = pkg.version || null;
  if (expectVersion && version !== expectVersion) {
    throw new Error(
      `proprietary package at ${simDir} is version ${version ?? "(no package.json)"}, expected ${expectVersion}`
    );
  }
  return {
    source: "npm",
    package: pkg.name || "@swmansion/argent",
    version,
    binDir: simDir,
    platformKey,
    files,
  };
}

/** iOS: the downloaded binary hashes plus the release identity of the tag. */
function githubReleaseProvenance({
  repo,
  requestedTag,
  scriptDefaultTag,
  resolvedTag,
  release,
  assetName,
  files: paths,
}) {
  const files = {};
  for (const p of paths) if (fs.existsSync(p)) files[p] = sha256File(p);
  const rel = release && typeof release === "object" ? release : {};
  const asset = (rel.assets || []).find((a) => a.name === assetName) || null;
  const primary = paths[0] && files[paths[0]];
  const digest = asset && typeof asset.digest === "string" ? asset.digest : null;
  const dbId = asset && asset.apiUrl ? Number(String(asset.apiUrl).split("/").pop()) : null;
  return {
    source: "github-release",
    repo: repo || null,
    requestedTag: requestedTag || null,
    scriptDefaultTag: scriptDefaultTag || null,
    resolvedTag: resolvedTag || null,
    release: rel.tagName
      ? {
          tagName: rel.tagName,
          name: rel.name || null,
          publishedAt: rel.publishedAt || null,
          createdAt: rel.createdAt || null,
          url: rel.url || null,
        }
      : null,
    asset: asset
      ? {
          name: asset.name,
          id: asset.id || null,
          databaseId: Number.isFinite(dbId) ? dbId : null,
          digest,
          size: asset.size ?? null,
          updatedAt: asset.updatedAt || null,
        }
      : null,
    // The binary on disk vs the digest GitHub reports for the asset: recorded, not
    // enforced (a floating tag may move between the download and the API call).
    assetDigestMatches: digest && primary ? digest === `sha256:${primary}` : null,
    // A floating tag (radon-main) keeps its release publishedAt while its assets are
    // re-uploaded, so the asset's updatedAt is the better short identity.
    version: rel.tagName
      ? `${rel.tagName}${asset && asset.updatedAt ? ` (asset ${asset.updatedAt})` : rel.publishedAt ? ` (${rel.publishedAt})` : ""}`
      : null,
    files,
  };
}

function isKnown(p) {
  return !!p && typeof p === "object";
}

/** Short human label: `@swmansion/argent@0.27.0`, a release tag, or "unknown". */
function provenanceLabel(p) {
  if (!isKnown(p)) return UNKNOWN;
  if (p.source === "github-release") return `${p.repo || "?"}@${p.version || "?"}`;
  return `${p.package || "?"}@${p.version || "?"}`;
}

/** Identity key: two OFF blocks are the same arm iff their keys are equal. */
function provenanceKey(p) {
  if (!isKnown(p)) return UNKNOWN;
  const files = Object.entries(p.files || {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return `${provenanceLabel(p)}|${files}`;
}

/** Why two provenances are not the same arm (version, or which sha256 differs). */
function provenanceDiff(a, b) {
  if (!isKnown(a) || !isKnown(b)) return `${provenanceLabel(a)} vs ${provenanceLabel(b)}`;
  if (provenanceLabel(a) !== provenanceLabel(b)) {
    return `${provenanceLabel(a)} vs ${provenanceLabel(b)}`;
  }
  const keys = [...new Set([...Object.keys(a.files || {}), ...Object.keys(b.files || {})])];
  const diff = keys.filter((k) => (a.files || {})[k] !== (b.files || {})[k]);
  return `same version ${provenanceLabel(a)} but sha256 differs for ${diff.join(", ")}`;
}

/* ----------------------------------- CLI ----------------------------------- */

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      i++;
      if (k === "file") (opt.file = opt.file || []).push(v);
      else opt[k] = v;
    } else pos.push(a);
  }
  return { pos, opt };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const { pos, opt } = parseArgs(rest);
  const common = {
    expectVersion: opt["expect-version"] || null,
    ...(opt["platform-key"] ? { platformKey: opt["platform-key"] } : {}),
    ...(opt["apk-version-name"] ? { apkVersionName: opt["apk-version-name"] } : {}),
  };
  if (cmd === "stamp") {
    const file = pos[0];
    if (!file) throw new Error("stamp: block JSON path required");
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const env = json.env || {};
    const simDir = opt["bin-dir"] || env.simulatorServerDir;
    const p = npmProvenance({
      simDir,
      adtDir: opt["adt-dir"] || env.devtoolsAndroidBinDir || simDir,
      ...common,
    });
    json.block = json.block || {};
    json.block.proprietaryProvenance = p;
    fs.writeFileSync(file, JSON.stringify(json, null, 2));
    console.log(`[provenance] ${json.block.block || file}: ${provenanceLabel(p)}`);
    for (const [k, v] of Object.entries(p.files)) console.log(`  ${v}  ${k}`);
    return;
  }
  if (cmd === "npm") {
    const p = npmProvenance({
      simDir: opt["bin-dir"],
      adtDir: opt["adt-dir"] || opt["bin-dir"],
      ...common,
    });
    fs.writeFileSync(opt.out, JSON.stringify(p, null, 2));
    console.log(`[provenance] ${provenanceLabel(p)} -> ${opt.out}`);
    for (const [k, v] of Object.entries(p.files)) console.log(`  ${v}  ${k}`);
    return;
  }
  if (cmd === "gh-release") {
    let release = {};
    try {
      release = JSON.parse(fs.readFileSync(opt["release-json"], "utf8"));
    } catch {
      /* unresolved — recorded as release: null */
    }
    const p = githubReleaseProvenance({
      repo: opt.repo,
      requestedTag: opt["requested-tag"],
      scriptDefaultTag: opt["script-default-tag"],
      resolvedTag: opt["resolved-tag"],
      release,
      assetName: opt.asset,
      files: opt.file || [],
    });
    fs.writeFileSync(opt.out, JSON.stringify(p, null, 2));
    console.log(`[provenance] ${provenanceLabel(p)} -> ${opt.out}`);
    for (const [k, v] of Object.entries(p.files)) console.log(`  ${v}  ${k}`);
    return;
  }
  throw new Error(`unknown command "${cmd}" (stamp | npm | gh-release)`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  UNKNOWN,
  sha256File,
  hostPlatformKey,
  npmProvenance,
  githubReleaseProvenance,
  provenanceLabel,
  provenanceKey,
  provenanceDiff,
};
