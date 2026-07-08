import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import type { Database, Json } from "@/lib/supabase/database.types";
import { examProfileSpecSchema } from "@/features/exam-profile/spec";
import { hqConfigSchema, validateHqConfig, type HqConfig } from "@/features/exam-profile/selection";
import { recomputeHqInsights, supabaseHqReader } from "@/features/hq/recompute";
import { supabaseKnowledgeRepo } from "@/features/knowledge/repo";
import { supabasePlanRepo } from "@/features/plan/repo";
import { supabaseForecastRepo } from "@/features/forecast/repo";

// D7 🔴: смена config/exam_date (и будущего target, T8) регенит план/прогноз
// — оркестратор многошаговый (карта+план), тот же maxDuration=60, что и у
// submit-хука/ручного recompute-роута.
export const maxDuration = 60;

// D1/Task5: расширение финала онбординг-визарда. Старый body {examProfileId}
// остаётся валидным (config/examDate — optional, отсутствие обеих не меняет
// поведение относительно версии до Task5).
const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
// D6 (Task 8): target — free-text goal score typed on the onboarding wizard's
// goal step, stored as-is (study_hqs.target is text, not validated against
// the exam profile's scoring scale — a stale target from a profile swap
// still parses as a number; range-checking happens read-time in
// parseTargetNumber/computeGoalGap, D2/T6). Only the *shape* (finite decimal
// string) is enforced here — garbage ("abc", "") -> 400.
const targetStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/, "expected a numeric string");
const bodySchema = z.object({
  examProfileId: z.uuid(),
  config: z.unknown().optional(),
  examDate: dateStringSchema.nullable().optional(),
  target: targetStringSchema.optional(),
});

// D1 🔴: config, если передан, проверяется на форму (Array.isArray-гард, как
// в T4 /api/tests) и на целостность через hqConfigSchema — провал любого из
// двух шагов -> вызывающий роут отвечает 400 (в отличие от defensive-чтения
// существующих hq в T4, где непарсибельный config молча деградирует в
// legacy null; здесь это НОВЫЙ ввод пользователя, его нужно отвергнуть, а не
// молча проигнорировать).
function parseConfigField(raw: unknown): { ok: true; value: HqConfig } | { ok: false } {
  if (raw === undefined || raw === null || Array.isArray(raw)) return { ok: false };
  const parsed = hqConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false };
  return { ok: true, value: parsed.data };
}

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rawBody = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const rawObject =
    rawBody !== null && typeof rawBody === "object" ? (rawBody as Record<string, unknown>) : {};

  // config считается "переданным", только если ключ реально присутствует в
  // теле запроса (а не просто отсутствует/undefined после zod-парса) —
  // сообразно тому, как ниже проверяется присутствие examDate.
  let config: HqConfig | undefined;
  if ("config" in rawObject && rawObject.config !== undefined) {
    const configResult = parseConfigField(rawObject.config);
    if (!configResult.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    config = configResult.value;
  }

  // 🔴 Частичный patch: examDate трогаем ТОЛЬКО если ключ присутствует в
  // body — отсутствие поля (шаг даты пропущен в визарде) не должно обнулять
  // уже сохранённую дату существующего hq.
  const hasExamDateField = "examDate" in rawObject;
  const examDate: string | null | undefined = hasExamDateField
    ? (parsed.data.examDate ?? null)
    : undefined;

  // D6 (Task 8) 🔴 partial-patch, exact same pattern as examDate above:
  // target trotters ONLY if the key is present in the body — the goal step
  // being skipped (no key at all) must not clear an already-saved target.
  // Unlike examDate, target has no "clear" story here (bodySchema rejects
  // null/garbage) — the goal step's own "Пропустить" simply omits the key.
  const hasTargetField = "target" in rawObject;
  const target: string | undefined = hasTargetField ? parsed.data.target : undefined;

  // Если пришёл config — валидируем его против спеки профиля ДО записи
  // (422 invalid_config, а не тихое сохранение несовместимого выбора).
  if (config !== undefined) {
    const { data: profileRow, error: profileError } = await supabase
      .from("exam_profiles")
      .select("spec")
      .eq("id", parsed.data.examProfileId)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profileRow) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const spec = examProfileSpecSchema.parse(profileRow.spec);
    const validation = validateHqConfig(spec, config);
    if (!validation.ok) {
      return NextResponse.json({ error: "invalid_config" }, { status: 422 });
    }
  }

  const { data: existing, error: findError } = await supabase
    .from("study_hqs")
    .select("id")
    .eq("user_id", data.user.id)
    .eq("exam_profile_id", parsed.data.examProfileId)
    .maybeSingle();
  if (findError) throw findError;

  if (existing) {
    const updatePayload: Database["public"]["Tables"]["study_hqs"]["Update"] = {};
    if (config !== undefined) updatePayload.config = config as unknown as Json;
    if (hasExamDateField) updatePayload.exam_date = examDate;
    if (hasTargetField && target !== undefined) updatePayload.target = target;

    if (Object.keys(updatePayload).length > 0) {
      const { error: updateError } = await supabase
        .from("study_hqs")
        .update(updatePayload)
        .eq("id", existing.id);
      if (updateError) throw updateError;

      // 🔴 D7: смена config/exam_date (и, с T8, target) регенит план/прогноз
      // — best-effort, сбой пересчёта НЕ должен ронять уже успешный UPDATE
      // ответа клиенту (тот же паттерн try/catch, что и submit-хук).
      try {
        await recomputeHqInsights(
          {
            hqReader: supabaseHqReader(supabase),
            knowledgeRepo: supabaseKnowledgeRepo(supabase),
            planRepo: supabasePlanRepo(supabase),
            forecastRepo: supabaseForecastRepo(supabase),
          },
          { hqId: existing.id, now: new Date() },
        );
      } catch (err) {
        console.warn(`study-hqs: recompute failed for hq=${existing.id}`, err);
      }
    }
    return NextResponse.json({ id: existing.id, existed: true });
  }

  const insertPayload: Database["public"]["Tables"]["study_hqs"]["Insert"] = {
    user_id: data.user.id,
    exam_profile_id: parsed.data.examProfileId,
  };
  if (config !== undefined) insertPayload.config = config as unknown as Json;
  if (hasExamDateField) insertPayload.exam_date = examDate;
  if (hasTargetField && target !== undefined) insertPayload.target = target;

  const { data: created, error } = await supabase
    .from("study_hqs")
    .insert(insertPayload)
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") {
      const { data: raced, error: racedError } = await supabase
        .from("study_hqs")
        .select("id")
        .eq("user_id", data.user.id)
        .eq("exam_profile_id", parsed.data.examProfileId)
        .maybeSingle();
      if (racedError) throw racedError;
      if (raced) return NextResponse.json({ id: raced.id, existed: true });
    }
    throw error;
  }
  return NextResponse.json({ id: created.id, existed: false });
}
