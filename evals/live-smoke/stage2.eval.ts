import { describe, expect, it, beforeAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createLlm, type Llm } from "@/lib/llm";
import { supabaseTaskRepo } from "@/features/tasks/repo";
import { supabaseTestRepo } from "@/features/tests/repo";
import { assembleTest } from "@/features/tests/assemble";
import { supabaseAttemptRepo } from "@/features/attempts/repo";
import { startAttempt, saveAnswers, submitAttempt } from "@/features/attempts/service";
import { supabaseExamProfileRepo } from "@/features/exam-profile/repo";

// Live smoke этапа 2: МУТИРУЕТ живую БД и тратит до 3 LLM-вызовов (первый прогон).
// Полный цикл: сборка diagnostic (холодная/тёплая) → попытка → автосейв → сабмит.

const EMAIL = "smoke@upal.test";
const PASSWORD = "upal-smoke-Passw0rd!";

beforeAll(() => {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // ключи должны быть в окружении
  }
});

function countedLlm(llm: Llm): { llm: Llm; calls: () => number } {
  let n = 0;
  return {
    llm: {
      complete: (args) => {
        n += 1;
        return llm.complete(args);
      },
    },
    calls: () => n,
  };
}

describe("stage 2 live smoke (mutates live DB, spends up to 3 LLM calls once)", () => {
  it("cold assemble <=3 calls -> attempt -> save -> submit -> warm assemble = 0 calls", async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) throw new Error("нет SUPABASE env");

    const user = createClient<Database>(url, anon, { auth: { persistSession: false } });
    const signIn = await user.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    expect(signIn.error).toBeNull();
    const uid = signIn.data.user!.id;

    const profile = await supabaseExamProfileRepo(user, uid).findBySlug("ent-kazahstan");
    if (!profile) throw new Error("профиль ent-kazahstan не найден — прогоните stage1 smoke");

    const { data: hq } = await user
      .from("study_hqs")
      .select("id")
      .eq("user_id", uid)
      .eq("exam_profile_id", profile.id)
      .limit(1)
      .maybeSingle();
    if (!hq) throw new Error("hq не найден — прогоните stage1 smoke");

    const taskRepo = supabaseTaskRepo(user);
    const testRepo = supabaseTestRepo(user);

    // Сборка №1 (банк может быть холодным или уже тёплым от прошлых прогонов)
    const c1 = countedLlm(createLlm());
    const test1 = await assembleTest(
      { taskRepo, testRepo, llm: c1.llm },
      { hqId: hq.id, examProfile: profile, kind: "diagnostic" },
    );
    console.log("assemble#1:", {
      testId: test1.id,
      tasks: test1.spec.taskIds.length,
      llmCalls: c1.calls(),
    });
    expect(c1.calls()).toBeLessThanOrEqual(3);
    expect(test1.spec.taskIds.length).toBeGreaterThan(0);
    expect(test1.spec.taskIds.length).toBeLessThanOrEqual(12);

    // Попытка: старт (идемпотентность: второй старт = та же)
    const attemptRepo = supabaseAttemptRepo(user);
    const s1 = await startAttempt({ repo: attemptRepo }, { test: test1, userId: uid });
    const s2 = await startAttempt({ repo: attemptRepo }, { test: test1, userId: uid });
    expect(s2.attempt.id).toBe(s1.attempt.id);

    // Автосейв: ответим на первое задание чем-то валидным по его формату
    const { data: firstTaskRow } = await user
      .from("tasks")
      .select("id, body")
      .eq("id", test1.spec.taskIds[0])
      .single();
    const body = firstTaskRow!.body as { format: string; options?: Array<{ id: string }> };
    const response =
      body.format === "single_choice"
        ? { format: "single_choice", optionId: body.options![0].id }
        : body.format === "multi_choice"
          ? { format: "multi_choice", optionIds: [body.options![0].id] }
          : { format: "text_input", value: "42" };
    await saveAnswers(
      { repo: attemptRepo },
      {
        attempt: s1.attempt,
        test: test1,
        items: [{ taskId: test1.spec.taskIds[0], response, timeMs: 1234 }],
      },
    );

    // Сабмит + идемпотентность
    const r1 = await submitAttempt(
      { repo: attemptRepo },
      { attemptId: s1.attempt.id, test: test1, tasks: await loadTasks(user, test1.spec.taskIds), userId: uid, now: new Date() },
    );
    const r2 = await submitAttempt(
      { repo: attemptRepo },
      { attemptId: s1.attempt.id, test: test1, tasks: await loadTasks(user, test1.spec.taskIds), userId: uid, now: new Date() },
    );
    expect(r2.alreadyFinished).toBe(true);
    expect(r2.scaled).toBe(r1.scaled);
    console.log("submit:", { raw: r1.raw, scaled: r1.scaled, total: r1.total });

    // Сборка №2 — банк греется дальше (первая могла упереться в кап до
    // заполнения всех бакетов); вызовов не больше капа.
    const c2 = countedLlm(createLlm());
    const test2 = await assembleTest(
      { taskRepo, testRepo, llm: c2.llm },
      { hqId: hq.id, examProfile: profile, kind: "diagnostic" },
    );
    console.log("assemble#2:", { tasks: test2.spec.taskIds.length, llmCalls: c2.calls() });
    expect(c2.calls()).toBeLessThanOrEqual(3);

    // Сборка №3 — если №2 добрала банк до полного плана, это полностью
    // ТЁПЛАЯ сборка: ноль LLM-вызовов (экономика D2).
    const c3 = countedLlm(createLlm());
    const test3 = await assembleTest(
      { taskRepo, testRepo, llm: c3.llm },
      { hqId: hq.id, examProfile: profile, kind: "diagnostic" },
    );
    console.log("assemble#3 (warm):", { tasks: test3.spec.taskIds.length, llmCalls: c3.calls() });
    if (test2.spec.taskIds.length === test3.spec.taskIds.length) {
      expect(c3.calls()).toBe(0);
    } else {
      console.warn("банк ещё догревается — план не заполнен, пропускаю строгий 0-ассерт");
      expect(c3.calls()).toBeLessThanOrEqual(3);
    }
  }, 300_000);
});

async function loadTasks(
  user: ReturnType<typeof createClient<Database>>,
  ids: string[],
) {
  const { data } = await user.from("tasks").select("*").in("id", ids);
  const { examProfileSpecSchema } = await import("@/features/exam-profile/spec");
  void examProfileSpecSchema;
  const { taskBodySchema, taskAnswerSchema } = await import("@/features/tasks/schema");
  return (data ?? []).map((row) => ({
    id: row.id,
    type: row.type,
    topic: row.topic,
    difficulty: row.difficulty,
    language: row.language,
    body: taskBodySchema.parse(row.body),
    answer: taskAnswerSchema.parse(row.answer),
    explanation: row.explanation ?? "",
  }));
}
