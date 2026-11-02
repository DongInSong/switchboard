import { describe, expect, it } from "vitest";
import { CATALOGS_FOR_TEST, detectLang, resolveLang, t } from "./i18n.ts";

describe("i18n", () => {
  it("두 언어의 키가 같고, 영어 문구에 한글이 섞이지 않는다", () => {
    const { en, ko } = CATALOGS_FOR_TEST;
    expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort());
    for (const [k, v] of Object.entries(en)) expect(v, k).not.toMatch(/[가-힣]/);
    // 자리표시자도 같아야 한다
    for (const k of Object.keys(ko) as (keyof typeof ko)[]) expect(en[k].match(/\{\w+\}/g)?.sort() ?? [], k).toEqual(ko[k].match(/\{\w+\}/g)?.sort() ?? []);
  });

  it("언어 고르기: 설정 > 브라우저 언어(ko…면 한국어, 그 밖은 영어)", () => {
    expect(detectLang("ko-KR")).toBe("ko");
    expect(detectLang("en-US")).toBe("en");
    expect(detectLang("ja")).toBe("en");
    expect(resolveLang("ko", "en-US")).toBe("ko");
    expect(resolveLang("auto", "ko")).toBe("ko");
    expect(resolveLang(undefined, "de")).toBe("en");
  });

  it("자리표시자 채우기", () => {
    expect(t("region", { w: 320, h: 180, name: "Card" }, "en")).toBe("region 320×180 · Card");
    expect(t("elements", { n: 3, name: "Card" }, "ko")).toBe("요소 3개 · Card");
  });
});
