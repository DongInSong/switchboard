import { cropScreenshot, makeThumbnail, type Thumb } from "../src/crop.ts";
import * as daemon from "../src/daemon.ts";
import { DraftStore, sessionKV } from "../src/drafts.ts";
import { loadLang, onLangChange, t } from "../src/i18n.ts";
import type { Recommendation } from "@switchboard/protocol";
import type { ContentMessage, Request, Result } from "../src/messages.ts";

const drafts = new DraftStore(sessionKV());

/** 찍어서 잘라 둔 스크린샷. 업로드하면 지운다. 서비스 워커가 내려가도 잃는 것은 진행 중인 캡처 하나뿐이다. */
const shots = new Map<string, { element: Blob; viewport: Blob; at: number }>();
const SHOT_TTL_MS = 5 * 60_000;

function prune() {
  const now = Date.now();
  for (const [id, s] of shots) if (now - s.at > SHOT_TTL_MS) shots.delete(id);
}

async function markUnavailable(tabId: number, reason: string) {
  await browser.action.setBadgeText({ tabId, text: "—" });
  await browser.action.setBadgeBackgroundColor({ tabId, color: "#6b7280" });
  await browser.action.setTitle({ tabId, title: `Switchboard: ${reason}` });
}

/** 오버레이와 probe를 넣는다(이미 있으면 그대로). 넣으면 오버레이가 이 페이지 몫의 초안·칩을 되살린다. */
async function ensureOverlay(tabId: number): Promise<void> {
  const [probe] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => Boolean((window as unknown as { __switchboardOverlay?: boolean }).__switchboardOverlay),
  });
  if (!probe?.result) {
    await browser.scripting.executeScript({ target: { tabId }, files: ["/probe.js"], world: "MAIN" });
    await browser.scripting.executeScript({ target: { tabId }, files: ["/overlay.js"] });
  }
}

/** 선택을 시작한다. 다른 페이지의 요청이 연계 대기 중이면 그 요청에 덧붙이는 선택으로. */
async function startPick(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  try {
    await ensureOverlay(tabId);
    const tab = await browser.tabs.get(tabId);
    const armed = await drafts.armed();
    const remote = armed && !(armed.tabId === tabId && armed.url === tab.url) ? { draftId: armed.draftId, name: armed.name } : undefined;
    await browser.tabs.sendMessage(tabId, { type: "pick/start", ...(remote ? { attachTo: remote } : {}) } satisfies ContentMessage);
  } catch (e) {
    // edge://, 확장 스토어처럼 스크립트를 넣을 수 없는 페이지.
    await markUnavailable(tabId, e instanceof Error ? e.message : t("unavailable"));
  }
}

/** 보이는 화면을 한 번 찍고 바로 잘라 둔다. 팝업에는 줄인 미리보기만 보낸다(페이지를 다시 그리지 않음). */
async function shoot(windowId: number | undefined, req: Extract<Request, { type: "capture/shoot" }>): Promise<Result<{ shotId: string; thumbnail: Thumb | null }>> {
  prune();
  try {
    const dataUrl = await browser.tabs.captureVisibleTab(windowId ?? browser.windows.WINDOW_ID_CURRENT, { format: "png" });
    const images = await cropScreenshot(dataUrl, req.rect, req.viewport);
    const shotId = crypto.randomUUID();
    shots.set(shotId, { ...images, at: Date.now() });
    const thumbnail = await makeThumbnail(images.element).catch(() => null);
    return { ok: true, data: { shotId, thumbnail } };
  } catch (e) {
    return { ok: false, error: `capture-failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function upload(req: Extract<Request, { type: "capture/upload" }>): Promise<Result<{ captureId: string; recommendations: Recommendation[] }>> {
  const shot = shots.get(req.shotId);
  if (!shot) return { ok: false, error: "capture-failed: no screenshot" };
  shots.delete(req.shotId);
  const images = shot;
  const form = new FormData();
  form.set("capture", JSON.stringify({ ...req.capture, screenshots: { element: "element", viewport: "viewport" } }));
  form.set("element", images.element, "element.png");
  form.set("viewport", images.viewport, "viewport.png");
  const res = await daemon.uploadCapture(form);
  return res.ok ? { ok: true, data: { captureId: res.data.id, recommendations: res.data.recommendations ?? [] } } : res;
}

async function handle(req: Request, sender: Browser.runtime.MessageSender): Promise<unknown> {
  switch (req.type) {
    case "capture/shoot":
      return shoot(sender.tab?.windowId, req);
    case "capture/upload":
      return upload(req);
    case "daemon/status":
      return daemon.status();
    case "daemon/sessions":
      return daemon.sessions(req.fresh);
    case "daemon/pair":
      return daemon.pair(req.code);
    case "daemon/preview":
      return daemon.preview(req.captureId, req.text, req.sessionKey, req.extraCaptureIds);
    case "daemon/recommend":
      return daemon.recommend(req.captureId, req.text);
    case "daemon/request":
      return daemon.createRequest(req.captureId, req.text, req.sessionKey, req.extraCaptureIds);
    case "daemon/request-get":
      return daemon.getRequest(req.id);
    case "daemon/requests":
      return daemon.listRequests();
    case "daemon/cancel":
      return daemon.cancelDispatch(req.dispatchId);
    case "daemon/capture-image":
      return daemon.captureImage(req.captureId);
    case "daemon/followup":
      return daemon.followUp(req.id, req.text, req.extraCaptureIds);
    case "drafts/sync":
      if (sender.tab?.id === undefined) return { ok: false, error: "no-tab" };
      await drafts.sync(sender.tab.id, req.scope, req.popovers, req.chips);
      return { ok: true, data: null };
    case "drafts/restore":
      if (sender.tab?.id === undefined) return { ok: false, error: "no-tab" };
      return { ok: true, data: await drafts.restore(sender.tab.id, req.url) };
    case "drafts/others":
      if (sender.tab?.id === undefined) return { ok: false, error: "no-tab" };
      return { ok: true, data: await drafts.others(sender.tab.id, req.url) };
    case "drafts/link": {
      const target = await drafts.link(req.targetId, req.links);
      if (!target) return { ok: false, error: "draft-gone" };
      await drafts.disarm();
      // 그 요청이 열려 있는 탭이 살아 있으면 바로 반영하고, 그쪽 선택 도구는 내린다
      const tell = (m: ContentMessage) => browser.tabs.sendMessage(target.tabId, m).catch(() => undefined);
      await tell({ type: "draft/linked", draftId: req.targetId, links: req.links });
      await tell({ type: "pick/cancel", draftId: req.targetId });
      return { ok: true, data: null };
    }
    case "attach/arm":
      if (sender.tab?.id !== undefined) await drafts.arm(req.draftId, sender.tab.id, req.url);
      return { ok: true, data: null };
    case "attach/disarm":
      await drafts.disarm();
      return { ok: true, data: null };
    case "panel/open":
      if (sender.tab?.windowId !== undefined) await browser.sidePanel.open({ windowId: sender.tab.windowId });
      return { ok: true, data: null };
    case "e2e/start-pick":
      if (import.meta.env.WXT_E2E === "1") {
        await startPick(req.tabId);
        return { ok: true, data: null };
      }
      return { ok: false, error: "disabled" };
  }
}

export default defineBackground(() => {
  void loadLang();
  onLangChange(() => undefined);
  browser.commands.onCommand.addListener((command, tab) => {
    if (command === "start-pick") void startPick(tab?.id);
  });
  browser.action.onClicked.addListener((tab) => void startPick(tab.id));

  // 아이콘 우클릭 메뉴에서 사이드 패널 열기.
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({ id: "open-panel", title: (browser.i18n.getMessage as (key: string) => string)("menuPanel") || "Sessions panel", contexts: ["action"] });
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "open-panel" && tab?.windowId !== undefined) void browser.sidePanel.open({ windowId: tab.windowId });
  });

  // 새로고침·이동 뒤: 이 페이지 몫의 초안·칩이 있고 그 사이트 권한이 있으면 오버레이를 다시 넣어 되살린다.
  // (권한이 없으면 다음에 단축키를 누를 때 되살아난다)
  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== "complete" || !tab.url || !/^https?:/.test(tab.url)) return;
    void (async () => {
      if (!(await drafts.hasPageState(tabId, tab.url!))) return;
      const origin = `${new URL(tab.url!).origin}/*`;
      if (!(await browser.permissions.contains({ origins: [origin] }).catch(() => false))) return;
      await ensureOverlay(tabId).catch(() => undefined);
    })();
  });
  browser.tabs.onRemoved.addListener((tabId) => void drafts.forgetTab(tabId));

  // Chrome 계열은 onMessage에서 Promise 반환을 보장하지 않으므로 sendResponse + true.
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handle(msg as Request, sender).then(sendResponse, (e: unknown) =>
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
    return true;
  });
});
