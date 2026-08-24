import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service | Sato Pharma",
};

export default function TermsOfServicePage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold text-text">Terms of Service — Sato Pharma / Phoenix HR Workforce</h1>
      <p className="mt-1 text-sm text-muted">Last updated: August 2026</p>

      <p className="mt-6 text-text">
        These terms govern use of Phoenix HR Workforce (the &quot;Platform&quot;), the human-resources system
        operated by Sato Pharma Egyptian Pharmaceutical Company (&quot;Sato Pharma,&quot; &quot;we,&quot;
        &quot;us&quot;), and of the recruitment messaging channels connected to it — including our WhatsApp
        Business account. By using the Platform, or by messaging us on a channel described below, you agree to
        these terms.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-text">What the Platform is</h2>
      <p className="mt-2 text-text">
        Phoenix HR Workforce is Sato Pharma&apos;s internal platform for human-resources operations, including
        recruitment, attendance, payroll, leave, and field-force management. It is not a public consumer service
        and is not offered to other businesses.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-text">Who may use it</h2>
      <p className="mt-2 text-text">
        Access to the Platform is limited to Sato Pharma employees and authorised personnel, each acting within
        the permissions assigned to them. Job candidates interact with us only through the recruitment channels
        described below; candidates are not given Platform accounts.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-text">WhatsApp recruitment channel</h2>
      <p className="mt-2 text-text">
        Sato Pharma operates a WhatsApp Business account used to receive job applications. If you send us a
        message or a CV on WhatsApp, you are contacting us voluntarily to apply for employment, and you consent to
        our receiving and processing that message and any attachment for recruitment purposes. Messages sent to
        this account are delivered into the Platform and handled by our Talent Acquisition and HR personnel.
      </p>
      <p className="mt-2 text-text">
        We use this channel to respond about your application. We do not send marketing or promotional messages on
        it, and we do not sell, rent, or share your WhatsApp number with third parties for their own marketing. You
        may stop the conversation at any time by replying to tell us so, or by blocking the account in WhatsApp.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-text">Acceptable use</h2>
      <p className="mt-2 text-text">
        Do not use the Platform or our messaging channels to submit unlawful, fraudulent, or deliberately
        misleading content, to impersonate another person, to send malware, or to attempt to gain access to data
        or accounts you are not authorised to reach. Information you submit about yourself must be accurate.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-text">Personal data</h2>
      <p className="mt-2 text-text">
        Our handling of personal data — what we collect, how it is used, who can access it, how long it is kept,
        and your rights over it — is described in our{" "}
        <a href="/privacy" className="underline">
          Privacy Policy
        </a>
        , which forms part of these terms.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-text">Availability</h2>
      <p className="mt-2 text-text">
        We aim to keep the Platform and our messaging channels available, but they are provided on an
        &quot;as is&quot; and &quot;as available&quot; basis. Delivery of messages depends on third-party networks
        and services outside our control, and we do not guarantee uninterrupted or error-free operation.
        Submitting an application does not create any obligation to interview, hire, or respond.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-text">Changes to these terms</h2>
      <p className="mt-2 text-text">
        We may update these terms as the Platform and our recruitment channels change. The revision date at the
        top of this page indicates when they were last updated, and continued use after an update means you accept
        the revised terms.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-text">Governing law</h2>
      <p className="mt-2 text-text">
        These terms are governed by the laws of the Arab Republic of Egypt.
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
