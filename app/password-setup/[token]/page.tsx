import { PasswordSetupForm } from "@/components/auth/password-setup-form";
import { systemIdentity } from "@/config/system-settings";
import { getPasswordSetupPreview } from "@/lib/auth/password-setup";
import {
  PASSWORD_SETUP_ERROR_PARAM,
  PASSWORD_SETUP_SAVED_PARAM,
  PASSWORD_SETUP_SAVED_VALUE,
  passwordSetupFormAction,
  passwordSetupNoScriptErrorMessage,
} from "@/lib/auth/password-setup-no-script";
import { SIGN_IN_AFTER_SETUP_PARAM, SIGN_IN_AFTER_SETUP_VALUE } from "@/lib/auth/temporary-password";
import { cairoDateTime } from "@/lib/format/cairo-datetime";

export const dynamic = "force-dynamic";

export default async function PasswordSetupPage(
  { params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const { token } = await params;
  // Reached from a sign-in with the emailed TEMPORARY password (app/api/auth/login): once the person
  // has chosen their own password they are signed in and taken inside, not sent back to /login.
  const query = await searchParams;
  const signInAfter = query[SIGN_IN_AFTER_SETUP_PARAM] === SIGN_IN_AFTER_SETUP_VALUE;
  // A native form post (src/lib/auth/password-setup-no-script.ts) comes back here with `saved` or a fixed
  // error code. Only the code travels; the words are Phoenix's own.
  const saved = query[PASSWORD_SETUP_SAVED_PARAM] === PASSWORD_SETUP_SAVED_VALUE;
  const errorParam = query[PASSWORD_SETUP_ERROR_PARAM];
  const initialError = passwordSetupNoScriptErrorMessage(Array.isArray(errorParam) ? errorParam[0] : errorParam);
  let preview: Awaited<ReturnType<typeof getPasswordSetupPreview>>;

  try {
    preview = await getPasswordSetupPreview(token);
  } catch (error) {
    // `saved` is believed only once the link is spent: a crafted ?saved=1 on a live link shows the form.
    if (saved) {
      return (
        <main className="min-h-screen bg-[#020202] px-4 py-10 text-white">
          <section className="mx-auto max-w-xl border border-white/10 bg-[linear-gradient(145deg,rgba(19,22,27,0.92),rgba(5,6,8,0.98))] p-8 shadow-[0_30px_70px_rgba(0,0,0,0.55)]">
            <p className="text-sm font-black uppercase tracking-[0.24em] text-[#ff7900]">{systemIdentity.appName}</p>
            <h1 className="mt-5 text-3xl font-black text-white">Password saved</h1>
            <p className="mt-3 text-base leading-7 text-white/72">
              Your password is ready. Sign in with your username and the password you just created.
            </p>
            <a
              className="mt-8 inline-flex h-12 items-center justify-center bg-gradient-to-b from-[#ff8a00] to-[#ff4d00] px-5 text-sm font-black text-white"
              href="/login"
            >
              Go to sign in
            </a>
          </section>
        </main>
      );
    }
    const message = error instanceof Error ? error.message : "This password setup link is unavailable.";

    return (
      <main className="min-h-screen bg-[#020202] px-4 py-10 text-white">
        <section className="mx-auto max-w-xl border border-white/10 bg-[linear-gradient(145deg,rgba(19,22,27,0.92),rgba(5,6,8,0.98))] p-8 shadow-[0_30px_70px_rgba(0,0,0,0.55)]">
          <p className="text-sm font-black uppercase tracking-[0.24em] text-[#ff7900]">{systemIdentity.appName}</p>
          <h1 className="mt-5 text-3xl font-black text-white">Link unavailable</h1>
          <p className="mt-3 text-base leading-7 text-white/72">{message}</p>
          <p className="mt-4 text-sm text-white/55">Ask your admin to generate a new password setup link.</p>
        </section>
      </main>
    );
  }

  // Formatted HERE, on the server, and handed down as a finished string.
  //
  // The form is a client component, so anything it formats itself is formatted TWICE — once by
  // Node when the HTML is rendered and again by the browser when React hydrates it. Those are two
  // different engines carrying two independently-versioned copies of the Unicode locale data, and
  // when they disagree by a single character React throws away the server HTML and re-renders
  // (hydration error #418). It did: en-GB's abbreviated September is "Sep" before CLDR 42 and
  // "Sept" after it, so the Railway server and a reader on Samsung Internet 20 built different
  // strings for the same instant. Formatting once, on the server, means there is no second render
  // to disagree with.
  //
  // `cairoDateTime` is the shared, zone-pinned helper (Cairo, never the runtime's own zone — the
  // copy below says "Cairo time" and must not be lying); it returns an em dash for an absent or
  // unparseable instant, which becomes `null` here so the expiry LINE disappears rather than
  // printing a dash where a date should be.
  const formattedExpiry = cairoDateTime(preview.expiresAt);

  return (
    <PasswordSetupForm
      action={passwordSetupFormAction(token, signInAfter)}
      expiryLabel={formattedExpiry === "—" ? null : formattedExpiry}
      initialError={initialError}
      hrId={preview.hrId}
      loginId={preview.loginId}
      name={preview.name}
      purpose={preview.purpose}
      signInAfter={signInAfter}
      token={token}
    />
  );
}
