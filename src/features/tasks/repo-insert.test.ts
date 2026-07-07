import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { supabaseTaskRepo, contentHash } from "./repo";
import type { NewTaskRow } from "./repo";
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

function row(id: string, prompt: string): Row {
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

function newRow(prompt: string): NewTaskRow {
  return {
    type: "algebra",
    topic: "Уравнения",
    difficulty: 3,
    language: "kk",
    body: body(prompt),
    answer: { format: "single_choice", correctOptionId: "a" },
    explanation: "2+2=4.",
    contentHash: contentHash(body(prompt)),
    examProfileId: "profile-1",
    origin: "ai",
  };
}

// Мок цепочки client.from('tasks').insert(...).select('*').single() —
// возвращает результаты из очереди по одному на каждый .single() вызов, в
// порядке вызовов insertMany's for-loop.
function makeMockClient(results: Array<{ data: Row | null; error: { code: string } | null }>) {
  let call = 0;
  const singleMock = vi.fn(async () => {
    const result = results[call];
    call += 1;
    return result;
  });
  const selectMock = vi.fn(() => ({ single: singleMock }));
  const insertMock = vi.fn(() => ({ select: selectMock }));
  const fromMock = vi.fn(() => ({ insert: insertMock }));
  const client = { from: fromMock } as unknown as SupabaseClient<Database>;
  return { client, fromMock, insertMock, selectMock, singleMock };
}

describe("supabaseTaskRepo.insertMany", () => {
  it("skips a row that fails with a 23505 duplicate error and keeps inserting the remaining rows", async () => {
    const rows = [newRow("Задание 1"), newRow("Задание 2"), newRow("Задание 3")];
    const { client, fromMock, insertMock } = makeMockClient([
      { data: row("id-1", "Задание 1"), error: null },
      { data: null, error: { code: "23505" } },
      { data: row("id-3", "Задание 3"), error: null },
    ]);

    const result = await supabaseTaskRepo(client).insertMany(rows);

    expect(result.inserted).toHaveLength(2);
    expect(result.inserted.map((t) => t.id)).toEqual(["id-1", "id-3"]);
    expect(result.skipped).toBe(1);
    // цикл дошёл до третьей строки, а не остановился после ошибки второй
    expect(fromMock).toHaveBeenCalledTimes(3);
    expect(insertMock).toHaveBeenCalledTimes(3);
  });
});
