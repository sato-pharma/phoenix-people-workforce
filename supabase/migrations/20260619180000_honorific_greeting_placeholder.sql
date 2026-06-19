-- Add {{honorific}} to individual-recipient template greetings.
-- "Dr. " is injected for manager roles; "" for Employee / Medical Rep / Super Admin.
-- Only updates greetings that contain {{recipientName}} and don't already have {{honorific}}.
UPDATE email_templates
SET greeting = REPLACE(greeting, '{{recipientName}}', '{{honorific}}{{recipientName}}')
WHERE greeting LIKE '%{{recipientName}}%'
  AND greeting NOT LIKE '%{{honorific}}%';

UPDATE email_template_drafts
SET greeting = REPLACE(greeting, '{{recipientName}}', '{{honorific}}{{recipientName}}')
WHERE greeting LIKE '%{{recipientName}}%'
  AND greeting NOT LIKE '%{{honorific}}%';
