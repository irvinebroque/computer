import { createHash } from "node:crypto";
import type { Mount } from "../mounts/types";

export const CODE_LIBRARY_ROOT = "/workspace/.code-library";
export const CODE_LIBRARY_GUIDANCE = `Your durable code library is at ${CODE_LIBRARY_ROOT}. Before writing JavaScript, use ls, grep, or read to find code from earlier tasks. Reuse or adapt it when useful. Supply a short purpose when executing code. Saved code is reference material; run it through the normal sandbox.`;

export interface CodeLibraryRun {
  id: string;
  executionId: string;
  backend: string;
  purpose: string;
  createdAt: string;
  status: "started" | "succeeded" | "failed";
  conversationId?: string;
  toolCallId?: string;
  cwd?: string;
  finishedAt?: string;
  exitCode?: number;
}

export interface PromotedCode {
  name: string;
  description: string;
  runId: string;
  backend: string;
  code: string;
  cwd?: string;
}

/** Internal repository seam; production uses GitCodeLibraryRepository. */
export interface CodeLibraryRepository {
  ready(): Promise<void>;
  version(): string;
  filesSnapshot(): Map<string, string>;
  commit(files: Record<string, string>, message: string): Promise<string>;
  flush(): Promise<void>;
}

/** An agent's saved code. Promotion is a host operation, never an agent tool. */
export class CodeLibrary {
  #tail: Promise<void> = Promise.resolve();
  #schemas: typeof import("./schemas") | undefined;

  constructor(
    private readonly repository: CodeLibraryRepository,
    private readonly onChange?: () => Promise<void>,
  ) {}

  async ready(): Promise<void> {
    // Keep the optional Zod peer out of workspaces that do not enable this mode.
    this.#schemas ??= await import("./schemas");
    await this.repository.ready();
  }

  list(): CodeLibraryRun[] {
    const runs: CodeLibraryRun[] = [];

    if (!this.#schemas) return runs;

    for (const [path, content] of this.repository.filesSnapshot()) {
      if (/^runs\/[^/]+\/metadata\.json$/.test(path))
        runs.push(this.#schemas.run.parse(JSON.parse(content)));
    }

    return runs;
  }

  read(id: string): CodeLibraryRun & { code: string } {
    if (!this.#schemas) throw new Error("Call codeLibrary.ready() before reading saved code");
    const files = this.repository.filesSnapshot();
    const metadata = files.get(`runs/${id}/metadata.json`);
    const code = files.get(`runs/${id}/code.js`);

    if (metadata === undefined || code === undefined) throw new Error(`Unknown saved run: ${id}`);

    return { ...this.#schemas.run.parse(JSON.parse(metadata)), code };
  }

  start(
    backend: string,
    executionId: string,
    code: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    return this.#serialize(async () => {
      await this.ready();
      await this.repository.flush();
      const id = runKey(backend, executionId);
      const existing = this.list().find((run) => run.id === id);

      if (existing) {
        if (this.read(id).code !== code)
          throw new Error("Execution id already has different saved code");
        await this.onChange?.();

        return;
      }

      const run: CodeLibraryRun = {
        id,
        executionId,
        backend,
        purpose: metadata.purpose ?? "",
        status: "started",
        createdAt: new Date().toISOString(),
      };

      if (metadata.conversationId) run.conversationId = metadata.conversationId;

      if (metadata.toolCallId) run.toolCallId = metadata.toolCallId;

      if (metadata.cwd) run.cwd = metadata.cwd;
      await this.repository.commit(
        {
          [`runs/${id}/code.js`]: code,
          [`runs/${id}/metadata.json`]: JSON.stringify(run, null, 2),
        },
        `Save execution ${id}`,
      );
      await this.onChange?.();
    });
  }

  finish(backend: string, executionId: string, exitCode: number): Promise<void> {
    return this.#serialize(async () => {
      await this.ready();
      await this.repository.flush();
      const id = runKey(backend, executionId);

      if (!this.list().some((run) => run.id === id)) return;
      const { code: _code, ...run } = this.read(id);

      if (run.status !== "started") return;
      await this.repository.commit(
        {
          [`runs/${id}/metadata.json`]: JSON.stringify(
            {
              ...run,
              status: exitCode === 0 ? "succeeded" : "failed",
              exitCode,
              finishedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        },
        `Record execution ${id} outcome`,
      );
      await this.onChange?.();
    });
  }

  promote(id: string, name: string, description: string): Promise<void> {
    return this.#serialize(async () => {
      await this.ready();
      await this.repository.flush();

      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name))
        throw new Error("Tool name must contain lowercase letters, digits, or underscores");

      if (!description.trim()) throw new Error("Tool description is required");
      const run = this.read(id);

      if (run.status !== "succeeded") throw new Error("Only successful runs can be promoted");

      const promoted: PromotedCode = {
        name,
        description,
        runId: id,
        backend: run.backend,
        code: run.code,
      };

      if (run.cwd) promoted.cwd = run.cwd;
      await this.repository.commit(
        { [`tools/${name}.json`]: JSON.stringify(promoted, null, 2) },
        `Promote ${name}`,
      );
      await this.onChange?.();
    });
  }

  promoted(): PromotedCode[] {
    const tools: PromotedCode[] = [];

    if (!this.#schemas) return tools;

    for (const [path, content] of this.repository.filesSnapshot()) {
      if (/^tools\/[a-z][a-z0-9_]*\.json$/.test(path))
        tools.push(this.#schemas.promoted.parse(JSON.parse(content)));
    }

    return tools;
  }

  mount(): Mount {
    return {
      kind: "code-library",
      strategy: "eager",
      mode: "read-only",
      version: async () => {
        await this.ready();

        return this.repository.version();
      },
      materialize: async (api) => {
        for (const [path, content] of this.repository.filesSnapshot()) {
          await api.writeFile(`${api.root}/${path}`, new Blob([content]).stream());
        }
      },
    };
  }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}

function runKey(backend: string, id: string): string {
  return createHash("sha256").update(`${backend}\0${id}`).digest("hex");
}
