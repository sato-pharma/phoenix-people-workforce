"use client";

import {
  BarChart3,
  Eye,
  EyeOff,
  Lock,
  ShieldCheck,
  User,
  Zap,
} from "lucide-react";
import Image from "next/image";
import { FormEvent, useEffect, useMemo, useState } from "react";

import { resolveLandingPathForRole } from "@/lib/auth/landing";

const rememberedLoginIdKey = "phoenix_remembered_login_id";

const loginErrorMessages: Record<string, string> = {
  invalid_credentials: "Invalid login ID or password.",
  password_setup_required: "Your password must be set or reset from the admin link before you can sign in.",
  rate_limited: "Too many failed login attempts. Please try again later.",
};

const embers = Array.from({ length: 42 }, (_, index) => ({
  delay: `${(index % 12) * 0.42}s`,
  duration: `${6.5 + (index % 7)}s`,
  left: `${4 + ((index * 13) % 92)}%`,
  size: `${2 + (index % 5)}px`,
}));

const features = [
  {
    description: "Data-driven intelligence at your fingertips.",
    icon: BarChart3,
    title: "Performance Insights",
  },
  {
    description: "Enterprise-grade security you can trust.",
    icon: ShieldCheck,
    title: "Secure & Reliable",
  },
  {
    description: "Empowering teams to achieve more.",
    icon: Zap,
    title: "Built for Excellence",
  },
];

export function PremiumLoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [shakeError, setShakeError] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();

    if (hour >= 5 && hour < 12) {
      return "Good morning. Ready to rise?";
    }

    if (hour >= 12 && hour < 18) {
      return "Good afternoon. Keep the momentum.";
    }

    return "Good evening. Secure access starts here.";
  }, []);

  useEffect(() => {
    const frames: number[] = [];
    const loginError = new URLSearchParams(window.location.search).get("error");
    if (loginError && loginErrorMessages[loginError]) {
      frames.push(window.requestAnimationFrame(() => setError(loginErrorMessages[loginError])));
    }

    const rememberedLoginId = window.localStorage.getItem(rememberedLoginIdKey);

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setShakeError(false);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        body: JSON.stringify({ loginId, password, remember }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string; message?: string }
          | null;

        setError(
          payload?.message ??
            "Credentials not recognized. Please check your HR_ID or login ID and password.",
        );
        setShakeError(true);
        window.setTimeout(() => setShakeError(false), 460);
        return;
      }

      const payload = (await response.json()) as {
        user?: { role?: string | null };
      };

      if (remember) {
        window.localStorage.setItem(rememberedLoginIdKey, loginId);
      } else {
        window.localStorage.removeItem(rememberedLoginIdKey);
      }

      window.location.assign(resolveLandingPathForRole(payload.user?.role));
    } catch {
      setError("Unable to sign in. Check your connection and try again.");
      setShakeError(true);
      window.setTimeout(() => setShakeError(false), 460);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#020202] px-2 py-2 text-white sm:px-4 sm:py-4 lg:px-6">
      <div className="login-grid-bg pointer-events-none fixed inset-0 opacity-70" />
      <div className="login-noise pointer-events-none fixed inset-0 opacity-[0.08]" />
      <section className="relative mx-auto grid min-h-[calc(100vh-16px)] w-full max-w-[1740px] overflow-hidden rounded-[28px] border border-white/10 bg-black shadow-[0_28px_90px_rgba(0,0,0,0.72)] sm:min-h-[calc(100vh-32px)] lg:min-h-[calc(100vh-48px)] lg:grid-cols-[1.06fr_0.94fr]">
        <AccessPanel
          error={error}
          greeting={greeting}
          isSubmitting={isSubmitting}
          loginId={loginId}
          onLoginIdChange={setLoginId}
          onPasswordChange={setPassword}
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

function BrandPanel() {
  return (
    <aside className="relative order-2 min-h-[500px] lg:min-h-[690px] overflow-hidden px-6 py-12 sm:px-10 lg:order-1 lg:px-10 lg:py-7 xl:px-16">
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
          <div className="login-logo-glow relative flex h-48 w-48 items-center justify-center sm:h-[300px] sm:w-[300px] lg:h-[340px] lg:w-[340px]">
            <Image
              alt="Phoenix logo"
              className="relative z-10 h-auto w-[112%] max-w-none object-contain drop-shadow-[0_0_32px_rgba(255,106,0,0.52)]"
              height={340}
              priority
              src="/brand/phoenix-login-emblem.png"
              width={340}
            />
          </div>

          <h1 className="-mt-2 text-4xl font-black uppercase tracking-[0.20em] text-white drop-shadow-[0_0_18px_rgba(255,255,255,0.22)] sm:text-6xl lg:text-7xl">
            PHOENI<span className="text-[#ff6a00]">X</span>
          </h1>
          <p className="mt-2 text-[10px] font-black uppercase tracking-[0.20em] text-white/88 sm:mt-3 sm:text-sm sm:tracking-[0.28em]">
            PEOPLE. PERFORMANCE. INTELLIGENCE.
          </p>

          <div className="relative mt-6 h-px w-full max-w-[320px] bg-gradient-to-r from-transparent via-[#ff6a00] to-transparent sm:mt-8 sm:max-w-[420px]">
            <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_22px_7px_rgba(255,106,0,0.9)]" />
          </div>

          <p className="mt-6 max-w-[620px] text-lg font-medium leading-7 text-white/92 sm:mt-8 sm:text-2xl sm:leading-8">
            Phoenix is more than a system &mdash;
            <br />
            it&apos;s your partner in performance and growth.
          </p>

          <div className="mt-8 w-full max-w-[560px] space-y-4 text-left sm:mt-9">
            {features.map((feature) => (
              <div className="flex items-center gap-4 sm:gap-5" key={feature.title}>
                <span className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-xl border border-[#ff6a00]/80 bg-black/35 text-[#ff6a00] shadow-[0_0_24px_rgba(255,106,0,0.16)] sm:h-[62px] sm:w-[62px] sm:rounded-2xl">
                  <feature.icon className="h-6 w-6 sm:h-7 sm:w-7" strokeWidth={2.3} />
                </span>
                <div>
                  <h2 className="text-lg font-black text-white sm:text-2xl">{feature.title}</h2>
                  <p className="mt-0.5 text-sm leading-5 text-white/68 sm:mt-1 sm:text-lg sm:leading-6">{feature.description}</p>
                </div>
              </div>
            ))}
          </div>

          <p className="mt-8 w-full max-w-[560px] text-left text-xl font-black text-[#ff7900] sm:mt-9 sm:text-3xl">
            Rise. Learn. Rebuild.
          </p>
        </div>
      </div>
    </aside>
  );
}

function AccessPanel({
  error,
  greeting,
  isSubmitting,
  loginId,
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
  error: string | null;
  greeting: string;
  isSubmitting: boolean;
  loginId: string;
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
  return (
    <section className="relative order-1 flex min-h-[690px] items-center justify-center px-4 py-8 sm:px-8 lg:order-2 lg:px-9 xl:px-14">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(255,106,0,0.08),transparent_34%)]" />
      <form
        action="/api/auth/login"
        className={`relative w-full max-w-[620px] rounded-[36px] border border-white/12 bg-[linear-gradient(145deg,rgba(19,22,27,0.9),rgba(5,6,8,0.98))] px-6 py-8 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_32px_70px_rgba(0,0,0,0.48)] backdrop-blur-xl sm:px-10 sm:py-12 lg:px-12 xl:px-14 ${shakeError ? "login-card-shake" : ""}`}
        method="post"
        onSubmit={onSubmit}
      >
        <div className="text-center">
          <p className="text-4xl font-black uppercase tracking-[0.26em] text-white sm:text-5xl">
            PHOENI<span className="text-[#ff6a00]">X</span>
          </p>
          <div className="mx-auto mt-3 flex max-w-[360px] items-center gap-4">
            <span className="h-px flex-1 bg-gradient-to-r from-transparent to-[#ff6a00]" />
            <p className="text-sm font-black uppercase tracking-[0.24em] text-[#ff7900] sm:text-base">SECURE ACCESS</p>
            <span className="h-px flex-1 bg-gradient-to-l from-transparent to-[#ff6a00]" />
          </div>
          <h2 className="mt-10 text-2xl font-bold text-white sm:text-3xl">Sign in to your account</h2>
          <p className="mt-3 text-lg text-white/52">Enter your credentials to continue</p>
          <p className="mt-2 text-sm font-medium text-[#ff9a2f]/85">{greeting}</p>
        </div>

        <div className="mt-9 space-y-6">
          <label className="block" htmlFor="login-id">
            <span className="mb-3 block text-base font-semibold text-white">HR_ID or Login ID</span>
            <span className="relative block">
              <input
                aria-label="Login ID"
                autoComplete="username"
                className="h-16 w-full rounded-2xl border border-white/14 bg-white/[0.045] px-6 pr-14 text-lg text-white outline-none shadow-[inset_0_1px_18px_rgba(255,255,255,0.035)] transition placeholder:text-white/36 focus:border-[#ff7900] focus:bg-white/[0.065] focus:ring-4 focus:ring-[#ff6a00]/16"
                id="login-id"
                name="loginId"
                onChange={(event) => onLoginIdChange(event.target.value)}
                placeholder="Enter HR_ID or login ID"
                type="text"
                value={loginId}
              />
              <User className="pointer-events-none absolute right-5 top-1/2 h-6 w-6 -translate-y-1/2 text-white/48" />
            </span>
          </label>

          <label className="block" htmlFor="login-password">
            <span className="mb-3 block text-base font-semibold text-white">Password</span>
            <span className="relative block">
              <input
                autoComplete="current-password"
                className="h-16 w-full rounded-2xl border border-white/14 bg-white/[0.045] px-6 pr-14 text-lg text-white outline-none shadow-[inset_0_1px_18px_rgba(255,255,255,0.035)] transition placeholder:text-white/36 focus:border-[#ff7900] focus:bg-white/[0.065] focus:ring-4 focus:ring-[#ff6a00]/16"
                id="login-password"
                name="password"
                onChange={(event) => onPasswordChange(event.target.value)}
                placeholder="Enter your password"
                type={showPassword ? "text" : "password"}
                value={password}
              />
              <button
                aria-label={showPassword ? "Hide" : "Show"}
                className="absolute right-5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center text-white/62 transition hover:text-white"
                type="button"
                onClick={onTogglePassword}
              >
                {showPassword ? <EyeOff className="h-6 w-6" /> : <Eye className="h-6 w-6" />}
              </button>
            </span>
          </label>
        </div>

        <div className="mt-7 flex flex-col gap-4 text-base sm:flex-row sm:items-center sm:justify-between">
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
              className={`flex h-7 w-7 items-center justify-center rounded-lg border bg-white/[0.035] transition peer-focus-visible:ring-4 peer-focus-visible:ring-[#ff6a00]/30 ${
                remember ? "border-[#ff7900] bg-[#ff7900]" : "border-white/22"
              }`}
            >
              {remember ? <span className="h-2.5 w-2.5 rounded-sm bg-white" /> : null}
            </span>
            Remember login ID
          </label>
          <a
            className="font-semibold text-[#ff7900] transition hover:text-[#ff9a2f]"
            href="#"
            onClick={(event) => event.preventDefault()}
          >
            Ask admin for a password link
          </a>
        </div>

        {error && (
          <div
            className="mt-5 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-100"
            role="alert"
          >
            {error}
          </div>
        )}

        <button
          className="mt-7 flex h-16 w-full items-center justify-center gap-3 rounded-[14px] bg-gradient-to-b from-[#ff8a00] to-[#ff4d00] text-xl font-black text-white shadow-[0_14px_38px_rgba(255,106,0,0.34),inset_0_1px_0_rgba(255,255,255,0.3)] transition hover:translate-y-[-1px] hover:shadow-[0_18px_48px_rgba(255,106,0,0.48),inset_0_1px_0_rgba(255,255,255,0.35)] focus:outline-none focus:ring-4 focus:ring-[#ff6a00]/30 disabled:cursor-not-allowed disabled:opacity-70"
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting ? (
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/35 border-t-white" />
          ) : (
            <Lock className="h-6 w-6" />
          )}
          {isSubmitting ? "Signing in..." : "Sign in"}
        </button>

        <p className="mt-10 flex items-center justify-center gap-3 text-center text-base text-white/48">
          <ShieldCheck className="h-5 w-5" />
          Secure. Trusted. Built for performance.
        </p>
      </form>
    </section>
  );
}



