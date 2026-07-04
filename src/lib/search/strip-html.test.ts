import { describe, expect, it } from "vitest";
import { stripHtml } from "./strip-html";

describe("stripHtml", () => {
  it("removes tags and collapses whitespace", () => {
    expect(stripHtml("<p>Формат   <b>ЕНТ</b></p>\n<div>2027</div>")).toBe("Формат ЕНТ 2027");
  });
  it("drops script and style content entirely", () => {
    expect(stripHtml("<style>a{}</style>x<script>alert(1)</script>y")).toBe("x y");
  });
  it("decodes basic entities", () => {
    expect(stripHtml("a&nbsp;b &amp; c")).toBe("a b & c");
  });
});
