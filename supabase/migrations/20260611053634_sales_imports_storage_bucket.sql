-- Private bucket for large distributor sales workbooks. Browsers upload files that exceed Vercel's
-- ~4.5MB serverless request-body cap straight to Storage via a short-lived signed upload URL
-- (/api/sales/monthly-import/upload-url), then /validate downloads + processes the workbook server-side
-- and deletes the temp object. Service-role + signed URLs only; no public access, no permissive RLS.
insert into storage.buckets (id, name, public, file_size_limit)
values ('sales-imports', 'sales-imports', false, 20971520)
on conflict (id) do nothing;
