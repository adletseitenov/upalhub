import { describe, expect, it, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

// Заглушка supabase-окружения: схема auth, auth.uid() и роли anon/authenticated,
// которых нет в чистом Postgres, но которые Supabase создаёт на платформе.
const SUPABASE_STUB = `
  create role anon;
  create role authenticated;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text
  );
  create function auth.uid() returns uuid
  language sql stable as $$ select null::uuid $$;
`;

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

  it("tightens tasks insert RLS to profile-creator and ai-origin-only policies", async () => {
    const res = await db.query<{ polname: string }>(
      `select p.polname from pg_policy p
       join pg_class c on c.oid = p.polrelid
       where c.relname = 'tasks' and p.polcmd = 'a'`,
    );
    const names = res.rows.map((r) => r.polname).sort();
    expect(names).toEqual(
      ["tasks insert by profile creator", "tasks ai insert by any authenticated"].sort(),
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
});
