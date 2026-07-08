import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { createLlm } from "@/lib/llm";
import { examProfileSpecSchema } from "@/features/exam-profile/spec";
import { refineExamSpec } from "@/features/exam-profile/refine";
import { researchLimiter } from "@/features/exam-profile/research-limiter";
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

  // 🔴 final-review Fix2: refine — тот же LLM-спенд-путь, что и research/
  // reroll (POST /api/exam-profiles), но раньше не был закрыт лимитером.
  // Делит один бюджет с ними (см. jsdoc в research-limiter.ts) — ДО любой
  // загрузки/LLM.
  if (!researchLimiter.take(data.user.id)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const { data: row } = await supabase
    .from("exam_profiles")
    .select("*")
    .eq("slug", parsed.data.slug)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.created_by !== data.user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Backlog wave fix4: .parse() throws on a stale/corrupted spec (manual DB
  // edit, upstream regression) -> unhandled exception -> 500, after the
  // limiter token for this call was already burned. safeParse degrades to a
  // clean 422 instead (same convention as "invalid_config"/"reconfigure_needed"
  // elsewhere in this API surface — see study-hqs/route.ts, tests/route.ts).
  const currentParsed = examProfileSpecSchema.safeParse(row.spec);
  if (!currentParsed.success) {
    return NextResponse.json({ error: "profile_spec_invalid" }, { status: 422 });
  }
  const refined = await refineExamSpec({ llm: createLlm() }, currentParsed.data, parsed.data.sampleText);

  const { data: updated, error } = await supabase
    .from("exam_profiles")
    .update({ spec: refined as unknown as Json, origin: "uploaded" })
    .eq("slug", parsed.data.slug)
    .eq("created_by", data.user.id)
    .select("id");
  if (error) throw error;
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  return NextResponse.json({ ok: true });
}
