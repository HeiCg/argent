import { z } from "zod";
import type { FileInputSpec, ToolDefinition } from "@argent/registry";
import {
  getFlowPath,
  startRecordingSession,
  withFlowFileLock,
  writeNewFlowFile,
  clientFileDirective,
  serializeFlow,
  validateFlow,
  type FlowFile,
  type FlowSavedTo,
} from "./flow-utils";

const zodSchema = z.object({
  name: z.string().describe('Name for this flow (e.g. "settings-explore")'),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root directory (the directory that contains or should contain `.argent/flows/`). The flow file is created at `<project_root>/.argent/flows/<name>.yaml`."
    ),
  executionPrerequisite: z
    .string()
    .optional()
    .describe(
      'Fragments only: the app/device state assumed on entry (e.g. "Settings app open on General page"). ' +
        "For a self-contained e2e flow, omit this and record a `restart-app` as the first step instead — " +
        "it is captured as the flow's `launch` step. restart-app has no chromium support, so a chromium " +
        "flow records as a fragment; add the `launch: { chromium: <app path> }` line to the YAML " +
        "afterward, deleting the executionPrerequisite line if you passed one — a flow that starts " +
        "with a launch must not declare it."
    ),
});

/**
 * `project_root` is the AGENT's project. The probe tells us whether it exists
 * on this host: when it does (co-located, or a synced checkout) the flow file
 * is written here exactly as before; when it doesn't (remote tool-server) the
 * recording is kept in memory and every mutating flow tool returns a
 * client-write directive so the YAML lands in the agent's project instead of
 * recreating the agent's directory layout on this host.
 */
const fileInputs: FileInputSpec[] = [
  { target: "project_root", path: "${project_root}", kind: "probe" },
];

export const flowStartRecordingTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    message: string;
    restarted?: true;
    discardedSteps?: number;
    flowFile: string;
    savedTo: FlowSavedTo;
  }
> = {
  id: "flow-start-recording",
  interaction: {
    startedMsg: () => "Starting flow recording",
    completedMsg: () => "Started flow recording",
    failedMsg: ({ failureSignal }) => `Failed to start flow recording: ${failureSignal.error_code}`,
  },
  description: `Start recording a new flow. Creates a .yaml file in the .argent/flows/ directory.
Use when you want to capture a reusable sequence of device interactions for later replay.
Returns { message, flowFile, savedTo }.
Starting ALWAYS truncates <project_root>/.argent/flows/<name>.yaml to an empty flow — including a name that exists only as a saved file with no recording in progress, so starting under the name of a committed flow overwrites it. { restarted, discardedSteps } is added only when a LIVE recording of the same flow was discarded; its absence does NOT mean nothing was overwritten. Either way, re-record from the top rather than expecting to resume.
Fails before anything is written on a \`project_root\` that is not absolute or contains a ".." segment, or a \`name\` outside letters/digits/underscore/hyphen. It can also fail on the .argent/flows/ directory not being creatable or the file not being writable - but only when the project root is on the tool-server host; against a remote client the YAML travels back in \`savedTo\` for the client to write and no host filesystem access happens.

Recording state is independent: several flows can be recorded at once (different
names, different projects) and one recording's steps never land in another's
file. Steps still execute LIVE on a device, so give each concurrent recording its
own device. Every subsequent recording tool takes the same \`name\` +
\`project_root\` to say which one it is addressing — and the (project_root, name)
key has no ownership check, so pick a name unique to your task or another agent
starting the same one takes the key and your next step lands in its recording.

After starting, use flow-add-step to append tool calls — each step is executed
LIVE so you can verify it works before it gets recorded. For a self-contained
e2e flow, record a restart-app of the app under test as the FIRST step (captured
as the flow's \`launch\` step); for a reusable fragment, skip that and pass
executionPrerequisite instead. Use flow-add-echo to add labels. Call
flow-finish-recording when done.

If a recorded step turns out to be wrong, you can edit the .yaml file directly
to remove or reorder steps.`,
  zodSchema,
  fileInputs,
  services: () => ({}),
  async execute(_services, params, ctx) {
    const filePath = getFlowPath(params.project_root, params.name);
    // A recording's type emerges from its steps: recording a `restart-app`
    // first makes it an e2e flow (captured as a leading `launch` step by
    // flow-add-step); declaring an executionPrerequisite documents a fragment.
    const flow: FlowFile = {
      executionPrerequisite: params.executionPrerequisite ?? "",
      steps: [],
    };
    validateFlow(flow);
    const flowFile = serializeFlow(flow);

    // No probe (older client, direct invocation) means the caller shares this
    // filesystem — the pre-boundary assumption — so host persistence stands.
    const probe = ctx?.fileInputs?.project_root;
    const persist = probe && !probe.presentOnHost ? "client" : "host";

    // Truncate-and-register is one critical section. Held under the flow-file
    // lock, so a step from the take being discarded can neither slip into the
    // file between the reset and the swap, nor be written after both: it finds
    // its session superseded and fails instead.
    const { savedTo, replaced } = await withFlowFileLock(
      params.project_root,
      params.name,
      async () => {
        let savedTo: FlowSavedTo;
        if (persist === "host") {
          await writeNewFlowFile(filePath, flowFile);
          savedTo = filePath;
        } else {
          savedTo = clientFileDirective(filePath, flowFile);
        }
        const replaced = startRecordingSession({
          name: params.name,
          projectRoot: params.project_root,
          persist,
          filePath,
          flow,
        });
        return { savedTo, replaced };
      }
    );

    // Only a same-key restart replaces anything — the documented "re-record it
    // to fix it" workflow. Recordings are keyed per flow file, so starting a
    // *different* flow abandons nothing and there is nothing to report about it.
    if (replaced) {
      const discardedSteps = replaced.flow.steps.length;
      // Only claim the file was reset when this process actually reset it. In
      // client mode the truncation happens only once the client applies the
      // directive, and a rejected path or a failed write there surfaces as
      // `savedTo: null` — so asserting the reset here would tell the agent its
      // file is empty while it still holds the previous take.
      const reset =
        persist === "host"
          ? `${filePath} reset to an empty flow.`
          : `${filePath} is reset to an empty flow once your client applies \`savedTo\` ` +
            `(a null \`savedTo\` means it did not).`;
      return {
        message:
          `Restarted recording "${params.name}" — the previous take ` +
          `(${discardedSteps} step${discardedSteps === 1 ? "" : "s"}) was discarded and ` +
          reset,
        restarted: true,
        discardedSteps,
        flowFile,
        savedTo,
      };
    }

    return {
      message: `Started recording "${params.name}" flow`,
      flowFile,
      savedTo,
    };
  },
};
