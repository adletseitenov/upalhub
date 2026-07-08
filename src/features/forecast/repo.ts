// D4/Task5: supabase-граница прогноза — единственное место, где Forecast
// (из pure computeForecast, compute.ts) ложится в forecasts append-only.
// Ноль доменной логики здесь, кроме дедупа последней записи — только
// чтение/запись. User-клиент (RLS: existing study_hqs-owner policies
// покрывают forecasts — см. D7 миграции).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { Forecast } from "./compute";

export type StoredForecast = { point: number; low: number; high: number };

export interface ForecastRepo {
  /** Самая свежая запись forecasts(hq_id) по created_at desc, либо null,
   * если строк ещё нет ИЛИ последняя строка legacy (point === null,
   * т.е. записана до колонки point из миграции D7 — трактуется как
   * "нет сопоставимой предыдущей записи", дедуп не применяется). */
  latest(hqId: string): Promise<StoredForecast | null>;
  /** Append-only insert. 🔴 Дедуп: если latest(hqId) совпадает по
   * (point, low, high) с новым прогнозом — insert пропускается (no-op,
   * без сетевого вызова записи). */
  append(hqId: string, forecast: Forecast): Promise<void>;
}

export function supabaseForecastRepo(client: SupabaseClient<Database>): ForecastRepo {
  async function latest(hqId: string): Promise<StoredForecast | null> {
    const { data, error } = await client
      .from("forecasts")
      .select("point, low, high")
      .eq("hq_id", hqId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data || data.point === null) return null;
    return { point: data.point, low: data.low, high: data.high };
  }

  return {
    latest,

    async append(hqId, forecast) {
      const existing = await latest(hqId);
      if (
        existing &&
        existing.point === forecast.point &&
        existing.low === forecast.low &&
        existing.high === forecast.high
      ) {
        return; // 🔴 дедуп — идентичный прогноз, insert пропущен
      }

      const row: Database["public"]["Tables"]["forecasts"]["Insert"] = {
        hq_id: hqId,
        point: forecast.point,
        low: forecast.low,
        high: forecast.high,
        confidence: forecast.confidence,
        coverage: forecast.coverage,
      };
      const { error } = await client.from("forecasts").insert(row);
      if (error) throw error;
    },
  };
}
