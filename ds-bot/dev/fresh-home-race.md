# Fresh-home race: the first model call of a new session has no memory tools

Found on the cloud bench (2026-10-22, `runs\20261022-1950-qa-m55-smoke2`), reproducible
2 out of 2 on a brand-new DSH_HOME, never on a warm one. This file is the recipe; the
archived mock.jsonl of the failed run holds the raw evidence (call 1: plain-text answer,
no tool_use; call 3, same system-prompt hash: `tool:recall`).

## Symptom

- A fresh DSH_HOME with the plugin linked, a Main Bot bootstrapped by the mock greeting.
- The first user message `记住 Alpha uses pnpm` is answered with plain text by the
  scripted mock, because the request's tool list has no `remember` (the mock answers
  anything it has no tool for with `收到：…`). The save is silently skipped.
- The next message in the same session (`回忆 Alpha`) already carries `recall` — the
  tools arrived between the first and third model call, with the same system prompt.

## Recipe (the cloud bench, ~5 minutes)

1. Remove the bench home, recreate it, link the plugin:

   ```bat
   rmdir /s /q C:\lab\bench-m55\.dsh-test-m55
   mkdir C:\lab\bench-m55\.dsh-test-m55
   set DSH_HOME=C:\lab\bench-m55\.dsh-test-m55
   dsh plugin --profile web add link:C:/lab/src/DeepSeek-Bot-m55/ds-bot
   ```

2. Start the mock (port 3211) and `dsh --profile web --no-open --port 3210` with
   `DEEPSEEK_BASE_URL=http://127.0.0.1:3211/v1`, wait for the 3210 listener only
   (the login URL needs a token; a plain HTTP probe fails).
3. As soon as `state` shows the Main Bot, send `记住 Alpha uses pnpm`, settle, then
   `回忆 Alpha`, settle. Stop both processes.
4. Read the mock log: the first call for the send must show
   `"out":[{"type":"tool_use","name":"remember",...}]`. On the failing builds it shows
   a text block instead — that is the race.

## Where to look

The tools reach the model through the per-session request assembled by DSH; the plugin
registers its tools once at load. The gap is between the first request of a brand-new
session and the plugin's (or the capability layer's) registration becoming visible to
it. Not reproduced in unit tests because fixtures register tools synchronously.

## Acceptance line for #55

A fresh-home bench run must save the first `记住` message; the current smoke
(`ds-bot/dev/../dev` bench scripts, cloud copy `m55-smoke.mjs` in the run archive)
asserts exactly this and fails on the race.
