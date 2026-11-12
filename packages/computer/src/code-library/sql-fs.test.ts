import { Buffer } from "node:buffer";
import { Database } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { SqlGitFilesystem } from "./sql-fs";

describe("private code library filesystem", () => {
  it("preserves binary data and honors string and object encodings", async () => {
    const fs = new SqlGitFilesystem(new Database(new SQLiteTestStorage()));
    const bytes = new Uint8Array([0, 255, 128, 65]);
    await fs.promises.writeFile("/binary", bytes);
    expect(await fs.promises.readFile("/binary")).toEqual(Buffer.from(bytes));
    expect(await fs.promises.readFile("/binary", "hex")).toBe("00ff8041");
    expect(await fs.promises.readFile("/binary", { encoding: "base64" })).toBe("AP+AQQ==");
  });
});
