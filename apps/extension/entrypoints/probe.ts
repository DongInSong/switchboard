import { installProbeListener } from "@switchboard/page-probe";

/** MAIN world에 주입된다. 페이지의 React/Vue/Svelte 개발용 정보를 읽어 소스 위치를 찾는다. */
export default defineUnlistedScript(() => {
  installProbeListener(document);
});
