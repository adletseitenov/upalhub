import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { supabaseTaskRepo, contentHash } from "./repo";
import type { TaskBody } from "./schema";

type Row = Database["public"]["Tables"]["tasks"]["Row"];

function body(prompt: string): TaskBody {
  return {
    format: "single_choice",
    prompt,
    options: [
      { id: "a", text: "4" },
      { id: "b", text: "5" },
    ],
  };
}

function validRow(id: string, prompt: string): Row {
  return {
    id,
    exam_profile_id: "profile-1",
    type: "algebra",
    topic: "Уравнения",
    difficulty: 3,
    language: "kk",
    body: body(prompt) as unknown as Row["body"],
    answer: { format: "single_choice", correctOptionId: "a" } as unknown as Row["answer"],
    explanation: "2+2=4.",
    origin: "ai",
    content_hash: contentHash(body(prompt)),
    hub_id: null,
    created_at: "2026-07-07T00:00:00.000Z",
  };
}

// Мусорная строка (D-fix3): body — не JSON-объект в форме taskBodySchema
// вовсе (например, старый формат / ручной SQL-фикс, отвалившийся от схемы).
function garbageRow(id: string): Row {
  return {
    id,
    exam_profile_id: "profile-1",
    type: "algebra",
    topic: "Уравнения",
    difficulty: 3,
    language: "kk",
    body: { nonsense: true } as unknown as Row["body"],
    answer: { format: "single_choice", correctOptionId: "a" } as unknown as Row["answer"],
    explanation: "garbage",
    origin: "ai",
    content_hash: "garbage-hash",
    hub_id: null,
    created_at: "2026-07-07T00:00:00.000Z",
  };
}

// Мок цепочки client.from('tasks').select('*').eq(...).eq(...).eq(...).limit(...) —
// каждый .eq/.select возвращает тот же builder (чейнится любое число раз,
// включая ноль — для difficulty=null ветки, где .eq("difficulty", ...) не
// вызывается), .limit резолвит заданный результат.
function makeMockClient(result: { data: Row[] | null; error: { message: string } | null }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.limit = vi.fn(() => Promise.resolve(result));
  const fromMock = vi.fn(() => builder);
  const client = { from: fromMock } as unknown as SupabaseClient<Database>;
  return { client, fromMock, builder };
}

describe("supabaseTaskRepo.findBucket", () => {
  it("skips a malformed row (invalid body/answer shape) without throwing, keeping the valid ones", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = makeMockClient({
      data: [validRow("id-1", "Задание 1"), garbageRow("id-2"), validRow("id-3", "Задание 3")],
      error: null,
    });

    const result = await supabaseTaskRepo(client).findBucket("profile-1", "algebra", "Уравнения", 3, 10);

    expect(result.map((t) => t.id)).toEqual(["id-1", "id-3"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("id-2");
    warnSpy.mockRestore();
  });

  it("omits the .eq('difficulty', ...) filter when difficulty is null (relax fallback)", async () => {
    const { client, builder } = makeMockClient({ data: [validRow("id-1", "Задание 1")], error: null });

    await supabaseTaskRepo(client).findBucket("profile-1", "algebra", "Уравнения", null, 10);

    const eqCalls = (builder.eq as ReturnType<typeof vi.fn>).mock.calls.map((args: unknown[]) => args[0]);
    expect(eqCalls).toEqual(["exam_profile_id", "type", "topic"]);
    expect(eqCalls).not.toContain("difficulty");
  });

  it("includes the .eq('difficulty', ...) filter when difficulty is a number", async () => {
    const { client, builder } = makeMockClient({ data: [], error: null });

    await supabaseTaskRepo(client).findBucket("profile-1", "algebra", "Уравнения", 3, 10);

    const eqCalls = (builder.eq as ReturnType<typeof vi.fn>).mock.calls.map((args: unknown[]) => args[0]);
    expect(eqCalls).toEqual(["exam_profile_id", "type", "topic", "difficulty"]);
  });
});
