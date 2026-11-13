-- interview_calendar_link_clear_tokens
--
-- WHAT THIS CHANGES: fills in any link made by the old code in between, clears the plain `token` of
-- every interview calendar copy link, and makes token_hash NOT NULL. Each row keeps
-- token_hash (how the app finds it), token_preview and expires_at, written by
-- 20261113181701_interview_calendar_link_hash_and_expiry.sql.
--
-- 🔴 APPLY ONLY AFTER the code that finds links by token_hash is serving on production (read
-- /api/healthz `revision`). Before that, the running code still looks links up by `token`, and every
-- link already sent would stop opening.
--
-- WHY: S01 audit, REC-055 (F-RCT-004) — a copy link is stored only as its hash.
--
-- ROLLBACK: none — the plain tokens are gone. The links keep working through token_hash; the whole
-- link cannot be shown again (the owner chose "shown once", 13 Nov 2026).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

-- A link made by the old code after 20261113181701 was applied has only its token: fill it in first.
update public.ats_interview_calendar_links
set token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex'),
    token_preview = left(token, 8),
    expires_at = coalesce(expires_at, created_at + interval '90 days')
where token is not null and token_hash is null;

update public.ats_interview_calendar_links
set token = null
where token is not null and token_hash is not null;

alter table public.ats_interview_calendar_links alter column token_hash set not null;

commit;
