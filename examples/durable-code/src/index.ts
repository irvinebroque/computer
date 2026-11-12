import { DurableObject } from "cloudflare:workers";
import { CODE_LIBRARY_GUIDANCE, Workspace } from "@cloudflare/computer";
import { createArtifact } from "@cloudflare/computer/artifacts";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { z } from "zod";
import { workspaceExtension } from "./tools";

const repositorySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

const taskSchema = z.object({
  task: z.string().trim().min(1).max(20_000),
  sessionId: z.string().trim().min(1).max(128).default("demo"),
});

/** One durable host writer per repository; sessions submit turns to it. */
export class LibraryAgent extends DurableObject<Env> {
  #workspace: Workspace | undefined;
  #repository: string | undefined;
  #tail: Promise<void> = Promise.resolve();

  readonly ai = createAI({ binding: this.env.AI });
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const repository = await this.ctx.storage.get<string>("code_library_repository");

      // Restore tools before pi resumes any interrupted conversations.
      if (repository) await this.#getWorkspace(repository);
      const models = createModels();
      models.setProvider(this.ai.provider);

      return Harness.open(storage, { models, registry: this.registry }, context);
    },
    defaults: { model: this.ai("@cf/zai-org/glm-5.2"), thinkingLevel: "low" },
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async #getWorkspace(repository: string): Promise<Workspace> {
    const stored =
      this.#repository ?? (await this.ctx.storage.get<string>("code_library_repository"));

    if (stored !== undefined && stored !== repository)
      throw new Error("A library writer belongs to one repository");

    if (this.#workspace) return this.#workspace;
    await this.ctx.storage.put("code_library_repository", repository);
    this.#repository = repository;

    const workspace = new Workspace({
      storage: this.ctx.storage,
      sessionId: this.ctx.id.toString(),
      backends: [new CodemodeBackend({ loader: this.env.LOADER })],
      codeLibrary: { binding: this.env.ARTIFACTS, repository },
    });

    // Keep startup local: Artifact I/O runs after Lifecycle opens the input gate.
    this.registry.install(
      workspaceExtension(
        createPiTools({ workspace }),
        async (conversationId) => {
          await workspace.ready();

          const sessionId = await this.ctx.storage.get<string>(
            `code_library_session:${conversationId}`,
          );

          if (sessionId === undefined) throw new Error("Missing capture session identity");

          return sessionId;
        },
        CODE_LIBRARY_GUIDANCE,
      ),
    );
    this.#workspace = workspace;

    return workspace;
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      // Recovered turns also belong to this repository's one writer.
      for (const pending of await this.harness.pending())
        await this.harness.wait(pending.operationId, { session: pending.session });

      return operation();
    };

    const result = this.#tail.then(run, run);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  async runTask(repository: string, input: z.infer<typeof taskSchema>) {
    return this.#exclusive(async () => {
      const workspace = await this.#getWorkspace(repository);
      await workspace.ready();
      await workspace.codeLibrary?.refresh();
      const session = await this.harness.sessions.create();
      const conversationId = session.id;
      await this.ctx.storage.put(`code_library_session:${conversationId}`, input.sessionId);
      const result = await session.prompt(input.task);

      if (result.status !== "done")
        throw new Error(`Task unanswered: ${result.reason ?? "unknown"}`);

      return { repository, sessionId: input.sessionId, conversationId, text: result.text };
    });
  }

  async library(repository: string) {
    return this.#exclusive(async () => {
      const workspace = await this.#getWorkspace(repository);
      await workspace.ready();
      const library = workspace.codeLibrary;

      if (!library) throw new Error("Code library is disabled");
      await library.refresh();
      const artifact = await createArtifact(this.env.ARTIFACTS).get(repository);

      return {
        artifact,
        runs: library.list().map(({ id }) => library.read(id)),
      };
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

    if (request.method === "POST" && url.pathname === "/run") {
      const body = await request.json().catch(() => null);
      const parsed = taskSchema.safeParse(body);

      if (!parsed.success) return new Response("Expected { task, sessionId? }", { status: 400 });

      return Response.json(await agent.runTask(repository, parsed.data));
    }

    return new Response("GET /library, POST /run", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
