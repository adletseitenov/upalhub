import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { testSpecSchema } from "./spec";
import type { TestKind, TestSpec } from "./spec";

type Row = Database["public"]["Tables"]["tests"]["Row"];

export type StoredTest = { id: string; hqId: string; kind: string; spec: TestSpec };

export interface TestRepo {
  insertTest(hqId: string, kind: TestKind, spec: TestSpec): Promise<StoredTest>;
  getTest(id: string): Promise<StoredTest | null>;
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
  };
}
