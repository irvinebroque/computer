import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeArtifactsBinding } from "../../tests/utilities/fake-artifacts-binding";
import type { WorkspaceModuleBackend, WorkspaceRuntimeEvent } from "../runtime/types";
import { createAITools } from "../tools/ai-sdk/index";
import { WorkspaceFileStore } from "../tools/common/fs/store";
import { Workspace } from "../workspace";
import { CODE_LIBRARY_ROOT } from "./library";
import { SqlGitFilesystem } from "./sql-fs";

let root: string;
let offline = false;

class GitArtifacts extends FakeArtifactsBinding {
  override async create(name: string, opts?: Parameters<Artifacts["create"]>[1]) {
    const result = await super.create(name, opts);
    runGit(["init", "--bare", "--initial-branch=main", join(root, `${name}.git`)]);
    runGit(["--git-dir", join(root, `${name}.git`), "config", "http.receivepack", "true"]);

    return result;
  }
}

function runGit(args: string[]): Buffer {
  const result = spawnSync("git", args);

  if (result.status !== 0) throw new Error(result.stderr.toString());

  return result.stdout;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-library-test-"));
  offline = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (offline) throw new Error("Artifact unavailable");
    const request = new Request(input, init);
    const url = new URL(request.url);

    const result = spawnSync("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname.replace(/^\/git/, ""),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers.get("content-type") ?? "",
      },
      input: Buffer.from(await request.arrayBuffer()),
      maxBuffer: 16 * 1024 * 1024,
    });

    if (result.status !== 0) throw new Error(result.stderr.toString());
    const split = result.stdout.indexOf("\r\n\r\n");
    const headers = new Headers();

    for (const line of result.stdout.subarray(0, split).toString().split("\r\n")) {
      const colon = line.indexOf(":");

      if (colon > 0) headers.set(line.slice(0, colon), line.slice(colon + 1).trim());
    }

    const status = Number(headers.get("Status")?.split(" ")[0] ?? 200);

    return new Response(new Uint8Array(result.stdout.subarray(split + 4)), { headers, status });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function backend(calls: string[], exitCode = 0): WorkspaceModuleBackend {
  const events = (id: string, after = 0) =>
    new ReadableStream<WorkspaceRuntimeEvent>({
      start(controller) {
        if (after < 1)
          controller.enqueue({
            id,
            seq: 1,
            name: "stdout",
            value: new TextEncoder().encode("output"),
          });

        if (after < 2) controller.enqueue({ id, seq: 2, name: "exit", code: exitCode, result: 42 });
        controller.close();
      },
    });

  return {
    id: "codemode",
    type: "test-module",
    protocol: "module",
    callable: true,
    async connect() {
      return {
        async exec(input) {
          const id = input.id ?? "test-execution";
          calls.push(input.source);

          return {
            id,
            events: events(id),
          };
        },
        async getExec({ id, after }) {
          return { id, events: events(id, after) };
        },
        async killExec() {},
        async disposeExec() {},
      };
    },
  };
}

function workspace(storage: SQLiteTestStorage, binding: Artifacts, calls: string[], exitCode = 0) {
  return new Workspace({
    storage,
    sessionId: "agent-one",
    artifacts: { binding },
    codeLibrary: true,
    backends: [backend(calls, exitCode)],
  });
}

function library(ws: Workspace) {
  if (!ws.codeLibrary) throw new Error("Expected a code library");

  return ws.codeLibrary;
}

describe("Artifacts-backed code library", () => {
  it("keeps the library read-only while another capture refreshes its files", async () => {
    const ws = workspace(new SQLiteTestStorage(), new GitArtifacts(), []);
    await ws.ready();
    const mount = ws.mounts().get(CODE_LIBRARY_ROOT);

    if (!mount) throw new Error("Expected a library mount");
    const materialize = mount.materialize;
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    mount.materialize = async (api) => {
      entered.resolve(undefined);
      await release.promise;
      await materialize(api);
    };

    const capture = ws.runtime.exec("export default () => 42;");
    await entered.promise;

    try {
      await expect(
        ws.fs.writeFile(`${CODE_LIBRARY_ROOT}/unexpected.js`, "tampered"),
      ).rejects.toThrow("read-only mount");
    } finally {
      release.resolve(undefined);
      await (await capture).result();
    }

    await expect(ws.fs.stat(`${CODE_LIBRARY_ROOT}/unexpected.js`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["cancelled source", "partial replay"])(
    "records the outcome when result() replays a %s",
    async (kind) => {
      const ws = workspace(new SQLiteTestStorage(), new GitArtifacts(), []);
      const initial = await ws.runtime.exec("export default () => 42;", { id: "replay" });
      await initial.cancel();
      expect(library(ws).list()[0].status).toBe("started");

      const handle =
        kind === "partial replay" ? await ws.runtime.getExec(initial.id, { resume: 2 }) : initial;

      expect((await handle.result()).exitCode).toBe(0);
      expect(library(ws).list()[0].status).toBe("succeeded");
    },
  );

  it("keeps an uncertain dispatch started until a terminal event is observed", async () => {
    const module = backend([]);
    const connect = module.connect;
    module.connect = async (context) => {
      const handle = await connect(context);

      return {
        ...handle,
        async exec(input) {
          await handle.exec(input);
          throw new Error("Dispatch acknowledgement lost");
        },
      };
    };

    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      sessionId: "agent-one",
      artifacts: { binding: new GitArtifacts() },
      codeLibrary: true,
      backends: [module],
    });

    await expect(ws.runtime.exec("export default () => 42;", { id: "uncertain" })).rejects.toThrow(
      "acknowledgement lost",
    );
    expect(library(ws).list()[0].status).toBe("started");
    expect((await (await ws.runtime.getExec("uncertain")).result()).exitCode).toBe(0);
    expect(library(ws).list()[0].status).toBe("succeeded");
  });

  it("preserves completed results during an outcome publication outage and refreshes on retry", async () => {
    const module = backend([]);
    const connect = module.connect;
    module.connect = async (context) => {
      const handle = await connect(context);

      return {
        ...handle,
        async exec(input) {
          const envelope = await handle.exec(input);
          offline = true;

          return envelope;
        },
      };
    };

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      sessionId: "agent-one",
      artifacts: { binding: new GitArtifacts() },
      codeLibrary: true,
      backends: [module],
    });

    const handle = await ws.runtime.exec("export default () => 42;", { id: "publication" });
    expect(await handle.result()).toMatchObject({ exitCode: 0, value: 42 });
    const run = library(ws).list()[0];
    expect(run.status).toBe("started");
    expect(errors).toHaveBeenCalledOnce();
    offline = false;
    await (await ws.runtime.getExec(handle.id)).result();
    expect(library(ws).read(run.id).status).toBe("succeeded");

    const metadata = await ws.fs.readFile(
      `${CODE_LIBRARY_ROOT}/runs/${run.id}/metadata.json`,
      "utf8",
    );

    expect(JSON.parse(metadata).status).toBe("succeeded");
  });

  it("saves before dispatch, exposes a read-only library, and restores it from the remote artifact", async () => {
    const binding = new GitArtifacts();
    const calls: string[] = [];
    const ws = workspace(new SQLiteTestStorage(), binding, calls);
    const source = "export default ({ rows }) => rows.length;";
    await (
      await ws.runtime.exec(source, {
        metadata: { purpose: "Count CSV rows", conversationId: "first-chat" },
      })
    ).result();
    expect(calls).toEqual([source]);
    const run = library(ws).list()[0];
    expect(run).toMatchObject({
      status: "succeeded",
      purpose: "Count CSV rows",
      conversationId: "first-chat",
    });
    expect(await ws.fs.readFile(`${CODE_LIBRARY_ROOT}/runs/${run.id}/code.js`, "utf8")).toBe(
      source,
    );
    await expect(
      ws.fs.writeFile(`${CODE_LIBRARY_ROOT}/runs/${run.id}/code.js`, "tampered"),
    ).rejects.toThrow("read-only mount");
    await new WorkspaceFileStore(ws).write(
      "/workspace/working.js",
      new TextEncoder().encode(source),
    );
    expect(await ws.fs.readFile("/workspace/working.js", "utf8")).toBe(source);
    const restored = workspace(new SQLiteTestStorage(), binding, []);
    await restored.ready();
    expect(library(restored).read(run.id).code).toBe(source);
    expect(await restored.fs.grep("Count CSV", CODE_LIBRARY_ROOT)).toHaveLength(1);
    expect(binding.has("agent-one__code-library")).toBe(true);
  });

  it("blocks execution when saving fails and can retry after recovery", async () => {
    const calls: string[] = [];
    const ws = workspace(new SQLiteTestStorage(), new GitArtifacts(), calls);
    await ws.ready();
    offline = true;
    await expect(ws.runtime.exec("export default () => 42;", { id: "retry" })).rejects.toThrow(
      "Artifact unavailable",
    );
    expect(calls).toEqual([]);
    expect(library(ws).list()).toEqual([]);
    offline = false;
    await (await ws.runtime.exec("export default () => 42;", { id: "retry" })).result();
    expect(calls).toHaveLength(1);
    expect(library(ws).list()[0].status).toBe("succeeded");
  });

  it("keeps failed executions and exposes purpose in the model tool schema", async () => {
    const ws = workspace(new SQLiteTestStorage(), new GitArtifacts(), [], 1);
    await (
      await ws.runtime.exec("invalid code", { metadata: { purpose: "Try parsing CSV" } })
    ).result();
    expect(library(ws).list()[0].status).toBe("failed");
    const tools = createAITools({ workspace: ws });
    expect(tools.exec.description).toContain(CODE_LIBRARY_ROOT);
  });

  it("restores the committed source after a crash leaves uncommitted working files", async () => {
    const storage = new SQLiteTestStorage();
    const binding = new GitArtifacts();
    const ws = workspace(storage, binding, []);
    const source = "export default () => 42;";
    await (await ws.runtime.exec(source)).result();
    const run = library(ws).list()[0];
    const privateFS = new SqlGitFilesystem(new Database(storage));
    await privateFS.promises.writeFile(`/runs/${run.id}/code.js`, "uncommitted");
    const restored = workspace(storage, binding, []);
    await restored.ready();
    expect(library(restored).read(run.id).code).toBe(source);
  });

  it("makes only reviewed code available as a named tool on a later workspace", async () => {
    const binding = new GitArtifacts();
    const ws = workspace(new SQLiteTestStorage(), binding, []);
    const source = "export default ({ rows }) => rows.length;";
    await (await ws.runtime.exec(source)).result();
    expect(createAITools({ workspace: ws }).saved_count_rows).toBeUndefined();
    await library(ws).promote(library(ws).list()[0].id, "count_rows", "Count rows in input.rows");
    const calls: string[] = [];

    const restored = new Workspace({
      storage: new SQLiteTestStorage(),
      sessionId: "agent-one",
      artifacts: { binding },
      codeLibrary: true,
      backends: [backend(calls), { ...backend([]), id: "other" }],
    });

    await restored.ready();

    const tool = createAITools({
      workspace: restored,
      exec: {
        output: { maxBytes: 32, maxLines: 2 },
        metadata: ({ toolCallId }) => ({ conversationId: `conversation-for-${toolCallId}` }),
      },
    }).saved_count_rows;

    expect(
      createAITools({ workspace: restored, exec: { backends: { other: {} } } }).saved_count_rows,
    ).toBeUndefined();

    if (!tool.execute) throw new Error("Expected an executable saved tool");
    const exec = vi.spyOn(restored.runtime, "exec");
    expect(
      await tool.execute({ input: '{"rows":[1,2]}' }, { toolCallId: "reviewed", messages: [] }),
    ).toBe(42);
    expect(exec).toHaveBeenCalledWith(
      source,
      expect.objectContaining({
        input: { rows: [1, 2] },
        output: { maxBytes: 32, maxLines: 2 },
        metadata: {
          conversationId: "conversation-for-reviewed",
          toolCallId: "reviewed",
          purpose: "Run reviewed tool count_rows",
        },
      }),
    );
    expect(calls).toEqual([source]);
    expect(library(restored).list()).toHaveLength(2);
  });

  it("omits reviewed tools when their backend no longer accepts function input", async () => {
    const binding = new GitArtifacts();
    const ws = workspace(new SQLiteTestStorage(), binding, []);
    await (await ws.runtime.exec("export default () => 42;")).result();
    await library(ws).promote(library(ws).list()[0].id, "answer", "Return an answer");
    const incompatible = { ...backend([]), callable: false };

    const restored = new Workspace({
      storage: new SQLiteTestStorage(),
      sessionId: "agent-one",
      artifacts: { binding },
      codeLibrary: true,
      backends: [incompatible],
    });

    await restored.ready();
    expect(createAITools({ workspace: restored }).saved_answer).toBeUndefined();
  });

  it("requires a scoped artifact and leaves disabled workspaces alone", () => {
    expect(() => new Workspace({ storage: new SQLiteTestStorage(), codeLibrary: true })).toThrow(
      "sessionId",
    );
    const ws = new Workspace({ storage: new SQLiteTestStorage() });
    expect(ws.codeLibrary).toBeUndefined();
    expect(ws.runtime.codeLibraryEnabled).toBe(false);
  });

  it("does not reuse one agent's private Git store for another scope", async () => {
    const storage = new SQLiteTestStorage();
    const binding = new GitArtifacts();
    await workspace(storage, binding, []).ready();

    const other = new Workspace({
      storage,
      sessionId: "another-agent",
      artifacts: { binding },
      codeLibrary: true,
    });

    await expect(other.ready()).rejects.toThrow("different artifact");
  });
});
