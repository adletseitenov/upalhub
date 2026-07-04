export const APP_NAME = "U-Pal";

export function healthcheck(): { ok: true; app: string } {
  return { ok: true, app: APP_NAME };
}
