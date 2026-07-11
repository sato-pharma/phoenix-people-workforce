-- Add {{honorific}} to individual-recipient template greetings.
-- "Dr. " is injected for manager roles; "" for Employee / Medical Rep / Super Admin.
-- Only updates greetings that contain {{recipientName}} and don't already have {{honorific}}.
UPDATE email_templates
SET greeting = REPLACE(greeting, '{{recipientName}}', '{{honorific}}{{recipientName}}')
WHERE greeting LIKE '%{{recipientName}}%'
  AND greeting NOT LIKE '%{{honorific}}%';

-- email_template_drafts has no top-level "greeting" column — it lives inside the
-- template_snapshot JSON blob, so this updates that key instead of a bare column.
UPDATE email_template_drafts
SET template_snapshot = jsonb_set(
  template_snapshot,
  '{greeting}',
  to_jsonb(REPLACE(template_snapshot->>'greeting', '{{recipientName}}', '{{honorific}}{{recipientName}}'))
)
WHERE template_snapshot->>'greeting' LIKE '%{{recipientName}}%'
  AND template_snapshot->>'greeting' NOT LIKE '%{{honorific}}%';
