import { describe, expect, it } from "vitest";

import { CodeLibrary, type CodeLibraryRepository } from "./library";

class MemoryRepository implements CodeLibraryRepository {
  files = new Map<string, string>();
  commits: Map<string, string>[] = [];
  fail = false;
  async ready() {}
  async flush() {}
  version() {
    return String(this.commits.length);
  }
  filesSnapshot() {
    return new Map(this.files);
  }
  async commit(files: Record<string, string>) {
    if (this.fail) throw new Error("Artifact unavailable");

    for (const [path, content] of Object.entries(files)) this.files.set(path, content);
    this.commits.push(new Map(this.files));

    return this.version();
  }
}

function library(repository: MemoryRepository) {
  return new CodeLibrary(repository);
}

describe("code library", () => {
  it.each([
    { status: "unknown" },
    { status: "started" },
    { exitCode: null },
    { finishedAt: "not a date" },
    { createdAt: "2026-02-31T00:00:00.000Z" },
  ])("rejects invalid saved metadata %j", async (changes) => {
    const repository = new MemoryRepository();
    const lib = library(repository);
    await lib.start("codemode", "r", "export default () => 42;", {});
    await lib.finish("codemode", "r", 0);
    const run = lib.list()[0];
    repository.files.set(`runs/${run.id}/metadata.json`, JSON.stringify({ ...run, ...changes }));
    expect(() => lib.read(run.id)).toThrow("Invalid input");
  });

  it("rejects a success status that contradicts the recorded exit code", async () => {
    const repository = new MemoryRepository();
    const lib = library(repository);
    await lib.start("codemode", "r", "export default () => 42;", {});
    await lib.finish("codemode", "r", 1);
    const run = lib.list()[0];
    repository.files.set(
      `runs/${run.id}/metadata.json`,
      JSON.stringify({ ...run, status: "succeeded" }),
    );
    expect(() => lib.read(run.id)).toThrow("outcome");
  });

  it.each([NaN, Infinity, 0.5])(
    "rejects invalid exit code %s without corrupting saved metadata",
    async (code) => {
      const lib = library(new MemoryRepository());
      await lib.start("codemode", "r", "export default () => 42;", {});
      await expect(lib.finish("codemode", "r", code)).rejects.toThrow("integer");
      expect(lib.list()[0].status).toBe("started");
      await lib.finish("codemode", "r", 0);
      expect(lib.list()[0].status).toBe("succeeded");
    },
  );

  it.each(["runs/r/metadata.json", "tools/reviewed.json"])(
    "rejects malformed artifact metadata in %s",
    async (path) => {
      const repository = new MemoryRepository();
      const lib = library(repository);
      await lib.ready();
      repository.files.set(path, JSON.stringify({ status: "succeeded" }));
      expect(() => (path.startsWith("runs/") ? lib.list() : lib.promoted())).toThrow(
        /Invalid input/,
      );
    },
  );

  it("stores source and minimal context before execution and retains failed attempts", async () => {
    const repository = new MemoryRepository();
    const lib = library(repository);
    const source = "export default () => { throw new Error('bad CSV'); };";
    await lib.start("codemode", "run-1", source, {
      purpose: "Total a department CSV",
      conversationId: "chat-1",
      toolCallId: "call-1",
    });
    const run = lib.list()[0];
    expect(lib.read(run.id)).toMatchObject({
      code: source,
      status: "started",
      purpose: "Total a department CSV",
    });
    await lib.finish("codemode", "run-1", 1);
    expect(lib.read(run.id).status).toBe("failed");
    expect(repository.commits[0].get(`runs/${run.id}/code.js`)).toBe(source);
    const reopened = library(repository);
    await reopened.ready();
    expect(reopened.read(run.id).code).toBe(source);
  });

  it("does not report an execution as saved when the artifact write fails", async () => {
    const repository = new MemoryRepository();
    repository.fail = true;
    await expect(
      library(repository).start("codemode", "r", "export default () => 42;", {}),
    ).rejects.toThrow("Artifact unavailable");
    expect(repository.files.size).toBe(0);
  });

  it("serializes simultaneous captures without losing either run", async () => {
    const lib = library(new MemoryRepository());
    await Promise.all([
      lib.start("a", "same-id", "export default () => 1;", {}),
      lib.start("b", "same-id", "export default () => 2;", {}),
    ]);
    expect(lib.list()).toHaveLength(2);
  });

  it("promotes only successful runs and pins the reviewed source", async () => {
    const lib = library(new MemoryRepository());
    await lib.start("codemode", "r", "export default ({ amount }) => amount * 2;", {});
    const run = lib.list()[0];
    await expect(lib.promote(run.id, "double", "Double an amount")).rejects.toThrow("successful");
    await lib.finish("codemode", "r", 0);
    await lib.promote(run.id, "double", "Double an amount");
    expect(lib.promoted()[0]).toMatchObject({ name: "double", code: lib.read(run.id).code });
    await expect(lib.promote(run.id, "../escape", "Invalid")).rejects.toThrow("name");
  });
});
