-- interview_calendar_link_hash_and_expiry
--
-- WHAT THIS CHANGES: ats_interview_calendar_links gains
--   * token_hash    — the SHA-256 (hex) of the link, unique. The app finds a link by this from now on.
--   * token_preview — the link's first 8 characters, for the owner's list.
--   * expires_at    — 90 days after the link was made; the link opens nothing after it.
-- Every existing row is filled in from its own token and created_at (7 rows on production on
-- 13 Nov 2026, the oldest made 19 Sep 2026, so none expires before 18 Dec 2026). `token` becomes
-- nullable: a new link is stored without it. The existing tokens are KEPT by this migration so the
-- links already sent keep working while the old code still serves; they are cleared by
-- 20261113181702_interview_calendar_link_clear_tokens.sql once the new code is live.
--
-- WHY: S01 audit, REC-055 (F-RCT-004). Owner, 13 Nov 2026: 90 days for the existing links and new
-- ones; links already sent keep working; the whole link is shown once, when it is made.
--
-- ROLLBACK:
--   alter table public.ats_interview_calendar_links drop column token_hash, drop column token_preview,
--     drop column expires_at;
--   (only while every row still has its token) alter table ... alter column token set not null;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.ats_interview_calendar_links
  add column if not exists token_hash text,
  add column if not exists token_preview text,
  add column if not exists expires_at timestamptz;

update public.ats_interview_calendar_links
set token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex'),
    token_preview = left(token, 8),
    expires_at = coalesce(expires_at, created_at + interval '90 days')
where token is not null and token_hash is null;

alter table public.ats_interview_calendar_links alter column token drop not null;
-- token_hash stays NULLABLE here: the code serving when this is applied still makes links with only
-- `token`. 20261113181702 fills those in and sets it NOT NULL once the new code is live.
create unique index if not exists ats_interview_calendar_links_token_hash_key
  on public.ats_interview_calendar_links (token_hash);

commit;
