begin;

-- The coaching_report email template's header box used a dark navy background
-- (#0F172A) with white/light-gray inline text colors. The shared Phoenix email
-- layout wraps every template's body_html in a container whose stylesheet
-- forces every nested <p> to a fixed text color (#0F172A in light mode) via
-- !important, which beats a plain (non-!important) inline color. That left the
-- header box rendering navy-on-navy text: fully invisible in light-mode email
-- clients (the common case). Fix: remove the header box entirely; everything
-- else in the template (Status row, Metric Scorecard, score table, closing
-- note) is unchanged.
insert into public.email_templates (
  template_key,
  template_name,
  description,
  is_active,
  subject,
  greeting,
  body_html,
  body_text,
  closing_text,
  preview_text,
  updated_at,
  updated_by
) values (
  'coaching_report',
  'Coaching Report',
  'Coaching report notifications: a submitted report awaiting the employee''s review and acknowledgement.',
  true,
  '{{subject}}',
  'Dear {{honorific}}{{recipientName}},',
  $template$
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;width:100%;border:1px solid #CBD5E1">
  <tr>
    <td style="background-color:#FFFFFF;padding:16px">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;border:1px solid #E2E8F0">
        <tr>
          <td style="background-color:#F8FAFC;border:1px solid #E2E8F0;padding:10px 12px;color:#64748B;font-size:12px;line-height:1.4;font-weight:700;text-align:left">Status</td>
          <td style="border:1px solid #E2E8F0;padding:10px 12px;color:#0F172A;font-size:13px;line-height:1.4;font-weight:700;text-align:right">{{status}}</td>
        </tr>
      </table>
      <p style="color:#0F172A;font-size:16px;line-height:1.4;font-weight:900">Metric Scorecard</p>
      {{scoreTable}}
      <p style="color:#64748B;font-size:12px;line-height:1.55">Please review the submitted coaching scores and acknowledge the report in Phoenix Workforce.</p>
    </td>
  </tr>
</table>
$template$,
  $text$Status: {{status}}

Metric Scorecard
{{scoreTable}}

Please review the submitted coaching scores and acknowledge the report in Phoenix Workforce.$text$,
  'Open Phoenix Workforce to review and acknowledge the coaching report.',
  'A coaching report is ready for your review.',
  now(),
  'codex:fix-coaching-report-email-dark-block'
)
on conflict (template_key) do update
set
  template_name = excluded.template_name,
  description = excluded.description,
  subject = excluded.subject,
  greeting = excluded.greeting,
  body_html = excluded.body_html,
  body_text = excluded.body_text,
  closing_text = excluded.closing_text,
  preview_text = excluded.preview_text,
  updated_at = excluded.updated_at,
  updated_by = excluded.updated_by
where email_templates.template_key = 'coaching_report';

commit;
