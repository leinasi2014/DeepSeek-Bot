# Fresh-home first write: a mock routing defect, not a product one

Found on the cloud bench (2026-10-22, `runs\20261022-1930/1950`), reproduced 3/3 on a
brand-new DSH_HOME, never on a warm one. This file is the closed-out record; the raw
evidence lives in the run archives (mock.jsonl, web.log, finding.txt).

## Final verdict (C: the mock's own routing)

The first request of a fresh session is fine: `toolNames=56` with `remember`/`recall`
present (logged with `MOCK_LOG_TOOLS=1`; the failed run's first call carries the exact
same tools digest `3f480ea3178c` as a passing one). The product never lacked the tools.

What swallowed the first `记住` was `dev/mock-llm.mjs` itself:

1. A fresh home appends its runtime context and a `<system-reminder>` block to the user
   message. The memory-command regexes matched the whole text with `^…$` (no `m` flag),
   so `记住 X` followed by the reminder never matched.
2. The miss fell through to the free-text rule that answers `list_bots` when the text
   mentions "team" — and the reminder block does. The mock answered `list_bots({})` and
   the save was silently skipped.
3. Warm homes do not re-inject the whole reminder, which is why only fresh homes failed.

Both fixed in `5c8a6d9`: command matching reads the first line, and the reminder block
is stripped before the free-text rules. With the fix, a brand-new home answers the very
first `记住` with a real `remember` tool_use and the entry lands (SMOKE-PASS twice on
the cloud bench: `runs\20261022-2135`, `runs\20261022-2145`).

## Guards against a comeback

- `dev/bench-memory.mjs` probe: when the tap records tool names, the first chat call
  must include `remember`, or the bench fails loudly.
- The repro case added with `5c8a6d9` pins the first-line matching itself.

## Acceptance line for #55

A fresh-home bench run must save the first `记住` message: first-round `remember`
tool_use and the entry in `MEMORY.md`. That line stands; the earlier "tool
registration window" hypothesis behind it was wrong and is withdrawn.
