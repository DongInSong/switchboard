// 전체 흐름 E2E: 임시 데몬 + 시험 페이지 + 확장(e2e 빌드) + 가짜 Claude 세션(격리된 tmux 서버)을 headless Chromium에서 돌린다.
// 실제 세션·실제 tmux 서버·실제 설정 디렉터리는 건드리지 않는다.
// 실행: pnpm --filter @switchboard/extension e2e
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { EXTENSION_ID, NATIVE_HOST_NAME } from "../../../packages/protocol/src/native.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const extDir = resolve(here, "../.output-e2e/chrome-mv3");
const fixtureDir = resolve(repo, "apps/fixture");
// E2E_CLI=dist/switchboard.mjs 이면 릴리즈용 단일 파일 데몬으로 돌린다
const cli = process.env.E2E_CLI ? resolve(process.env.E2E_CLI) : resolve(repo, "apps/daemon/bin/switchboard.js");
const PORT = 7592;
const FIXTURE_PORT = 5298;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}`;
const SOCKET = `sb-e2e-${process.pid}`;
const artifacts = process.env.E2E_ARTIFACTS;

const tmp = mkdtempSync(join(tmpdir(), "sb-e2e-"));
const claudeDir = join(tmp, "claude");
const agentsFile = join(tmp, "agents.json");
const fakeLog = join(tmp, "fake.log");
const control = join(tmp, "control.json");
const vsControl = join(tmp, "vscode-control.json");
const openedLog = join(tmp, "opened.log");
const opener = join(tmp, "fake-open.sh");
const env = {
  ...process.env,
  SWITCHBOARD_STATE_DIR: join(tmp, "state"),
  SWITCHBOARD_DATA_DIR: join(tmp, "data"),
  SWITCHBOARD_PORT: String(PORT),
  // 사용자의 실제 설정 파일(~/.config/switchboard/config.json)을 읽지 않게
  SWITCHBOARD_CONFIG: join(tmp, "config.json"),
  // VS Code를 실제로 띄우지 않고 연 주소만 기록
  SWITCHBOARD_OPEN_COMMAND: opener,
  SWITCHBOARD_AGENTS_FILE: agentsFile,
  SWITCHBOARD_TMUX_SOCKET: SOCKET,
  CLAUDE_CONFIG_DIR: claudeDir,
};
const children = [];
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function waitFor(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch {}
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error(`timeout: ${fn.toString().slice(0, 120)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => execFileSync("tmux", ["-L", SOCKET, "-f", "/dev/null", ...a], { encoding: "utf8" });
const fakeEntries = () => (existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function pngSize(file) {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

async function main() {
  if (!existsSync(join(extDir, "manifest.json"))) throw new Error(`e2e 빌드 없음: ${extDir} (pnpm build:e2e)`);

  // 가짜 Claude 세션: 격리된 tmux 서버, 넓은 화면(긴 경로가 줄바꿈되지 않게)
  writeFileSync(control, JSON.stringify({ dialog: false }));
  const fakeCmd = [process.execPath, join(here, "fake-claude.mjs"), `agents=${agentsFile}`, `claudeDir=${claudeDir}`, `cwd=${fixtureDir}`, `log=${fakeLog}`, `control=${control}`]
    .map((a) => `'${a}'`)
    .join(" ");
  tmux("new-session", "-d", "-s", "e2e", "-x", "220", "-y", "50", "-c", fixtureDir, fakeCmd);
  await waitFor(() => existsSync(agentsFile));
  // 가짜 VS Code 세션: tmux 밖, 다른 폴더(추천 1위를 뺏지 않게)
  writeFileSync(opener, `#!/bin/sh\necho "$1" >> '${openedLog}'\n`, { mode: 0o755 });
  writeFileSync(vsControl, "{}");
  const vsCwd = join(tmp, "vscode-proj");
  mkdirSync(vsCwd, { recursive: true });
  const vscodeProc = spawn(process.execPath, [join(here, "fake-vscode.mjs"), `agents=${agentsFile}`, `claudeDir=${claudeDir}`, `cwd=${vsCwd}`, `control=${vsControl}`], { stdio: "ignore" });
  children.push(vscodeProc);
  await waitFor(() => readFileSync(agentsFile, "utf8").includes("fake-vscode"));

  const daemon = spawn(process.execPath, [cli, "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(daemon);
  let daemonOut = "";
  daemon.stdout.on("data", (d) => (daemonOut += d));
  daemon.stderr.on("data", (d) => process.stderr.write(`[daemon] ${d}`));
  await waitFor(() => fetch(`http://127.0.0.1:${PORT}/v1/health`).then((r) => r.ok));

  const vite = spawn(join(repo, "node_modules/.bin/vite"), ["--port", String(FIXTURE_PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: fixtureDir, stdio: "ignore", env: process.env });
  children.push(vite);
  await waitFor(() => fetch(FIXTURE).then((r) => r.ok));

  const sessions = execFileSync(process.execPath, [cli, "sessions", "--json"], { env, encoding: "utf8" });
  const fake = JSON.parse(sessions).sessions.find((s) => s.name === "fake-e2e");
  check("가짜 세션 발견 + 격리 tmux pane 연결", fake?.dispatchable === true && fake?.tmux?.session === "e2e", fake?.tmux?.paneId);
  check("세션 목록 출처 = 레지스트리 파일(claude agents는 가끔만)", JSON.parse(sessions).source === "registry", JSON.parse(sessions).source);
  const vs = JSON.parse(sessions).sessions.find((s) => s.name === "fake-vscode");
  check("VS Code 세션: tmux 밖이어도 VS Code 방식으로 보낼 수 있음", vs?.surface === "vscode" && vs?.delivery === "vscode" && vs?.dispatchable === true, JSON.stringify({ surface: vs?.surface, delivery: vs?.delivery }));

  const context = await chromium.launchPersistentContext(join(tmp, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    // 아래 확인들은 한국어 화면 기준(언어 자동 = 브라우저 언어). 영어는 마지막에 설정에서 바꿔 확인한다.
    locale: "ko-KR",
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--lang=ko"],
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: FIXTURE });
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const extId = new URL(sw.url()).host;
    check("확장 로드", Boolean(extId), extId);

    // 사이드 패널(탭으로 열기): 데몬 주소를 테스트 포트로 바꾸고 UI로 페어링
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await panel.evaluate((base) => chrome.storage.local.set({ "sb:base": base }), `http://127.0.0.1:${PORT}`);
    await panel.reload();
    await panel.getByText("연결", { exact: true }).waitFor();
    const out = execFileSync(process.execPath, [cli, "pair"], { env, encoding: "utf8" }).replace(/\x1b\[[0-9;]*m/g, "");
    const code = /(\d{3}) (\d{3})/.exec(out);
    await panel.locator("input").fill(`${code[1]} ${code[2]}`);
    await panel.getByRole("button", { name: "확인" }).click();
    await panel.locator("table").waitFor({ timeout: 10000 });
    check("페어링 후 세션 표 (tmux 세션 + VS Code 세션)", (await panel.locator("tbody tr").count()) === 2);

    const page = await context.newPage();
    await page.goto(FIXTURE);
    await page.locator(".avatar").waitFor();
    const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}/*` }))[0]?.id, FIXTURE);
    const startPick = async () => {
      await page.bringToFront();
      await panel.evaluate((id) => chrome.runtime.sendMessage({ type: "e2e/start-pick", tabId: id }), tabId);
      await page.locator("switchboard-ui .sb-glass").waitFor({ state: "attached" });
    };
    const box = await page.locator('[data-testid="avatar-button"]').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // ---- 0. 선택 모드에서 우클릭하면 빠져나온다
    await startPick();
    await page.mouse.move(cx, cy, { steps: 2 });
    await page.mouse.click(cx, cy, { button: "right" });
    await waitFor(async () => (await page.locator("switchboard-ui .sb-glass").count()) === 0, 3000).catch(() => null);
    check("우클릭 = 선택 취소", (await page.locator("switchboard-ui .sb-glass").count()) === 0 && (await page.locator("switchboard-ui .sb-pop").count()) === 0);

    // ---- 1. 선택 → 추천 자동 선택 → 보내기 → 완료
    await startPick();
    await page.mouse.move(cx - 30, cy);
    await page.mouse.move(cx, cy, { steps: 4 });
    await waitFor(async () => (await page.locator("switchboard-ui .sb-label").textContent())?.includes("AvatarMenu"), 5000);
    await page.mouse.click(cx, cy);
    await page.locator("switchboard-ui .sb-pop").waitFor();
    check("페이지 클릭은 막힘", (await page.locator(".dropdown").count()) === 0);
    // 선택 직후 클릭 없이 바로 칠 수 있어야 한다(사용자 지적: 한 번 클릭해야 했음)
    const focusedText = () => page.evaluate(() => document.querySelector("switchboard-ui")?.shadowRoot?.activeElement?.className ?? "");
    await waitFor(async () => (await focusedText()) === "sb-text", 2000).catch(() => null);
    check("선택 직후 입력칸에 포커스", (await focusedText()) === "sb-text", await focusedText());
    // 세션 목록을 펼치면 목록 갱신(3초)이 지나도 그대로 (사용자 지적: 몇 초 뒤 저절로 닫힘)
    const sessionLine = page.locator("switchboard-ui .sb-current");
    await waitFor(async () => ((await sessionLine.textContent()) ?? "").includes("fake-e2e"), 10000);
    await sessionLine.click();
    await page.locator("switchboard-ui .sb-list").waitFor();
    await sleep(4000);
    check("펼친 세션 목록이 저절로 안 닫힘", (await page.locator("switchboard-ui .sb-list").count()) === 1);
    // 다크 테마 사이트(color-scheme: dark)에서도 목록 스크롤바는 패널 테마를 따른다
    const schemeOf = () => page.evaluate(() => getComputedStyle(document.querySelector("switchboard-ui").shadowRoot.querySelector(".sb-list")).colorScheme);
    await page.evaluate(() => (document.documentElement.style.colorScheme = "dark"));
    const lightScheme = await schemeOf();
    await page.emulateMedia({ colorScheme: "dark" });
    const darkScheme = await schemeOf();
    await page.emulateMedia({ colorScheme: "light" });
    await page.evaluate(() => (document.documentElement.style.colorScheme = ""));
    check("스크롤바 테마 = 패널 테마(페이지 color-scheme 무시)", lightScheme === "light" && darkScheme === "dark", `${lightScheme}/${darkScheme}`);
    await sessionLine.click();
    const current = page.locator("switchboard-ui .sb-current");
    await waitFor(async () => (await current.textContent())?.includes("fake-e2e"), 10000);
    const currentText = (await current.textContent()) ?? "";
    check("추천 1위 자동 선택 + 근거", currentText.includes("소스 일치") && currentText.includes("dev 서버"), currentText.trim());

    // 선택 영역 미리보기: 잘라 낸 스크린샷을 canvas에 그린다(페이지를 다시 그리지 않음)
    const thumb = await waitFor(
      () =>
        page.evaluate(() => {
          const c = document.querySelector("switchboard-ui")?.shadowRoot?.querySelector(".sb-thumb canvas");
          if (!c || !c.width) return null;
          const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
          let opaque = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++;
          return opaque > 0 ? { w: c.width, h: c.height, opaque } : null;
        }),
      5000,
    ).catch(() => null);
    check("팝업 썸네일", Boolean(thumb), JSON.stringify(thumb));
    await page.locator("switchboard-ui .sb-thumb").click();
    const shotCanvas = page.locator("switchboard-ui .sb-shot canvas");
    const big = await waitFor(async () => {
      const b = await shotCanvas.boundingBox();
      return b && b.width > 0 ? b : null;
    }, 5000).catch(() => null);
    // 52px 아바타 → 최대 2배 → 104px
    check("스크린샷 크게 보기", Boolean(big && Math.round(big.width) === 104), big ? `${Math.round(big.width)}×${Math.round(big.height)}` : "");
    if (artifacts) await page.screenshot({ path: join(artifacts, "popover-shot.png") });
    await page.locator("switchboard-ui .sb-thumb").click();

    await page.locator("switchboard-ui .sb-text").fill("드롭다운이 모바일에서 잘림");
    await page.locator("switchboard-ui .sb-key", { hasText: "미리보기" }).click();
    await waitFor(async () => (await page.locator("switchboard-ui .sb-preview").textContent())?.includes("- 대상: src/AvatarMenu.tsx:~"), 5000);
    check("미리보기: 세션 기준 상대 경로", true);
    if (artifacts) {
      await page.screenshot({ path: join(artifacts, "popover.png") });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: join(artifacts, "popover-dark.png") });
      await page.emulateMedia({ colorScheme: "light" });
    }
    await page.locator("switchboard-ui .sb-text").press("Control+Enter");

    const chip1 = page.locator("switchboard-ui .sb-chip", { hasText: "#1" });
    await chip1.waitFor();
    const seen = new Set();
    await waitFor(async () => {
      const t = (await chip1.textContent()) ?? "";
      for (const s of ["예약", "전달", "작업 중", "완료"]) if (t.includes(s)) seen.add(s);
      return t.includes("완료");
    }, 15000, 50);
    check("상태 칩: 전달/작업 중 → 완료 (유휴 세션인데 예약으로 안 보임)", seen.has("완료") && seen.has("작업 중") && !seen.has("예약"), [...seen].join(" → "));
    if (artifacts) await page.screenshot({ path: join(artifacts, "chip-done.png") });
    await chip1.click();
    const replyBox = page.locator("switchboard-ui .sb-chip.is-open .sb-reply");
    await replyBox.waitFor();
    const replyText = (await replyBox.textContent()) ?? "";
    const cells = await replyBox.locator("td").allTextContents();
    if (artifacts) {
      await page.screenshot({ path: join(artifacts, "chip-open.png") });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: join(artifacts, "chip-open-dark.png") });
      await page.emulateMedia({ colorScheme: "light" });
    }
    check("완료 로그: 전체 답변 + 표", replyText.startsWith("Kept the dropdown") && cells.includes("src/style.css") && replyText.includes("Reload the page to check."), cells.join(" , "));

    const entries = fakeEntries();
    check("세션에 정확히 한 번 입력", entries.length === 1);
    const typed = entries[0]?.text ?? "";
    check("마커와 여러 줄이 그대로", typed.startsWith("[switchboard #1] 드롭다운이 모바일에서 잘림") && typed.includes("\n- 대상: src/AvatarMenu.tsx:~"), typed.split("\n")[0]);
    const screen = tmux("capture-pane", "-p", "-t", "e2e");
    check("가짜 세션 화면에 프롬프트 표시", screen.includes("❯ [switchboard #1]"));
    if (artifacts) writeFileSync(join(artifacts, "fake-screen.txt"), screen);
    await page.locator("switchboard-ui .sb-chip.is-open").getByRole("button", { name: "닫기" }).click();

    // ---- 1b. 여러 창: 따로 띄운 팝업 두 개를 각자 보낸다
    const card = await page.locator(".card").first().boundingBox();
    const kx = card.x + card.width / 2;
    const ky = card.y + card.height / 2;
    await startPick();
    await page.mouse.move(cx, cy, { steps: 2 });
    await page.mouse.click(cx, cy);
    const popA = page.locator("switchboard-ui .sb-pop", { hasText: "AvatarMenu" });
    await popA.waitFor();
    await popA.locator(".sb-text").fill("A 요청");
    await startPick();
    await page.mouse.move(kx, ky, { steps: 2 });
    await page.mouse.click(kx, ky);
    const popB = page.locator("switchboard-ui .sb-pop", { hasText: "Card" });
    await popB.waitFor();
    check("팝업 두 개 동시에", (await page.locator("switchboard-ui .sb-pop").count()) === 2);
    await popB.locator(".sb-text").fill("B 요청");
    if (artifacts) await page.screenshot({ path: join(artifacts, "popovers-two.png") });
    await waitFor(async () => !(await popB.locator(".sb-send").isDisabled()), 10000);
    await popB.locator(".sb-text").press("Control+Enter");
    await waitFor(async () => (await page.locator("switchboard-ui .sb-pop").count()) === 1, 5000);
    check("보낸 팝업만 닫히고 다른 팝업은 내용 유지", (await popA.locator(".sb-text").inputValue()) === "A 요청");
    await waitFor(async () => !(await popA.locator(".sb-send").isDisabled()), 10000);
    await popA.locator(".sb-text").press("Control+Enter");
    const chipB = page.locator("switchboard-ui .sb-chip", { hasText: "#2" });
    const chipA = page.locator("switchboard-ui .sb-chip", { hasText: "#3" });
    await waitFor(async () => ((await chipB.textContent()) ?? "").includes("완료") && ((await chipA.textContent()) ?? "").includes("완료"), 25000);
    const sep = fakeEntries();
    check("따로 보낸 두 요청이 차례로", sep.length === 3 && sep[1].text.startsWith("[switchboard #2] B 요청") && sep[2].text.startsWith("[switchboard #3] A 요청"));

    // ---- 1c. 연계: 한 팝업에 대상을 덧붙여 한 요청으로
    await startPick();
    await page.mouse.move(cx, cy, { steps: 2 });
    await page.mouse.click(cx, cy);
    const popL = page.locator("switchboard-ui .sb-pop").first();
    await popL.waitFor();
    await popL.locator(".sb-text").fill("두 곳 간격을 맞춰줘");
    await popL.locator(".sb-text").press("Alt+a");
    await page.locator("switchboard-ui .sb-glass").waitFor({ state: "attached" });
    check("연계 선택 중 덧붙일 팝업 표시", (await page.locator("switchboard-ui .sb-pop.is-attaching").count()) === 1);
    await page.mouse.move(kx, ky, { steps: 2 });
    await page.mouse.click(kx, ky);
    await popL.locator(".sb-link").waitFor();
    await waitFor(async () => (await focusedText()) === "sb-text", 2000).catch(() => null);
    check("대상 추가 뒤 원래 팝업으로 포커스", (await focusedText()) === "sb-text");
    check("대상 추가 줄 + 팝업은 하나", ((await popL.locator(".sb-link").textContent()) ?? "").includes("Card") && (await page.locator("switchboard-ui .sb-pop").count()) === 1);
    await waitFor(async () => !(await popL.locator(".sb-send").isDisabled()), 10000);
    if (artifacts) {
      await popL.locator(".sb-key", { hasText: "미리보기" }).click();
      await waitFor(async () => ((await popL.locator(".sb-preview").textContent()) ?? "").includes("대상 2"), 5000).catch(() => null);
      await page.screenshot({ path: join(artifacts, "popover-linked.png") });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: join(artifacts, "popover-linked-dark.png") });
      await page.emulateMedia({ colorScheme: "light" });
    }
    await popL.locator(".sb-text").press("Control+Enter");
    const chipL = page.locator("switchboard-ui .sb-chip", { hasText: "#4" });
    await waitFor(async () => ((await chipL.textContent()) ?? "").includes("완료"), 15000);
    const linked = fakeEntries()[3]?.text ?? "";
    check(
      "연계: 대상 1·2가 한 프롬프트에",
      linked.startsWith("[switchboard #4] 두 곳 간격을 맞춰줘") && linked.includes("- 대상 1: src/AvatarMenu.tsx") && linked.includes("- 대상 2: src/Card.tsx") && (linked.match(/스크린샷: /g) ?? []).length === 2,
      linked.split("\n").filter((l) => l.startsWith("- 대상")).join(" | "),
    );

    // ---- 2. 권한 확인 창이 떠 있으면 입력하지 않고 예약 → 창이 닫히면 전달
    writeFileSync(control, JSON.stringify({ dialog: true }));
    await waitFor(() => JSON.parse(readFileSync(agentsFile, "utf8"))[0].status === "waiting");
    await startPick();
    await page.mouse.move(cx, cy, { steps: 2 });
    await page.mouse.click(cx, cy);
    await page.locator("switchboard-ui .sb-pop").waitFor();
    await waitFor(async () => (await current.textContent())?.includes("fake-e2e"), 10000);
    await page.locator("switchboard-ui .sb-text").fill("두 번째 요청");
    const primary = page.locator("switchboard-ui .sb-send");
    const primaryText = await waitFor(async () => ((await primary.textContent())?.trim().startsWith("예약") ? "예약" : null), 5000).catch(async () => (await primary.textContent())?.trim());
    check("응답 대기 세션이면 버튼이 예약", primaryText === "예약", primaryText);
    await page.locator("switchboard-ui .sb-text").press("Control+Enter");
    const chip2 = page.locator("switchboard-ui .sb-chip", { hasText: "#5" });
    await chip2.waitFor();
    await sleep(2500);
    check("대기 중에는 입력 안 함", fakeEntries().length === 4 && (await chip2.textContent()).includes("예약"), (await chip2.textContent()).trim());
    check("대화상자 화면 그대로", tmux("capture-pane", "-p", "-t", "e2e").includes("Do you want to make this edit?"));
    writeFileSync(control, JSON.stringify({ dialog: false }));
    await waitFor(async () => (await chip2.textContent()).includes("완료"), 15000);
    check("창이 닫히면 전달 → 완료", fakeEntries().length === 5 && fakeEntries()[4].text.startsWith("[switchboard #5] 두 번째 요청"));

    // ---- 3. 저장된 결과 + 영역 선택 + 입력값 제거
    const capRoot = join(tmp, "data", "captures");
    const cap = join(capRoot, readdirSync(capRoot).sort()[0]);
    const el = pngSize(join(cap, "element.png"));
    check("스크린샷 자르기", el.w > 30 && el.w < 200, `${el.w}×${el.h}`);
    if (artifacts) {
      mkdirSync(artifacts, { recursive: true });
      copyFileSync(join(cap, "element.png"), join(artifacts, "element.png"));
    }
    check("데몬 로그에 전달 기록", /#1 fake-e2e\s+done/.test(daemonOut) && /#5 fake-e2e\s+queued \(waiting\)/.test(daemonOut));

    const before = readdirSync(capRoot).length;
    await startPick();
    const first = await page.locator(".card").first().boundingBox();
    const form = await page.locator(".login").boundingBox();
    await page.mouse.move(first.x - 6, first.y - 6);
    await page.mouse.down();
    await page.mouse.move(form.x + form.width + 6, form.y + form.height + 6, { steps: 8 });
    await page.mouse.up();
    await page.locator("switchboard-ui .sb-pop").waitFor();
    check("영역 선택 머리줄", ((await page.locator("switchboard-ui .sb-name").textContent()) ?? "").startsWith("영역 "));
    await waitFor(() => readdirSync(capRoot).length === before + 1, 10000);
    const newest = join(capRoot, readdirSync(capRoot).sort().at(-1));
    const json2 = readFileSync(join(newest, "capture.json"), "utf8");
    const c2 = JSON.parse(json2);
    check("영역 안 요소들", c2.selection.mode === "region" && c2.selection.others.length >= 3, `others ${c2.selection.others.length}`);
    check("입력값·비밀번호 미수집", !json2.includes("hunter2") && !json2.includes("me@example.com"));

    await page.locator("switchboard-ui .sb-pop").getByRole("button", { name: "닫기", exact: true }).click();

    // ---- 3b. 화면을 거의 다 덮는 영역: 옆에 자리가 없으면 드래그를 끝낸 점에 붙어 화면 안에 뜬다
    {
      const vp = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }));
      const end = { x: vp.w - 10, y: vp.h - 10 };
      await startPick();
      await page.mouse.move(10, 10);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await page.mouse.up();
      const bigPop = page.locator("switchboard-ui .sb-pop");
      await bigPop.waitFor();
      await waitFor(async () => !(await bigPop.locator(".sb-send").isDisabled()), 10000).catch(() => null);
      const inside = (b, v) => b && b.x >= 7 && b.y >= 7 && b.x + b.width <= v.w - 7 && b.y + b.height <= v.h - 7;
      const box = await bigPop.boundingBox();
      check(
        "큰 영역: 팝업이 화면 안, 놓은 점 왼쪽 위",
        inside(box, vp) && Math.abs(box.x + box.width - (end.x - 12)) <= 2 && Math.abs(box.y + box.height - (end.y - 12)) <= 2,
        box && `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}`,
      );
      if (artifacts) await page.screenshot({ path: join(artifacts, "big-region.png") });
      // 창이 낮아지면 팝업 높이를 화면에 맞추고 가운데만 스크롤
      await page.setViewportSize({ width: 1280, height: 220 });
      await bigPop.locator(".sb-text").press("Alt+p");
      await bigPop.locator(".sb-preview").waitFor();
      await waitFor(async () => ((await bigPop.locator(".sb-preview").textContent()) ?? "").length > 40, 5000).catch(() => null);
      await page.waitForTimeout(150);
      const vp2 = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }));
      const box2 = await bigPop.boundingBox();
      const body = await bigPop.locator(".sb-body").evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
      if (artifacts) await page.screenshot({ path: join(artifacts, "short-window.png") });
      check("낮은 창: 팝업이 화면 안 + 가운데 스크롤", inside(box2, vp2) && body.sh > body.ch && (await bigPop.locator(".sb-send").isVisible()), box2 && `${Math.round(box2.y)}+${Math.round(box2.height)} / ${vp2.h}, body ${body.ch}/${body.sh}`);
      await page.setViewportSize({ width: 1280, height: 800 });
      await bigPop.getByRole("button", { name: "닫기", exact: true }).click();
    }

    // ---- 4. 완료 로그에서 이어서: 앞 요청 번호 + 덧붙인 대상
    await chip2.click();
    const open5 = page.locator("switchboard-ui .sb-chip.is-open");
    await open5.locator(".sb-follow").fill("버튼 색도 같이");
    await open5.locator(".sb-follow").press("Alt+a");
    await page.locator("switchboard-ui .sb-glass").waitFor({ state: "attached" });
    await page.mouse.move(kx, ky, { steps: 2 });
    await page.mouse.click(kx, ky);
    await open5.locator(".sb-link").waitFor();
    await waitFor(async () => (await focusedText()).includes("sb-follow"), 2000).catch(() => null);
    check("이어서 쓰기에 대상 추가 + 포커스 복귀", ((await open5.locator(".sb-link").textContent()) ?? "").includes("Card") && (await focusedText()).includes("sb-follow"));
    await waitFor(async () => !(await open5.locator(".sb-send").isDisabled()), 10000);
    if (artifacts) await page.screenshot({ path: join(artifacts, "chip-follow.png") });
    await open5.locator(".sb-follow").press("Control+Enter");
    const chip6 = page.locator("switchboard-ui .sb-chip", { hasText: "#6" });
    await waitFor(async () => ((await chip6.textContent()) ?? "").includes("완료"), 15000);
    const fu = fakeEntries()[5]?.text ?? "";
    check("이어서: #5에 이어서 + 대상", fu.startsWith("[switchboard #6] 버튼 색도 같이") && fu.includes("- #5에 이어서") && fu.includes("- 대상 1: src/Card.tsx"), fu.split("\n").slice(0, 4).join(" | "));

    // ---- 5. 다른 페이지 연계(레퍼런스): alt+a 뒤 다른 탭에서 고르면 원래 요청에 붙는다
    await startPick();
    await page.mouse.move(cx, cy, { steps: 2 });
    await page.mouse.click(cx, cy);
    const popX = page.locator("switchboard-ui .sb-pop").first();
    await popX.waitFor();
    await popX.locator(".sb-text").fill("이 메뉴를 다른 페이지 배너처럼");
    await waitFor(async () => !(await popX.locator(".sb-send").isDisabled()), 10000);
    await popX.locator(".sb-text").press("Alt+a");
    await page.locator("switchboard-ui .sb-glass").waitFor({ state: "attached" });
    const page2 = await context.newPage();
    await page2.goto(`${FIXTURE}/other.html`);
    await page2.locator(".banner").waitFor();
    const tab2 = await panel.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${FIXTURE}/other.html`);
    await page2.bringToFront();
    await panel.evaluate((id) => chrome.runtime.sendMessage({ type: "e2e/start-pick", tabId: id }), tab2);
    const banner = page2.locator("switchboard-ui .sb-banner");
    await banner.waitFor({ timeout: 8000 });
    check("다른 페이지: 덧붙일 요청 표시", ((await banner.textContent()) ?? "").includes("AvatarMenu"), (await banner.textContent())?.trim());
    if (artifacts) await page2.screenshot({ path: join(artifacts, "remote-picking.png") });
    const bb = await page2.locator(".banner").boundingBox();
    await page2.mouse.move(bb.x + 12, bb.y + 12, { steps: 2 });
    await page2.mouse.click(bb.x + 12, bb.y + 12);
    const toast2 = page2.locator("switchboard-ui .sb-toast");
    await toast2.waitFor();
    check("다른 페이지: 붙임 알림, 새 팝업 없음", ((await toast2.textContent()) ?? "").includes("붙임") && (await page2.locator("switchboard-ui .sb-pop").count()) === 0, (await toast2.textContent())?.trim());
    await page.bringToFront();
    await popX.locator(".sb-link").waitFor();
    const xr = (await popX.locator(".sb-link").textContent()) ?? "";
    check("원래 팝업에 다른 페이지 대상(페이지 표시)", xr.includes("Banner") && xr.includes("/other.html") && (await page.locator("switchboard-ui .sb-glass").count()) === 0, xr.trim());

    // alt+l: 다른 페이지에서 만든 요청을 원래 요청에 통째로 붙이기
    await page2.bringToFront();
    await panel.evaluate((id) => chrome.runtime.sendMessage({ type: "e2e/start-pick", tabId: id }), tab2);
    await page2.locator("switchboard-ui .sb-glass").waitFor({ state: "attached" });
    await page2.mouse.move(bb.x + bb.width - 12, bb.y + bb.height - 12, { steps: 2 });
    await page2.mouse.click(bb.x + bb.width - 12, bb.y + bb.height - 12);
    const pop2 = page2.locator("switchboard-ui .sb-pop");
    await pop2.waitFor();
    await pop2.locator(".sb-key", { hasText: "연결" }).waitFor({ timeout: 8000 });
    await pop2.locator(".sb-text").press("Alt+l");
    const target = pop2.locator(".sb-linklist .sb-srow", { hasText: "이 메뉴를" });
    await waitFor(async () => !(await target.isDisabled()), 10000);
    if (artifacts) await page2.screenshot({ path: join(artifacts, "link-into.png") });
    await target.click();
    await waitFor(async () => (await page2.locator("switchboard-ui .sb-pop").count()) === 0, 5000);
    await page.bringToFront();
    await waitFor(async () => (await popX.locator(".sb-link").count()) === 2, 5000).catch(() => null);
    check("alt+l: 다른 페이지 요청이 원래 팝업에 붙음", (await popX.locator(".sb-link").count()) === 2);
    if (artifacts) await page.screenshot({ path: join(artifacts, "popover-remote-linked.png") });
    await waitFor(async () => !(await popX.locator(".sb-send").isDisabled()), 10000);
    await popX.locator(".sb-text").press("Control+Enter");
    const chip7 = page.locator("switchboard-ui .sb-chip", { hasText: "#7" });
    await waitFor(async () => ((await chip7.textContent()) ?? "").includes("완료"), 15000);
    const xp = fakeEntries()[6]?.text ?? "";
    check(
      "다른 페이지 대상이 한 프롬프트에(페이지별)",
      xp.startsWith("[switchboard #7] 이 메뉴를 다른 페이지 배너처럼") && xp.includes("- 대상 1: src/AvatarMenu.tsx") && xp.includes("- 대상 2: src/Banner.tsx") && xp.includes("- 대상 3: src/Banner.tsx") && /- 페이지\(대상 2, 3\): \S+\/other\.html/.test(xp),
      xp.split("\n").filter((l) => l.startsWith("- 대상") || l.startsWith("- 페이지")).join(" | "),
    );

    // ---- 6. 새로고침해도 쓰던 팝업과 칩이 되살아난다
    await startPick();
    await page.mouse.move(cx, cy, { steps: 2 });
    await page.mouse.click(cx, cy);
    await page.locator("switchboard-ui .sb-pop").waitFor();
    await page.locator("switchboard-ui .sb-text").fill("새로고침해도 남음");
    await sleep(800);
    await page.reload();
    const restoredText = await waitFor(async () => {
      const t = page.locator("switchboard-ui .sb-text");
      return (await t.count()) ? await t.inputValue() : null;
    }, 10000).catch(() => null);
    check("새로고침 뒤 팝업·쓰던 글 복원", restoredText === "새로고침해도 남음", String(restoredText));
    check("새로고침 뒤 칩 복원", (await page.locator("switchboard-ui .sb-chip", { hasText: "#7" }).count()) === 1);
    await page.locator("switchboard-ui .sb-pop").getByRole("button", { name: "닫기", exact: true }).click();

    // ---- 7. 사이드 패널 기록
    await panel.bringToFront();
    await panel.getByRole("button", { name: "기록" }).click();
    await panel.locator(".history li").first().waitFor();
    await waitFor(async () => (await panel.locator(".history .hrow").allTextContents()).every((r) => r.includes("완료")), 8000).catch(() => null);
    const rows = await panel.locator(".history .hrow").allTextContents();
    check("기록 탭", rows.length === 7 && rows.every((r) => r.includes("완료")) && rows[1].includes("← #5"), rows.map((r) => r.replace(/\s+/g, " ")).join(" | "));
    await panel.locator(".history .hrow").first().click();
    const histImg = await waitFor(() => panel.evaluate(() => document.querySelector(".hshot")?.naturalWidth || null), 5000).catch(() => null);
    check("기록 썸네일", Boolean(histImg), `${histImg}px`);
    await panel.locator(".hdetail .md table").waitFor({ timeout: 5000 });
    const pcells = await panel.locator(".hdetail .md td").allTextContents();
    check("기록: 전체 답변 표", pcells.includes("src/style.css") && ((await panel.locator(".hdetail .md").textContent()) ?? "").includes("Reload the page to check."));
    await panel.locator(".follow textarea").fill("패널에서 이어서");
    await panel.locator(".follow textarea").press("Control+Enter");
    await waitFor(() => fakeEntries().length === 8, 15000).catch(() => null);
    const pf = fakeEntries()[7]?.text ?? "";
    check("기록에서 이어서", pf.startsWith("[switchboard #8] 패널에서 이어서") && pf.includes("- #7에 이어서"), pf.split("\n").join(" | "));

    // ---- 8. 설정 탭: 데몬 주소는 이 컴퓨터만, 고치면 바로 그 주소로
    await panel.getByRole("button", { name: "설정" }).click();
    const daemonField = panel.getByLabel("데몬 주소");
    await waitFor(async () => (await daemonField.inputValue()) === `http://127.0.0.1:${PORT}`, 5000);
    await panel.locator(".settings").getByText("● 연결됨").waitFor({ timeout: 5000 });
    check("설정: 데몬 주소·연결 상태", true);
    await daemonField.fill("http://example.com:7490");
    await panel.getByRole("button", { name: "적용" }).click();
    await panel.getByText("이 컴퓨터 주소만").waitFor({ timeout: 3000 }).catch(() => null);
    check("설정: 바깥 주소 거절", (await panel.getByText("이 컴퓨터 주소만").count()) === 1);
    await daemonField.fill("http://127.0.0.1:1");
    await panel.getByRole("button", { name: "적용" }).click();
    await panel.locator(".settings").getByText("● 연결 안 됨").waitFor({ timeout: 8000 }).catch(() => null);
    check("설정: 바꾼 주소로 바로 접속(없는 포트 → 연결 안 됨)", (await panel.locator(".settings").getByText("● 연결 안 됨").count()) === 1);
    await daemonField.fill(String(PORT));
    await panel.getByRole("button", { name: "적용" }).click();
    await waitFor(async () => (await daemonField.inputValue()) === `http://127.0.0.1:${PORT}` && (await panel.locator(".settings").getByText("● 연결됨").count()) === 1, 8000).catch(() => null);
    check("설정: 포트만 써도 주소로 맞춰 다시 연결", (await panel.locator(".settings").getByText("● 연결됨").count()) === 1, await daemonField.inputValue());
    if (artifacts) {
      await panel.screenshot({ path: join(artifacts, "panel-settings.png") });
      await panel.emulateMedia({ colorScheme: "dark" });
      await panel.screenshot({ path: join(artifacts, "panel-settings-dark.png") });
      await panel.emulateMedia({ colorScheme: "light" });
    }
    await panel.getByRole("button", { name: "기록" }).click();

    if (artifacts) {
      await panel.screenshot({ path: join(artifacts, "panel-history.png") });
      await panel.emulateMedia({ colorScheme: "dark" });
      await panel.setViewportSize({ width: 380, height: 640 });
      await panel.screenshot({ path: join(artifacts, "panel-history-dark.png") });
      await panel.getByRole("button", { name: "세션" }).click();
      await panel.screenshot({ path: join(artifacts, "panel-sessions-dark.png") });
    }

    // ---- 9. VS Code 세션: 복사 → 그 탭 띄우기 → (사용자가 붙여 넣으면) 기록으로 추적 → 완료
    await page.bringToFront();
    await startPick();
    await page.mouse.move(cx, cy, { steps: 2 });
    await page.mouse.click(cx, cy);
    const popV = page.locator("switchboard-ui .sb-pop");
    await popV.waitFor();
    await waitFor(async () => ((await popV.locator(".sb-current").textContent()) ?? "").includes("fake-e2e"), 10000);
    await popV.locator(".sb-current").click();
    await popV.locator(".sb-srow", { hasText: "fake-vscode" }).click();
    const cur = (await popV.locator(".sb-current").textContent()) ?? "";
    await popV.locator(".sb-text").fill("VS Code로 보내기");
    await waitFor(async () => !(await popV.locator(".sb-send").isDisabled()), 10000);
    const btn = ((await popV.locator(".sb-send").textContent()) ?? "").trim();
    check("VS Code 세션 고르면 표시 + 버튼이 복사", cur.includes("fake-vscode") && cur.includes("VS Code") && btn.startsWith("복사"), `${cur.trim()} / ${btn}`);
    if (artifacts) await page.screenshot({ path: join(artifacts, "popover-vscode.png") });
    const tmuxBefore = fakeEntries().length;
    await popV.locator(".sb-text").press("Control+Enter");
    const toastV = page.locator("switchboard-ui .sb-toast");
    await toastV.waitFor();
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `ERR ${e}`);
    const vmatch = /^\[switchboard #(\d+)\] VS Code로 보내기/.exec(clip);
    check("복사됨 + 붙여넣기 안내", Boolean(vmatch) && ((await toastV.textContent()) ?? "").includes("ctrl+v"), clip.split("\n")[0]);
    const vid = vmatch?.[1];
    const chipV = page.locator("switchboard-ui .sb-chip", { hasText: `#${vid}` });
    await waitFor(async () => ((await chipV.textContent()) ?? "").includes("붙여넣기"), 5000).catch(() => null);
    const opened = await waitFor(() => (existsSync(openedLog) ? readFileSync(openedLog, "utf8").trim() : null), 5000).catch(() => "");
    check(
      "칩은 붙여넣기 대기 + 그 세션 탭 주소를 엶 + tmux로는 안 보냄",
      ((await chipV.textContent()) ?? "").includes("붙여넣기") && opened === "vscode://anthropic.claude-code/open?session=e2e00000-0000-4000-8000-00000000c0de" && fakeEntries().length === tmuxBefore,
      opened,
    );
    if (artifacts) await page.screenshot({ path: join(artifacts, "chip-paste.png") });
    // 사용자가 VS Code 입력칸에 붙여 넣고 Enter
    writeFileSync(vsControl, JSON.stringify({ seq: 1, paste: clip }));
    const vseen = new Set();
    await waitFor(async () => {
      const t = (await chipV.textContent()) ?? "";
      for (const st of ["작업 중", "완료"]) if (t.includes(st)) vseen.add(st);
      return t.includes("완료");
    }, 15000, 100).catch(() => null);
    await chipV.click();
    const vreply = page.locator("switchboard-ui .sb-chip.is-open .sb-reply");
    await vreply.waitFor({ timeout: 5000 }).catch(() => null);
    check("붙여 넣은 뒤: 작업 중 → 완료, 답변 표시", vseen.has("완료") && ((await vreply.textContent()) ?? "").includes("Received in VS Code."), [...vseen].join(" → "));

    // ---- 9b. Native Messaging: 데몬을 끄고 HTTP 경로(토큰·주소)도 막은 뒤, 브라우저가 호스트를 띄워 데몬을 켜고 페어링 없이 보내는지
    check("확장 ID 고정(manifest key)", extId === EXTENSION_ID, extId);
    const launcher = join(tmp, "native-host.sh");
    const keep = ["PATH", "SWITCHBOARD_STATE_DIR", "SWITCHBOARD_DATA_DIR", "SWITCHBOARD_PORT", "SWITCHBOARD_AGENTS_FILE", "SWITCHBOARD_TMUX_SOCKET", "SWITCHBOARD_CONFIG", "SWITCHBOARD_OPEN_COMMAND", "CLAUDE_CONFIG_DIR", "SWITCHBOARD_PROC_SOURCE", "SWITCHBOARD_PORT_OWNER"];
    const exportsSh = keep.filter((k) => env[k] !== undefined).map((k) => `export ${k}='${env[k]}'`);
    writeFileSync(launcher, `#!/bin/sh\n${exportsSh.join("\n")}\nexec '${process.execPath}' '${cli}' native-host\n`, { mode: 0o755 });
    // --user-data-dir를 쓰면 Chromium은 그 안의 NativeMessagingHosts에서 찾는다(사용자 실제 브라우저 설정은 건드리지 않음)
    mkdirSync(join(tmp, "profile", "NativeMessagingHosts"), { recursive: true });
    writeFileSync(
      join(tmp, "profile", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`),
      JSON.stringify({ name: NATIVE_HOST_NAME, description: "Switchboard e2e host", path: launcher, type: "stdio", allowed_origins: [`chrome-extension://${extId}/`] }),
    );
    daemon.kill("SIGINT");
    await waitFor(() => fetch(`http://127.0.0.1:${PORT}/v1/health`).then(() => false, () => true), 10000);
    await panel.evaluate(async () => {
      await chrome.storage.local.set({ "sb:base": "http://127.0.0.1:1" });
      await chrome.storage.local.remove("sb:token");
    });
    await panel.bringToFront();
    await panel.reload();
    await panel.getByRole("button", { name: "설정" }).click();
    const nat = await waitFor(async () => {
      const t = (await panel.locator(".settings .line").first().textContent()) ?? "";
      return t.includes("연결됨") && t.includes("네이티브") ? t : null;
    }, 30000, 500).catch(async () => (await panel.locator(".settings .line").first().textContent()) ?? "");
    check("Native: HTTP 막힌 채로 브라우저가 호스트→데몬을 켜고 페어링 없이 연결", nat.includes("네이티브"), nat.trim());
    check("Native: 데몬 자동 시작(pid 파일)", existsSync(join(tmp, "state", "daemon.pid")));
    await page.bringToFront();
    await startPick();
    await page.mouse.move(cx, cy, { steps: 2 });
    await page.mouse.click(cx, cy);
    const popN = page.locator("switchboard-ui .sb-pop");
    await popN.waitFor();
    await waitFor(async () => ((await popN.locator(".sb-current").textContent()) ?? "").includes("fake-e2e"), 15000);
    await popN.locator(".sb-text").fill("네이티브로 보냄");
    await waitFor(async () => !(await popN.locator(".sb-send").isDisabled()), 10000);
    const nBefore = fakeEntries().length;
    await popN.locator(".sb-text").press("Control+Enter");
    await waitFor(() => fakeEntries().length === nBefore + 1, 15000).catch(() => null);
    const nText = fakeEntries().at(-1)?.text ?? "";
    check("Native: 스크린샷 업로드(multipart)·요청·tmux 전달", /^\[switchboard #\d+\] 네이티브로 보냄/.test(nText) && nText.includes("element.png"), nText.split("\n")[0]);
    await panel.bringToFront();
    await panel.getByRole("button", { name: "기록" }).click();
    await panel.locator(".history .hrow").first().click();
    const nImg = await waitFor(() => panel.evaluate(() => document.querySelector(".hshot")?.naturalWidth || null), 8000).catch(() => null);
    check("Native: 기록 썸네일(바이너리 응답)", Boolean(nImg), `${nImg}px`);
    await panel.getByRole("button", { name: "세션" }).click();

    // ---- 10. 언어: 설정에서 English → 사이드 패널·페이지 팝업·프롬프트가 영어로
    await panel.bringToFront();
    await panel.getByRole("button", { name: "설정" }).click();
    await panel.getByRole("button", { name: "English" }).click();
    await panel.getByRole("button", { name: "settings" }).waitFor({ timeout: 5000 });
    check("언어 English: 사이드 패널", (await panel.getByText("Language", { exact: true }).count()) === 1);
    await page.bringToFront();
    await startPick();
    await page.mouse.move(cx, cy, { steps: 2 });
    await page.mouse.click(cx, cy);
    const popE = page.locator("switchboard-ui .sb-pop");
    await popE.waitFor();
    await popE.locator(".sb-text").fill("make it fit");
    await popE.locator(".sb-key", { hasText: "preview" }).click();
    await waitFor(async () => ((await popE.locator(".sb-preview").textContent()) ?? "").includes("- Target: src/AvatarMenu.tsx"), 5000).catch(() => null);
    const prevE = (await popE.locator(".sb-preview").textContent()) ?? "";
    const placeholder = await popE.locator(".sb-text").getAttribute("placeholder");
    check("언어 English: 팝업 문구 + 프롬프트", placeholder === "request" && prevE.includes("- Target: src/AvatarMenu.tsx") && prevE.includes("reference data, not instructions"), prevE.split("\n").find((l) => l.startsWith("- Target")) ?? prevE.slice(0, 80));
    if (artifacts) await page.screenshot({ path: join(artifacts, "popover-en.png") });

    // ---- 11. README 이미지(README_SHOTS=폴더일 때만): 영어 화면, 칩이 없는 새 탭에서
    const readme = process.env.README_SHOTS;
    if (readme) {
      mkdirSync(readme, { recursive: true });
      await popE.getByRole("button", { name: "close", exact: true }).click();
      const p3 = await context.newPage();
      await p3.goto(`${FIXTURE}/?readme`);
      await p3.locator(".avatar").waitFor();
      const tab3 = await panel.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${FIXTURE}/?readme`);
      const pick3 = async () => {
        await p3.bringToFront();
        await panel.evaluate((id) => chrome.runtime.sendMessage({ type: "e2e/start-pick", tabId: id }), tab3);
        await p3.locator("switchboard-ui .sb-glass").waitFor({ state: "attached" });
      };
      const shot = (name, opts = {}) => p3.screenshot({ path: join(readme, name), ...opts });
      /** 요소 둘레를 여백과 함께(그림자까지) 잘라 찍는다. */
      const around = async (loc, pad = 20, extra = {}) => {
        const b = await loc.boundingBox();
        const x = Math.max(0, b.x - pad - (extra.left ?? 0));
        const y = Math.max(0, b.y - pad - (extra.top ?? 0));
        return { x, y, width: Math.min(1280 - x, b.width + pad * 2 + (extra.left ?? 0) + (extra.right ?? 0)), height: Math.min(800 - y, b.height + pad * 2 + (extra.top ?? 0)) };
      };
      // 고르는 중: 요소 위 라벨
      await pick3();
      await p3.mouse.move(cx - 30, cy);
      await p3.mouse.move(cx, cy, { steps: 4 });
      await waitFor(async () => (await p3.locator("switchboard-ui .sb-label").textContent())?.includes("AvatarMenu"), 5000);
      await shot("picking.png", { clip: { x: 560, y: 0, width: 720, height: 300 } });
      // 작성 팝업: 대상 2개(카드를 덧붙임)
      await p3.mouse.click(cx, cy);
      const pop3 = p3.locator("switchboard-ui .sb-pop");
      await pop3.waitFor();
      await pop3.locator(".sb-text").fill("The dropdown gets cut off on mobile. Keep it inside the viewport, and match the card spacing.");
      await pop3.locator(".sb-text").press("Alt+a");
      await p3.locator("switchboard-ui .sb-glass").waitFor({ state: "attached" });
      await p3.mouse.move(kx, ky, { steps: 2 });
      await p3.mouse.click(kx, ky);
      await pop3.locator(".sb-link").waitFor();
      await waitFor(async () => !(await pop3.locator(".sb-send").isDisabled()), 10000);
      await waitFor(async () => ((await pop3.locator(".sb-current").textContent()) ?? "").includes("fake-e2e"), 10000);
      await sleep(300);
      await shot("compose.png", { clip: await around(pop3, 24, { left: 120, right: 60 }) });
      // 보내고 → 완료 → 전체 답변
      await pop3.locator(".sb-text").press("Control+Enter");
      const chip3 = p3.locator("switchboard-ui .sb-chip").last();
      await waitFor(async () => ((await chip3.textContent()) ?? "").includes("done"), 20000);
      await chip3.click();
      await p3.locator("switchboard-ui .sb-chip.is-open .sb-reply table").waitFor();
      await p3.locator("switchboard-ui .sb-chip.is-open .sb-follow").click();
      await sleep(200);
      const openChip = p3.locator("switchboard-ui .sb-chip.is-open");
      await shot("answer.png", { clip: await around(openChip, 20) });
      await p3.emulateMedia({ colorScheme: "dark" });
      await sleep(200);
      await shot("answer-dark.png", { clip: await around(openChip, 20) });
      await p3.emulateMedia({ colorScheme: "light" });
      await p3.locator("switchboard-ui .sb-chip.is-open .sb-chip-head").click();
      // VS Code 세션
      await pick3();
      await p3.mouse.move(cx, cy, { steps: 2 });
      await p3.mouse.click(cx, cy);
      const popV3 = p3.locator("switchboard-ui .sb-pop");
      await popV3.waitFor();
      await waitFor(async () => ((await popV3.locator(".sb-current").textContent()) ?? "").includes("fake-e2e"), 10000);
      await popV3.locator(".sb-current").click();
      await popV3.locator(".sb-srow", { hasText: "fake-vscode" }).click();
      await popV3.locator(".sb-text").fill("Use the header color for this button");
      await waitFor(async () => !(await popV3.locator(".sb-send").isDisabled()), 10000);
      await sleep(200);
      await shot("vscode.png", { clip: await around(popV3, 24, { left: 120, right: 60 }) });
      await popV3.getByRole("button", { name: "close", exact: true }).click();
      // 사이드 패널: 기록(전체 답변) / 설정
      await panel.bringToFront();
      await panel.setViewportSize({ width: 440, height: 760 });
      await panel.emulateMedia({ colorScheme: "light" });
      await panel.getByRole("button", { name: "history" }).click();
      await panel.locator(".history .hrow").first().click();
      await panel.locator(".hdetail .md table").waitFor({ timeout: 8000 });
      await sleep(300);
      // 펼친 항목(이 요청)까지만: 아래 목록에는 다른 시험 요청이 있다
      const followBox = await panel.locator(".follow").boundingBox();
      await panel.screenshot({ path: join(readme, "panel-history.png"), clip: { x: 0, y: 0, width: 440, height: Math.ceil(followBox.y + followBox.height + 12) } });
      await panel.getByRole("button", { name: "settings" }).click();
      await panel.locator(".settings").waitFor();
      await sleep(300);
      await panel.screenshot({ path: join(readme, "panel-settings.png") });
      console.log(`README 이미지: ${readme}`);
    }
  } finally {
    await context.close();
  }
}

try {
  await main();
} catch (e) {
  failures++;
  console.error("FAIL ", e?.stack ?? e);
} finally {
  for (const c of children) c.kill("SIGINT");
  // 호스트가 켠 데몬(분리된 프로세스)도 끈다
  try {
    const pid = Number(readFileSync(join(tmp, "state", "daemon.pid"), "utf8"));
    if (pid > 0) process.kill(pid, "SIGINT");
  } catch {}
  try {
    tmux("kill-server");
  } catch {}
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "\nE2E 통과" : `\nE2E 실패 ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
