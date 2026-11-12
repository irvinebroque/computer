import type { CreatePiToolsResult } from "@cloudflare/computer/tools/pi-ai";
import { createRegistry, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { durableTools, workspaceExtension } from "./tools";

const context: Parameters<ToolExecutionApi["agent"]>[0] = {
  toString: () => "test",
  abortSignal: new AbortController().signal,
  value: () => undefined,
};

describe("durable workspace tools", () => {
  it("installs the library prompt and tools in pi's registry", () => {
    const registry = createRegistry();

    const extension = workspaceExtension(
      {
        tools: [{ name: "exec", description: "Run JavaScript", parameters: { type: "object" } }],
        async execute() {
          return { content: [], isError: false };
        },
      },
      async () => "alice",
      "Search the code library.",
    );

    registry.install(extension);

    expect(
      registry
        .snapshot()
        .tools()
        .map(({ tool }) => tool.name),
    ).toEqual(["exec"]);
    expect(registry.snapshot().sections()).toHaveLength(1);
  });

  it("restores capture identity from the calling conversation", async () => {
    const observed: unknown[] = [];

    const computer: CreatePiToolsResult = {
      tools: [{ name: "exec", description: "Run JavaScript", parameters: { type: "object" } }],
      async execute(call, executionContext) {
        observed.push({ call, executionContext });

        return { content: [{ type: "text", text: "25" }], isError: false };
      },
    };

    const tools = durableTools(computer, async (conversationId) =>
      conversationId === "2" ? "alice" : "bob",
    );

    for (const conversationId of [2, 3]) {
      await tools[0].execute(
        { command: "export default () => 25" },
        {
          conversationId,
          callId: `call-${conversationId}`,
        },
        context,
      );
    }

    expect(observed).toEqual(
      ["alice", "bob"].map((sessionId, index) => ({
        call: {
          id: `call-${index + 2}`,
          name: "exec",
          arguments: { command: "export default () => 25" },
        },
        executionContext: {
          abortSignal: context.abortSignal,
          metadata: { conversationId: String(index + 2), sessionId },
        },
      })),
    );
  });

  it("preserves failed tool results for the model", async () => {
    const tools = durableTools(
      {
        tools: [{ name: "exec", description: "Run JavaScript", parameters: { type: "object" } }],
        async execute() {
          return { content: [{ type: "text", text: "SyntaxError" }], isError: true };
        },
      },
      async () => "alice",
    );

    const result = await tools[0].execute(
      {},
      {
        conversationId: 2,
        callId: "call",
      },
      context,
    );

    expect(result).toEqual({ output: [{ type: "text", text: "SyntaxError" }], isError: true });
  });

  it("allows only reads and searches to replay after an interrupted call", () => {
    const names = ["read", "ls", "find", "grep", "write", "edit", "delete", "exec"];

    const tools = durableTools(
      {
        tools: names.map((name) => ({ name, description: name, parameters: { type: "object" } })),
        async execute() {
          throw new Error("No execution expected");
        },
      },
      async () => "alice",
    );

    expect(tools.filter((tool) => tool.replay === "safe").map((tool) => tool.name)).toEqual([
      "read",
      "ls",
      "find",
      "grep",
    ]);
    expect(tools.filter((tool) => tool.replay === "unsafe").map((tool) => tool.name)).toEqual([
      "write",
      "edit",
      "delete",
      "exec",
    ]);
  });
});
