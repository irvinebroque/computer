import { Database } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";

import { SqlGitFilesystem } from "./sql-fs";

describe("private code library filesystem", () => {
  it("preserves a real Git commit across filesystem instances", async () => {
    const db = new Database(new SQLiteTestStorage());
    const fs = new SqlGitFilesystem(db);
    await git.init({ fs, dir: "/", defaultBranch: "main" });
    await fs.promises.mkdir("/runs");
    await fs.promises.writeFile("/runs/code.js", "export default () => 42;");
    await git.add({ fs, dir: "/", filepath: "runs/code.js" });
    const oid = await git.commit({
      fs,
      dir: "/",
      message: "Save code",
      author: { name: "Agent", email: "agent@example.invalid" },
    });
    const reopened = new SqlGitFilesystem(db);
    expect(await git.resolveRef({ fs: reopened, dir: "/", ref: "main" })).toBe(oid);
    const blob = await git.readBlob({ fs: reopened, dir: "/", oid, filepath: "runs/code.js" });
    expect(new TextDecoder().decode(blob.blob)).toBe("export default () => 42;");
  });
});
