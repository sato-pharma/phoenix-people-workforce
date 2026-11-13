-- share_link_clear_tokens
--
-- WHAT THIS CHANGES: fills in any link made by the old code in between, clears the plain `token` of
-- every Direct Orders report, Marketing Requests report and Territory preview share link, and makes
-- token_hash and token_preview NOT NULL. Each row keeps token_hash (how the app finds it) and
-- token_preview, written by 20261113183501_share_link_token_hash.sql.
--
-- 🔴 APPLY ONLY AFTER the code that finds links by token_hash is serving on production (read
-- /api/healthz `revision`). Before that, the running code still looks links up by `token`, and both
-- live Google Sheets would stop reading.
--
-- WHY: S01 audit, REC-055 (F-MKT-012, F-SAL-006) — a share link is stored only as its hash.
--
-- ROLLBACK: none — the plain tokens are gone. The links keep working through token_hash; the whole
-- link cannot be shown again (it is shown once, when it is made, as it already was).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

-- A link made by the old code after 20261113183501 was applied has only its token: fill it in first.
update public.direct_order_report_share_links
set token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex'), token_preview = left(token, 8)
where token is not null and token_hash is null;
update public.marketing_request_report_share_links
set token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex'), token_preview = left(token, 8)
where token is not null and token_hash is null;
update public.territory_preview_links
set token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex'), token_preview = left(token, 8)
where token is not null and token_hash is null;

update public.direct_order_report_share_links set token = null where token is not null and token_hash is not null;
update public.marketing_request_report_share_links set token = null where token is not null and token_hash is not null;
update public.territory_preview_links set token = null where token is not null and token_hash is not null;

alter table public.direct_order_report_share_links
  alter column token_hash set not null,
  alter column token_preview set not null;
alter table public.marketing_request_report_share_links
  alter column token_hash set not null,
  alter column token_preview set not null;
alter table public.territory_preview_links
  alter column token_hash set not null,
  alter column token_preview set not null;

commit;
