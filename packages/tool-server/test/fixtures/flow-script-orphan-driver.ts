// The lifeline watchdog stops a runner whose parent died, so proving it needs a
// parent that can be `SIGKILL`ed — which the test process itself cannot be.
import { FlowScriptExecutor } from "../../src/tools/flows/script/flow-script-executor";

const [scriptPath, projectRoot, interpreter] = process.argv.slice(2);

const executor = new FlowScriptExecutor({ concurrency: 2, maxTimeoutMs: 600_000 });
void executor
  .execute({
    scriptPath,
    projectRoot,
    timeoutMs: 300_000,
    ...(interpreter === "bash" ? { interpreter: "bash" as const } : {}),
  })
  .then((result) => {
    process.stdout.write(`DONE ${JSON.stringify(result)}\n`);
  })
  .catch((err: unknown) => {
    process.stderr.write(`FAILED ${String(err)}\n`);
    process.exit(1);
  });
