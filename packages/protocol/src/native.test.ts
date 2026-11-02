import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EXTENSION_ID, EXTENSION_KEY, NATIVE_HOST_NAME } from "./native.ts";

describe("native messaging", () => {
  it("확장 ID는 manifest key에서 나온다(어디서 로드해도 같음)", () => {
    const hex = createHash("sha256").update(Buffer.from(EXTENSION_KEY, "base64")).digest("hex").slice(0, 32);
    expect([...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("")).toBe(EXTENSION_ID);
  });
  it("호스트 이름 규칙(소문자·숫자·밑줄, 점으로 구분)", () => {
    expect(NATIVE_HOST_NAME).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/);
  });
});
