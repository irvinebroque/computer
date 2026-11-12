import { Buffer } from "node:buffer";
import { posix } from "node:path";
import type { Database } from "@cloudflare/dofs";

type Entry = { path: string; content: Uint8Array | null; mtime: number };

/** Git's private filesystem. Its tables never enter Workspace sync or the sandbox. */
export class SqlGitFilesystem {
  readonly promises;

  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS workspace_code_library_git (
      path TEXT PRIMARY KEY, content BLOB, mtime INTEGER NOT NULL
    )`);
    db.run("INSERT OR IGNORE INTO workspace_code_library_git VALUES ('/', NULL, 0)");

    const stat = async (path: string) => {
      const entry = this.#entry(path);
      const directory = entry.content === null;

      return {
        size: entry.content?.byteLength ?? 0,
        mode: directory ? 0o40755 : 0o100644,
        mtimeMs: entry.mtime,
        ctimeMs: entry.mtime,
        mtime: new Date(entry.mtime),
        ctime: new Date(entry.mtime),
        dev: 0,
        ino: 0,
        uid: 0,
        gid: 0,
        isDirectory: () => directory,
        isFile: () => !directory,
        isSymbolicLink: () => false,
      };
    };

    this.promises = {
      stat,
      lstat: stat,
      readFile: async (path: string, options?: BufferEncoding | { encoding?: BufferEncoding }) => {
        const content = this.#entry(path).content;

        if (content === null) throw fsError("EISDIR", path);
        const bytes = Buffer.from(content);

        const encoding = typeof options === "string" ? options : options?.encoding;

        return encoding ? bytes.toString(encoding) : bytes;
      },
      writeFile: async (path: string, content: Uint8Array | string) => {
        path = posix.resolve("/", path);

        if (this.#entry(posix.dirname(path)).content !== null) throw fsError("ENOTDIR", path);
        db.run(
          "INSERT OR REPLACE INTO workspace_code_library_git VALUES (?, ?, ?)",
          path,
          typeof content === "string" ? Buffer.from(content) : content,
          Date.now(),
        );
      },
      mkdir: async (path: string) => {
        path = posix.resolve("/", path);

        if (this.exists(path)) throw fsError("EEXIST", path);

        if (this.#entry(posix.dirname(path)).content !== null) throw fsError("ENOTDIR", path);
        db.run("INSERT INTO workspace_code_library_git VALUES (?, NULL, ?)", path, Date.now());
      },
      readdir: async (path: string) => {
        path = posix.resolve("/", path);

        if (this.#entry(path).content !== null) throw fsError("ENOTDIR", path);

        const children: string[] = [];

        for (const entry of db.all<Pick<Entry, "path">>(
          "SELECT path FROM workspace_code_library_git",
        )) {
          if (entry.path !== path && posix.dirname(entry.path) === path)
            children.push(posix.basename(entry.path));
        }

        return children;
      },
      unlink: async (path: string) => {
        if (this.#entry(path).content === null) throw fsError("EISDIR", path);
        db.run("DELETE FROM workspace_code_library_git WHERE path = ?", posix.resolve("/", path));
      },
      rmdir: async (path: string) => {
        if ((await this.promises.readdir(path)).length) throw fsError("ENOTEMPTY", path);
        db.run("DELETE FROM workspace_code_library_git WHERE path = ?", posix.resolve("/", path));
      },
      readlink: async (path: string): Promise<string> => {
        throw fsError("EINVAL", path);
      },
      symlink: async (_target: string, path: string): Promise<void> => {
        throw fsError("ENOSYS", path);
      },
      chmod: async (path: string) => {
        this.#entry(path);
      },
    };
  }

  exists(path: string): boolean {
    return (
      this.db.one(
        "SELECT path FROM workspace_code_library_git WHERE path = ?",
        posix.resolve("/", path),
      ) !== undefined
    );
  }

  #entry(path: string): Entry {
    const entry = this.db.one<Entry>(
      "SELECT * FROM workspace_code_library_git WHERE path = ?",
      posix.resolve("/", path),
    );

    if (!entry) throw fsError("ENOENT", path);

    return entry;
  }

  reset(): void {
    this.db.transactionSync(() => {
      this.db.run("DELETE FROM workspace_code_library_git");
      this.db.run("INSERT INTO workspace_code_library_git VALUES ('/', NULL, 0)");
    });
  }
}

function fsError(code: string, path: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}
