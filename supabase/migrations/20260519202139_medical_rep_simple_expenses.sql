alter table public.outstation_expense_requests
  add column if not exists go_ticket_amount double precision not null default 0,
  add column if not exists return_ticket_amount double precision not null default 0,
  add column if not exists ticket_attachment_paths jsonb not null default '[]'::jsonb,
  add column if not exists ticket_attachment_metadata jsonb not null default '[]'::jsonb;

update public.outstation_expense_requests
set
  go_ticket_amount = coalesce(go_ticket_amount, 0),
  return_ticket_amount = coalesce(return_ticket_amount, 0),
  ticket_attachment_paths = coalesce(ticket_attachment_paths, '[]'::jsonb),
  ticket_attachment_metadata = coalesce(ticket_attachment_metadata, '[]'::jsonb);

alter table public.outstation_expense_requests
  alter column go_ticket_amount set default 0,
  alter column go_ticket_amount set not null,
  alter column return_ticket_amount set default 0,
  alter column return_ticket_amount set not null,
  alter column ticket_attachment_paths set default '[]'::jsonb,
  alter column ticket_attachment_paths set not null,
  alter column ticket_attachment_metadata set default '[]'::jsonb,
  alter column ticket_attachment_metadata set not null;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'outstation-evidence',
      'outstation-evidence',
      false,
      5242880,
      array['image/jpeg', 'image/png', 'application/pdf']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = greatest(coalesce(storage.buckets.file_size_limit, 0), excluded.file_size_limit),
        allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;
