import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import type { Database, Json } from "@/lib/supabase/database.types";
import { examProfileSpecSchema } from "@/features/exam-profile/spec";
import { parseHqConfig, resolveActiveSections } from "@/features/exam-profile/selection";
import { recomputeHqInsights, supabaseHqReader } from "@/features/hq/recompute";
import { supabaseKnowledgeRepo } from "@/features/knowledge/repo";
import { supabasePlanRepo } from "@/features/plan/repo";
import { supabaseForecastRepo } from "@/features/forecast/repo";
import { createLlm } from "@/lib/llm";
import { locales, defaultLocale, type Locale } from "@/i18n/locales";
import {
  APPROACH_LEVELS,
  EXPLANATION_STYLES,
  HOURS_PER_WEEK,
  deriveApproachFromButtons,
  mergeApproach,
  parseApproach,
  type InterviewButtons,
} from "@/features/interview/approach";
import { analyzeOpenAnswers } from "@/features/interview/analyze";
import { interviewLimiter } from "@/features/interview/interview-limiter";

// D1 (Stage 5, Task 2): интервью-роут — многошаговый (auth+ownership+
// лимитер+spec-load+валидация+derive+опц. LLM-вызов+UPDATE+recompute), тот
// же maxDuration=60, что и у /api/study-hqs и /api/attempts/.../explain.
export const maxDuration = 60;

const buttonsSchema = z.object({
  level: z.enum(APPROACH_LEVELS),
  hoursPerWeek: z.enum(HOURS_PER_WEEK),
  weakSections: z.array(z.string()),
  explanationStyle: z.enum(EXPLANATION_STYLES),
});

const openAnswersSchema = z.object({
  concern: z.string().max(2_000).optional(),
  motivation: z.string().max(2_000).optional(),
});

const bodySchema = z.object({
  hqId: z.uuid(),
  buttons: buttonsSchema,
  openAnswers: openAnswersSchema.optional(),
});

// Тот же fallback, что и /api/attempts/.../explain/route.ts — route handlers
// не проходят через getRequestConfig, поэтому cookie читается напрямую.
async function resolveLocale(): Promise<Locale> {
  const store = await cookies();
  const fromCookie = store.get("NEXT_LOCALE")?.value;
  return locales.includes(fromCookie as Locale) ? (fromCookie as Locale) : defaultLocale;
}

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const { hqId, buttons, openAnswers } = parsed.data;

  // Ownership: строка hq не существует ИЛИ принадлежит другому юзеру ->
  // единый 404 (не 403 — не подтверждаем существование чужого штаба).
  const { data: hqRow, error: hqError } = await supabase
    .from("study_hqs")
    .select("user_id, exam_profile_id, config, approach")
    .eq("id", hqId)
    .maybeSingle();
  if (hqError) throw hqError;
  if (!hqRow || hqRow.user_id !== data.user.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // 🔴 Лимитер строго ПОСЛЕ ownership, ДО любого дальнейшего чтения/LLM-
  // спенда (тот же порядок, что и explain/study-hqs роуты).
  if (!interviewLimiter.take(data.user.id)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const { data: profileRow, error: profileError } = await supabase
    .from("exam_profiles")
    .select("spec")
    .eq("id", hqRow.exam_profile_id)
    .maybeSingle();
  if (profileError) throw profileError;
  const specParsed = profileRow ? examProfileSpecSchema.safeParse(profileRow.spec) : null;
  if (!profileRow || !specParsed || !specParsed.success) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const spec = specParsed.data;

  // 🔴 D1 Important-фикс: weakSections должны быть подмножеством РЕЗОЛВНУТЫХ
  // активных секций (variant+selectionGroups применены), НЕ просто
  // spec.sections целиком — иначе секции отменённого варианта/невыбранной
  // группы прошли бы валидацию.
  const config = parseHqConfig(hqRow.config);
  const activeSectionNames = new Set(resolveActiveSections(spec, config).map((s) => s.name));
  const hasInvalidWeakSection = buttons.weakSections.some((name) => !activeSectionNames.has(name));
  if (hasInvalidWeakSection) {
    return NextResponse.json({ error: "invalid_weak_sections" }, { status: 400 });
  }

  const derived = deriveApproachFromButtons(buttons as InterviewButtons);

  const locale = await resolveLocale();
  const interviewLocale = locale === "kk" ? "kk" : "ru";

  // 🔴 D1 Acceptance: падение analyze НЕ блокирует запись approach — тот же
  // best-effort дух, что и recompute ниже, но с иным следствием: analyze-поля
  // просто не патчатся в этом вызове (mergeApproach(..., null) сохраняет их
  // из existing), а не проваливает весь ответ 5xx.
  let analyzed: Awaited<ReturnType<typeof analyzeOpenAnswers>> = null;
  try {
    analyzed = await analyzeOpenAnswers(
      { llm: createLlm() },
      {
        locale: interviewLocale,
        sections: Array.from(activeSectionNames),
        buttons: buttons as InterviewButtons,
        openAnswers: openAnswers ?? {},
      },
    );
  } catch (e) {
    console.warn(`interview: analyze failed for hq=${hqId}`, e);
    analyzed = null;
  }

  const existing = parseApproach(hqRow.approach);
  const merged = mergeApproach(existing, derived, analyzed);

  const updatePayload: Database["public"]["Tables"]["study_hqs"]["Update"] = {
    approach: merged as unknown as Json,
  };
  const { error: updateError } = await supabase.from("study_hqs").update(updatePayload).eq("id", hqId);
  if (updateError) throw updateError;

  // Best-effort: тот же паттерн try/catch, что и /api/study-hqs — сбой
  // пересчёта НЕ должен ронять уже успешно записанный approach.
  try {
    await recomputeHqInsights(
      {
        hqReader: supabaseHqReader(supabase),
        knowledgeRepo: supabaseKnowledgeRepo(supabase),
        planRepo: supabasePlanRepo(supabase),
        forecastRepo: supabaseForecastRepo(supabase),
      },
      { hqId, now: new Date() },
    );
  } catch (err) {
    console.warn(`interview: recompute failed for hq=${hqId}`, err);
  }

  return NextResponse.json({ approach: merged });
}
