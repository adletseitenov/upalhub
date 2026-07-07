import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { createLlm } from "@/lib/llm";
import { createSearch } from "@/lib/search";
import { findOrCreateExamProfile } from "@/features/exam-profile/service";
import { supabaseExamProfileRepo } from "@/features/exam-profile/repo";
import { ResearchError } from "@/features/exam-profile/research";

export const maxDuration = 60; // research может идти десятки секунд

const bodySchema = z.object({ query: z.string().min(2).max(200) });

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  try {
    const { profile, created } = await findOrCreateExamProfile(
      {
        llm: createLlm(),
        search: createSearch(),
        repo: supabaseExamProfileRepo(supabase, data.user.id),
      },
      parsed.data.query,
    );
    return NextResponse.json({ slug: profile.slug, created });
  } catch (e) {
    if (e instanceof ResearchError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw e;
  }
}
