import { primaryComponent } from "@switchboard/page-probe";
import { createRoot } from "react-dom/client";
import { getLang, loadLang, onLangChange, t } from "../i18n.ts";
import { send, type CaptureDraft, type ContentMessage } from "../messages.ts";
import { sourceShort } from "../ui/labels.ts";
import { App, type PickTarget } from "./App.tsx";
import { collectElement } from "./collect.ts";
import css from "./overlay.css?inline";
import { Picker, type LabelParts, type PickResult } from "./picker.ts";
import { probeSource } from "./probe-client.ts";
import { createStore, updateChip, updateLink, updatePopover, type Link } from "./store.ts";

/** 페이지 이벤트가 우리 UI 밖으로 새지 않게 막는다(페이지의 단축키·바깥 클릭 핸들러 보호). */
const ISOLATED_EVENTS = ["keydown", "keyup", "keypress", "input", "beforeinput", "focusin", "focusout", "pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "wheel", "contextmenu"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frames = (n: number) => new Promise<void>((resolve) => {
  const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
  step(n);
});

function shortName(el: Element): string {
  const cls = Array.from(el.classList).slice(0, 2).map((c) => `.${c}`).join("");
  return `${el.tagName.toLowerCase()}${cls}`;
}

function hostStyle(host: HTMLElement) {
  const s: Record<string, string> = {
    position: "fixed", inset: "0", width: "100vw", height: "100vh", margin: "0", padding: "0", border: "0",
    background: "transparent", overflow: "visible", "pointer-events": "none", "z-index": "2147483647",
    "max-width": "none", "max-height": "none", display: "block", color: "initial",
  };
  for (const [k, v] of Object.entries(s)) host.style.setProperty(k, v, "important");
}

/** 선택이 어디로 가는지: 새 팝업(null) / 이 페이지 팝업에 덧붙이기 / 칩의 이어서 쓰기에 덧붙이기 / 다른 페이지 요청에 덧붙이기. */
type Target = PickTarget | { kind: "remote"; draftId: string; name: string };

export function boot(): void {
  const w = window as unknown as { __switchboardOverlay?: boolean };
  if (w.__switchboardOverlay) return;
  w.__switchboardOverlay = true;

  const host = document.createElement("switchboard-ui");
  hostStyle(host);
  const root = host.attachShadow({ mode: import.meta.env.WXT_E2E === "1" ? "open" : "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  root.adoptedStyleSheets = [sheet];
  for (const type of ISOLATED_EVENTS) root.addEventListener(type, (e) => e.stopPropagation());
  const mount = document.createElement("div");
  mount.className = "sb-root";
  root.append(mount);
  document.documentElement.append(host);
  // top layer에 올려 페이지 z-index와 경쟁하지 않는다.
  try {
    host.popover = "manual";
    host.showPopover();
  } catch {
    /* popover 미지원이면 z-index로 */
  }

  const store = createStore({
    url: location.href,
    picking: false,
    attaching: null,
    focusReq: null,
    remoteAttach: null,
    toast: null,
    lang: getLang(),
    popovers: [],
    chips: [],
  });
  let seq = 0;
  const nextId = (p: string) => `${p}${Date.now().toString(36)}-${++seq}`;
  /** 선택하려고 화면을 클릭하면 입력 포커스가 빠지므로, 덧붙이기가 끝나면 그쪽으로 돌려준다. */
  const refocus = (id: string | null) => {
    if (id) store.set({ focusReq: { id, n: ++seq } });
  };
  const toast = (text: string) => store.set({ toast: { text, n: ++seq } });
  // 언어: 저장된 설정을 읽고, 사이드 패널에서 바꾸면 바로 다시 그린다
  void loadLang().then((lang) => store.set({ lang }));
  onLangChange((lang) => store.set({ lang }));
  // 선택하는 동안 열려 있는 팝업은 흐리게
  store.subscribe(() => mount.classList.toggle("is-picking", store.get().picking));

  // ------------------------------------------------ 보관·복원 (새로고침·이동 뒤에도)
  /** 이 오버레이가 본 주소들. 동기화는 이 범위 안의 초안만 갈아 끼운다. */
  const scope = new Set([location.href]);
  let restored = false;
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  const syncNow = async () => {
    clearTimeout(syncTimer);
    const s = store.get();
    await send({ type: "drafts/sync", scope: [...scope], popovers: s.popovers, chips: s.chips });
  };
  store.subscribe(() => {
    if (!restored) return; // 되살리기 전에 빈 상태로 덮어쓰지 않게
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => void syncNow(), 300);
  });
  const restore = async (url: string) => {
    const res = await send({ type: "drafts/restore", url });
    if (res.ok) {
      store.set((s) => ({
        popovers: [...s.popovers, ...res.data.popovers.filter((p) => !s.popovers.some((x) => x.id === p.id))],
        chips: [...s.chips, ...res.data.chips.filter((c) => !s.chips.some((x) => x.id === c.id))],
      }));
    }
  };
  void restore(location.href).finally(() => {
    restored = true;
  });
  // SPA 화면 전환: 주소가 바뀌면 그 주소의 팝업만 보이게(App이 url로 거른다) + 그 주소에 보관된 초안을 되살린다.
  setInterval(() => {
    if (location.href === store.get().url) return;
    scope.add(location.href);
    store.set({ url: location.href });
    void restore(location.href);
  }, 500);

  // ------------------------------------------------ 선택
  const describe = async (el: Element): Promise<LabelParts> => {
    await sleep(120);
    const hints = await probeSource(el);
    return { comp: primaryComponent(hints), sel: shortName(el), src: sourceShort(hints[0])?.short };
  };

  let attachTo: Target | null = null;

  const onPicked = async (r: PickResult, target: Target | null) => {
    const hints = await probeSource(r.primary, 400);
    const primary = collectElement(r.primary);
    const others = r.others.map(collectElement);
    const draft: CaptureDraft = {
      url: location.href,
      title: document.title,
      capturedAt: Date.now(),
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio, scrollX: window.scrollX, scrollY: window.scrollY },
      selection: { mode: r.mode, rect: r.rect, primary, others },
      source: hints,
    };
    // 우리 UI가 스크린샷에 찍히지 않게 숨기고 두 프레임 기다린다.
    mount.style.visibility = "hidden";
    await frames(2);
    const shot = await send({ type: "capture/shoot", rect: r.rect, viewport: { width: draft.viewport.width, height: draft.viewport.height } });
    mount.style.visibility = "";
    const name = primaryComponent(hints) ?? shortName(r.primary);
    const thumbnail = shot.ok ? shot.data.thumbnail : null;
    const label = r.mode === "region" ? t("region", { w: Math.round(r.rect.width), h: Math.round(r.rect.height), name }) : name;
    const newLink = (): Link => ({ id: nextId("l"), name: label, source: hints[0], thumbnail, captureId: null, captureError: shot.ok ? null : shot.error });
    const upload = async () => (shot.ok ? send({ type: "capture/upload", shotId: shot.data.shotId, capture: draft }) : null);

    // 다른 페이지·탭의 요청에 참고 대상으로
    if (target?.kind === "remote") {
      const up = await upload();
      if (!up?.ok) {
        toast(t("captureFailed"));
        return;
      }
      const link: Link = { ...newLink(), captureId: up.data.captureId, page: { url: location.href, title: document.title } };
      const res = await send({ type: "drafts/link", targetId: target.draftId, links: [link] });
      toast(res.ok ? t("link.attached", { name: target.name }) : t("link.closed"));
      return;
    }

    // 완료 로그의 이어서 쓰기에
    if (target?.kind === "chip") {
      const link = newLink();
      updateChip(store, target.id, (c) => ({ followLinks: [...c.followLinks, link], expanded: true }));
      refocus(`chip:${target.id}`);
      const up = await upload();
      updateChip(store, target.id, (c) => ({
        followLinks: c.followLinks.map((l) => (l.id === link.id ? { ...l, captureId: up?.ok ? up.data.captureId : null, captureError: up?.ok ? null : (up?.error ?? l.captureError) } : l)),
      }));
      return;
    }

    // 이 페이지 팝업에
    if (target?.kind === "popover" && store.get().popovers.some((p) => p.id === target.id)) {
      const link = newLink();
      store.set((s) => ({ popovers: s.popovers.map((p) => (p.id === target.id ? { ...p, links: [...p.links, link] } : p)) }));
      refocus(target.id);
      const up = await upload();
      updateLink(store, target.id, link.id, { captureId: up?.ok ? up.data.captureId : null, captureError: up?.ok ? null : (up?.error ?? link.captureError) });
      return;
    }

    // 새 팝업
    const key = `${location.href}|${primary.selector}|${r.mode}`;
    const id = nextId("p");
    const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < 120;
    store.set((s) => ({
      popovers: [
        ...s.popovers,
        {
          id,
          z: Math.max(0, ...s.popovers.map((p) => p.z)) + 1,
          cascade: s.popovers.filter((p) => p.draft.url === location.href && near(p.rect, r.rect)).length,
          key,
          mode: r.mode,
          rect: r.rect,
          point: r.point,
          name,
          count: 1 + r.others.length,
          source: hints[0],
          draft,
          captureId: null,
          captureError: shot.ok ? null : shot.error,
          recommendations: [],
          thumbnail,
          links: [],
          text: "",
          selectedKey: null,
          userPicked: false,
        },
      ],
    }));
    const up = await upload();
    if (!up) return;
    updatePopover(store, id, {
      captureId: up.ok ? up.data.captureId : null,
      captureError: up.ok ? null : up.error,
      recommendations: up.ok ? up.data.recommendations : [],
    });
  };

  const endPick = () => {
    const target = attachTo;
    attachTo = null;
    store.set({ picking: false, attaching: null, remoteAttach: null });
    if (target?.kind === "popover") void send({ type: "attach/disarm" });
    return target;
  };

  const picker = new Picker({
    root,
    host,
    describe,
    onDone: (r) => void onPicked(r, endPick()),
    onCancel: () => {
      const target = endPick();
      if (target?.kind === "remote") void send({ type: "attach/disarm" });
      refocus(target?.kind === "popover" ? target.id : target?.kind === "chip" ? `chip:${target.id}` : null);
    },
  });

  /**
   * 팝업이 떠 있어도 새로 선택한다(여러 개를 동시에).
   * 이 페이지 팝업에 덧붙이는 선택이면 백그라운드에 "연계 대기"로 알려, 다른 페이지·탭에서 골라도 그 팝업에 붙게 한다.
   */
  const startPick = (target: Target | null) => {
    if (store.get().picking) return;
    attachTo = target;
    store.set({
      picking: true,
      attaching: target?.kind === "popover" ? target.id : null,
      remoteAttach: target?.kind === "remote" ? { draftId: target.draftId, name: target.name } : null,
    });
    // 연계 대기 전에 초안부터 보관한다(팝업을 막 만들고 바로 다른 탭으로 가도 그 초안을 찾을 수 있게)
    if (target?.kind === "popover") void (restored ? syncNow() : Promise.resolve()).then(() => send({ type: "attach/arm", draftId: target.id, url: location.href }));
    picker.start();
  };

  createRoot(mount).render(<App store={store} actions={{ pick: startPick }} />);

  browser.runtime.onMessage.addListener((raw: unknown) => {
    const msg = raw as ContentMessage | null;
    if (msg?.type === "pick/start") {
      startPick(msg.attachTo ? { kind: "remote", ...msg.attachTo } : null);
    } else if (msg?.type === "draft/linked") {
      store.set((s) => ({
        popovers: s.popovers.map((p) =>
          p.id === msg.draftId ? { ...p, links: [...p.links, ...msg.links.filter((l) => !p.links.some((x) => x.id === l.id))] } : p,
        ),
      }));
    } else if (msg?.type === "pick/cancel") {
      if (picker.active && attachTo?.kind === "popover" && attachTo.id === msg.draftId) {
        picker.stop();
        endPick();
        refocus(msg.draftId);
      }
    }
  });
}
