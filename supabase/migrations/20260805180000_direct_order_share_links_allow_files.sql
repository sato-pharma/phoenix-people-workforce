-- Clickable storefront photos in the owner's live Direct Orders sheet.
--
-- The share link already carries the ORDER TABLE. This adds a separate, off-by-default grant for
-- the FILES behind it, mirroring marketing_request_report_share_links.allow_files.
--
-- Why the two are not one permission: the table leaks numbers — quantities, prices, sales values.
-- A file leaks a photograph of a real shop front with a GPS stamp on it, taken to prove a pharmacy
-- exists. Those are not the same disclosure, so a link minted to feed a spreadsheet must not become
-- a key to the photographs just because someone guessed the file route exists.
--
-- Default FALSE deliberately: the safe link is the one you get without asking for anything.

alter table public.direct_order_report_share_links
  add column if not exists allow_files boolean not null default false,
  add column if not exists file_access_count integer not null default 0;

comment on column public.direct_order_report_share_links.allow_files is
  'Whether this token may stream pharmacy-validation storefront photos. Separate from the CSV '
  'grant on purpose: the table leaks numbers, a file leaks a GPS-stamped photograph of a real shop '
  'front. Off unless explicitly asked for.';

comment on column public.direct_order_report_share_links.file_access_count is
  'File opens, counted separately from CSV pulls. "Nobody ever opened a photo" and "someone opened '
  '200" are different facts, and only the second is worth investigating.';
