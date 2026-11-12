import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { PromotedCode } from "../../code-library/library";
import { defineExec, type ExecToolOptions, jsonValueSchema } from "../common/exec";
import { type CreateToolsOptions, resolveToolOptions } from "../common/options";
import type { PublishWorkspaceLike } from "../common/publish";
import {
  createDeleteTool,
  createEditTool,
  createExecTool,
  createFindTool,
  createGrepTool,
  createListTool,
  createPublishTool,
  createReadTool,
  createWriteTool,
} from "./tools";

export { forAISDKTools } from "./bindings";

/** Options for {@link createAITools}. */
export type CreateAIToolsOptions = CreateToolsOptions & {
  /** Register the host-reviewed saved tools from the current library snapshot. Defaults to false. */
  savedCodeTools?: boolean;
};

export {
  createDeleteTool,
  createEditTool,
  createExecTool,
  createFindTool,
  createGrepTool,
  createListTool,
  createPublishTool,
  createReadTool,
  createWriteTool,
} from "./tools";

/**
 * Build the AI SDK tool set for a Workspace: `read`, `ls`, `find`, and
 * `grep`, plus `write`, `edit`, `delete`, `exec`, and `publish` unless
 * the set is read-only. `exec` offers every backend the Workspace has
 * unless `exec.backends` lists them.
 *
 * @param options - The Workspace and per-tool options.
 * @returns An AI SDK `ToolSet` for `generateText`, `streamText`, or an agent's `getTools()`.
 */
export function createAITools(options: CreateAIToolsOptions): ToolSet {
  const resolved = resolveToolOptions(options);
  const workspace = resolved.workspace;

  const tools: ToolSet = {
    read: createReadTool(resolved.read),
    ls: createListTool({ workspace }),
    find: createFindTool({ workspace }),
    grep: createGrepTool({ workspace }),
  };

  if (resolved.readonly) return tools;

  tools.write = createWriteTool(resolved.write);
  tools.edit = createEditTool(resolved.edit);
  tools.delete = createDeleteTool(resolved.delete);

  const exec = resolved.exec;

  if (exec !== undefined) {
    tools.exec = createExecTool(exec);

    const backends = exec.workspace.runtime.backends?.() ?? [];

    for (const saved of options.savedCodeTools ? (workspace.codeLibrary?.promoted() ?? []) : []) {
      if (exec.backends && !Object.hasOwn(exec.backends, saved.backend)) continue;

      if (
        !backends.some(
          ({ id, protocol, callable }) => id === saved.backend && protocol === "module" && callable,
        )
      )
        continue;
      tools[`saved_${saved.name}`] = createSavedCodeTool(saved, exec);
    }
  }

  if (resolved.publish) {
    tools.publish = createPublishTool({ workspace: workspace as PublishWorkspaceLike });
  }

  return tools;
}

function createSavedCodeTool(saved: PromotedCode, exec: ExecToolOptions) {
  const execution = defineExec(exec);

  return tool({
    description: saved.description,
    inputSchema: z.object({
      input: z
        .string()
        .describe(
          "JSON-encoded object passed to the reviewed function. Preserve JSON value types, including arrays and numbers.",
        ),
    }),
    execute: async ({ input: encoded }, { toolCallId, abortSignal }) => {
      abortSignal?.throwIfAborted();
      const input = z.record(z.string(), jsonValueSchema).parse(JSON.parse(encoded));

      let outcome;

      for await (const snapshot of execution.execute(
        {
          command: saved.code,
          backend: saved.backend,
          cwd: saved.cwd,
          input,
          purpose: `Run reviewed tool ${saved.name}`,
        },
        { toolCallId, abortSignal },
      )) {
        outcome = snapshot;
      }

      if (!outcome) throw new Error("Saved tool returned no outcome");

      if ("error" in outcome) throw new Error(outcome.error);

      if (outcome.exitCode !== 0)
        throw new Error(outcome.stderr || `Saved tool exited with code ${outcome.exitCode}`);

      return outcome.result;
    },
  });
}
