---
"@cloudflare/computer": patch
---

`CodemodeBackend` takes an experimental `onSettle` hook that hears how every run ended, saved with the run's end and delivered again after a restart or from `runtime.recover()`; see [Hearing how a run ended](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#hearing-how-a-run-ended).
