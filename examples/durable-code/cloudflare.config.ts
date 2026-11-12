import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "computer-durable-code",
    entrypoint,
    compatibilityDate: "2026-11-11",
    compatibilityFlags: ["nodejs_compat"],
    exports: { LibraryAgent: exports.durableObject({ storage: "sqlite" }) },
    env: {
      ARTIFACTS: bindings.artifacts({ namespace: "computer-durable-code", dev: { remote: true } }),
      AI: bindings.ai({ dev: { remote: true } }),
      LOADER: bindings.workerLoader(),
      DEMO_TOKEN: bindings.secret(),
    },
    observability: { enabled: true },
  },
});
