import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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

// Stage3 СРОЧНО: мостик до добавления SUPABASE_SECRET_KEY в Vercel. Прод уже
// вызывает supabaseAdmin() на путях чтения банка (submit/tests/refill/
// import/explain/tests-page), а ключ в Vercel ещё не добавлен -> эти пути
// 500-ят. Пока миграция 20260709130000 (колонко-гранты tasks.answer/
// explanation) НЕ применена к живой БД, роль authenticated ещё видит эти
// колонки — user-клиент как фолбэк безопасен ровно в этом текущем состоянии
// БД. После применения 130000 фолбэк перестанет читать answer -> грейдинг
// сломается, поэтому 130000 применять ТОЛЬКО после появления ключа в env.
export function taskReadClient(userClient: SupabaseClient<Database>): SupabaseClient<Database> {
  const env = supabaseEnv();
  if (env?.secretKey) return supabaseAdmin();
  console.warn(
    "SUPABASE_SECRET_KEY missing - falling back to user client for task reads; REQUIRED before applying migration 20260709130000",
  );
  return userClient;
}
