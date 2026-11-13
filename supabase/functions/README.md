# Supabase Edge Functions

Production runs **no** edge functions. This folder keeps the source of the one it used to run, so the
repository holds a record of everything production has run (enterprise audit 2026-11-13, F-DB-013 /
REC-041).

## summarize-thread — DELETED from production on 13 Nov 2026, kept only as a record

- **What was deployed:** version 25, last updated 12 May 2026, `verify_jwt` on, ESZIP sha256
  `5e60e5d8a75a4f8b48b982258379bf0ec3e897e8b91d02541f01b4345e36c9a3`. `summarize-thread/index.ts` is its
  single file, copied from production on 13 Nov 2026 (`get_edge_function`) before it was deleted.
- **Nothing used it.** No code in the app called it, and the `public.messages` table it read does not
  exist on production (only Supabase's own `realtime.messages`), so every call failed with an error before
  it reached OpenAI. It was a generic chat-summary template, unrelated to Phoenix.
- **Why it was removed:** anyone holding the public anon key could call it, and it held an
  `OPENAI_API_KEY` secret. Had a table named `messages` ever been created in `public`, it would have
  started spending that key on whatever the caller could read. It was also a second way into an AI model,
  outside the one door every AI call in the app goes through (`src/lib/ai/`).
- **Deleted** on the owner's decision, 13 Nov 2026, with `supabase functions delete summarize-thread`;
  afterwards `list_edge_functions` returned none and the endpoint answered 404. Redeploying it from this
  source would bring it back. Never do that without the owner.

## How this folder is treated

- **Never deployed from here.** No workflow deploys edge functions; deploying is a deliberate
  `supabase functions deploy` by hand.
- **Not typechecked or linted with the app.** It is Deno code (`npm:` imports, the `Deno` global), so
  `tsconfig.json` and `eslint.config.mjs` leave `supabase/functions` out.
- **Not a second AI door in the app.** `tests/ai-one-door.test.ts` scans `src` and `app`; a new function
  here that calls a model must go through the owner first.
