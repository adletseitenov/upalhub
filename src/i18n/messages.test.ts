import { describe, expect, it } from "vitest";
import ru from "../../messages/ru.json";
import kk from "../../messages/kk.json";

function keys(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v !== null && typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe("locale messages", () => {
  it("ru and kk have identical key sets", () => {
    expect(keys(kk).sort()).toEqual(keys(ru).sort());
  });
  it("has at least the shell keys", () => {
    expect(keys(ru)).toEqual(
      expect.arrayContaining(["shell.appName", "auth.getCode", "auth.signIn"]),
    );
  });
});
