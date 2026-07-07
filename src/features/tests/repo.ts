import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { testSpecSchema } from "./spec";
import type { TestKind, TestSpec } from "./spec";

type Row = Database["public"]["Tables"]["tests"]["Row"];

export type StoredTest = { id: string; hqId: string; kind: string; spec: TestSpec };

export interface TestRepo {
  insertTest(hqId: string, kind: TestKind, spec: TestSpec): Promise<StoredTest>;
  getTest(id: string): Promise<StoredTest | null>;
  // D5/T6 «Дособрать»: атомарная замена tests.spec, ТОЛЬКО если у теста ещё
  // нет попыток (TOCTOU-фикс красной команды — проверка и запись в одном
  // SQL-стейтменте на стороне RPC, не select-then-update из JS). Возвращает
  // false, если RPC не заменила ни одной строки (попытка уже существует) —
  // T6-роут превращает это в 409 attempt_exists.
  replaceTestSpecIfNoAttempts(testId: string, spec: TestSpec): Promise<boolean>;
}

// Паттерн exam-profile/repo.ts: zod-парс jsonb-спеки на чтении, а не на записи —
// одна точка правды о форме tests.spec, даже если строка была вставлена в обход кода.
function rowToTest(row: Row): StoredTest {
  return {
    id: row.id,
    hqId: row.hq_id,
    kind: row.kind,
    spec: testSpecSchema.parse(row.spec),
  };
}

export function supabaseTestRepo(client: SupabaseClient<Database>): TestRepo {
  return {
    async insertTest(hqId, kind, spec) {
      const { data, error } = await client
        .from("tests")
        .insert({ hq_id: hqId, kind, spec: spec as unknown as Json })
        .select("*")
        .single();
      if (error) throw error;
      return rowToTest(data);
    },

    async getTest(id) {
      const { data, error } = await client.from("tests").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return data ? rowToTest(data) : null;
    },

    async replaceTestSpecIfNoAttempts(testId, spec) {
      // database.types.ts не знает про этот RPC до миграции T5 (Functions:
      // { [_ in never]: never } — сгенерировано до появления
      // replace_test_spec_if_no_attempts) — явный cast сигнатуры client.rpc,
      // как условлено в брифе задачи; регенерация типов в T5 уберёт
      // необходимость каста. RPC делает
      // `UPDATE tests SET spec=$2 WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM
      // attempts WHERE test_id=$1) RETURNING id` — 0 строк значит попытки уже
      // существуют, не ошибка сама по себе.
      const rpc = client.rpc.bind(client) as unknown as (
        fn: "replace_test_spec_if_no_attempts",
        args: { p_test_id: string; p_spec: Json },
      ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
      const { data, error } = await rpc("replace_test_spec_if_no_attempts", {
        p_test_id: testId,
        p_spec: spec as unknown as Json,
      });
      if (error) throw error;
      return Array.isArray(data) ? data.length > 0 : Boolean(data);
    },
  };
}
