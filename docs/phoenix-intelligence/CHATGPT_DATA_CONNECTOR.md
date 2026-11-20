# The ChatGPT data connector

ChatGPT answers questions from live Phoenix data: an employee's record, attendance, leave, pay, a
representative's achievement for a quarter, targets, the field CRM. It can also build an Excel sheet or a
PDF from what it found. It reads Phoenix as the person who connected it and sees exactly what that
person's own Phoenix screens show.

## The owner's decisions (17 Nov 2026)

| Question | His answer |
| --- | --- |
| Where the data comes from | The live Phoenix app (`https://phoenix-hr.satopharma.com/api/mcp`) |
| What it may see | Everything his role can see, including bank details, ID numbers and medical information |
| Who may connect it | Him and the CEO only (`Super Admin`, `CEO`) |
| Who builds sheets and PDFs | Phoenix builds them, in the house identity |
| The raw database tables | Every table, every row and every character, for him and the CEO: "read every single table in the system, every single letter … answer me or Dr. Anwar". Only credentials stay out |
| The customer lists as a file | With names, not codes (17 Nov 2026: "export every doctor with names instead of codes via ChatGPT") — `phoenix_export_customer_list` |

He has also switched off model training in ChatGPT, so OpenAI does not use these conversations to train its models.

## How to connect it

1. In ChatGPT: **Settings → Apps & Connectors → Advanced → Developer mode** on. Then **Create** (add a custom connector).
2. Name it `Phoenix`. Set the MCP server URL to `https://phoenix-hr.satopharma.com/api/mcp`. Set authentication to **OAuth**.
3. ChatGPT registers itself and opens Phoenix's own page, `/connector/authorize`. Sign in to Phoenix if asked.
   The page says what ChatGPT will be able to do. Press **Allow**.
4. In a new chat, turn on the Phoenix connector and ask, for example: "What was Ibtissam's achievement last
   quarter?" or "Make me a sheet of everyone in Cairo on leave this week".

Any seat other than the owner or the CEO sees "ChatGPT cannot be connected from this account".

## What protects the data

- **Its own sign-in.** The connector uses OAuth 2.1 with PKCE and dynamic registration. Registration is
  accepted only for ChatGPT's own return addresses. A code works once and lasts two minutes. An access
  token lasts one hour. A refresh token lasts 30 days and works once. Presenting a spent refresh token
  again revokes the whole connection. Every code and token is stored only as a SHA-256 fingerprint.
- **A live check on every question.** Each call re-reads the account behind the token. If the account is
  switched off, the person has left, the role changed, or the password was changed or the account signed
  out everywhere (`session_version`), the connector stops and ChatGPT asks to sign in again.
- **The person's own permissions.** Every tool asserts the same permission and applies the same scope as
  the matching Phoenix page. Sales and target figures come only from the published monthly closing.
- **Read-only.** No tool changes, approves, sends or publishes anything.
- **Every table, for the owner and the CEO.** `phoenix_list_tables`, `phoenix_read_table` and
  `phoenix_export_table` read any public table or view. A read is one page of up to 1,000 rows; a page too big
  for one answer is shortened to whole rows, and the answer gives `next_offset` so the next read carries on. Nothing
  is cut mid-row. `phoenix_export_table` puts a whole table (up to 50,000 rows a file and 500,000 cells, so a
  table of 25 columns gives 20,000 rows a file and one of 200 columns 2,500; or what it can read in 15 seconds) in one
  Excel workbook and names the offset for the next file. If reading and building took over 30 seconds, nothing is saved and
  the answer says so (the call's own 40-second limit does not cancel work, so a late file would be an orphan a retry duplicates). A cell over Excel's limit (32,000
  characters) is shortened in the sheet and named in the answer. What stays out, always: passwords and their
  hashes, tokens, one-time and recovery codes, keys, the tables that hold them (sign-in links, share links,
  OAuth codes) and the session id in `app_sessions` (`src/lib/chatgpt-connector/tools/table-guard.ts`).
- **The customer lists, with names.** `phoenix_export_customer_list` (the owner and the CEO) puts every doctor
  (the AM and PM lists), every pharmacy, or both into one workbook: the medical rep and the district manager by
  name ("Vacant" where the territory has no rep), the line, region and area names, the status in words and the
  dates in Cairo time, with dropped customers on a second sheet. It can narrow to one line, to on-the-list or
  dropped, or to vacant territories only. Test rows never appear. It exists because `phoenix_export_table`
  copies seat ids and line codes as stored, and ChatGPT cannot open the file to put the names back. After a new
  tool ships, press **Refresh tools** in ChatGPT (Settings → Plugins → Phoenix) or ChatGPT keeps the old list
  and falls back to paging the raw table (17 Nov 2026).
- **Files only for the same person.** A sheet or PDF is kept in the private `job-exports` bucket. The
  link ChatGPT shows opens only in the same person's signed-in Phoenix session, for 7 days. Anyone else
  gets "not found".
- **An audit row for every question.** Each call writes an audit row with entity type `chatgpt_connector`,
  showing which tool ran, its small inputs, whether it answered and how long it took. The answer itself is
  never stored. Read the rows in the audit log screen.
- **Limits.** 120 questions a minute per connection. Each question is cut off after 40 seconds. An answer
  is cut, with a note, past 180,000 characters.

## Which ChatGPT callback may register

Registration is open to anyone, so a new registration may name only ChatGPT's stable callback
(`https://chatgpt.com/connector_platform_oauth_redirect`) or a per-connector callback
(`https://chatgpt.com/connector/oauth/<id>`) whose id is listed in the `PHOENIX_CHATGPT_CALLBACK_IDS` environment
variable (comma separated; ChatGPT's connector form shows the id). A stranger's own connector id is refused, so a
stranger cannot put a connection of theirs in front of the owner on the Allow page. A connection registered
before this rule keeps working. The Allow page also prints the return address and says the name is unverified.

That rule alone cannot keep a stranger out: the stable callback is every ChatGPT user's, and a connection
registered before the rule still exists. So once the owner's own connection is made, **lock the Allow page to it**:
the audit row written when he pressed Allow (entity type `chatgpt_connector`, summary "ChatGPT was allowed into
Phoenix as …") carries its `clientId` and `redirectUri`. List that id in the `PHOENIX_CHATGPT_CLIENT_IDS` environment
variable (comma separated). From then on only a listed client can reach the Allow page; any other is refused there
and again when Allow is pressed. A connection already allowed keeps working. Unset, every registered client can
reach Allow, as before. The same person re-adding the connector in ChatGPT gets a new client id and must list it.

## Sign-in text that names no account

A wrong sign-in name is stored as it was typed — a password pasted into the login-id box is stored as text — in
`auth_login_attempts.login_id` and in the `actor_login_id` and `entity_id` of an `auth_session` audit row. The table tools
read every table, so (owner, 18 Nov 2026) such text reads **"(not an account)"** instead: a real login id or HR id stays
visible, so "who failed to sign in" still works, and only text that proves nobody is hidden. An audit row's entity is masked
only when it is its actor's typed text; a blocked address and every other row stay as stored. The check lives in
`maskUnrecognizedIdentifiers` (`tools/table-guard.ts`), runs on every page of the reader and the export, and refuses the read
when the list of accounts cannot be loaded.

## Screenshots and videos (20 Nov 2026)

The owner asked for it in his words: "I WANT THE CINNECTER BE ABLE TO TAKE SCEEN SHOTS AND RE CORD
VIDEOS". He chose the live data connector over the masked staging inspector. Two tools do it, in
`src/lib/chatgpt-connector/tools/screens.ts`. Both seats, the owner and the CEO, can use them.

- **`phoenix_screenshot_page`** takes `{ path, viewport?, fullPage? }`. `path` is a page inside
  Phoenix, starting with `/`. The screen is desktop 1440, tablet 768 or mobile 390. A full-page capture
  stops at 12,000 pixels.
- **`phoenix_record_video`** takes `{ paths[1..3], viewport?, seconds? }`. It opens each page and scrolls it
  to the bottom, for about 16 seconds of video at most. `seconds` (2 to 16) is the length the person asked
  for, shared evenly by the pages; each page is held at its bottom until its share is used. Without it,
  each page is scrolled once and the video ends, so a short page gives a video of about 3 seconds (the
  owner's first "10-second video" of `/employees` came out 3.4 s, 20 Nov 2026). When slow pages leave too
  little time, the answer says it came out shorter than asked. ffmpeg joins the frames into an MP4
  (libx264), or a WebM when libx264 is missing.

**How a capture runs.** Chromium is the same browser the offer-letter PDFs use (`withChromiumSlot`). It
opens the page on this server's own loopback address: `http://127.0.0.1:$PORT`, or
`PHOENIX_CAPTURE_ORIGIN` when that is set. It signs in with a five-minute Phoenix session minted for the
person who asked (`browser/session.ts`). The session's user agent is "Phoenix ChatGPT connector capture",
and it is revoked when the capture ends, with reason `chatgpt_connector_capture`. So the picture shows
exactly what that person's own screen shows.

**What stops a capture from changing anything** (`browser/fence.ts`):

- The page path is checked before any browser opens. It must be inside Phoenix, never `/api`, never a
  page whose server render writes, and never a download, sign-out or cron address.
- Every request the page sends goes through the fence. Only GET and HEAD pass. Every other method, and
  every Server Action, is answered 204 and never reaches Phoenix, so a page that "saves" saved nothing.
  The answer counts each one it stopped.
- GETs that write are refused too: every API route and every page whose render writes, from the list
  built from source (`scripts/phoenix-inspect/generated/side-effect-routes.json`, traced into the image
  by `next.config.ts`), plus the inspector's never-touch paths. **If that list cannot be read, the fence
  fails closed and no capture runs.**
- Downloads are denied, pop-ups are closed and dialogs are dismissed. Requests to other sites are https
  only.

**What comes back.** The picture or video is stored like the sheets and PDFs: a `connector_files` row
(the kinds `png`, `mp4` and `webm` were added by `20261120111031`) and a link that only the same
person opens, for 7 days. ChatGPT shows the result in the **capture viewer** (`browser/viewer.ts`,
`ui://phoenix/capture-v1.html`). It is an MCP Apps view, because ChatGPT does not show a tool's own image
block. The picture goes out as an image block. The video goes in the result's `_meta` (`phoenix/video`)
when it is 5 MB or less. Base64 never goes in the text ChatGPT reads. The viewer fetches nothing from
outside. Change the page, and bump the version in its URI.

**Settings.** `PHOENIX_FFMPEG_PATH` gives ffmpeg's path (default `ffmpeg`, installed in the runner image
by the `Dockerfile`). `PHOENIX_CAPTURE_ORIGIN` overrides the loopback address. When ffmpeg is missing,
the video tool says so and the screenshot tool still works.

## The kill switch

To end every ChatGPT connection at once, run this on production:

```sql
update public.connector_oauth_tokens set revoked_at = now(), revoked_reason = 'owner' where revoked_at is null;
```

There are two other ways. Changing the password, or signing out everywhere, ends that person's
connection. Removing the connector in ChatGPT does too.

## Where it lives

| Piece | File |
| --- | --- |
| The MCP door | `app/api/mcp/route.ts` |
| Sign-in (discovery, registration, token, revoke) | `app/.well-known/oauth-*`, `app/api/connector/oauth/*` |
| The consent page | `app/connector/authorize/` |
| File downloads | `app/api/connector/files/[id]/route.ts` |
| OAuth service and store | `src/lib/chatgpt-connector/oauth.ts`, `oauth-store.ts` |
| The live account check | `src/lib/chatgpt-connector/identity.ts` |
| The MCP server, audit and limits | `src/lib/chatgpt-connector/server.ts` |
| The tools, module by module | `src/lib/chatgpt-connector/tools/` |
| The sheet and PDF tools | `src/lib/chatgpt-connector/files.ts` |
| Screenshots and videos (fence, session, browser, viewer) | `src/lib/chatgpt-connector/browser/`, `tools/screens.ts` |
| Tables | `supabase/migrations/20261117130928_chatgpt_connector_oauth.sql`, `20261120111031_chatgpt_connector_capture_file_kinds.sql` |
| Tests | `tests/chatgpt-connector-oauth.test.ts`, `tests/chatgpt-connector-tools.test.ts`, `tests/chatgpt-connector-capture.test.ts` |

To add a tool, put it in the right `tools/<module>.ts` file and use `defineTool`. Assert the page's own
permission, narrow the rows with the page's scope helper, and return `{ summary, data }`. Never add a
tool that writes.
