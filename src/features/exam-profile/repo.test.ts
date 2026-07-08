import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { supabaseExamProfileRepo } from "./repo";

type Row = Database["public"]["Tables"]["exam_profiles"]["Row"];

const validSpec = {
  examName: "ЕНТ",
  language: "kk",
  description: "Единое национальное тестирование.",
  sections: [{ name: "Математика", taskTypes: [], topics: [] }],
  variants: [],
  selectionGroups: [],
  scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
};

function baseRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "profile-1",
    slug: "ent-2027",
    title: "ЕНТ",
    language: "kk",
    spec: validSpec as unknown as Row["spec"],
    sources: [] as unknown as Row["sources"],
    origin: "ai_research",
    trust: "ai_draft",
    created_at: "2026-07-07T00:00:00.000Z",
    created_by: null,
    ...overrides,
  };
}

// Мок цепочки client.from('exam_profiles').select('*').eq('slug', ...).maybeSingle().
function makeFindClient(result: { data: Row | null; error: { message: string } | null }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(() => Promise.resolve(result));
  const fromMock = vi.fn(() => builder);
  const client = { from: fromMock } as unknown as SupabaseClient<Database>;
  return { client };
}

describe("supabaseExamProfileRepo.findBySlug (rowToProfile safeParse, Stage3 T1)", () => {
  it("returns the parsed profile for a row with a valid spec", async () => {
    const { client } = makeFindClient({ data: baseRow(), error: null });

    const profile = await supabaseExamProfileRepo(client).findBySlug("ent-2027");

    expect(profile).not.toBeNull();
    expect(profile?.slug).toBe("ent-2027");
    expect(profile?.spec.examName).toBe("ЕНТ");
  });

  it("returns null (not a throw) when the row's spec fails safeParse, and warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const brokenRow = baseRow({ spec: { nonsense: true } as unknown as Row["spec"] });
    const { client } = makeFindClient({ data: brokenRow, error: null });

    const profile = await supabaseExamProfileRepo(client).findBySlug("ent-2027");

    expect(profile).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("profile-1");
    warnSpy.mockRestore();
  });

  it("returns null when there is no row at all (unaffected by the safeParse change)", async () => {
    const { client } = makeFindClient({ data: null, error: null });

    const profile = await supabaseExamProfileRepo(client).findBySlug("does-not-exist");

    expect(profile).toBeNull();
  });
});
