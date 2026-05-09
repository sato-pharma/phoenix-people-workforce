export const SUPPORTED_LOCALES = ["en", "ar"] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = "en";

export const LOCALE_DIRECTION: Record<AppLocale, "ltr" | "rtl"> = {
  en: "ltr",
  ar: "rtl",
};

const SUPPORTED_LOCALE_SET = new Set<string>(SUPPORTED_LOCALES);

export function resolveLocale(input?: string | null): AppLocale {
  if (!input) {
    return DEFAULT_LOCALE;
  }

  const normalized = input.trim().toLowerCase().split("-")[0];

  if (SUPPORTED_LOCALE_SET.has(normalized)) {
    return normalized as AppLocale;
  }

  return DEFAULT_LOCALE;
}

export function localeDirection(locale: AppLocale): "ltr" | "rtl" {
  return LOCALE_DIRECTION[locale];
}

export function defaultIntlLocale(locale: AppLocale): string {
  return locale === "ar" ? "ar-EG" : "en-EG";
}
