import { CODE_LIBRARY_GUIDANCE, Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { createAITools } from "@cloudflare/computer/tools/ai-sdk";
import { Agent } from "agents";
import { generateText, isStepCount } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

const taskSchema = z.object({ task: z.string().min(1).max(20_000) });
const promotionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  description: z.string().min(1).max(1_000),
});

export class LibraryAgent extends Agent<Env> {
  readonly #workspace = new Workspace({
    storage: this.ctx.storage,
    sessionId: this.ctx.id.toString(),
    artifacts: { binding: this.env.ARTIFACTS },
    backends: [new CodemodeBackend({ loader: this.env.LOADER })],
    codeLibrary: true,
  });

  async runTask(task: string) {
    await this.#workspace.ready();
    const conversationId = crypto.randomUUID();
    const result = await generateText({
      model: createWorkersAI({ binding: this.env.AI })("@cf/zai-org/glm-5.2"),
      instructions: `${CODE_LIBRARY_GUIDANCE}
Use exec to run JavaScript as export default async function(input) { ... }.
Prefer self-contained functions with JSON input so a human can review and reuse them.
Each request starts a fresh conversation. Check the library for earlier solutions.`,
      prompt: task,
      tools: createAITools({
        workspace: this.#workspace,
        exec: { metadata: { conversationId } },
      }),
      stopWhen: isStepCount(8),
    });
    return { conversationId, text: result.text };
  }

  async library() {
    await this.#workspace.ready();
    const library = this.#workspace.codeLibrary;
    if (!library) throw new Error("Code library is disabled");
    const artifact = await this.#workspace.artifacts.get("code-library");
    return { artifact, runs: library.list().map(({ id }) => library.read(id)) };
  }

  // Only the authenticated host endpoint calls this; it is never an agent tool.
  async promoteRun({ id, name, description }: z.infer<typeof promotionSchema>) {
    const library = this.#workspace.codeLibrary;
    if (!library) throw new Error("Code library is disabled");
    await library.promote(id, name, description);
    return { tool: `saved_${name}` };
  }
}

export default {
  async fetch(request, env, ctx) {
    const expected = new TextEncoder().encode(`Bearer ${env.DEMO_TOKEN}`);
    const actual = new TextEncoder().encode(request.headers.get("Authorization") ?? "");
    if (
      !env.DEMO_TOKEN ||
      actual.length !== expected.length ||
      !crypto.subtle.timingSafeEqual(actual, expected)
    )
      return new Response("Unauthorized", { status: 401 });

    const agent = ctx.exports.LibraryAgent.getByName("demo");
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/library")
      return Response.json(await agent.library());
    if (request.method === "POST" && (path === "/run" || path === "/promote")) {
      const body = await request.json().catch(() => null);

      if (path === "/run") {
        const parsed = taskSchema.safeParse(body);
        if (!parsed.success) return new Response("Expected { task: string }", { status: 400 });
        return Response.json(await agent.runTask(parsed.data.task));
      }
      const parsed = promotionSchema.safeParse(body);
      if (!parsed.success)
        return new Response("Expected { id, name, description }", { status: 400 });
      return Response.json(await agent.promoteRun(parsed.data));
    }
    return new Response("GET /library, POST /run, POST /promote", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
