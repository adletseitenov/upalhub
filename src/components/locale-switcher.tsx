"use client";
import { useLocale } from "next-intl";
import { setLocale } from "@/app/actions/set-locale";
import { locales, type Locale } from "@/i18n/locales";

export function LocaleSwitcher() {
  const current = useLocale();
  return (
    <div className="flex gap-2 text-sm">
      {locales.map((l) => (
        <button
          key={l}
          className={l === current ? "font-bold underline" : ""}
          onClick={() => setLocale(l as Locale)}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
