"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

// Mounts Sentry's feedback widget only within the admin/ops shell (see app/(admin)/layout.tsx).
// instrumentation-client.ts registers feedbackIntegration with autoInject: false specifically
// so it never appears globally — this is an HR platform, and employee-facing pages (payslips,
// personal data) should not show a generic "Report a Bug" widget.
export function SentryFeedbackWidget() {
  useEffect(() => {
    const feedback = Sentry.getFeedback();
    if (!feedback) return;
    const widget = feedback.createWidget();
    return () => {
      widget?.removeFromDom();
    };
  }, []);

  return null;
}
