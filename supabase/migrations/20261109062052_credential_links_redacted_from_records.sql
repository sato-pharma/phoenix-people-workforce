-- Remove password-reset codes and set-your-password link tokens from the records that kept them.
--
-- The email outbox was cleared by 20261109043800. Five more records kept them readable after the send:
--   notification_send_reviews  the Notification Confidence Gate's copy of every rendered email: 33 codes
--                              and 162 links (rendered_html and rendered_text)
--   notification_events        the notification's own row: the link in action_url and metadata.href
--   email_delivery_events      the mail provider's click events: the clicked link in raw_event
--   audit_logs                 setupUrl in "Generated setup/reset link" entries from May 2026
--   internal_messages          one message body that pasted a link
-- From this release the app strips them before storing (src/lib/email/credential-redaction.ts and
-- password-setup.ts). This clears what was stored before.
--
-- Data only, no schema change. Only the token after `password-setup/` and the reset email's six digits
-- become `[removed]`; every other character of each row is unchanged. The token is 32 random bytes in
-- base64url, so it has no character that needs escaping in JSON, and the replacement has none either.
-- The six-digit code is the only six-digit run in a reset-code email: measured on all 33 stored, once in
-- the text and once in the HTML; a colour such as #003366 is excluded by the # before it.

update public.notification_send_reviews
set rendered_html = regexp_replace(rendered_html, '(password-setup/)[A-Za-z0-9_-]{16,}', '\1[removed]', 'g'),
    rendered_text = regexp_replace(rendered_text, '(password-setup/)[A-Za-z0-9_-]{16,}', '\1[removed]', 'g')
where rendered_html ~ 'password-setup/[A-Za-z0-9_-]{16,}' or rendered_text ~ 'password-setup/[A-Za-z0-9_-]{16,}';

update public.notification_send_reviews
set rendered_html = regexp_replace(rendered_html, '(?<![#[:alnum:]_])[0-9]{6}(?![[:alnum:]_])', '[removed]', 'g'),
    rendered_text = regexp_replace(rendered_text, '(?<![#[:alnum:]_])[0-9]{6}(?![[:alnum:]_])', '[removed]', 'g')
where rendered_text ~ 'Your code'
  and (template_key = 'password_reset_code' or template_key is null);

update public.notification_events
set action_url = regexp_replace(action_url, '(password-setup/)[A-Za-z0-9_-]{16,}', '\1[removed]', 'g'),
    metadata = regexp_replace(metadata::text, '(password-setup/)[A-Za-z0-9_-]{16,}', '\1[removed]', 'g')::jsonb
where action_url ~ 'password-setup/[A-Za-z0-9_-]{16,}' or metadata::text ~ 'password-setup/[A-Za-z0-9_-]{16,}';

update public.email_delivery_events
set raw_event = regexp_replace(raw_event::text, '(password-setup/)[A-Za-z0-9_-]{16,}', '\1[removed]', 'g')::jsonb
where raw_event::text ~ 'password-setup/[A-Za-z0-9_-]{16,}';

update public.audit_logs
set new_values = regexp_replace(new_values::text, '(password-setup/)[A-Za-z0-9_-]{16,}', '\1[removed]', 'g')::jsonb
where new_values::text ~ 'password-setup/[A-Za-z0-9_-]{16,}';

update public.internal_messages
set body = regexp_replace(body, '(password-setup/)[A-Za-z0-9_-]{16,}', '\1[removed]', 'g')
where body ~ 'password-setup/[A-Za-z0-9_-]{16,}';
