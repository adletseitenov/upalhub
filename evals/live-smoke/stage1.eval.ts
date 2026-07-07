import { describe, expect, it, beforeAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createLlm } from "@/lib/llm";
import { createSearch } from "@/lib/search";
import { findOrCreateExamProfile } from "@/features/exam-profile/service";
import { supabaseExamProfileRepo } from "@/features/exam-profile/repo";

// Live smoke этапа 1: МУТИРУЕТ живую БД (создаёт smoke-пользователя, профиль ЕНТ, hq).
// Требует .env.local: SUPABASE_* + OPENROUTER + TAVILY. Не входит в CI/npm test.

const EMAIL = "smoke@upal.test";
const PASSWORD = "upal-smoke-Passw0rd!";

beforeAll(() => {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // ключи должны быть в окружении
  }
});

describe("stage 1 live smoke (mutates live DB)", () => {
  it("full pipeline: admin user -> sign in -> research + dedup -> study hq under RLS", async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const secret = process.env.SUPABASE_SECRET_KEY;
    if (!url || !anon || !secret) throw new Error("нет SUPABASE env — smoke невозможен");

    const admin = createClient<Database>(url, secret, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
    }); // при повторном прогоне пользователь уже есть — ошибку игнорируем

    const user = createClient<Database>(url, anon, { auth: { persistSession: false } });
    const signIn = await user.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    expect(signIn.error).toBeNull();
    const uid = signIn.data.user!.id;

    const deps = {
      llm: createLlm(),
      search: createSearch(),
      repo: supabaseExamProfileRepo(user, uid),
    };
    const first = await findOrCreateExamProfile(deps, "ЕНТ Казахстан");
    expect(first.profile.slug).toBe("ent-kazahstan");
    expect(first.profile.spec.sections.length).toBeGreaterThan(0);

    // Дедуп: второй вызов другим регистром НЕ должен звать LLM
    const second = await findOrCreateExamProfile(
      {
        llm: {
          complete: async () => {
            throw new Error("LLM must not be called on dedup");
          },
        },
        search: deps.search,
        repo: deps.repo,
      },
      "ент казахстан",
    );
    expect(second.created).toBe(false);
    expect(second.profile.id).toBe(first.profile.id);

    // Штаб под RLS (23505 допустим после применения unique-индекса при повторных прогонах)
    const ins = await user
      .from("study_hqs")
      .insert({ user_id: uid, exam_profile_id: first.profile.id })
      .select("id")
      .single();
    if (ins.error && ins.error.code !== "23505") {
      throw new Error(`study_hqs insert failed: ${ins.error.code} ${ins.error.message}`);
    }
    console.log("smoke ok:", {
      profileId: first.profile.id,
      createdFirstRun: first.created,
      hqInsert: ins.error ? "duplicate (unique index активен)" : ins.data?.id,
    });
  }, 180_000);
});
