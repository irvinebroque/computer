---
"@cloudflare/computer": patch
---

The `exec` tool takes an experimental `detach: { onWait, afterMs }` that returns before a run ends, with its `executionId` and output so far, and leaves the run going; see [Detaching](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#detaching).
