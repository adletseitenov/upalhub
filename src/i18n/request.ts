import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { defaultLocale, locales, type Locale } from "./locales";

export default getRequestConfig(async () => {
  const store = await cookies();
  const fromCookie = store.get("NEXT_LOCALE")?.value;
  const locale: Locale = locales.includes(fromCookie as Locale)
    ? (fromCookie as Locale)
    : defaultLocale;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
