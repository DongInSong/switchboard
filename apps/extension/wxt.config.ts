import { defineConfig } from "wxt";

// 기본 빌드는 activeTab만 쓴다(단축키·아이콘을 누른 탭에만 임시 권한).
// WXT_E2E=1 빌드는 자동화 테스트용: 모든 사이트 권한 + 테스트 훅 + 열린 shadow root.
const e2e = process.env.WXT_E2E === "1";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  outDir: e2e ? ".output-e2e" : ".output",
  zip: { artifactTemplate: "switchboard-{{version}}-{{browser}}.zip" },
  manifest: {
    name: e2e ? "Switchboard (e2e)" : "Switchboard",
    description: "__MSG_description__",
    default_locale: "en",
    permissions: ["activeTab", "scripting", "storage", "sidePanel", "contextMenus"],
    host_permissions: e2e ? ["<all_urls>"] : ["http://127.0.0.1:7490/*", "http://localhost:7490/*"],
    // 설정 탭에서 사용자가 고른 곳만 그때 요청한다: 자동 복원 사이트, 기본이 아닌 데몬 포트
    optional_host_permissions: ["http://*/*", "https://*/*"],
    action: { default_title: "Switchboard  Alt+Shift+S" },
    commands: {
      "start-pick": { suggested_key: { default: "Alt+Shift+S" }, description: "__MSG_startPick__" },
    },
  },
  vite: () => ({
    define: { "import.meta.env.WXT_E2E": JSON.stringify(e2e ? "1" : "") },
  }),
});
