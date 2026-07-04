import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseEnv } from "./env";

export async function supabaseServer() {
  const env = supabaseEnv();
  if (!env) throw new Error("Supabase env is not configured");
  const cookieStore = await cookies();
  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (all) => {
        try {
          all.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // вызвано из Server Component — сессию обновит middleware
        }
      },
    },
  });
}
