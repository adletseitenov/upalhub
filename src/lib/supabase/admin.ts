import { createClient } from "@supabase/supabase-js";
import { supabaseEnv } from "./env";
import type { Database } from "./database.types";

// Service-role клиент. ОБХОДИТ RLS. Использовать ТОЛЬКО в серверных путях
// ПОСЛЕ явной проверки ownership, только для колонок, недоступных роли
// authenticated (tasks.answer/explanation). НИКОГДА не импортировать в
// клиентские компоненты.
export function supabaseAdmin() {
  const env = supabaseEnv();
  if (!env) throw new Error("Supabase env is not configured");
  if (!env.secretKey) throw new Error("SUPABASE_SECRET_KEY is not configured");
  return createClient<Database>(env.url, env.secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
