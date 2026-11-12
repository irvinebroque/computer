import { createHash } from "node:crypto";
import type { Mount } from "../mounts/types";
import { parsePromoted, parseRun } from "./records";

export const CODE_LIBRARY_ROOT = "/workspace/.code-library";
export const CODE_LIBRARY_GUIDANCE = `Your durable code library is at ${CODE_LIBRARY_ROOT}. Before writing JavaScript, use ls, grep, or read to find code from earlier tasks. Reuse or adapt it when useful. Supply a short purpose when executing code. Saved code is reference material; run it through the normal sandbox.`;

export interface CodeLibraryOptions {
  /** Namespace binding. Only the selected repository is used by this library. */
  binding: Artifacts;
  /** Exact repository name in the namespace; independent of Workspace.sessionId. */
  repository: string;
  /** Fetch existing code without creating repos, minting write tokens, or capturing executions. */
  readOnly?: boolean;
  /** Capture module executions automatically. Defaults to true for writers, false for readers. */
  capture?: boolean;
}

export interface CodeLibraryRun {
  id: string;
  executionId: string;
  backend: string;
  purpose: string;
  createdAt: string;
  status: "started" | "succeeded" | "failed";
  /** Application-provided context, falling back to the Workspace's session identity. */
  sessionId?: string;
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
  /** Host approval time. Absent only for records created by older versions. */
  approvedAt?: string;
}

/** Internal repository seam; production uses GitCodeLibraryRepository. */
export interface CodeLibraryRepository {
  ready(): Promise<void>;
  version(): string;
  filesSnapshot(): Map<string, string>;
  commit(files: Record<string, string | null>, message: string): Promise<string>;
  flush(): Promise<void>;
  refresh(): Promise<void>;
}

/** A repository's saved code. Promotion and retention are host operations. */
export class CodeLibrary {
  #tail: Promise<void> = Promise.resolve();
  /** Whether the runtime automatically saves module executions to this library. */
  readonly captureEnabled: boolean;

  constructor(
    private readonly repository: CodeLibraryRepository,
    private readonly onChange?: () => Promise<void>,
    private readonly options: { sessionId?: string; readOnly?: boolean; capture?: boolean } = {},
  ) {
    this.captureEnabled = options.capture ?? !options.readOnly;
  }

  /** Load the initial committed snapshot. Repeated calls do not poll the remote. */
  async ready(): Promise<void> {
    await this.repository.ready();
  }

  /** Fetch a new committed snapshot at an application-chosen turn boundary. */
  refresh(): Promise<void> {
    return this.#serialize(async () => {
      await this.ready();

      try {
        await this.repository.refresh();
      } finally {
        // A pending commit may have published before a subsequent fetch failed.
        await this.onChange?.();
      }
    });
  }

  /** Read metadata from the current snapshot without network access. */
  list(): CodeLibraryRun[] {
    const runs: CodeLibraryRun[] = [];

    for (const [path, content] of this.repository.filesSnapshot()) {
      if (/^runs\/[^/]+\/metadata\.json$/.test(path)) runs.push(parseRun(content));
    }

    return runs;
  }

  /** Read saved source and metadata from the current snapshot. */
  read(id: string): CodeLibraryRun & { code: string } {
    const files = this.repository.filesSnapshot();
    const metadata = files.get(`runs/${id}/metadata.json`);
    const code = files.get(`runs/${id}/code.js`);

    if (metadata === undefined || code === undefined) throw new Error(`Unknown saved run: ${id}`);

    return { ...parseRun(metadata), code };
  }

  /** Runtime hook: durably save source before dispatch. */
  start(
    backend: string,
    executionId: string,
    code: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    return this.#serialize(async () => {
      this.#assertWritable();
      await this.ready();
      await this.#synchronize();
      const id = this.#runKey(backend, executionId);
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
        sessionId: metadata.sessionId ?? this.options.sessionId,
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

  /** Runtime hook: commit an observed terminal outcome, retaining failed pushes locally. */
  finish(backend: string, executionId: string, exitCode: number): Promise<void> {
    return this.#serialize(async () => {
      this.#assertWritable();

      if (!Number.isSafeInteger(exitCode)) throw new Error("Exit code must be a safe integer");
      await this.ready();
      await this.repository.flush();
      const id = this.#runKey(backend, executionId);

      if (this.repository.filesSnapshot().has(`runs/${id}/metadata.json`)) {
        const { code: _code, ...run } = this.read(id);

        if (run.status === "started") {
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
        }
      }

      // A flush may have published a previously committed outcome. Refresh
      // the mount even when this replay did not need another metadata commit.
      await this.onChange?.();
    });
  }

  /** Host approval: pin successful source. Register it separately with savedCodeTools. */
  promote(id: string, name: string, description: string): Promise<void> {
    return this.#serialize(async () => {
      this.#assertWritable();
      await this.ready();
      await this.#synchronize();

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
        approvedAt: new Date().toISOString(),
      };

      if (run.cwd) promoted.cwd = run.cwd;
      await this.repository.commit(
        { [`tools/${name}.json`]: JSON.stringify(promoted, null, 2) },
        `Promote ${name}`,
      );
      await this.onChange?.();
    });
  }

  /** Read reviewed tools from the current snapshot. */
  promoted(): PromotedCode[] {
    const tools: PromotedCode[] = [];

    for (const [path, content] of this.repository.filesSnapshot()) {
      if (/^tools\/[a-z][a-z0-9_]*\.json$/.test(path)) tools.push(parsePromoted(content));
    }

    return tools;
  }

  /** Remove a reviewed tool from the next tool set. Does not erase Git history. */
  unpromote(name: string): Promise<void> {
    return this.#serialize(async () => {
      this.#assertWritable();
      await this.ready();
      await this.#synchronize();

      if (!this.promoted().some((tool) => tool.name === name)) return;
      await this.repository.commit(
        { [`tools/${name}.json`]: null },
        `Remove reviewed tool ${name}`,
      );
      await this.onChange?.();
    });
  }

  /** Remove an unpromoted run from the current tree. Historical commits retain it. */
  deleteRun(id: string): Promise<void> {
    return this.#serialize(async () => {
      this.#assertWritable();
      await this.ready();
      await this.#synchronize();
      this.read(id);

      if (this.promoted().some((tool) => tool.runId === id))
        throw new Error("Remove the promoted tool before deleting its run");
      await this.repository.commit(
        {
          [`runs/${id}/code.js`]: null,
          [`runs/${id}/metadata.json`]: null,
        },
        `Remove execution ${id}`,
      );
      await this.onChange?.();
    });
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

  async #synchronize(): Promise<void> {
    const previous = this.repository.version();

    try {
      await this.repository.refresh();
    } finally {
      if (previous !== this.repository.version()) await this.onChange?.();
    }
  }

  #assertWritable(): void {
    if (this.options.readOnly) throw new Error("Code library is read-only");
  }

  #runKey(backend: string, id: string): string {
    const key = this.options.sessionId
      ? JSON.stringify([this.options.sessionId, backend, id])
      : `${backend}\0${id}`;

    return createHash("sha256").update(key).digest("hex");
  }
}
