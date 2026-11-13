# Supabase Edge Functions

Production runs exactly one edge function, and its source is kept here so the repository holds
everything production runs (enterprise audit 2026-11-13, F-DB-013 / REC-041).

## summarize-thread — DEAD, kept only as a record

- **What is deployed:** version 25, last updated 12 May 2026, `verify_jwt` on, ESZIP sha256
  `5e60e5d8a75a4f8b48b982258379bf0ec3e897e8b91d02541f01b4345e36c9a3`. `summarize-thread/index.ts` is its
  single file, copied from production on 13 Nov 2026 (`get_edge_function`).
- **Nothing uses it.** No code in the app calls it, and the `public.messages` table it reads does not
  exist on production (only Supabase's own `realtime.messages`), so every call fails with an error before
  it reaches OpenAI. It is a generic chat-summary template, unrelated to Phoenix.
- **Why it still matters:** it is a live endpoint that anyone holding the public anon key can call, and
  it holds an `OPENAI_API_KEY` secret. If a table named `messages` is ever created in `public`, it would
  start spending that key on whatever the caller can read. It is also a second way into an AI model,
  outside the one door every AI call in the app goes through (`src/lib/ai/`).
- **Removing it from production** is a dashboard or `supabase functions delete summarize-thread` action,
  and is the owner's decision. This source stays as the record either way.

## How this folder is treated

- **Never deployed from here.** No workflow deploys edge functions; deploying is a deliberate
  `supabase functions deploy` by hand.
- **Not typechecked or linted with the app.** It is Deno code (`npm:` imports, the `Deno` global), so
  `tsconfig.json` and `eslint.config.mjs` leave `supabase/functions` out.
- **Not a second AI door in the app.** `tests/ai-one-door.test.ts` scans `src` and `app`; a new function
  here that calls a model must go through the owner first.
