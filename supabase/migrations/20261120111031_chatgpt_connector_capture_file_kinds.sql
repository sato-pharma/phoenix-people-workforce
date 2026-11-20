-- chatgpt_connector_capture_file_kinds
--
-- WHAT THIS CHANGES: public.connector_files.kind may now also be 'png', 'mp4' or 'webm' (until now
--   'xlsx' or 'pdf' only). One CHECK constraint is dropped and re-added under the same name; no row
--   changes, and every existing row ('xlsx'/'pdf') satisfies the new constraint.
-- WHY: the ChatGPT connector's screenshot and video tools (owner, 20 Nov 2026: "I WANT THE CINNECTER
--   BE ABLE TO TAKE SCEEN SHOTS AND RE CORD VIDEOS") store their picture or video exactly like the
--   connector's sheets and PDFs: a connector_files row and a private link only the same person opens
--   for 7 days (src/lib/chatgpt-connector/files.ts, app/api/connector/files/[id]/route.ts).
-- ROLLBACK: delete the png/mp4/webm rows (and their storage objects through the Storage API), then
--   alter table public.connector_files drop constraint connector_files_kind_check,
--     add constraint connector_files_kind_check check (kind in ('xlsx', 'pdf'));
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Not destructive and not bulk: a constraint widened, nothing deleted or rewritten.

begin;

alter table public.connector_files drop constraint if exists connector_files_kind_check;
alter table public.connector_files
  add constraint connector_files_kind_check check (kind in ('xlsx', 'pdf', 'png', 'mp4', 'webm'));

commit;
