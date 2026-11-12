import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { jsonValueSchema } from "../common/exec";
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
export type CreateAIToolsOptions = CreateToolsOptions;

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
    const runtime = exec.workspace.runtime;
    for (const saved of workspace.codeLibrary?.promoted() ?? []) {
      if (exec.backends && !Object.hasOwn(exec.backends, saved.backend)) continue;
      tools[`saved_${saved.name}`] = tool({
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
          const metadata =
            typeof exec.metadata === "function" ? exec.metadata({ toolCallId }) : exec.metadata;
          const handle = await runtime.exec(saved.code, {
            backend: saved.backend,
            cwd: saved.cwd,
            input,
            encoding: "utf8",
            metadata: { ...metadata, toolCallId, purpose: `Run reviewed tool ${saved.name}` },
          });
          const onAbort = () => void handle.kill?.().catch(() => undefined);
          if (abortSignal?.aborted) onAbort();
          else abortSignal?.addEventListener("abort", onAbort, { once: true });
          try {
            const result = await handle.result();
            if (result.exitCode !== 0)
              throw new Error(result.stderr || `Saved tool exited with code ${result.exitCode}`);
            return result.value;
          } finally {
            abortSignal?.removeEventListener("abort", onAbort);
          }
        },
      });
    }
  }

  if (resolved.publish) {
    tools.publish = createPublishTool({ workspace: workspace as PublishWorkspaceLike });
  }

  return tools;
}
