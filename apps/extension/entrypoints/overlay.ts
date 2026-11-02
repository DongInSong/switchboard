import { boot } from "../src/overlay/boot.tsx";

/** 단축키·아이콘을 누르면 백그라운드가 scripting.executeScript로 주입한다(ISOLATED world). */
export default defineUnlistedScript(() => {
  boot();
});
