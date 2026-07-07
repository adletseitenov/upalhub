"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export function RefineForm({ slug }: { slug: string }) {
  const router = useRouter();
  const t = useTranslations("profile");
  const [sampleText, setSampleText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || sampleText.trim().length < 100) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/exam-profiles/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, sampleText: sampleText.trim() }),
    });
    if (res.status === 401) return router.push("/sign-in");
    if (res.ok) {
      setSampleText("");
      setBusy(false);
      return router.refresh();
    }
    setError(t("error"));
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <h2 className="font-semibold">{t("refineTitle")}</h2>
      <textarea
        className="min-h-32 rounded border p-3"
        placeholder={t("refinePlaceholder")}
        value={sampleText}
        onChange={(e) => setSampleText(e.target.value)}
      />
      <button className="rounded border px-6 py-3 font-medium" disabled={busy}>
        {busy ? t("refining") : t("refineSubmit")}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
