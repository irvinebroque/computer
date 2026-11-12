# Durable code library

An Agents SDK agent remembers JavaScript it wrote in earlier conversations.
Computer saves each module execution to a Cloudflare Artifacts repository,
along with its purpose, time, execution id, conversation id, and outcome.
The agent can search and read that code on later requests. A human can review
a successful run and promote its source into a named tool.

The switch is `codeLibrary: true`:

```ts
const workspace = new Workspace({
  storage: this.ctx.storage,
  sessionId: this.ctx.id.toString(),
  artifacts: { binding: this.env.ARTIFACTS },
  backends: [new CodemodeBackend({ loader: this.env.LOADER })],
  codeLibrary: true,
});

await workspace.ready();
const tools = createAITools({ workspace });
```

The `exec` tool asks the model for a short `purpose`. Computer commits and
pushes the source before starting the sandbox, then records the observed exit
code. The repository is named `<sessionId>__code-library` in the configured
Artifacts namespace. It contains:

```text
runs/<id>/code.js
runs/<id>/metadata.json
tools/<reviewed-name>.json
```

The agent sees these files at `/workspace/.code-library` through its normal
`ls`, `grep`, and `read` tools. This mount is read-only. Git's working files and
credentials stay in the host, outside the agent's filesystem.

## Run

From the repository root:

```sh
npm install
npm run build --workspace @cloudflare/computer
cd examples/durable-code
cp .dev.vars.example .dev.vars
# Replace DEMO_TOKEN in .dev.vars with a random secret.
cf dev
```

This example needs access to Artifacts and Workers AI. Both bindings are remote
during local development. The `cf` CLI currently requires Wrangler to be
installed directly in the example's `node_modules`. If npm hoisted it to the
repository root, link that installation once before `cf dev`:

```sh
mkdir -p node_modules
ln -s ../../../node_modules/wrangler node_modules/wrangler
```

Set `DEMO_TOKEN` in your terminal to the value in `.dev.vars`, then make a task
that produces a reusable function:

```sh
curl http://localhost:8787/run \
  -H "Authorization: Bearer $DEMO_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"task":"Write and execute a reusable JavaScript function that sums input.amounts. Try it with [12, 8, 5]."}'
```

Each `/run` call starts a fresh conversation with the same agent. Ask it to use
the library in a subsequent request:

```sh
curl http://localhost:8787/run \
  -H "Authorization: Bearer $DEMO_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"task":"Find the sum function in your code library and use it with [3, 4, 9]."}'
```

## Review and promote

Read the source and metadata:

```sh
curl http://localhost:8787/library \
  -H "Authorization: Bearer $DEMO_TOKEN"
```

Choose a successful run's `id`, review its source, then promote it:

```sh
curl http://localhost:8787/promote \
  -H "Authorization: Bearer $DEMO_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"<run id>","name":"sum_amounts","description":"Sum input.amounts, an array of numbers; return the total."}'
```

The next `/run` exposes `saved_sum_amounts`. Promotion pins the reviewed source;
calling the tool supplies `input` as a JSON-encoded object, which Computer parses
and passes to its default export in the same sandbox. Tool calls are saved as
new executions too. The model has no
promotion tool. The host endpoint requires the demo token, which is never
passed to generated code.

The equivalent host operation is:

```ts
await workspace.codeLibrary?.promote(runId, "sum_amounts", description);
```

Call `createAITools()` after `await workspace.ready()` on each turn to pick up
promotions. The AI SDK adapter adds the named tools; other adapters still
support capture and filesystem retrieval.

## Scope

This is source reuse, not an execution cache. Inputs, environment variables,
outputs, imported files, and external dependencies are not copied into the
artifact. Review self-contained functions for promotion. Their tool
descriptions should explain the expected JSON input.

The initial implementation makes a Git push for capture and another for the
outcome. If capture cannot be pushed, execution does not start. If the process
is interrupted or its terminal event is never consumed, the run remains
`started`; reading its execution handle later can record the outcome. A
successful run means exit code zero, not a correctness or safety review.

Use one Workspace writer per agent session. A rejected push stops the operation
instead of overwriting concurrent remote changes. Keep the same session id for
the lifetime of the agent. Shell commands and JavaScript launched inside a shell
are outside this mode; capture happens at Computer's module execution boundary.
