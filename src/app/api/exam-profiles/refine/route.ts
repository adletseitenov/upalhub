import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { createLlm } from "@/lib/llm";
import { examProfileSpecSchema } from "@/features/exam-profile/spec";
import { refineExamSpec } from "@/features/exam-profile/refine";
import type { Json } from "@/lib/supabase/database.types";

export const maxDuration = 60; // refine может идти десятки секунд

const bodySchema = z.object({
  slug: z.string(),
  sampleText: z.string().min(100).max(50_000),
});

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const { data: row } = await supabase
    .from("exam_profiles")
    .select("*")
    .eq("slug", parsed.data.slug)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const current = examProfileSpecSchema.parse(row.spec);
  const refined = await refineExamSpec({ llm: createLlm() }, current, parsed.data.sampleText);

  const { data: updated, error } = await supabase
    .from("exam_profiles")
    .update({ spec: refined as unknown as Json, origin: "uploaded" })
    .eq("slug", parsed.data.slug)
    .select("id");
  if (error) throw error;
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  return NextResponse.json({ ok: true });
}
