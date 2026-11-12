import { posix } from "node:path";
import type { Database } from "@cloudflare/dofs";
import type { HttpClient } from "isomorphic-git";
import type { ArtifactClient } from "../artifacts/index";
import { withFetch } from "../git/http";
import type { CodeLibraryRepository } from "./library";
import { SqlGitFilesystem } from "./sql-fs";

const AUTHOR = { name: "Cloudflare Agent", email: "agent@cloudflare.invalid" };

/** One private Git working tree, pushed without force to this agent's artifact. */
export class GitCodeLibraryRepository implements CodeLibraryRepository {
  readonly #fs: SqlGitFilesystem;
  #ready: Promise<void> | undefined;
  #remote = "";
  #version = "empty";
  #published = new Map<string, string>();

  constructor(
    private readonly db: Database,
    private readonly artifacts: ArtifactClient,
  ) {
    this.#fs = new SqlGitFilesystem(db);
    db.run(`CREATE TABLE IF NOT EXISTS workspace_code_library_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), remote TEXT NOT NULL, initialized INTEGER NOT NULL
    )`);
  }

  ready(): Promise<void> {
    this.#ready ??= this.#initialize().catch((error: unknown) => {
      this.#ready = undefined;
      throw error;
    });
    return this.#ready;
  }

  async #initialize(): Promise<void> {
    const git = await import("isomorphic-git");
    try {
      this.#remote = (await this.artifacts.get("code-library")).remote;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "NOT_FOUND")
        throw error;
      this.#remote = (
        await this.artifacts.create("code-library", { setDefaultBranch: "main" })
      ).remote;
    }
    const state = this.db.one<{ remote: string; initialized: number }>(
      "SELECT remote, initialized FROM workspace_code_library_state WHERE id = 1",
    );
    if (state && state.remote !== this.#remote)
      throw new Error("Code library storage belongs to a different artifact");
    if (!state)
      this.db.run("INSERT INTO workspace_code_library_state VALUES (1, ?, 0)", this.#remote);
    if (state?.initialized) {
      await this.flush();
      return;
    }
    // An interrupted initial clone is safe to start over; no executions used it yet.
    this.#fs.reset();
    const auth = await this.#auth();
    const http = withFetch(globalThis.fetch) as unknown as HttpClient;
    const refs = await git.listServerRefs({ http, url: this.#remote, ...auth });
    if (refs.some((ref) => ref.ref === "refs/heads/main")) {
      await git.clone({
        fs: this.#fs,
        http,
        dir: "/",
        url: this.#remote,
        ref: "main",
        singleBranch: true,
        ...auth,
      });
      await this.#publishSnapshot();
    } else {
      await git.init({ fs: this.#fs, dir: "/", defaultBranch: "main" });
    }
    this.db.run("UPDATE workspace_code_library_state SET initialized = 1 WHERE id = 1");
  }

  version(): string {
    return this.#version;
  }

  filesSnapshot(): Map<string, string> {
    return new Map(this.#published);
  }

  async commit(files: Record<string, string>, message: string): Promise<string> {
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
    if (!this.#fs.exists("/.git/refs/heads/main")) return;
    const head = await this.#fs.promises.readFile("/.git/refs/heads/main", "utf8");
    if (typeof head !== "string") throw new Error("Expected a Git ref");
    if (head.trim() === this.#version) return;
    const git = await import("isomorphic-git");
    const result = await git.push({
      fs: this.#fs,
      http: withFetch(globalThis.fetch) as unknown as HttpClient,
      dir: "/",
      url: this.#remote,
      ref: "main",
      ...(await this.#auth()),
    });
    if (!result.ok) throw new Error("Code library artifact push was rejected");
    await this.#publishSnapshot();
  }

  async #publishSnapshot(): Promise<void> {
    // Read the commit, never a working tree left half-written by an interruption.
    const git = await import("isomorphic-git");
    const oid = await git.resolveRef({ fs: this.#fs, dir: "/", ref: "main" });
    const paths = await git.listFiles({ fs: this.#fs, dir: "/", ref: oid });
    const files = new Map<string, string>();
    for (const filepath of paths) {
      if (!/^(runs\/[^/]+\/(code\.js|metadata\.json)|tools\/[a-z][a-z0-9_]*\.json)$/.test(filepath))
        continue;
      const { blob } = await git.readBlob({ fs: this.#fs, dir: "/", oid, filepath });
      files.set(filepath, new TextDecoder().decode(blob));
    }
    this.#published = files;
    this.#version = oid;
  }

  async #auth() {
    const token = await this.artifacts.createToken("code-library", "write", 300);
    return {
      headers: { Authorization: `Basic ${btoa(`x:${token.plaintext.split("?expires=")[0]}`)}` },
    };
  }
}
