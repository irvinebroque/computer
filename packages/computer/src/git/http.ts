import type { GitHttpRequest, HttpClient } from "isomorphic-git";

/** Bridge Git's iterable bodies to Fetch without buffering packfiles. */
export function withFetch(fetcher: typeof globalThis.fetch) {
  return {
    async request({ url, method = "GET", headers = {}, body, signal }: GitHttpRequest) {
      if (signal !== undefined && !(signal instanceof AbortSignal))
        throw new TypeError("Expected an AbortSignal for Git transport");
      const init: RequestInit & { duplex?: "half" } = { method, headers, signal };
      if (body !== undefined) {
        const iterator = (async function* () {
          yield* body;
        })();
        init.body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await iterator.next();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            } catch (error) {
              controller.error(error);
            }
          },
          async cancel() {
            await iterator.return(undefined);
          },
        });
        // Required by Node's Fetch for streaming uploads; ignored by Workers.
        init.duplex = "half";
      }
      const response = await fetcher(url, init);
      return {
        url: response.url || url,
        method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBytes(response.body),
      };
    },
  } satisfies HttpClient;
}

async function* responseBytes(body: ReadableStream<Uint8Array> | null) {
  if (!body) return;
  const reader = body.getReader();
  let done = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    try {
      if (!done) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
