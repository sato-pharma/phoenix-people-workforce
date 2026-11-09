-- Delete the password-reset codes and set-your-password links from finished email-outbox rows.
--
-- The outbox stored the whole email as its payload, so every reset code (in `metrics`) and every
-- set-your-password link (in `ctaHref`) sent since 7 Oct 2026 sat readable in notification_outbox for
-- the 90 days a sent row is kept. From this release the app seals both while a row waits and deletes
-- them when it finishes (src/lib/notifications/credential-seal.ts). This clears the rows written before.
--
-- Data only, no schema change. It touches finished rows alone (sent, skipped, or failed with no
-- retries left), so nothing still waiting to send loses its email. Rows from before 23 Oct 2026 carry
-- no `credentialEmail` stamp, so they are found by the link path, the code template and the code label.

update public.notification_outbox
set payload = (payload - 'metrics' - 'ctaHref' - 'sealedCredential') || jsonb_build_object('credentialRedacted', true)
where (
    status in ('sent', 'skipped')
    or (status = 'failed' and attempts >= max_attempts)
  )
  and (
    payload ->> 'credentialEmail' in ('password_reset_code', 'password_setup_link')
    or payload ->> 'ctaHref' like '/password-setup/%'
    or payload ->> 'templateKey' = 'password_reset_code'
    or payload -> 'metrics' @> '[{"label": "Your code"}]'::jsonb
  )
  and (payload ? 'metrics' or payload ? 'ctaHref' or payload ? 'sealedCredential');
