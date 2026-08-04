-- The marketing customer/pharmacy "live photo" was captured in the browser, stamped with GPS and a
-- timestamp, and then THROWN AWAY. Only `evidence_photo_name` survived, so `evidence_status =
-- 'complete'` asserted proof that did not exist and an approver reading "Live capture photo on file"
-- was reading a filename, not evidence. `public.marketing_evidence_files` was designed for exactly
-- this and defaults `storage_bucket` to 'marketing-evidence' — but that bucket was never created, so
-- the table has stayed empty since it shipped.
--
-- Private, never public: these are shop-front photographs with GPS coordinates burned into the
-- image. They are readable only through a short-lived signed URL minted server-side by the
-- service-role client. Mirrors the recruitment-files parity migration, which is the pattern that
-- works here.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'marketing-evidence',
      'marketing-evidence',
      false,
      -- 2MB, matching the outstation car-evidence cap. The capture is a canvas JPEG at quality
      -- 0.86, which lands well under this even at full sensor resolution.
      2097152,
      -- JPEG only. The capture path produces `canvas.toDataURL("image/jpeg", 0.86)`; accepting
      -- anything else would let a gallery paste in through a flow whose entire point is that the
      -- photo was taken live, at the location, at the stamped time.
      array['image/jpeg']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists marketing_evidence_service_role on storage.objects';
    execute $policy$
      create policy marketing_evidence_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'marketing-evidence')
      with check (bucket_id = 'marketing-evidence')
    $policy$;
  end if;
end $$;

notify pgrst, 'reload schema';
