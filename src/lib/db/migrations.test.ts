import { describe, expect, it, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

// Заглушка supabase-окружения: схема auth и auth.uid(), которых нет в чистом Postgres.
const SUPABASE_STUB = `
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
    const res = await db.query<{ count: string }>("select count(*)::text as count from profiles");
    expect(res.rows[0].count).toBe("1");
  });
});
