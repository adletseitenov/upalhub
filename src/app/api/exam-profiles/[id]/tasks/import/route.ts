import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseTaskRepo } from "@/features/tasks/repo";
import { importTasks, parseImport } from "@/features/tasks/import";

// D6: тело — JSON-массив заданий напрямую (не обёртка). Жёсткий cap на
// размер батча защищает insertMany от неограниченной по размеру вставки.
const MAX_ITEMS = 500;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { data: profileRow, error: profileError } = await supabase
    .from("exam_profiles")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profileRow) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Импорт — доступен только автору профиля (D6: "Роут gated на
  // exam_profiles.created_by"), в отличие от чтения банка (RLS select using(true)).
  if (profileRow.created_by !== data.user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const raw: unknown = await request.json().catch(() => null);
  if (Array.isArray(raw) && raw.length > MAX_ITEMS) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { valid, errors } = parseImport(raw);
  if (valid.length === 0) {
    return NextResponse.json({ error: "bad_request", errors }, { status: 400 });
  }

  // Creator-гейт (created_by !== user) уже прошёл выше на user-клиенте —
  // insertMany пишет тело задания (answer/explanation) через service-role,
  // т.к. .select("*").single() в insertMany читает те же колонки обратно
  // сразу после вставки, а authenticated их больше не видит (миграция
  // 20260709130000).
  const result = await importTasks({ repo: supabaseTaskRepo(supabaseAdmin()) }, id, valid);

  return NextResponse.json({
    inserted: result.inserted,
    skippedDuplicates: result.skippedDuplicates,
    rejected: errors.length,
    errors,
  });
}
