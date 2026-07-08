import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { createLlm } from "@/lib/llm";
import { createSearch } from "@/lib/search";
import {
  findOrCreateExamProfile,
  ExamProfileSlugConflictError,
  type StoredExamProfile,
} from "@/features/exam-profile/service";
import { supabaseExamProfileRepo } from "@/features/exam-profile/repo";
import { ResearchError } from "@/features/exam-profile/research";
import { researchLimiter } from "@/features/exam-profile/research-limiter";
import { slugifyExamQuery, ensureRerollSlug } from "@/features/exam-profile/slug";

export const maxDuration = 60; // research может идти десятки секунд

// D3/Task5: reroll («Не тот экзамен») расширяет body аддитивно —
// {query} по-прежнему валиден. excludeSlug задаёт отвергнутый профиль;
// clarification — необязательное уточнение пользователя.
const bodySchema = z.object({
  query: z.string().min(2).max(200),
  excludeSlug: z.string().min(1).optional(),
  clarification: z.string().min(3).max(200).optional(),
});

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // 🔴 D3: лимитер ДО любого спенда (research И reroll делят один бюджет —
  // см. jsdoc в research-limiter.ts).
  if (!researchLimiter.take(data.user.id)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const { query, excludeSlug, clarification } = parsed.data;

  const repo = supabaseExamProfileRepo(supabase, data.user.id);
  const deps = { llm: createLlm(), search: createSearch(), repo };

  try {
    let result: { profile: StoredExamProfile; created: boolean };
    let rejectedProfile: StoredExamProfile | null = null;

    if (excludeSlug) {
      rejectedProfile = await repo.findBySlug(excludeSlug);
    }

    if (rejectedProfile) {
      // Reroll-путь: избегаем переисследовать отвергнутый экзамен (avoid),
      // уточняем запрос кларификацией и гарантируем НОВЫЙ слаг (slug-guard).
      const avoid = {
        name: rejectedProfile.title,
        country: rejectedProfile.spec.country ?? null,
      };
      const refinedQuery = `${query} ${clarification ?? ""}`.trim();
      const newSlug = ensureRerollSlug(
        slugifyExamQuery(refinedQuery),
        excludeSlug as string,
        clarification ?? query,
      );

      result = await findOrCreateExamProfile(deps, refinedQuery, {
        slugOverride: newSlug,
        avoid,
      });

      // Best-effort: репорт фиксируется для аналитики/дедупа «не тот
      // экзамен», но его провал (в т.ч. RLS — таблица без update-политики,
      // см. миграцию 20260708120100) НЕ должен ронять успешный ответ роута.
      // First-report-wins: ignoreDuplicates=true → ON CONFLICT DO NOTHING.
      try {
        const { error: reportError } = await supabase.from("exam_profile_reports").upsert(
          {
            reported_profile_id: rejectedProfile.id,
            user_id: data.user.id,
            clarification: clarification ?? null,
            new_slug: result.profile.slug,
          },
          { onConflict: "reported_profile_id,user_id", ignoreDuplicates: true },
        );
        if (reportError) {
          console.warn("exam_profile_reports upsert failed:", reportError);
        }
      } catch (reportError) {
        console.warn("exam_profile_reports upsert threw:", reportError);
      }
    } else {
      // excludeSlug отсутствует, либо отвергнутый профиль не найден —
      // обычный research-путь (reroll-контекст молча игнорируется).
      result = await findOrCreateExamProfile(deps, query);
    }

    return NextResponse.json({ slug: result.profile.slug, created: result.created });
  } catch (e) {
    if (e instanceof ResearchError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    // D-important4: slug occupied by a corrupt/unparseable row — handled
    // degraded response, not a raw 500 (and no research spend was made).
    if (e instanceof ExamProfileSlugConflictError) {
      return NextResponse.json({ error: "slug_conflict" }, { status: 409 });
    }
    throw e;
  }
}
