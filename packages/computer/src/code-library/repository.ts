import { posix } from "node:path";
import type { Database } from "@cloudflare/dofs";
import type { ArtifactClient } from "../artifacts/index";
import { withFetch } from "../git/http";
import type { CodeLibraryRepository } from "./library";
import { SqlGitFilesystem } from "./sql-fs";

const AUTHOR = { name: "Cloudflare Agent", email: "agent@cloudflare.invalid" };
const PUBLISHED = "/.git/refs/computer/published";

/** Private checkout of an application-selected repository. Pushes never force remote history. */
export class GitCodeLibraryRepository implements CodeLibraryRepository {
  readonly #fs: SqlGitFilesystem;
  #ready: Promise<void> | undefined;
  #remote = "";
  #version = "empty";
  #published = new Map<string, string>();

  constructor(
    private readonly db: Database,
    private readonly artifacts: ArtifactClient,
    private readonly name: string,
    private readonly readOnly = false,
  ) {
    this.#fs = new SqlGitFilesystem(db);
    db.run(`CREATE TABLE IF NOT EXISTS workspace_code_library_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), remote TEXT NOT NULL, initialized INTEGER NOT NULL
    )`);
  }

  ready(): Promise<void> {
    this.#ready ??= this.#initialize().catch((cause: unknown) => {
      this.#ready = undefined;
      throw cause;
    });

    return this.#ready;
  }

  async #initialize(): Promise<void> {
    const git = await import("isomorphic-git");

    try {
      this.#remote = (await this.artifacts.get(this.name)).remote;
    } catch (error) {
      if (!(error instanceof Error) || !hasCode(error, "NOT_FOUND") || this.readOnly) throw error;

      try {
        this.#remote = (
          await this.artifacts.create(this.name, { setDefaultBranch: "main" })
        ).remote;
      } catch (cause) {
        if (!(cause instanceof Error) || !hasCode(cause, "ALREADY_EXISTS")) throw cause;
        this.#remote = (await this.artifacts.get(this.name)).remote;
      }
    }

    const state = this.db.one<{ remote: string; initialized: number }>(
      "SELECT remote, initialized FROM workspace_code_library_state WHERE id = 1",
    );

    if (state && state.remote !== this.#remote)
      throw new Error("Code library storage belongs to a different artifact");

    if (!state)
      this.db.run("INSERT INTO workspace_code_library_state VALUES (1, ?, 0)", this.#remote);

    if (state?.initialized) {
      await git.addRemote({
        fs: this.#fs,
        dir: "/",
        remote: "origin",
        url: this.#remote,
        force: true,
      });

      if (this.#fs.exists(PUBLISHED)) {
        const oid = (await this.#fs.promises.readFile(PUBLISHED)).toString().trim();
        await this.#publishSnapshot(oid);
      }
      // Readers recover from remote history, including interrupted refreshes.

      if (!this.readOnly) await this.flush();
      await this.#fetchSnapshot();

      return;
    }

    // No execution used an interrupted initial clone, so it can start over.
    this.#fs.reset();
    await git.init({ fs: this.#fs, dir: "/", defaultBranch: "main" });
    await git.addRemote({ fs: this.#fs, dir: "/", remote: "origin", url: this.#remote });
    await this.#fetchSnapshot();
    this.db.run("UPDATE workspace_code_library_state SET initialized = 1 WHERE id = 1");
  }

  version(): string {
    return this.#version;
  }
  filesSnapshot(): Map<string, string> {
    return new Map(this.#published);
  }

  async refresh(): Promise<void> {
    await this.ready();
    await this.flush();
    await this.#fetchSnapshot();
  }

  async commit(files: Record<string, string>, message: string): Promise<string> {
    if (this.readOnly) throw new Error("Code library is read-only");
    await this.ready();
    const git = await import("isomorphic-git");

    for (const [path, content] of Object.entries(files)) {
      let parent = posix.dirname(`/${path}`);
      const missing: string[] = [];

      while (!this.#fs.exists(parent)) {
        missing.unshift(parent);
        parent = posix.dirname(parent);
      }

      for (const directory of missing) await this.#fs.promises.mkdir(directory);
      await this.#fs.promises.writeFile(`/${path}`, content);
      await git.add({ fs: this.#fs, dir: "/", filepath: path });
    }

    const oid = await git.commit({ fs: this.#fs, dir: "/", message, author: AUTHOR });
    await this.flush();

    return oid;
  }

  async flush(): Promise<void> {
    const head = await this.#head();

    if (!head || head === this.#version) return;

    if (this.readOnly)
      throw new Error(
        "Read-only code library has an unpublished local commit; recover it with the writer",
      );
    const git = await import("isomorphic-git");

    const result = await git.push({
      fs: this.#fs,
      http: withFetch(globalThis.fetch),
      dir: "/",
      url: this.#remote,
      ref: "main",
      ...(await this.#auth()),
    });

    if (!result.ok)
      throw new Error(
        "Code library push rejected; coordinate one writer per repository. Local commit retained.",
      );
    await this.#publishSnapshot(head);
  }

  async #fetchSnapshot(): Promise<void> {
    const git = await import("isomorphic-git");
    const http = withFetch(globalThis.fetch);
    const auth = await this.#auth();

    // listServerRefs mutates headers; match fetch's protocol to avoid leaking v2 negotiation.
    const refs = await git.listServerRefs({
      http,
      url: this.#remote,
      protocolVersion: 1,
      ...auth,
    });

    if (!refs.some(({ ref }) => ref === "refs/heads/main")) {
      if (await this.#head()) throw new Error("Code library remote main branch was removed");

      return;
    }

    await git.fetch({
      fs: this.#fs,
      http,
      dir: "/",
      url: this.#remote,
      ref: "main",
      singleBranch: true,
      ...auth,
    });

    const remote = await git.resolveRef({
      fs: this.#fs,
      dir: "/",
      ref: "refs/remotes/origin/main",
    });

    const local = await this.#head();

    if (
      local &&
      local !== remote &&
      !(await git.isDescendent({ fs: this.#fs, dir: "/", oid: remote, ancestor: local }))
    )
      throw new Error(
        "Code library histories diverged; coordinate one writer per repository. Local commit retained.",
      );

    if (remote === this.#version) return;
    await git.writeRef({
      fs: this.#fs,
      dir: "/",
      ref: "refs/heads/main",
      value: remote,
      force: true,
    });
    await git.checkout({ fs: this.#fs, dir: "/", ref: "main", force: true });
    await this.#publishSnapshot(remote);
  }

  async #head(): Promise<string | undefined> {
    const path = "/.git/refs/heads/main";

    return this.#fs.exists(path)
      ? (await this.#fs.promises.readFile(path)).toString().trim()
      : undefined;
  }

  async #publishSnapshot(oid: string): Promise<void> {
    const git = await import("isomorphic-git");
    const paths = await git.listFiles({ fs: this.#fs, dir: "/", ref: oid });
    const files = new Map<string, string>();

    for (const filepath of paths) {
      if (!/^runs\/[^/]+\/(code\.js|metadata\.json)$/.test(filepath)) continue;
      const { blob } = await git.readBlob({ fs: this.#fs, dir: "/", oid, filepath });
      files.set(filepath, new TextDecoder().decode(blob));
    }

    if (!this.#fs.exists("/.git/refs/computer"))
      await this.#fs.promises.mkdir("/.git/refs/computer");
    await this.#fs.promises.writeFile(PUBLISHED, oid);
    this.#published = files;
    this.#version = oid;
  }

  async #auth() {
    const token = await this.artifacts.createToken(
      this.name,
      this.readOnly ? "read" : "write",
      300,
    );

    return {
      headers: { Authorization: `Basic ${btoa(`x:${token.plaintext.split("?expires=")[0]}`)}` },
    };
  }
}

function hasCode(error: Error, code: string): boolean {
  return "code" in error && error.code === code;
}
