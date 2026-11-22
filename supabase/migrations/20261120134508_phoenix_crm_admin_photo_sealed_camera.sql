-- phoenix_crm_admin_photo_sealed_camera
--
-- WHAT THIS CHANGES: three columns on public.phoenix_crm_admin_photo_validations, one CHECK and one partial
--   unique index:
--   * rep_source text not null default 'live' — 'live' when the rep sent the reading from the List while the
--     Super Admin's watch was on (the only kind until now), 'sealed_photo' when the reading came inside a photo
--     sealed by the Phoenix Camera app;
--   * seal_id text — SHA-256 of the seal's signature; one seal validates one customer (the unique index ignores a
--     cancelled watch, so the same photo can be uploaded again after Stop);
--   * seal_report jsonb — what the seal said and what Phoenix checked (time, satellites, phone model, the phone
--     key's fingerprint, the warnings shown). No photo bytes, no key material.
-- WHY: owner, 20 Nov 2026 — a separate Android camera app that photographs the place with NO network and stamps the
--   time, date and location, for the call with the System Administrator and for a clinic with no signal: "I'll
--   build my own, but you must take every precaution against fake locations and fraud, and keep its seal".
--   phoenix_crm_validate_with_admin_photo is unchanged: a sealed watch is born 'captured' with the seal's satellite
--   fix in the rep_* columns, and the function validates it exactly as a live one.
-- ROLLBACK:
--   drop index if exists public.phoenix_crm_admin_photo_validations_seal_idx;
--   alter table public.phoenix_crm_admin_photo_validations drop constraint if exists phoenix_crm_admin_photo_validations_seal;
--   alter table public.phoenix_crm_admin_photo_validations drop column if exists seal_report, drop column if exists seal_id,
--     drop column if exists rep_source;   -- loses which validations came from a sealed photo
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: three new columns (every existing row reads 'live'), one CHECK every
-- existing row already meets, one index.

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_admin_photo_validations
  add column if not exists rep_source text not null default 'live',
  add column if not exists seal_id text,
  add column if not exists seal_report jsonb;

alter table public.phoenix_crm_admin_photo_validations drop constraint if exists phoenix_crm_admin_photo_validations_seal;
alter table public.phoenix_crm_admin_photo_validations add constraint phoenix_crm_admin_photo_validations_seal check (
  rep_source in ('live', 'sealed_photo')
  and (rep_source = 'sealed_photo') = (seal_id is not null)
  and (seal_id is null) = (seal_report is null)
  and (rep_source = 'live' or rep_lat is not null)
);

create unique index if not exists phoenix_crm_admin_photo_validations_seal_idx
  on public.phoenix_crm_admin_photo_validations (seal_id)
  where seal_id is not null and status <> 'cancelled';

comment on column public.phoenix_crm_admin_photo_validations.rep_source is
  '''live'': the rep sent the reading from the List while the watch was on; ''sealed_photo'': the reading came inside a photo sealed by the Phoenix Camera app (owner, 2026-11-20).';
comment on column public.phoenix_crm_admin_photo_validations.seal_id is
  'SHA-256 of the Phoenix Camera seal''s signature — one seal validates one customer.';
comment on column public.phoenix_crm_admin_photo_validations.seal_report is
  'What the Phoenix Camera seal said and what Phoenix checked: time, satellites, phone model, the phone key''s fingerprint, the warnings shown. No photo, no key.';

notify pgrst, 'reload schema';

commit;
