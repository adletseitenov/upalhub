export function supabaseEnv(): { url: string; anonKey: string; secretKey?: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  // secretKey (service-role) — опциональна здесь: её обязательность проверяет
  // supabaseAdmin() (src/lib/supabase/admin.ts), а не общий env-геттер,
  // которым пользуются anon-клиенты (server.ts/browser.ts).
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  return secretKey ? { url, anonKey, secretKey } : { url, anonKey };
}
