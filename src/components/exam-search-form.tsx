"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export function ExamSearchForm() {
  const router = useRouter();
  const t = useTranslations("home");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || query.trim().length < 2) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/exam-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query.trim() }),
    });
    if (res.status === 401) return router.push("/sign-in");
    if (res.ok) {
      const { slug } = (await res.json()) as { slug: string };
      // D1 (Stage 2.5): после research юзер идёт в интервью-визард, а не
      // сразу на библиотечную страницу профиля.
      return router.push(`/onboarding/${slug}`);
    }
    setError(res.status === 404 ? t("notFound") : t("error"));
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-xl flex-col gap-3">
      <input
        className="rounded border p-3"
        placeholder={t("searchPlaceholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <button className="rounded border px-6 py-3 font-medium" disabled={busy}>
        {busy ? t("searching") : t("search")}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
