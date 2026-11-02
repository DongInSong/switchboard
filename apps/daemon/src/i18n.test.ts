import { describe, expect, it } from "vitest";
import { HELP, t } from "./i18n.ts";
import { parseValue, findSetting, SETTINGS } from "./settings.ts";

describe("daemon i18n", () => {
  it("영어 문구에 한글이 없고, 설정 설명도 두 언어 다 있다", () => {
    expect(HELP.en("0.1.0")).not.toMatch(/[가-힣]/);
    expect(t("dsp.pasteTimeout", undefined, "en")).toBe("not pasted (timed out)");
    for (const d of SETTINGS) {
      expect(d.help.en, d.key).not.toMatch(/[가-힣]/);
      expect(d.help.ko.length, d.key).toBeGreaterThan(0);
    }
  });

  it("언어 설정 값 검사", () => {
    const def = findSetting("language")!;
    expect(parseValue(def, "ko")).toEqual({ ok: true, value: "ko" });
    expect(parseValue(def, "fr").ok).toBe(false);
  });
});
