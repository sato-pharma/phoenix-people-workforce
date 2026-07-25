import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy | Sato Pharma",
};

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold text-text">Privacy Policy — Sato Pharma / Phoenix HR Workforce</h1>
      <p className="mt-1 text-sm text-muted">Last updated: July 2026</p>

      <p className="mt-6 text-text">
        This policy explains how Sato Pharma Egyptian Pharmaceutical Company (&quot;Sato Pharma,&quot; &quot;we,&quot;
        &quot;us&quot;) handles personal data collected through our recruitment channels, including our WhatsApp
        Business account, careers email inboxes, and the Phoenix HR Workforce platform.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-text">What we collect</h2>
      <p className="mt-2 text-text">
        When you contact us to apply for a position — via WhatsApp, email, or our careers page — we collect the
        information you provide, including your name, phone number, email address, and the contents of your
        CV/resume (education, work experience, and other details you choose to include).
      </p>

      <h2 className="mt-8 text-lg font-semibold text-text">How we use it</h2>
      <p className="mt-2 text-text">
        This information is used solely to evaluate your candidacy for employment with Sato Pharma, including
        matching you to open positions, contacting you about your application, and internal recruitment
        record-keeping.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-text">Who can access it</h2>
      <p className="mt-2 text-text">
        Access is limited to Sato Pharma&apos;s Talent Acquisition and HR personnel involved in recruitment.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-text">Retention</h2>
      <p className="mt-2 text-text">
        We retain candidate information for as long as reasonably necessary for recruitment purposes and applicable
        record-keeping requirements.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-text">Your rights</h2>
      <p className="mt-2 text-text">
        You may contact us at{" "}
        <a href="mailto:info@satopharma.com" className="underline">
          info@satopharma.com
        </a>{" "}
        to request access to, correction of, or deletion of your personal data.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-text">Contact</h2>
      <p className="mt-2 text-text">
        Sato Pharma Egyptian Pharmaceutical Company —{" "}
        <a href="mailto:info@satopharma.com" className="underline">
          info@satopharma.com
        </a>
      </p>
    </main>
  );
}
