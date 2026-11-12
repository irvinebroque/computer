import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("bundles the main entry without optional AI and tool peers", async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../index.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    logLevel: "silent",
    external: ["node:*", "cloudflare:*", "@cloudflare/computer/shell/*"],
    plugins: [
      {
        name: "reject-optional-peers",
        setup(bundler) {
          bundler.onResolve(
            { filter: /^(zod|ai|just-bash|vite|@platformatic\/vfs)$/ },
            ({ path }) => ({
              errors: [{ text: `Main entry requires optional peer ${path}` }],
            }),
          );
        },
      },
    ],
  });

  expect(result.errors).toEqual([]);
});
