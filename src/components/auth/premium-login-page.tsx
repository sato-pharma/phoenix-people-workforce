"use client";

import type { startAuthentication as StartAuthentication } from "@simplewebauthn/browser";
import {
  BarChart3,
  Eye,
  EyeOff,
  Fingerprint,
  Lock,
  ShieldCheck,
  User,
  Zap,
} from "lucide-react";
import Image from "next/image";
import { FormEvent, useEffect, useMemo, useState } from "react";

import { systemAssets, systemIdentity, systemUiText } from "@/config/system-settings";
import {
  clearSessionActivity,
  markSessionActivity,
  phoenixSessionTimeoutReason,
} from "@/lib/auth/client-session";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { currentCairoTimeHM } from "@/lib/i18n/format";

const rememberedLoginIdKey = "phoenix_remembered_login_id";
const loginIdRequiredMessage = "Enter your HR ID, login ID or Sato email.";
const maxLoginIdLength = 120;
const maxPasswordLength = 1024;
const passwordRequiredMessage = "Enter your password.";

const loginErrorMessages: Record<string, string> = {
  invalid_credentials: "Invalid login or password.",
  password_setup_required: "Set your password first using “Set or reset my password” below, then sign in.",
  rate_limited: "Too many failed login attempts. Please try again later.",
  sign_in_unavailable: "Sign-in is temporarily unavailable. Please try again in a few minutes.",
};

type LoginErrorField = "form" | "loginId" | "password";

const embers = Array.from({ length: 42 }, (_, index) => ({
  delay: `${(index % 12) * 0.42}s`,
  duration: `${6.5 + (index % 7)}s`,
  left: `${4 + ((index * 13) % 92)}%`,
  size: `${2 + (index % 5)}px`,
}));

const loginFeatureIcons = [BarChart3, ShieldCheck, Zap] as const;

function safeReturnUrl(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v || !v.startsWith("/") || v.startsWith("//")) return null;
  return v;
}

export function PremiumLoginPage({ returnUrl }: { returnUrl?: string }) {
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<LoginErrorField | null>(null);
  const [isBiometricSubmitting, setIsBiometricSubmitting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [shakeError, setShakeError] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const greeting = useMemo(() => {
    // The Cairo hour, never the runtime's own local hour: /login is server-rendered, the server runs in
    // UTC and the browser in Cairo, so the raw clock names a different greeting on each side for three
    // hours at every boundary and React throws the whole tree away with a hydration mismatch.
    const hour = currentCairoTimeHM().hours;

    if (hour >= 5 && hour < 12) {
      return "Good morning. Ready to rise?";
    }

    if (hour >= 12 && hour < 18) {
      return "Good afternoon. Keep the momentum.";
    }

    return "Good evening. Secure access starts here.";
  }, []);

  function showLoginError(message: string, field: LoginErrorField = "form") {
    setError(message);
    setErrorField(field);
    setShakeError(true);
    window.setTimeout(() => setShakeError(false), 460);
  }

  function updateLoginId(value: string) {
    setLoginId(value);
    if (errorField === "loginId") {
      setError(null);
      setErrorField(null);
    }
  }

  function updatePassword(value: string) {
    setPassword(value);
    if (errorField === "password") {
      setError(null);
      setErrorField(null);
    }
  }

  useEffect(() => {
    const frames: number[] = [];
    const searchParams = new URLSearchParams(window.location.search);
    const loginError = searchParams.get("error");
    const loginReason = searchParams.get("reason");

    if (loginReason === phoenixSessionTimeoutReason) {
      clearSessionActivity();
      frames.push(window.requestAnimationFrame(() => {
        setError("Your session expired. Please sign in again.");
        setErrorField("form");
      }));
    }

    if (loginError && loginErrorMessages[loginError]) {
      frames.push(window.requestAnimationFrame(() => {
        setError(loginErrorMessages[loginError]);
        setErrorField("form");
      }));
    }

    const rememberedLoginId = safeLocalStorageGet(rememberedLoginIdKey);

    if (rememberedLoginId) {
      frames.push(window.requestAnimationFrame(() => {
        setLoginId(rememberedLoginId);
        setRemember(true);
      }));
    }

    return () => {
      frames.forEach((frame) => window.cancelAnimationFrame(frame));
    };
  }, []);

  // Only offer biometrics where the device actually has a built-in sensor it can verify the person
  // with — Face ID, Touch ID, a fingerprint reader, Windows Hello. On anything else the button
  // never renders, so nobody is shown a control that can only fail. Older browsers lack
  // PublicKeyCredential entirely, which the optional chain treats as "not available".
  useEffect(() => {
    let cancelled = false;

    window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()
      .then((available) => {
        if (!cancelled) setBiometricAvailable(Boolean(available));
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleBiometricSignIn() {
    setError(null);
    setErrorField(null);
    setShakeError(false);
    setIsBiometricSubmitting(true);

    try {
      const optionsResponse = await fetch("/api/auth/biometric/login/options", {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!optionsResponse.ok) {
        const payload = (await optionsResponse.json().catch(() => null)) as
          | { message?: string }
          | null;
        showLoginError(payload?.message ?? "Biometric sign-in is unavailable. Use your password.");
        return;
      }

      const { options } = (await optionsResponse.json()) as { options: Parameters<typeof StartAuthentication>[0]["optionsJSON"] };
      // Loaded on demand: pulling @simplewebauthn/browser in at module scope put the
      // whole WebAuthn client in the login page's first JS payload, which only the
      // fingerprint button ever needs.
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const assertion = await startAuthentication({ optionsJSON: options });

      const verifyResponse = await fetch("/api/auth/biometric/login/verify", {
        body: JSON.stringify({ response: assertion }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!verifyResponse.ok) {
        const payload = (await verifyResponse.json().catch(() => null)) as
          | { message?: string }
          | null;
        showLoginError(
          payload?.message ?? "Biometric sign-in failed. Please sign in with your password.",
        );
        return;
      }

      const payload = (await verifyResponse.json()) as {
        redirectTo?: string;
        user?: { role?: string | null };
      };

      markSessionActivity();
      const urlReturnUrl = new URLSearchParams(window.location.search).get("returnUrl");
      const destination =
        returnUrl ??
        safeReturnUrl(urlReturnUrl) ??
        payload.redirectTo ??
        resolveLandingPathForRole(payload.user?.role);
      window.location.assign(destination);
    } catch (cancellation) {
      // Dismissing the Face ID / fingerprint sheet throws here. That is a normal thing to do, not
      // an error worth a red banner — leave the form exactly as it was so they can type instead.
      const name = (cancellation as { name?: string } | null)?.name ?? "";
      if (name !== "NotAllowedError" && name !== "AbortError") {
        showLoginError("Biometric sign-in failed. Please sign in with your password.");
      }
    } finally {
      setIsBiometricSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedLoginId = loginId.trim();
    setError(null);
    setErrorField(null);
    setShakeError(false);

    if (!trimmedLoginId) {
      showLoginError(loginIdRequiredMessage, "loginId");
      return;
    }

    if (!password) {
      showLoginError(passwordRequiredMessage, "password");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        body: JSON.stringify({ loginId: trimmedLoginId, password, remember }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string; message?: string }
          | null;

        showLoginError(
          payload?.message ??
            "Credentials not recognized. Please check your HR_ID or login ID and password.",
        );
        return;
      }

      const payload = (await response.json()) as {
        user?: { role?: string | null };
      };

      if (remember) {
        safeLocalStorageSet(rememberedLoginIdKey, trimmedLoginId);
      } else {
        safeLocalStorageRemove(rememberedLoginIdKey);
      }

      markSessionActivity();
      const urlReturnUrl = new URLSearchParams(window.location.search).get("returnUrl");
      const destination = returnUrl ?? safeReturnUrl(urlReturnUrl) ?? resolveLandingPathForRole(payload.user?.role);
      window.location.assign(destination);
    } catch {
      showLoginError("Unable to sign in. Check your connection and try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#020202] px-2 py-2 text-white sm:px-4 sm:py-4 lg:px-6">
      <div className="login-grid-bg pointer-events-none fixed inset-0 opacity-70" />
      <div className="login-noise pointer-events-none fixed inset-0 opacity-[0.08]" />
      <section className="relative mx-auto grid min-h-[calc(100vh-16px)] w-full max-w-[1740px] overflow-hidden border border-white/10 bg-black shadow-[0_28px_90px_rgba(0,0,0,0.72)] sm:min-h-[calc(100vh-32px)] lg:min-h-[calc(100vh-48px)] lg:grid-cols-[1.06fr_0.94fr]">
        <AccessPanel
          biometricAvailable={biometricAvailable}
          error={error}
          errorField={errorField}
          greeting={greeting}
          isBiometricSubmitting={isBiometricSubmitting}
          isSubmitting={isSubmitting}
          loginId={loginId}
          onBiometricSignIn={handleBiometricSignIn}
          onLoginIdChange={updateLoginId}
          onPasswordChange={updatePassword}
          onRememberChange={setRemember}
          onSubmit={handleSubmit}
          onTogglePassword={() => setShowPassword((current) => !current)}
          password={password}
          remember={remember}
          shakeError={shakeError}
          showPassword={showPassword}
        />
        <BrandPanel />
      </section>
    </main>
  );
}

function safeLocalStorageGet(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageRemove(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore blocked storage; remembering the login ID is optional.
  }
}

function safeLocalStorageSet(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore blocked storage; successful login must not depend on local storage.
  }
}

function BrandPanel() {
  return (
    <aside className="relative order-2 min-h-[500px] overflow-hidden px-6 py-12 sm:px-10 lg:order-1 lg:min-h-[620px] lg:px-10 lg:py-6 xl:px-16">
      <div className="login-fire-haze absolute inset-0" />
      <div className="login-bottom-fire absolute inset-x-0 bottom-0 h-64" />
      <div className="login-rock-floor pointer-events-none absolute inset-x-0 bottom-0 h-40" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_18%,rgba(255,106,0,0.16),transparent_28%),linear-gradient(90deg,rgba(0,0,0,0.08),rgba(0,0,0,0.42))]" />
      <div className="absolute inset-x-0 bottom-0 h-44 bg-[radial-gradient(ellipse_at_bottom,rgba(255,89,0,0.42),transparent_68%)]" />
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {embers.map((ember, index) => (
          <span
            className="login-ember"
            key={index}
            style={{
              animationDelay: ember.delay,
              animationDuration: ember.duration,
              height: ember.size,
              left: ember.left,
              width: ember.size,
            }}
          />
        ))}
      </div>

      <div className="relative z-10 flex min-h-full flex-col">
        <div className="mx-auto mt-4 flex w-full max-w-[660px] flex-1 flex-col items-center text-center lg:mt-5">
          <div className="login-logo-glow relative flex h-48 w-48 items-center justify-center sm:h-[300px] sm:w-[300px] lg:h-[260px] lg:w-[260px] xl:h-[300px] xl:w-[300px]">
            <Image
              alt={`${systemIdentity.brandName} logo`}
              className="relative z-10 h-auto w-[112%] max-w-none object-contain drop-shadow-[0_0_32px_rgba(255,106,0,0.52)]"
              height={340}
              priority
              src={systemAssets.loginEmblem}
              width={340}
            />
          </div>

          <h1 className="-mt-2 text-4xl font-black uppercase tracking-[0.20em] text-white drop-shadow-[0_0_18px_rgba(255,255,255,0.22)] sm:text-6xl lg:text-6xl xl:text-7xl">
            {systemIdentity.brandName.slice(0, -1).toUpperCase()}<span className="text-[#ff6a00]">{systemIdentity.brandName.slice(-1).toUpperCase()}</span>
          </h1>
          <p className="mt-2 text-phx-2xs font-black uppercase tracking-[0.20em] text-white/88 sm:mt-3 sm:text-sm sm:tracking-[0.28em]">
            {systemUiText.login.tagline}
          </p>

          <div className="relative mt-6 h-px w-full max-w-[320px] bg-gradient-to-r from-transparent via-[#ff6a00] to-transparent sm:mt-8 sm:max-w-[420px]">
            <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 bg-white shadow-[0_0_22px_7px_rgba(255,106,0,0.9)]" />
          </div>

          <p className="mt-5 max-w-[620px] text-lg font-medium leading-7 text-white/92 sm:mt-7 sm:text-2xl sm:leading-8 lg:text-xl">
            {systemUiText.login.statement} &mdash;
            <br />
            {systemUiText.login.statementSuffix}
          </p>

          <div className="mt-7 w-full max-w-[560px] space-y-4 text-left sm:mt-8 lg:space-y-3">
            {systemUiText.login.features.map((feature, index) => {
              const FeatureIcon = loginFeatureIcons[index] ?? Zap;

              return (
                <div className="flex items-center gap-4 sm:gap-5" key={feature.title}>
                  <span className="flex h-[52px] w-[52px] shrink-0 items-center justify-center border border-[#ff6a00]/80 bg-black/35 text-[#ff6a00] shadow-[0_0_24px_rgba(255,106,0,0.16)] sm:h-[62px] sm:w-[62px]">
                    <FeatureIcon className="h-6 w-6 sm:h-7 sm:w-7" strokeWidth={2.3} />
                  </span>
                  <div>
                    <h2 className="text-lg font-black text-white sm:text-2xl">{feature.title}</h2>
                    <p className="mt-0.5 text-sm leading-5 text-white/68 sm:mt-1 sm:text-lg sm:leading-6">{feature.description}</p>
                  </div>
                </div>
              );
            })}
          </div>

          <p className="mt-7 w-full max-w-[560px] text-left text-xl font-black text-[#ff7900] sm:mt-8 sm:text-3xl">
            {systemUiText.login.motto}
          </p>
        </div>
      </div>
    </aside>
  );
}

function AccessPanel({
  biometricAvailable,
  error,
  errorField,
  greeting,
  isBiometricSubmitting,
  isSubmitting,
  loginId,
  onBiometricSignIn,
  onLoginIdChange,
  onPasswordChange,
  onRememberChange,
  onSubmit,
  onTogglePassword,
  password,
  remember,
  shakeError,
  showPassword,
}: {
  biometricAvailable: boolean;
  error: string | null;
  errorField: LoginErrorField | null;
  greeting: string;
  isBiometricSubmitting: boolean;
  isSubmitting: boolean;
  loginId: string;
  onBiometricSignIn: () => void;
  onLoginIdChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onRememberChange: (value: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTogglePassword: () => void;
  password: string;
  remember: boolean;
  shakeError: boolean;
  showPassword: boolean;
}) {
  const loginInvalid = errorField === "form" || errorField === "loginId";
  const passwordInvalid = errorField === "form" || errorField === "password";

  return (
    <section className="relative order-1 flex min-h-[610px] items-center justify-center px-4 py-6 sm:px-8 lg:order-2 lg:px-9 xl:px-14">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(255,106,0,0.08),transparent_34%)]" />
      <form
        action="/api/auth/login"
        className={`relative w-full max-w-[620px] border border-white/12 bg-[linear-gradient(145deg,rgba(19,22,27,0.9),rgba(5,6,8,0.98))] px-6 py-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_32px_70px_rgba(0,0,0,0.48)] backdrop-blur-xl sm:px-8 sm:py-7 lg:px-10 xl:px-12 ${shakeError ? "login-card-shake" : ""}`}
        method="post"
        noValidate
        onSubmit={onSubmit}
      >
        <div className="text-center">
          <p className="text-3xl font-black uppercase tracking-[0.26em] text-white sm:text-4xl">
            PHOENI<span className="text-[#ff6a00]">X</span>
          </p>
          <div className="mx-auto mt-2 flex max-w-[360px] items-center gap-4">
            <span className="h-px flex-1 bg-gradient-to-r from-transparent to-[#ff6a00]" />
            <p className="text-xs font-black uppercase tracking-[0.24em] text-[#ff7900] sm:text-sm">SECURE ACCESS</p>
            <span className="h-px flex-1 bg-gradient-to-l from-transparent to-[#ff6a00]" />
          </div>
          <h2 className="mt-5 text-2xl font-bold text-white sm:text-3xl">Sign in to your account</h2>
          <p className="mt-2 text-base text-white/52">Enter your credentials to continue</p>
          <p className="mt-1.5 text-sm font-medium text-[#ff9a2f]/85">{greeting}</p>
        </div>

        <div className="mt-5 space-y-4">
          <label className="block" htmlFor="login-id">
            <span className="mb-2 block text-base font-semibold text-white">HR ID, Login ID or Sato email</span>
            <span className="relative block">
              <input
                aria-describedby={error ? "login-error" : undefined}
                aria-invalid={loginInvalid}
                autoComplete="username"
                className="h-12 w-full border border-white/14 bg-white/[0.045] px-5 pr-12 text-base text-white outline-none shadow-[inset_0_1px_18px_rgba(255,255,255,0.035)] transition placeholder:text-white/36 focus:border-[#ff7900] focus:bg-white/[0.065] focus:ring-4 focus:ring-[#ff6a00]/16"
                id="login-id"
                maxLength={maxLoginIdLength}
                name="loginId"
                onChange={(event) => onLoginIdChange(event.target.value)}
                placeholder="HR ID or name@satopharma.com"
                required
                type="text"
                value={loginId}
              />
              <User className="pointer-events-none absolute right-5 top-1/2 h-5 w-5 -translate-y-1/2 text-white/48" />
            </span>
          </label>

          <div className="block">
            <label className="mb-2 block text-base font-semibold text-white" htmlFor="login-password">Password</label>
            <span className="relative block">
              <input
                aria-describedby={error ? "login-error" : undefined}
                aria-invalid={passwordInvalid}
                autoComplete="current-password"
                className="h-12 w-full border border-white/14 bg-white/[0.045] px-5 pr-12 text-base text-white outline-none shadow-[inset_0_1px_18px_rgba(255,255,255,0.035)] transition placeholder:text-white/36 focus:border-[#ff7900] focus:bg-white/[0.065] focus:ring-4 focus:ring-[#ff6a00]/16"
                id="login-password"
                maxLength={maxPasswordLength}
                name="password"
                onChange={(event) => onPasswordChange(event.target.value)}
                placeholder="Enter your password"
                required
                type={showPassword ? "text" : "password"}
                value={password}
              />
              <button
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute right-4 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center text-white/62 transition hover:text-white"
                type="button"
                onClick={onTogglePassword}
              >
                {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </span>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
          <label className="flex cursor-pointer items-center gap-3 text-white/82" htmlFor="remember-login">
            <input
              checked={remember}
              className="peer sr-only"
              id="remember-login"
              name="remember"
              onChange={(event) => onRememberChange(event.target.checked)}
              type="checkbox"
              value="true"
            />
            <span
              className={`flex h-7 w-7 items-center justify-center border bg-white/[0.035] transition peer-focus-visible:ring-4 peer-focus-visible:ring-[#ff6a00]/30 ${
                remember ? "border-[#ff7900] bg-[#ff7900]" : "border-white/22"
              }`}
            >
              {remember ? <span className="h-2.5 w-2.5 bg-white" /> : null}
            </span>
            Remember login ID
          </label>
          <a
            className="font-semibold text-[#ff9a2f] underline-offset-4 transition hover:text-[#ffb366] hover:underline"
            href="/password-reset"
          >
            Set or reset my password
          </a>
        </div>

        {error && (
          <div
            className="mt-4 border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-100"
            id="login-error"
            role="alert"
          >
            {error}
          </div>
        )}

        <button
          className="mt-4 flex h-[52px] w-full items-center justify-center gap-3 bg-gradient-to-b from-[#ff8a00] to-[#ff4d00] text-lg font-black text-white shadow-[0_14px_38px_rgba(255,106,0,0.34),inset_0_1px_0_rgba(255,255,255,0.3)] transition hover:translate-y-[-1px] hover:shadow-[0_18px_48px_rgba(255,106,0,0.48),inset_0_1px_0_rgba(255,255,255,0.35)] focus:outline-none focus:ring-4 focus:ring-[#ff6a00]/30 disabled:cursor-not-allowed disabled:opacity-70"
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting ? (
            <span className="h-5 w-5 animate-spin border-2 border-white/35 border-t-white" />
          ) : (
            <Lock className="h-6 w-6" />
          )}
          {isSubmitting ? "Signing in..." : "Sign in"}
        </button>

        {biometricAvailable && (
          <>
            <div className="mt-4 flex items-center gap-4">
              <span className="h-px flex-1 bg-white/12" />
              <span className="text-xs font-bold uppercase tracking-[0.22em] text-white/38">or</span>
              <span className="h-px flex-1 bg-white/12" />
            </div>

            <button
              className="mt-4 flex h-[52px] w-full items-center justify-center gap-3 whitespace-nowrap border border-white/16 bg-white/[0.045] text-base font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition hover:border-[#ff7900]/60 hover:bg-white/[0.075] focus:outline-none focus:ring-4 focus:ring-[#ff6a00]/24 disabled:cursor-not-allowed disabled:opacity-70"
              disabled={isBiometricSubmitting || isSubmitting}
              onClick={onBiometricSignIn}
              type="button"
            >
              {isBiometricSubmitting ? (
                <span className="h-5 w-5 animate-spin border-2 border-white/35 border-t-white" />
              ) : (
                <Fingerprint className="h-6 w-6 text-[#ff9a2f]" />
              )}
              {isBiometricSubmitting ? "Waiting for you..." : "Sign in with biometrics"}
            </button>
          </>
        )}

        <p className="mt-5 flex items-center justify-center gap-3 text-center text-sm text-white/48">
          <ShieldCheck className="h-5 w-5" />
          Secure. Trusted. Built for performance.
        </p>
      </form>
    </section>
  );
}



