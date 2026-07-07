import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";

const bodySchema = z.object({ examProfileId: z.uuid() });

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const { data: existing, error: findError } = await supabase
    .from("study_hqs")
    .select("id")
    .eq("user_id", data.user.id)
    .eq("exam_profile_id", parsed.data.examProfileId)
    .maybeSingle();
  if (findError) throw findError;
  if (existing) return NextResponse.json({ id: existing.id, existed: true });

  const { data: created, error } = await supabase
    .from("study_hqs")
    .insert({ user_id: data.user.id, exam_profile_id: parsed.data.examProfileId })
    .select("id")
    .single();
  if (error) throw error;
  return NextResponse.json({ id: created.id, existed: false });
}
