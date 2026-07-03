-- Raise the leave-attachments storage bucket file size ceiling from 10MB to 20MB.
--
-- Sick documents and compensatory-day event photos are frequently phone camera photos, which
-- routinely land in the 5-12MB range (high-res / HDR). The previous 10MB bucket limit rejected the
-- larger of these at upload time. Employees need at least a comfortable 10MB accepted, so the ceiling
-- is raised to 20MB — matching the sales-imports bucket precedent and the app-side limits in
-- src/lib/vacation/route-guards.ts (vacationUploadMaxBytes) and src/lib/vacation/service.ts
-- (sickAttachmentMaxUploadBytes). allowed_mime_types is left unchanged. Idempotent.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    update storage.buckets
    set file_size_limit = 20971520 -- 20 * 1024 * 1024
    where id = 'leave-attachments';
  end if;
end $$;
