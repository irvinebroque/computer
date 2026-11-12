import { describe, expect, it } from "vitest";

import { CodeLibrary, type CodeLibraryRepository } from "./library";

class MemoryRepository implements CodeLibraryRepository {
  files = new Map<string, string>();
  revision = 0;
  async ready() {}
  async flush() {}
  async refresh() {}
  version() {
    return String(this.revision);
  }
  filesSnapshot() {
    return new Map(this.files);
  }
  async commit(files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
      this.files.set(path, content);
    }

    this.revision++;
  }
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
    const lib = new CodeLibrary(repository);
    await lib.start("codemode", "r", "export default () => 42;", {});
    await lib.finish("codemode", "r", 0);
    const run = lib.list()[0];
    repository.files.set(`runs/${run.id}/metadata.json`, JSON.stringify({ ...run, ...changes }));
    expect(() => lib.read(run.id)).toThrow("Invalid input");
  });

  it("rejects a success status that contradicts the recorded exit code", async () => {
    const repository = new MemoryRepository();
    const lib = new CodeLibrary(repository);
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
      const lib = new CodeLibrary(new MemoryRepository());
      await lib.start("codemode", "r", "export default () => 42;", {});
      await expect(lib.finish("codemode", "r", code)).rejects.toThrow("integer");
      expect(lib.list()[0].status).toBe("started");
      await lib.finish("codemode", "r", 0);
      expect(lib.list()[0].status).toBe("succeeded");
    },
  );

  it("rejects malformed artifact metadata", async () => {
    const repository = new MemoryRepository();
    const lib = new CodeLibrary(repository);
    repository.files.set("runs/r/metadata.json", JSON.stringify({ status: "succeeded" }));
    expect(() => lib.list()).toThrow("Invalid input");
  });
});
