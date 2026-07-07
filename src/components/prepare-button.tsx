"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export function PrepareButton({ examProfileId }: { examProfileId: string }) {
  const router = useRouter();
  const t = useTranslations("profile");
  const [busy, setBusy] = useState(false);

  async function prepare() {
    setBusy(true);
    const res = await fetch("/api/study-hqs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ examProfileId }),
    });
    if (res.status === 401) return router.push("/sign-in");
    if (res.ok) return router.push("/hq");
    setBusy(false);
  }

  return (
    <button onClick={prepare} disabled={busy} className="rounded border px-6 py-3 font-medium">
      {busy ? t("preparing") : t("prepare")}
    </button>
  );
}
