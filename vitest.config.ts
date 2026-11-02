import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/src/**/*.test.tsx"],
    // 기존 테스트는 한국어 문구로 쓰여 있다. 기계의 LANG과 상관없이 같은 결과가 나오게 고정한다(영어는 테스트에서 따로 확인).
    env: { SWITCHBOARD_LANG: "ko" },
  },
});
