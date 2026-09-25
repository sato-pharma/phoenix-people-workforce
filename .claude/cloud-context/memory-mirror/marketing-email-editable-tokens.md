---
name: marketing-email-editable-tokens
description: "How marketing notification emails are built — editable admin tokens + templateContext passthrough + sanitizer limits."
metadata: 
  node_type: memory
  type: reference
  originSessionId: b87d285f-1478-474e-b82a-93a69235ee66
---

The `marketing_request` email template (in `src/lib/email-templates/service.ts` `templateDefaults`, NO DB row in prod so the code default applies) is fully editable in `/admin/email-templates`. The premium layout lives in the **template body** using tokens; code only supplies VALUES.

- Editable scalar tokens (registered in `placeholderHints` + `EmailTemplateContext` + `contextVariables`): `estimatedCost`, `requiredRoi`, `roiWindow`, `payDate`, `customerName`, `currentStep`, `requestCode`, `requesterName`.
- Two raw-HTML block tokens in `htmlBlockTokens` (injected unescaped, then sanitized): `productsTable` (dynamic product rows — can't be hand-typed) and `returnCallout` (reason box, empty unless returned/rejected).
- Values flow via a generic `templateContext?: Partial<EmailTemplateContext>` passthrough on `NotificationEmailInput` → merged into the render context in `notifications/email.ts` (the `...(input.templateContext ?? {})` spread) → forwarded by `system.ts` `buildChannelEmailInput`. `marketing-requests/service.ts` `buildMarketingEmailContext()` builds it; wired into `notifyMarketingWorkflow` (assigned/returned/rejected/approved/completed) + the `request_submitted` email.
- Admin preview is populated by `sampleMarketingContext()` (mirrors the weekly_plans `samplePlanTable` demo).

CRITICAL email-HTML constraint (`src/lib/email/email-safety.ts`): the sanitizer **drops `div`, `border-radius`, `box-shadow`, gradients, `margin`, `display`**. Build email HTML **table-based** with `background-color`/`border`/`padding`; `font-size` ≤ 99px. The dark-slate/orange branded shell + "Open in Phoenix" CTA come from `renderPhoenixEmailHtml`. Shipped PRs #336 (premium card) + #337 (editable tokens). See [[premium-design-language]] [[email-template-unification]].
