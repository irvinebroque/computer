import { CODE_LIBRARY_GUIDANCE, Workspace } from "@cloudflare/computer";
import { createArtifact } from "@cloudflare/computer/artifacts";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { createAITools } from "@cloudflare/computer/tools/ai-sdk";
import { Agent } from "agents";
import { generateText, isStepCount } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

const repositorySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

const taskSchema = z.object({
  task: z.string().trim().min(1).max(20_000),
  sessionId: z.string().trim().min(1).max(128).default("demo"),
  useReviewedTools: z.boolean().default(false),
});

const promotionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  description: z.string().trim().min(1).max(1_000),
});

/** One durable host writer per repository; sessions submit turns to it. */
export class LibraryAgent extends Agent<Env> {
  #workspace: Workspace | undefined;
  #repository: string | undefined;
  #tail: Promise<void> = Promise.resolve();

  #getWorkspace(repository: string): Workspace {
    if (this.#repository !== undefined && this.#repository !== repository)
      throw new Error("A library writer belongs to one repository");
    this.#repository = repository;
    this.#workspace ??= new Workspace({
      storage: this.ctx.storage,
      sessionId: this.ctx.id.toString(),
      backends: [new CodemodeBackend({ loader: this.env.LOADER })],
      codeLibrary: { binding: this.env.ARTIFACTS, repository },
    });

    return this.#workspace;
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  async runTask(repository: string, input: z.infer<typeof taskSchema>) {
    return this.#exclusive(async () => {
      const workspace = this.#getWorkspace(repository);
      await workspace.ready();
      await workspace.codeLibrary?.refresh();
      const conversationId = crypto.randomUUID();

      const result = await generateText({
        model: createWorkersAI({ binding: this.env.AI })("@cf/zai-org/glm-5.2"),
        instructions: `${CODE_LIBRARY_GUIDANCE}
Use exec to run JavaScript as export default async function(input) { ... }.
Pass self-contained source directly in exec's command field, with JSON input.
Do not import local files: the library saves module source only.
Each request starts a fresh conversation. Check the library for earlier solutions.`,
        prompt: input.task,
        tools: createAITools({
          workspace,
          savedCodeTools: input.useReviewedTools,
          exec: { metadata: { conversationId, sessionId: input.sessionId } },
        }),
        stopWhen: isStepCount(8),
      });

      return { repository, sessionId: input.sessionId, conversationId, text: result.text };
    });
  }

  async library(repository: string) {
    return this.#exclusive(async () => {
      const workspace = this.#getWorkspace(repository);
      await workspace.ready();
      const library = workspace.codeLibrary;

      if (!library) throw new Error("Code library is disabled");
      await library.refresh();
      const artifact = await createArtifact(this.env.ARTIFACTS).get(repository);

      return {
        artifact,
        runs: library.list().map(({ id }) => library.read(id)),
        reviewed: library.promoted(),
      };
    });
  }

  // Host operations. These methods are never included in the model's tools.
  async promoteRun(repository: string, { id, name, description }: z.infer<typeof promotionSchema>) {
    return this.#exclusive(async () => {
      const library = this.#getWorkspace(repository).codeLibrary;

      if (!library) throw new Error("Code library is disabled");
      await library.promote(id, name, description);

      return { tool: `saved_${name}` };
    });
  }

  async deleteRun(repository: string, id: string) {
    return this.#exclusive(async () => {
      const library = this.#getWorkspace(repository).codeLibrary;

      if (!library) throw new Error("Code library is disabled");
      await library.deleteRun(id);
    });
  }

  async unpromote(repository: string, name: string) {
    return this.#exclusive(async () => {
      const library = this.#getWorkspace(repository).codeLibrary;

      if (!library) throw new Error("Code library is disabled");
      await library.unpromote(name);
    });
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

    const url = new URL(request.url);

    const selection = repositorySchema.safeParse(
      url.searchParams.get("repository") ?? "finance-code",
    );

    if (!selection.success) return new Response("Invalid repository name", { status: 400 });
    const repository = selection.data;
    const agent = ctx.exports.LibraryAgent.getByName(repository);

    if (request.method === "GET" && url.pathname === "/library")
      return Response.json(await agent.library(repository));

    if (request.method === "POST" && (url.pathname === "/run" || url.pathname === "/promote")) {
      const body = await request.json().catch(() => null);

      if (url.pathname === "/run") {
        const parsed = taskSchema.safeParse(body);

        if (!parsed.success)
          return new Response("Expected { task, sessionId?, useReviewedTools? }", { status: 400 });

        return Response.json(await agent.runTask(repository, parsed.data));
      }

      const parsed = promotionSchema.safeParse(body);

      if (!parsed.success)
        return new Response("Expected { id, name, description }", { status: 400 });

      return Response.json(await agent.promoteRun(repository, parsed.data));
    }

    const run = /^\/runs\/([a-f0-9]{64})$/.exec(url.pathname);

    if (request.method === "DELETE" && run) {
      await agent.deleteRun(repository, run[1]);

      return new Response(null, { status: 204 });
    }

    const tool = /^\/tools\/([a-z][a-z0-9_]{0,63})$/.exec(url.pathname);

    if (request.method === "DELETE" && tool) {
      await agent.unpromote(repository, tool[1]);

      return new Response(null, { status: 204 });
    }

    return new Response(
      "GET /library, POST /run, POST /promote, DELETE /runs/:id, DELETE /tools/:name",
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;
