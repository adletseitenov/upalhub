import { describe, expect, it, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

// Заглушка supabase-окружения: схема auth, auth.uid() и роли anon/authenticated,
// которых нет в чистом Postgres, но которые Supabase создаёт на платформе.
//
// D-security1/D-security6: auth.uid() читает сессионный GUC
// request.jwt.claim.sub (пусто по умолчанию -> null, как и раньше — старое
// поведение не меняется, пока тест явно не вызовет `set request.jwt.claim.sub`),
// а default privileges на public-схеме мимикрируют реальную платформу
// Supabase (`grant all on tables to anon, authenticated` заранее для всех
// таблиц, создаваемых миграциями) — БЕЗ этого локальный тестовый Postgres не
// воспроизводит уязвимость "RLS using(true) + platform-default grant", и
// column-level/policy-level фиксы (см. новые миграции) нечем было бы
// поведенчески проверить.
const SUPABASE_STUB = `
  create role anon;
  create role authenticated;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text
  );
  create function auth.uid() returns uuid
  language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
`;

// Переключает текущую Postgres-сессию на роль anon/authenticated с заданным
// auth.uid() — эмулирует прямой PostgREST-запрос анон/JWT-ключом. reset role
// — session-level (не set local), так что действует до явного вызова asRole
// заново/reset; тесты вызывают его в try/finally.
async function asRole(
  db: PGlite,
  role: "anon" | "authenticated",
  userId: string | null,
): Promise<void> {
  await db.exec(`set role ${role}`);
  await db.exec(`set request.jwt.claim.sub = '${userId ?? ""}'`);
}

async function resetRole(db: PGlite): Promise<void> {
  await db.exec(`reset role`);
  await db.exec(`reset request.jwt.claim.sub`);
}

const EXPECTED_TABLES = [
  "profiles",
  "families",
  "family_members",
  "exam_profiles",
  "hubs",
  "hub_stars",
  "tasks",
  "study_hqs",
  "exam_profile_reports",
  "tests",
  "attempts",
  "attempt_items",
  "knowledge_states",
  "study_plan_weeks",
  "forecasts",
  "subscriptions",
  "parent_reports",
  // Stage 5 Task 1 (D7):
  "topic_explanations",
];

describe("supabase migrations", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(SUPABASE_STUB);
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  }, 60_000);

  it("creates all core tables", async () => {
    const res = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const names = res.rows.map((r) => r.table_name).sort();
    expect(names).toEqual([...EXPECTED_TABLES].sort());
  });

  it("enables RLS on every core table", async () => {
    const res = await db.query<{ relname: string }>(
      `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity`,
    );
    const withRls = res.rows.map((r) => r.relname).sort();
    expect(withRls).toEqual([...EXPECTED_TABLES].sort());
  });

  it("creates a profile row via trigger when a user registers", async () => {
    await db.exec(
      "insert into auth.users (id, email) values (gen_random_uuid(), 'student@example.com')",
    );
    const res = await db.query<{ count: string }>(
      "select count(*)::text as count from profiles",
    );
    expect(res.rows[0].count).toBe("1");
  });

  it("creates the stage2 task-bank indexes", async () => {
    const res = await db.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public'`,
    );
    const names = res.rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "tasks_profile_hash_unique",
        "tasks_bucket_idx",
        "attempts_one_open_per_test",
        "attempt_items_task_idx",
      ]),
    );
  });

  it("tightens tasks insert RLS to profile-creator and ai-insert-by-hq-owner policies", async () => {
    const res = await db.query<{ polname: string }>(
      `select p.polname from pg_policy p
       join pg_class c on c.oid = p.polrelid
       where c.relname = 'tasks' and p.polcmd = 'a'`,
    );
    const names = res.rows.map((r) => r.polname).sort();
    // D-security6: "tasks ai insert by any authenticated" (bare origin='ai'
    // check, no ownership relation) was replaced by "tasks ai insert by hq
    // owner" — see the poisoning test below for the behavioral pin.
    expect(names).toEqual(
      ["tasks insert by profile creator", "tasks ai insert by hq owner"].sort(),
    );
  });

  it("rejects a second task with the same (exam_profile_id, content_hash)", async () => {
    const profile = await db.query<{ id: string }>(
      `insert into public.exam_profiles (slug, title, language, spec, origin)
       values ('stage2-dup-hash-test', 'Stage2 Dup Hash Test', 'ru', '{}'::jsonb, 'manual')
       returning id`,
    );
    const profileId = profile.rows[0].id;

    await db.exec(`
      insert into public.tasks
        (exam_profile_id, type, topic, difficulty, language, body, answer, explanation, origin, content_hash)
      values
        ('${profileId}', 'reading', 'topic-a', 1, 'ru', '{}'::jsonb, '{}'::jsonb, null, 'ai', 'dup-hash-value')
    `);

    await expect(
      db.exec(`
        insert into public.tasks
          (exam_profile_id, type, topic, difficulty, language, body, answer, explanation, origin, content_hash)
        values
          ('${profileId}', 'reading', 'topic-a', 1, 'ru', '{}'::jsonb, '{}'::jsonb, null, 'ai', 'dup-hash-value')
      `),
    ).rejects.toThrow();
  });

  // --- Stage 2.5 Task 5 -----------------------------------------------------

  async function insertUser(email: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), '${email}') returning id`,
    );
    return res.rows[0].id;
  }

  async function insertProfile(slug: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into public.exam_profiles (slug, title, language, spec, origin)
       values ('${slug}', 'Stage25 T5 Test', 'ru', '{}'::jsonb, 'manual')
       returning id`,
    );
    return res.rows[0].id;
  }

  it("study_hqs.config defaults to '{}' and rejects non-object jsonb", async () => {
    const userId = await insertUser("s25t5-config@example.com");
    const profileId = await insertProfile("s25t5-config-test");

    const hq = await db.query<{ config: unknown }>(
      `insert into public.study_hqs (user_id, exam_profile_id) values ('${userId}', '${profileId}') returning config`,
    );
    expect(hq.rows[0].config).toEqual({});

    await expect(
      db.exec(
        `insert into public.study_hqs (user_id, exam_profile_id, config) values ('${userId}', '${profileId}', '[]'::jsonb)`,
      ),
    ).rejects.toThrow();
  });

  it("exam_profile_reports enforces unique(reported_profile_id, user_id)", async () => {
    const userId = await insertUser("s25t5-report@example.com");
    const profileId = await insertProfile("s25t5-report-test");

    await db.exec(`
      insert into public.exam_profile_reports (reported_profile_id, user_id, clarification, new_slug)
      values ('${profileId}', '${userId}', 'не тот экзамен', 'other-exam')
    `);

    await expect(
      db.exec(`
        insert into public.exam_profile_reports (reported_profile_id, user_id, clarification, new_slug)
        values ('${profileId}', '${userId}', 'снова не тот', 'yet-another-exam')
      `),
    ).rejects.toThrow();
  });

  it("replace_test_spec_if_no_attempts replaces spec atomically only when no attempts exist", async () => {
    const userId = await insertUser("s25t5-rpc@example.com");
    const profileId = await insertProfile("s25t5-rpc-test");
    const hq = await db.query<{ id: string }>(
      `insert into public.study_hqs (user_id, exam_profile_id) values ('${userId}', '${profileId}') returning id`,
    );
    const hqId = hq.rows[0].id;
    const test = await db.query<{ id: string }>(
      `insert into public.tests (hq_id, kind, spec) values ('${hqId}', 'diagnostic', '{"v":0}'::jsonb) returning id`,
    );
    const testId = test.rows[0].id;

    // без попыток -> true, spec заменён
    const noAttemptResult = await db.query<{ replace_test_spec_if_no_attempts: boolean | null }>(
      `select public.replace_test_spec_if_no_attempts('${testId}', '{"v":1}'::jsonb)`,
    );
    expect(noAttemptResult.rows[0].replace_test_spec_if_no_attempts).toBe(true);
    const afterFirst = await db.query<{ spec: unknown }>(
      `select spec from public.tests where id = '${testId}'`,
    );
    expect(afterFirst.rows[0].spec).toEqual({ v: 1 });

    // с попыткой -> false/null, spec НЕ изменён
    await db.exec(
      `insert into public.attempts (test_id, user_id) values ('${testId}', '${userId}')`,
    );
    const withAttemptResult = await db.query<{ replace_test_spec_if_no_attempts: boolean | null }>(
      `select public.replace_test_spec_if_no_attempts('${testId}', '{"v":2}'::jsonb)`,
    );
    expect(withAttemptResult.rows[0].replace_test_spec_if_no_attempts).toBeFalsy();
    const afterSecond = await db.query<{ spec: unknown }>(
      `select spec from public.tests where id = '${testId}'`,
    );
    expect(afterSecond.rows[0].spec).toEqual({ v: 1 });
  });

  // --- Stage 3 Task 1 (D7 фундамент) -----------------------------------------

  it("adds knowledge_states.answered_count/last_seen_at, forecasts.point/coverage, study_hqs.last_recomputed_at", async () => {
    const res = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public'
         and (
           (table_name = 'knowledge_states' and column_name in ('answered_count', 'last_seen_at'))
           or (table_name = 'forecasts' and column_name in ('point', 'coverage'))
           or (table_name = 'study_hqs' and column_name = 'last_recomputed_at')
         )`,
    );
    const pairs = res.rows.map((r) => `${r.table_name}.${r.column_name}`).sort();
    expect(pairs).toEqual(
      [
        "knowledge_states.answered_count",
        "knowledge_states.last_seen_at",
        "forecasts.point",
        "forecasts.coverage",
        "study_hqs.last_recomputed_at",
      ].sort(),
    );
  });

  it("creates the forecasts_hq_created_idx index", async () => {
    const res = await db.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public'`,
    );
    const names = res.rows.map((r) => r.indexname);
    expect(names).toContain("forecasts_hq_created_idx");
  });

  it("rejects a second study_plan_weeks row with the same (hq_id, week_start)", async () => {
    const userId = await insertUser("s3t1-planweek@example.com");
    const profileId = await insertProfile("s3t1-planweek-test");
    const hq = await db.query<{ id: string }>(
      `insert into public.study_hqs (user_id, exam_profile_id) values ('${userId}', '${profileId}') returning id`,
    );
    const hqId = hq.rows[0].id;

    await db.exec(`
      insert into public.study_plan_weeks (hq_id, week_start, topics)
      values ('${hqId}', '2026-07-13', '[]'::jsonb)
    `);

    await expect(
      db.exec(`
        insert into public.study_plan_weeks (hq_id, week_start, topics)
        values ('${hqId}', '2026-07-13', '[]'::jsonb)
      `),
    ).rejects.toThrow();
  });

  // --- Mega-review wave: D-security1 (tasks.answer/explanation leak) --------

  it("D-security1: anon/authenticated cannot SELECT tasks.answer/tasks.explanation, but can read non-answer columns", async () => {
    const profileId = await insertProfile("s1-select-test");
    await db.exec(`
      insert into public.tasks (exam_profile_id, type, topic, difficulty, language, body, answer, explanation, origin)
      values ('${profileId}', 'reading', 'topic-a', 1, 'ru', '{"prompt":"x"}'::jsonb, '{"correct":true}'::jsonb, 'because', 'import')
    `);

    await asRole(db, "anon", null);
    try {
      await expect(db.query(`select answer from public.tasks limit 1`)).rejects.toThrow();
      await expect(db.query(`select explanation from public.tasks limit 1`)).rejects.toThrow();
      const bodyRes = await db.query<{ body: unknown }>(`select id, body from public.tasks limit 1`);
      expect(bodyRes.rows.length).toBe(1);
    } finally {
      await resetRole(db);
    }
  });

  // --- Mega-review wave: D-security6 (tasks ai-insert task-bank poisoning) --

  it("D-security6: rejects an AI-origin task insert into an exam_profile_id the caller owns no study_hq for", async () => {
    const ownerId = await insertUser("s6-owner@example.com");
    const attackerId = await insertUser("s6-attacker@example.com");
    const profileId = await insertProfile("s6-poison-test");
    await db.exec(
      `insert into public.study_hqs (user_id, exam_profile_id) values ('${ownerId}', '${profileId}')`,
    );

    await asRole(db, "authenticated", attackerId);
    try {
      await expect(
        db.exec(`
          insert into public.tasks (exam_profile_id, type, topic, difficulty, language, body, answer, explanation, origin)
          values ('${profileId}', 'reading', 'topic-a', 1, 'ru', '{}'::jsonb, '{"wrong":true}'::jsonb, 'attacker-controlled', 'ai')
        `),
      ).rejects.toThrow();
    } finally {
      await resetRole(db);
    }
  });

  it("D-security6: allows an AI-origin task insert into an exam_profile_id the caller owns a study_hq for", async () => {
    const userId = await insertUser("s6-legit@example.com");
    const profileId = await insertProfile("s6-legit-test");
    await db.exec(
      `insert into public.study_hqs (user_id, exam_profile_id) values ('${userId}', '${profileId}')`,
    );

    await asRole(db, "authenticated", userId);
    try {
      await db.exec(`
        insert into public.tasks (exam_profile_id, type, topic, difficulty, language, body, answer, explanation, origin)
        values ('${profileId}', 'reading', 'topic-a', 1, 'ru', '{}'::jsonb, '{}'::jsonb, null, 'ai')
      `);
      const res = await db.query<{ id: string }>(
        `select id from public.tasks where exam_profile_id = '${profileId}'`,
      );
      expect(res.rows.length).toBe(1);
    } finally {
      await resetRole(db);
    }
  });

  // --- Backlog wave: exam_profiles insert column-level security -----------

  it("backlog wave: rejects an authenticated exam_profiles insert that sets trust='verified' directly", async () => {
    const userId = await insertUser("bw-insert-trust@example.com");

    await asRole(db, "authenticated", userId);
    try {
      await expect(
        db.exec(`
          insert into public.exam_profiles (slug, title, language, spec, origin, created_by, trust)
          values ('bw-trust-verified', 'Trust Verified Test', 'ru', '{}'::jsonb, 'manual', '${userId}', 'verified')
        `),
      ).rejects.toThrow();
    } finally {
      await resetRole(db);
    }
  });

  it("backlog wave: allows an authenticated exam_profiles insert without trust, defaulting to 'ai_draft'", async () => {
    const userId = await insertUser("bw-insert-ok@example.com");

    await asRole(db, "authenticated", userId);
    try {
      await db.exec(`
        insert into public.exam_profiles (slug, title, language, spec, origin, created_by)
        values ('bw-trust-default', 'Trust Default Test', 'ru', '{}'::jsonb, 'manual', '${userId}')
      `);
    } finally {
      await resetRole(db);
    }

    const res = await db.query<{ trust: string }>(
      `select trust from public.exam_profiles where slug = 'bw-trust-default'`,
    );
    expect(res.rows[0].trust).toBe("ai_draft");
  });

  // --- Stage 5 Task 1 (D7 фундамент) -----------------------------------------

  it("adds study_hqs.approach jsonb (defaults null) and rejects a non-object value via the CHECK constraint", async () => {
    const userId = await insertUser("s5t1-approach@example.com");
    const profileId = await insertProfile("s5t1-approach-test");

    const hq = await db.query<{ id: string; approach: unknown }>(
      `insert into public.study_hqs (user_id, exam_profile_id) values ('${userId}', '${profileId}') returning id, approach`,
    );
    expect(hq.rows[0].approach).toBeNull();
    const hqId = hq.rows[0].id;

    await db.exec(
      `update public.study_hqs set approach = '{"level":"средний"}'::jsonb where id = '${hqId}'`,
    );
    const updated = await db.query<{ approach: unknown }>(
      `select approach from public.study_hqs where id = '${hqId}'`,
    );
    expect(updated.rows[0].approach).toEqual({ level: "средний" });

    await expect(
      db.exec(`update public.study_hqs set approach = '[1,2,3]'::jsonb where id = '${hqId}'`),
    ).rejects.toThrow();
  });

  it("creates topic_explanations with the readable/insert-by-hq-owner/delete-by-hq-owner policies", async () => {
    const res = await db.query<{ polname: string; polcmd: string }>(
      `select p.polname, p.polcmd from pg_policy p
       join pg_class c on c.oid = p.polrelid
       where c.relname = 'topic_explanations'`,
    );
    const names = res.rows.map((r) => r.polname).sort();
    expect(names).toEqual(
      [
        "topic explanations readable",
        "topic explanations insert by hq owner",
        "topic explanations delete by hq owner",
      ].sort(),
    );
  });

  it("topic_explanations: hq owner can insert, another authenticated user cannot; anyone can select; only the owner can delete", async () => {
    const ownerId = await insertUser("s5t1-topicex-owner@example.com");
    const strangerId = await insertUser("s5t1-topicex-stranger@example.com");
    const profileId = await insertProfile("s5t1-topicex-test");
    await db.exec(
      `insert into public.study_hqs (user_id, exam_profile_id) values ('${ownerId}', '${profileId}')`,
    );

    await asRole(db, "authenticated", strangerId);
    try {
      await expect(
        db.exec(`
          insert into public.topic_explanations (exam_profile_id, topic, locale, body)
          values ('${profileId}', 'Algebra', 'ru', '{"text":"x"}'::jsonb)
        `),
      ).rejects.toThrow();
    } finally {
      await resetRole(db);
    }

    await asRole(db, "authenticated", ownerId);
    try {
      await db.exec(`
        insert into public.topic_explanations (exam_profile_id, topic, locale, body)
        values ('${profileId}', 'Algebra', 'ru', '{"text":"x"}'::jsonb)
      `);
    } finally {
      await resetRole(db);
    }

    await asRole(db, "anon", null);
    try {
      const readRes = await db.query<{ topic: string }>(
        `select topic from public.topic_explanations where exam_profile_id = '${profileId}'`,
      );
      expect(readRes.rows).toEqual([{ topic: "Algebra" }]);
    } finally {
      await resetRole(db);
    }

    await asRole(db, "authenticated", strangerId);
    try {
      await db.exec(
        `delete from public.topic_explanations where exam_profile_id = '${profileId}' and topic = 'Algebra'`,
      );
      const stillThere = await db.query<{ topic: string }>(
        `select topic from public.topic_explanations where exam_profile_id = '${profileId}'`,
      );
      expect(stillThere.rows).toHaveLength(1); // stranger's DELETE affected 0 rows (RLS filters it out)
    } finally {
      await resetRole(db);
    }

    await asRole(db, "authenticated", ownerId);
    try {
      await db.exec(
        `delete from public.topic_explanations where exam_profile_id = '${profileId}' and topic = 'Algebra'`,
      );
      const gone = await db.query<{ topic: string }>(
        `select topic from public.topic_explanations where exam_profile_id = '${profileId}'`,
      );
      expect(gone.rows).toHaveLength(0);
    } finally {
      await resetRole(db);
    }
  });

  it("topic_explanations rejects a non-object body via the CHECK constraint", async () => {
    const userId = await insertUser("s5t1-topicex-check@example.com");
    const profileId = await insertProfile("s5t1-topicex-check-test");
    await db.exec(
      `insert into public.study_hqs (user_id, exam_profile_id) values ('${userId}', '${profileId}')`,
    );

    await expect(
      db.exec(`
        insert into public.topic_explanations (exam_profile_id, topic, locale, body)
        values ('${profileId}', 'Algebra', 'ru', '[1,2]'::jsonb)
      `),
    ).rejects.toThrow();
  });

  it("topic_explanations enforces unique(exam_profile_id, topic, locale)", async () => {
    const userId = await insertUser("s5t1-topicex-unique@example.com");
    const profileId = await insertProfile("s5t1-topicex-unique-test");
    await db.exec(
      `insert into public.study_hqs (user_id, exam_profile_id) values ('${userId}', '${profileId}')`,
    );
    await db.exec(`
      insert into public.topic_explanations (exam_profile_id, topic, locale, body)
      values ('${profileId}', 'Algebra', 'ru', '{"text":"x"}'::jsonb)
    `);

    await expect(
      db.exec(`
        insert into public.topic_explanations (exam_profile_id, topic, locale, body)
        values ('${profileId}', 'Algebra', 'ru', '{"text":"y"}'::jsonb)
      `),
    ).rejects.toThrow();
  });

  it("adds attempt_items.score/feedback and rejects a non-object feedback via the CHECK constraint", async () => {
    const userId = await insertUser("s5t1-attemptitems@example.com");
    const profileId = await insertProfile("s5t1-attemptitems-test");
    const hq = await db.query<{ id: string }>(
      `insert into public.study_hqs (user_id, exam_profile_id) values ('${userId}', '${profileId}') returning id`,
    );
    const test = await db.query<{ id: string }>(
      `insert into public.tests (hq_id, kind, spec) values ('${hq.rows[0].id}', 'practice', '{}'::jsonb) returning id`,
    );
    const attempt = await db.query<{ id: string }>(
      `insert into public.attempts (test_id, user_id) values ('${test.rows[0].id}', '${userId}') returning id`,
    );
    const task = await db.query<{ id: string }>(
      `insert into public.tasks (exam_profile_id, type, topic, difficulty, language, body, answer, explanation, origin)
       values ('${profileId}', 'speaking', 'topic-a', 1, 'ru', '{}'::jsonb, '{}'::jsonb, null, 'ai')
       returning id`,
    );

    await db.exec(`
      insert into public.attempt_items (attempt_id, task_id, score, feedback)
      values ('${attempt.rows[0].id}', '${task.rows[0].id}', 4.5, '{"note":"ok"}'::jsonb)
    `);
    const row = await db.query<{ score: string }>(
      `select score from public.attempt_items where attempt_id = '${attempt.rows[0].id}'`,
    );
    expect(row.rows[0].score).toBe("4.5");

    await expect(
      db.exec(`
        update public.attempt_items set feedback = '[1,2]'::jsonb
        where attempt_id = '${attempt.rows[0].id}' and task_id = '${task.rows[0].id}'
      `),
    ).rejects.toThrow();
  });

  // D7: приватный Storage-бакет speaking-recordings + owner-only RLS
  // (storage.buckets/storage.objects) применяется в migration 20260710120100
  // внутри guarded DO-блока (`if exists (...information_schema.tables where
  // table_schema='storage'...)`). PGlite — чистый Postgres без Supabase
  // storage-расширения, поэтому этот блок здесь всегда no-op и бакет НЕ
  // создаётся локально; проверить его существование можно только против
  // реальной Supabase-платформы (Storage tab в Studio / Management API)
  // после применения миграции контроллером. RLS-политики самой таблицы
  // attempt_items (owner via attempts.user_id, "own attempt items" policy,
  // core_schema.sql) и topic_explanations (тесты выше) покрыты обязательно.
  it.skip("creates the speaking-recordings storage bucket with owner-only policies (skipped: PGlite has no storage schema — verify against Supabase Studio/Management API post-deploy)", () => {});
});
