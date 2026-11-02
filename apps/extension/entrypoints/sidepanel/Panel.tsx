import type { Dispatch, RequestInfo, SessionSnapshot } from "@switchboard/protocol";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { send } from "../../src/messages.ts";
import { DEFAULT_BASE, daemonPattern, normalizeDaemonBase, restoreHosts, restorePatterns } from "../../src/origins.ts";
import { Markdown } from "../../src/ui/Markdown.tsx";
import { LANG_KEY, loadLang, onLangChange, t, type Key, type LangSetting } from "../../src/i18n.ts";
import { sendLabel } from "../../src/keys.ts";
import { copyText, dispatchLabel, orderedSessions, pasteHint, projectName, relativeTime, statusOf, surfaceTag, waitLabel } from "../../src/ui/labels.ts";

type Conn = "loading" | "ok" | "unpaired" | "disconnected";
type Tab = "sessions" | "history" | "settings";

function Pair({ onDone }: { onDone(): void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const res = await send({ type: "daemon/pair", code });
    if (res.ok) onDone();
    else setError(res.error === "expired" || res.error === "no-code" ? t("pair.expired") : res.error === "locked" ? t("pair.locked") : t("pair.wrong"));
  };
  return (
    <form
      className="block"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="line">
        <span className="mode">▸▸</span>
        <span className="strong">{t("pair.title")}</span>
        <span className="dim">{t("pair.run")}</span>
        <code>switchboard pair</code>
      </div>
      <div className="line">
        <span className="prompt">❯</span>
        <input autoFocus inputMode="numeric" placeholder="000 000" maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))} />
        <button className="btn" disabled={code.replace(/\D/g, "").length !== 6}>
          {t("ok")}
        </button>
        {error && <span className="err">{error}</span>}
      </div>
    </form>
  );
}

function Sessions({ snap }: { snap: SessionSnapshot | null }) {
  const sessions = orderedSessions(snap);
  const sendable = sessions.filter((s) => s.dispatchable).length;
  return (
    <>
      <table>
        <colgroup>
          <col />
          <col className="c-status" />
          <col className="c-age" />
          <col className="c-project" />
        </colgroup>
        <thead>
          <tr>
            <th>NAME</th>
            <th>STATUS</th>
            <th>AGE</th>
            <th>PROJECT</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => {
            const st = statusOf(s);
            return (
              <tr key={s.key} className={s.dispatchable ? "" : "off"} title={s.title ? `${s.title}\n${s.cwd}` : s.cwd}>
                <td>
                  {s.name}
                  {surfaceTag(s) && <span className="surface">{surfaceTag(s)}</span>}
                </td>
                <td className={`tone-${st.tone}`}>{st.label}</td>
                <td className="dim">{relativeTime(s.startedAt)}</td>
                <td className="dim">{projectName(s.git?.root ?? s.cwd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <footer>
        {sessions.length} sessions · {sendable} sendable{snap && !snap.tmuxRunning ? " · tmux off" : ""}
      </footer>
    </>
  );
}

function Glyph({ d }: { d: Dispatch | null }) {
  if (d && (d.state === "delivering" || d.state === "delivered" || d.state === "working" || (d.state === "queued" && !d.waitReason))) {
    return <span className="glyph spin tone-busy" aria-hidden />;
  }
  if (d?.state === "queued")
    return (
      <span className="glyph tone-waiting" aria-hidden>
        ◌
      </span>
    );
  const tone = d?.state === "done" ? "ok" : d?.state === "failed" ? "fail" : "off";
  return (
    <span className={`glyph tone-${tone}`} aria-hidden>
      ●
    </span>
  );
}

function Shot({ captureId }: { captureId: string }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void send({ type: "daemon/capture-image", captureId }).then((res) => {
      if (alive) setSrc(res.ok ? `data:${res.data.mime};base64,${res.data.base64}` : null);
    });
    return () => {
      alive = false;
    };
  }, [captureId]);
  if (src === undefined) return null;
  if (src === null)
    return (
      <div className="out">
        <span className="mark">└</span>
        <span className="dim">{t("screenshot.none")}</span>
      </div>
    );
  return <img className="hshot" src={src} alt="" />;
}

function Out({ children, tone }: { children: ReactNode; tone?: string }) {
  return (
    <div className="out">
      <span className="mark" aria-hidden>
        └
      </span>
      <span className={tone}>{children}</span>
    </div>
  );
}

/** 펼친 기록: 전체 답변(목록에는 답변이 빠져 있어 상세를 받는다) + 이어서 보내기. */
function Detail({ r, onSent, snap }: { r: RequestInfo; onSent(id: number): void; snap: SessionSnapshot | null }) {
  const d = r.dispatch;
  const wait = d?.state === "queued" && d.waitReason ? waitLabel(d.waitReason) : undefined;
  const [reply, setReply] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = d?.state === "done";
  useEffect(() => {
    if (!done) return;
    let alive = true;
    void send({ type: "daemon/request-get", id: r.id }).then((res) => {
      if (alive && res.ok) setReply(res.data.dispatch?.reply ?? null);
    });
    return () => {
      alive = false;
    };
  }, [r.id, done]);
  const canSend = !!d && text.trim().length > 0 && !sending;
  const follow = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    const res = await send({ type: "daemon/followup", id: r.id, text });
    setSending(false);
    if (!res.ok) {
      setError(res.error === "session-gone" ? t("err.sessionGone") : res.error === "not-dispatchable" ? t("err.notDispatchable") : t("err.failed"));
      return;
    }
    setText("");
    if (snap?.sessions.find((s) => s.key === res.data.dispatch?.sessionKey)?.delivery === "vscode") {
      setError((await copyText(res.data.prompt)) ? pasteHint() : t("copy.failed"));
    }
    onSent(res.data.id);
  };
  return (
    <div className="hdetail">
      <Out tone="dim">{d ? `${d.sessionName}${d.paneId ? ` · ${d.paneId}` : ""}` : t("savedOnly")}</Out>
      {reply ? <Markdown text={reply} className="reply" /> : d?.summary && <Out>{d.summary}</Out>}
      {d?.error && <Out tone="err">{d.error}</Out>}
      {wait && <Out tone="dim">{wait}</Out>}
      <Shot captureId={r.captureId} />
      <details>
        <summary className="dim">{t("sentPrompt")}</summary>
        <pre>{r.prompt}</pre>
      </details>
      {d && (
        <div className="follow">
          <span className="prompt">❯</span>
          <textarea
            rows={1}
            placeholder={t("placeholder.follow")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                void follow();
              }
            }}
          />
          <button type="button" className="btn send" disabled={!canSend} onClick={() => void follow()}>
            {sending ? "…" : t("follow")} <kbd>{sendLabel()}</kbd>
          </button>
          {error && <span className={error === pasteHint() ? "tone-waiting" : "err"}>{error}</span>}
        </div>
      )}
    </div>
  );
}

function History({ items, onSent, snap }: { items: RequestInfo[]; onSent(): void; snap: SessionSnapshot | null }) {
  const [open, setOpen] = useState<number | null>(null);
  if (items.length === 0) return <div className="block dim">{t("history.none")}</div>;
  return (
    <ul className="history">
      {items.map((r) => {
        const d = r.dispatch;
        const st = dispatchLabel(d);
        const wait = d?.state === "queued" && d.waitReason ? waitLabel(d.waitReason) : undefined;
        const isOpen = open === r.id;
        const parent = r.parentId ? ` ← #${r.parentId}` : "";
        return (
          <li key={r.id} className={isOpen ? "is-open" : ""}>
            <button type="button" className="hrow" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen}>
              <Glyph d={d} />
              <span className="dim">
                #{r.id}
                {parent}
              </span>
              <span className={`tone-${st.tone}`} title={wait}>
                {st.label}
              </span>
              <span className="htext">{r.text}</span>
              <span className="dim">{relativeTime(r.createdAt)}</span>
            </button>
            {isOpen && (
              <Detail
                r={r}
                snap={snap}
                onSent={(id) => {
                  setOpen(id);
                  onSent();
                }}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

const STATUS_KEY: Record<"ok" | "unpaired" | "disconnected", Key> = { ok: "conn.ok", unpaired: "conn.unpaired", disconnected: "conn.down" };
const isEdge = typeof navigator !== "undefined" && navigator.userAgent.includes("Edg/");

/**
 * 설정: 데몬 주소(이 컴퓨터만), 자동 복원 주소(새로고침 뒤 쓰던 팝업 다시 띄우기), 단축키.
 * 데몬 쪽 설정(포트·실행 파일·보관 기간 등)은 `switchboard config`.
 * 권한 요청은 클릭 처리 안에서 다른 await보다 먼저 불러야 창이 뜬다.
 */
function Settings({ onBaseChanged }: { onBaseChanged(): void }) {
  const required = useMemo(() => browser.runtime.getManifest().host_permissions ?? [], []);
  const [base, setBase] = useState(DEFAULT_BASE);
  const [draft, setDraft] = useState("");
  const [baseState, setBaseState] = useState<{ tone: string; text: string; title?: string | undefined } | null>(null);
  const [granted, setGranted] = useState<string[]>([]);
  const [site, setSite] = useState("");
  const [siteError, setSiteError] = useState<string | null>(null);
  const [shortcut, setShortcut] = useState<string | null>(null);
  const [langSetting, setLangSetting] = useState<LangSetting>("auto");
  useEffect(() => {
    void browser.storage.local.get(LANG_KEY).then((s) => {
      const v = s[LANG_KEY];
      setLangSetting(v === "en" || v === "ko" ? v : "auto");
    });
  }, []);
  const chooseLang = async (v: LangSetting) => {
    setLangSetting(v);
    if (v === "auto") await browser.storage.local.remove(LANG_KEY);
    else await browser.storage.local.set({ [LANG_KEY]: v });
  };

  const refreshGranted = useCallback(async () => {
    const all = await browser.permissions.getAll();
    setGranted(all.origins ?? []);
  }, []);
  const check = useCallback(async () => {
    const res = await send({ type: "daemon/status" });
    const key = res.ok ? (res.data.paired ? "ok" : "unpaired") : "disconnected";
    // HTTP로 붙었으면 네이티브가 왜 안 됐는지: 등록 안 됨 / 실패(브라우저가 준 이유)
    const nativeNote = res.ok && res.data.transport === "http" && res.data.nativeError ? (/not found/i.test(res.data.nativeError) ? t("native.notSetUp") : t("native.failed")) : "";
    setBaseState({
      tone: key === "ok" ? (nativeNote ? "waiting" : "ok") : key === "unpaired" ? "off" : "fail",
      text: `● ${t(STATUS_KEY[key])}${res.ok ? ` v${res.data.version} · ${t(res.data.transport === "native" ? "transport.native" : "transport.http")}${nativeNote ? ` · ${nativeNote}` : ""}` : ""}`,
      title: res.ok
        ? res.data.nativeError && !/not found/i.test(res.data.nativeError)
          ? t("native.failed.title", { reason: res.data.nativeError })
          : t(res.data.transport === "native" ? "transport.native.title" : "transport.http.title")
        : undefined,
    });
  }, []);
  useEffect(() => {
    void browser.storage.local.get("sb:base").then((s) => {
      const b = typeof s["sb:base"] === "string" ? (s["sb:base"] as string) : DEFAULT_BASE;
      setBase(b);
      setDraft(b);
    });
    void refreshGranted();
    void check();
    // 데몬이 막 뜨는 중이거나 통로(네이티브/HTTP)가 바뀌면 따라가게
    const timer = setInterval(() => void check(), 3000);
    void browser.commands.getAll().then((cmds) => setShortcut(cmds.find((c) => c.name === "start-pick")?.shortcut || ""));
    return () => clearInterval(timer);
  }, [refreshGranted, check]);

  const applyBase = async () => {
    const r = normalizeDaemonBase(draft);
    if (!r.ok) {
      setBaseState({ tone: "fail", text: r.error === "not-local" ? t("addr.localOnly") : t("addr.invalid") });
      return;
    }
    const pattern = daemonPattern(r.base);
    if (!required.includes(pattern)) {
      const ok = await browser.permissions.request({ origins: [pattern] }).catch(() => false);
      if (!ok) {
        setBaseState({ tone: "fail", text: t("perm.denied") });
        return;
      }
    }
    if (r.base === DEFAULT_BASE) await browser.storage.local.remove("sb:base");
    else await browser.storage.local.set({ "sb:base": r.base });
    setBase(r.base);
    setDraft(r.base);
    await check();
    await refreshGranted();
    onBaseChanged();
  };

  const addSite = async (patterns: string[] | null) => {
    if (!patterns) {
      setSiteError(t("addr.invalid"));
      return;
    }
    setSiteError(null);
    const ok = await browser.permissions.request({ origins: patterns }).catch(() => false);
    if (!ok) setSiteError(t("perm.denied"));
    else setSite("");
    await refreshGranted();
  };
  const removeSite = async (patterns: string[]) => {
    await browser.permissions.remove({ origins: patterns }).catch(() => false);
    await refreshGranted();
  };
  const hosts = restoreHosts(granted, [...required, daemonPattern(base)]);
  const allSites = granted.includes("<all_urls>");

  return (
    <div className="block settings">
      <div className="line">
        <span className="mode">▸▸</span>
        <span className="strong" title={t("set.daemon.title")}>
          {t("set.daemon")}
        </span>
        {baseState && (
          <span className={`tone-${baseState.tone}`} title={baseState.title}>
            {baseState.text}
          </span>
        )}
      </div>
      <form
        className="line indent"
        onSubmit={(e) => {
          e.preventDefault();
          void applyBase();
        }}
      >
        <span className="prompt">❯</span>
        <input className="field" aria-label={t("set.daemonAddr")} spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={DEFAULT_BASE} />
        <button className="btn" disabled={draft.trim() === base}>
          {t("apply")}
        </button>
      </form>

      <div className="line">
        <span className="mode">▸▸</span>
        <span className="strong" title={t("set.restore.title")}>
          {t("set.restore")}
        </span>
      </div>
      <div className="line indent hosts">
        {allSites && <span className="dim">{t("allSites")}</span>}
        {!allSites && hosts.length === 0 && <span className="dim">{t("none")}</span>}
        {hosts.map((h) => (
          <span key={h.host} className="host">
            {h.host}
            <button type="button" className="x" aria-label={t("removeHost", { host: h.host })} onClick={() => void removeSite(h.patterns)}>
              ✕
            </button>
          </span>
        ))}
        {!allSites && !hosts.some((h) => h.host === "localhost") && (
          <button type="button" className="btn" title="localhost, 127.0.0.1" onClick={() => void addSite(["http://localhost/*", "http://127.0.0.1/*"])}>
            + localhost
          </button>
        )}
      </div>
      <form
        className="line indent"
        onSubmit={(e) => {
          e.preventDefault();
          void addSite(restorePatterns(site));
        }}
      >
        <span className="prompt">❯</span>
        <input className="field" aria-label={t("set.restoreAddr")} spellCheck={false} value={site} onChange={(e) => setSite(e.target.value)} placeholder="myapp.test:3000" />
        <button className="btn" disabled={!site.trim()}>
          {t("add")}
        </button>
        {siteError && <span className="err">{siteError}</span>}
      </form>

      <div className="line">
        <span className="mode">▸▸</span>
        <span className="strong">{t("set.language")}</span>
        <span className="seg" role="group" aria-label={t("set.language")}>
          {(["auto", "en", "ko"] as const).map((v) => (
            <button key={v} type="button" className="btn" aria-pressed={langSetting === v} onClick={() => void chooseLang(v)}>
              {v === "auto" ? t("lang.auto") : v === "en" ? "English" : "한국어"}
            </button>
          ))}
        </span>
      </div>

      <div className="line">
        <span className="mode">▸▸</span>
        <span className="strong">{t("set.shortcut")}</span>
        <kbd>{shortcut === null ? "…" : shortcut || t("none")}</kbd>
        <button type="button" className="btn" onClick={() => void browser.tabs.create({ url: `${isEdge ? "edge" : "chrome"}://extensions/shortcuts` })}>
          {t("change")}
        </button>
      </div>

      <div className="line">
        <span className="mode">▸▸</span>
        <span className="strong" title={t("set.daemonConfig.title")}>
          {t("set.daemonConfig")}
        </span>
        <code>switchboard config</code>
      </div>
    </div>
  );
}

export function Panel() {
  const [tab, setTab] = useState<Tab>("sessions");
  // 언어: 설정을 읽고, 바뀌면 다시 그린다(오버레이도 같은 설정을 따른다)
  const [, setLangTick] = useState(0);
  useEffect(() => {
    void loadLang().then(() => setLangTick((n) => n + 1));
    return onLangChange(() => setLangTick((n) => n + 1));
  }, []);
  const [conn, setConn] = useState<Conn>("loading");
  const [snap, setSnap] = useState<SessionSnapshot | null>(null);
  const [history, setHistory] = useState<RequestInfo[]>([]);
  const load = useCallback(async () => {
    const res = await send({ type: "daemon/sessions" });
    if (!res.ok) {
      setConn(res.error === "unauthorized" ? "unpaired" : "disconnected");
      return;
    }
    setSnap(res.data);
    setConn("ok");
    const h = await send({ type: "daemon/requests" });
    if (h.ok) setHistory(h.data);
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

  // 숫자 키로 탭 전환 (입력 중이 아닐 때)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "1") setTab("sessions");
      if (e.key === "2") setTab("history");
      if (e.key === "3") setTab("settings");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const connLabel = conn === "ok" ? t("conn.ok") : conn === "unpaired" ? t("conn.unpaired") : conn === "disconnected" ? t("conn.lost") : "…";
  const connTone = conn === "ok" ? "ok" : conn === "disconnected" ? "fail" : "off";

  return (
    <main>
      <header>
        <span className="brand">✻</span>
        <span className="strong">switchboard</span>
        <span className={`conn tone-${connTone}`} title={conn === "disconnected" ? "switchboard start" : undefined}>
          ● {connLabel}
        </span>
      </header>
      <nav>
        <button type="button" className={`tab${tab === "sessions" ? " is-active" : ""}`} onClick={() => setTab("sessions")}>
          <kbd>1</kbd> {t("tab.sessions")}
        </button>
        <button type="button" className={`tab${tab === "history" ? " is-active" : ""}`} onClick={() => setTab("history")}>
          <kbd>2</kbd> {t("tab.history")}
        </button>
        <button type="button" className={`tab${tab === "settings" ? " is-active" : ""}`} onClick={() => setTab("settings")}>
          <kbd>3</kbd> {t("tab.settings")}
        </button>
      </nav>
      {tab === "settings" && <Settings onBaseChanged={() => void load()} />}
      {tab !== "settings" && conn === "unpaired" && <Pair onDone={() => void load()} />}
      {tab !== "settings" && conn === "disconnected" && (
        <div className="block">
          <div className="line">
            <span className="mode">▸▸</span>
            <code>switchboard start</code>
            <button className="btn" onClick={() => void load()}>
              {t("retry")}
            </button>
            <button className="btn" title={t("addr.title")} onClick={() => setTab("settings")}>
              {t("addr")}
            </button>
          </div>
        </div>
      )}
      {tab !== "settings" && conn === "ok" && (tab === "sessions" ? <Sessions snap={snap} /> : <History items={history} snap={snap} onSent={() => void load()} />)}
    </main>
  );
}
