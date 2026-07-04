import { redirect } from "next/navigation";
import { supabaseEnv } from "@/lib/supabase/env";
import { supabaseServer } from "@/lib/supabase/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!supabaseEnv()) redirect("/sign-in"); // Supabase ещё не сконфигурирован
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/sign-in");
  return <>{children}</>;
}
