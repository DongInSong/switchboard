import type { RequestInfo } from "@switchboard/protocol";
import { FINAL_DISPATCH_STATES } from "@switchboard/protocol";
import { defaultPort } from "../config.ts";
import { t } from "../i18n.ts";
import type { Style } from "./format.ts";
import { api } from "./serve.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function oneLine(s: string, max = 48): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export async function listRequests(opts: { port?: number; json: boolean }, style: Style): Promise<number> {
  const { status, body } = await api<RequestInfo[]>(opts.port ?? defaultPort(), "/v1/requests?limit=20");
  if (status !== 200) {
    process.stderr.write(`${t("req.failed", { status })}\n`);
    return 1;
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${style.dim("ID   STATE        SESSION                TEXT")}\n`);
  for (const r of body) {
    const state = r.dispatch?.state ?? "saved";
    const session = r.dispatch?.sessionName ?? r.sessionKey?.slice(0, 8) ?? "-";
    process.stdout.write(`${String(r.id).padEnd(4)} ${state.padEnd(12)} ${session.padEnd(22).slice(0, 22)} ${oneLine(r.text)}\n`);
  }
  return 0;
}

/** 저장된 요청을 세션에 보내고, 끝날 때까지 상태를 보여 준다. */
export async function send(opts: { port?: number; id: number; session?: string; now: boolean; follow: boolean }, style: Style): Promise<number> {
  const port = opts.port ?? defaultPort();
  const body: Record<string, string> = { mode: opts.now ? "now" : "wait-idle" };
  if (opts.session) body.sessionKey = opts.session;
  const res = await api<RequestInfo & { error?: string }>(port, `/v1/requests/${opts.id}/dispatch`, { method: "POST", body: JSON.stringify(body) });
  if (res.status !== 202) {
    process.stderr.write(`${t("req.sendFailed", { err: res.body?.error ?? res.status })}\n`);
    return 1;
  }
  if (!opts.follow) return 0;
  let last = "";
  for (;;) {
    const { body: r } = await api<RequestInfo>(port, `/v1/requests/${opts.id}`);
    const d = r.dispatch;
    if (d) {
      const line = `${d.state}${d.waitReason ? ` (${d.waitReason})` : ""}`;
      if (line !== last) process.stdout.write(`${style.dim(new Date().toLocaleTimeString("en-GB"))}  #${r.id} → ${d.sessionName}  ${line}\n`);
      // VS Code 세션: 터미널에서는 클립보드를 쓸 수 없으니 프롬프트를 보여 주고 직접 붙여 넣게 한다
      if (line !== last && d.waitReason === "paste") process.stdout.write(`${style.dim(t("req.pasteVscode"))}\n\n${r.prompt}\n\n`);
      last = line;
      if (FINAL_DISPATCH_STATES.includes(d.state)) {
        if (d.summary) process.stdout.write(`\n${d.summary}\n`);
        if (d.error) process.stdout.write(`${style.color(d.error, 31)}\n`);
        return d.state === "done" ? 0 : 1;
      }
    }
    await sleep(1000);
  }
}
