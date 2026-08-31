// Scratch harness: pull the raw hierarchy XML off the android-devtools helper
// on a live device, and optionally render it through both branch trees.
import * as fs from "fs";
import { createRegistry } from "./src/utils/setup-registry";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "./src/blueprints/android-devtools";

async function main() {
  const serial = process.argv[2]!;
  const out = process.argv[3]!;
  const registry = await createRegistry();
  const device = {
    id: serial,
    platform: "android" as const,
    name: serial,
    state: "device",
  };
  const ref = androidDevtoolsRef(device as any);
  const api = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
  const maxDepth = process.argv[4] ? Number(process.argv[4]) : undefined;
  const maxNodes = process.argv[5] ? Number(process.argv[5]) : undefined;
  const res = await api.getHierarchy({ clearCache: true, ...(maxDepth ? { maxDepth } : {}), ...(maxNodes ? { maxNodes } : {}) });
  const size = await api.getScreenSize();
  fs.writeFileSync(out, res.xml);
  console.log(
    JSON.stringify({
      out,
      nodeCount: res.nodeCount,
      truncated: res.truncated,
      captureMode: res.captureMode,
      windowCount: res.windowCount,
      size,
    })
  );
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
