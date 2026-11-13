-- cv_lifecycle_share_link_token_hash
--
-- WHAT THIS CHANGES: ats_cv_lifecycle_share_links (15 rows on production on 13 Nov 2026, one of them
-- live) gains
--   * token_hash    — the SHA-256 (hex) of the link's token, unique. The app finds a link by this from now on.
--   * token_preview — the token's first 8 characters, the same preview the audit rows already carry.
-- Every existing row is filled in from its own token. `token` becomes nullable: a new link is stored
-- without it. The existing tokens are KEPT by this migration so the live CV Lifecycle Google Sheet keeps
-- reading while the old code still serves; they are cleared by
-- 20261113195228_cv_lifecycle_share_link_clear_tokens.sql once the new code is live.
--
-- WHY: S01 audit, REC-055 — the CV Lifecycle share link is stored only as its hash, as the Direct
-- Orders, Marketing Requests and Territory preview links already are (20261113183501).
--
-- ROLLBACK:
--   drop index if exists public.ats_cv_lifecycle_share_links_token_hash_key;
--   alter table public.ats_cv_lifecycle_share_links drop column token_hash, drop column token_preview;
--   (only while every row still has its token) alter table public.ats_cv_lifecycle_share_links alter column token set not null;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.ats_cv_lifecycle_share_links
  add column if not exists token_hash text,
  add column if not exists token_preview text;

update public.ats_cv_lifecycle_share_links
set token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex'), token_preview = left(token, 8)
where token is not null and token_hash is null;

alter table public.ats_cv_lifecycle_share_links alter column token drop not null;

-- token_hash stays NULLABLE here: the code serving when this is applied still makes links with only
-- `token`. 20261113195228 fills those in and sets it NOT NULL once the new code is live.
create unique index if not exists ats_cv_lifecycle_share_links_token_hash_key
  on public.ats_cv_lifecycle_share_links (token_hash);

commit;
