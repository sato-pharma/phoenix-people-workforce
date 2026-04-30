import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | null = null;
const supabaseRequestTimeoutMs = 8000;

function getRequiredEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

export function getSupabaseAdmin() {
  if (cachedClient) {
    return cachedClient;
  }

  cachedClient = createClient(
    getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        fetch: async (input, init) => {
          const controller = new AbortController();
          const timeout = setTimeout(
            () => controller.abort(),
            supabaseRequestTimeoutMs,
          );

          try {
            return await fetch(input, {
              ...init,
              signal: controller.signal,
            });
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
              throw new Error("Supabase request timed out.");
            }

            throw error;
          } finally {
            clearTimeout(timeout);
          }
        },
      },
    },
  );

  return cachedClient;
}
