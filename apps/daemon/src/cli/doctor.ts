import { access } from "node:fs/promises";
import { run } from "../exec.ts";
import { listAgents } from "../registry/agents.ts";
import { sessionsDir } from "../registry/registryFile.ts";
import { listPanes } from "../registry/tmux.ts";
import { t } from "../i18n.ts";
import type { Style } from "./format.ts";

export type Check = { name: string; ok: boolean; detail: string };

function versionAtLeast(actual: string, min: readonly number[]): boolean {
  const parts = actual.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0;
    if (a !== min[i]) return a > min[i]!;
  }
  return true;
}

export async function runChecks(bins: { claudeBin: string; tmuxBin: string } = { claudeBin: "claude", tmuxBin: "tmux" }): Promise<Check[]> {
  const checks: Check[] = [];

  const node = process.versions.node;
  checks.push({ name: "node", ok: versionAtLeast(node, [24]), detail: t("doc.needNode", { v: node }) });

  const claude = await run(bins.claudeBin, ["--version"], { timeoutMs: 10_000 });
  const claudeVersion = /(\d+\.\d+\.\d+)/.exec(claude.stdout)?.[1];
  checks.push({
    name: "claude",
    ok: claude.code === 0 && claudeVersion !== undefined,
    detail: claudeVersion ? `v${claudeVersion}` : (claude.error ?? (claude.stderr.trim() || t("doc.runFailed"))),
  });

  const agents = await listAgents(bins.claudeBin);
  const live = agents.agents.filter((a) => a.pid !== undefined).length;
  checks.push({
    name: "claude agents --json",
    ok: !agents.error,
    detail: agents.error ?? t("doc.agents", { n: agents.agents.length, live }),
  });

  // tmux는 터미널 세션에만 필요하다(VS Code 세션은 없어도 됨). 없으면 실패가 아니라 안내, 낡은 버전만 실패.
  const tmux = await run(bins.tmuxBin, ["-V"], { timeoutMs: 5_000 });
  const tmuxVersion = /(\d+\.\d+)/.exec(tmux.stdout)?.[1];
  checks.push({
    name: "tmux",
    ok: tmuxVersion === undefined || versionAtLeast(tmuxVersion, [3, 2]),
    detail: tmuxVersion ? t("doc.needTmux", { v: tmuxVersion }) : t("doc.tmuxOptional"),
  });

  if (tmuxVersion !== undefined) {
    const panes = await listPanes(bins.tmuxBin);
    checks.push({
      name: "tmux server",
      ok: true,
      detail: panes.serverRunning ? t("doc.panes", { n: panes.panes.length }) : t("doc.tmuxIdle"),
    });
  }

  const dir = sessionsDir();
  const dirOk = await access(dir).then(
    () => true,
    () => false,
  );
  checks.push({ name: "session registry dir", ok: dirOk, detail: dirOk ? dir : t("doc.noRegistryDir", { dir }) });

  return checks;
}

export function renderChecks(checks: readonly Check[], style: Style): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks
    .map((c) => `${c.ok ? style.color("ok  ", 32) : style.color("fail", 31)}  ${c.name.padEnd(width)}  ${style.dim(c.detail)}`)
    .join("\n");
}
