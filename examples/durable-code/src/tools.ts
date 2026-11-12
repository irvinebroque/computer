import type { CreatePiToolsResult } from "@cloudflare/computer/tools/pi-ai";
import type { Extension, JsonObject, ToolRegistration } from "@earendil-works/pi-durable";

export function workspaceExtension(
  computer: CreatePiToolsResult,
  sessionIdFor: (conversationId: string) => Promise<string>,
  guidance: string,
): Extension {
  return {
    name: "workspace",
    sections: [
      {
        key: "code-library",
        tag: false,
        render: () => `${guidance}
Use exec to run JavaScript as export default async function(input) { ... }.
Pass self-contained source directly in exec's command field, with JSON input.
Each request starts a fresh conversation. Check the library for earlier solutions.`,
      },
    ],
    tools: durableTools(computer, sessionIdFor),
  };
}

/** Connect Computer's tools to pi-durable's execution and recovery context. */
export function durableTools(
  computer: CreatePiToolsResult,
  sessionIdFor: (conversationId: string) => Promise<string>,
) {
  const replaySafe = new Set(["read", "ls", "find", "grep"]);

  return computer.tools.map(
    (tool) =>
      ({
        ...tool,
        replay: replaySafe.has(tool.name) ? "safe" : "unsafe",
        executionMode: "sequential",
        async execute(
          args: JsonObject,
          api: { conversationId: number; callId: string },
          context: Parameters<ToolRegistration["execute"]>[2],
        ) {
          const conversationId = String(api.conversationId);
          const sessionId = await sessionIdFor(conversationId);

          const result = await computer.execute(
            { id: api.callId, name: tool.name, arguments: args },
            { abortSignal: context.abortSignal, metadata: { conversationId, sessionId } },
          );

          return { output: result.content, isError: result.isError };
        },
      }) satisfies ToolRegistration,
  );
}
