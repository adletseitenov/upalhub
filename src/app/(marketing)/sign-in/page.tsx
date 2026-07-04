"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { LocaleSwitcher } from "@/components/locale-switcher";

export default function SignInPage() {
  const router = useRouter();
  const t = useTranslations("auth");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    setError(null);
    const { error } = await supabaseBrowser().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    if (error) setError(error.message);
    else setStage("code");
  }

  async function verify() {
    setError(null);
    const { error } = await supabaseBrowser().auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });
    if (error) setError(error.message);
    else router.push("/hq");
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-4 p-6">
      <div className="self-end">
        <LocaleSwitcher />
      </div>
      {stage === "email" ? (
        <>
          <input
            className="rounded border p-2"
            type="email"
            placeholder={t("emailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="rounded border px-4 py-2 font-medium" onClick={sendCode}>
            {t("getCode")}
          </button>
        </>
      ) : (
        <>
          <input
            className="rounded border p-2"
            inputMode="numeric"
            placeholder={t("codePlaceholder")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="rounded border px-4 py-2 font-medium" onClick={verify}>
            {t("signIn")}
          </button>
        </>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
