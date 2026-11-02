import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Capture, Dispatch, DispatchMode, DispatchState, WaitReason } from "@switchboard/protocol";

export type CaptureRow = {
  id: string;
  createdAt: number;
  url: string;
  origin: string;
  title: string;
  dir: string;
  capture: Capture;
};

export type RequestStatus = "pending" | "dispatched" | "cancelled";

export type RequestRow = {
  id: number;
  captureId: string;
  /** 대상 전부(첫째가 captureId). */
  captureIds: string[];
  parentId: number | null;
  text: string;
  sessionKey: string | null;
  prompt: string;
  contextFile: string;
  status: RequestStatus;
  createdAt: number;
  /** 프롬프트를 쓴 언어(다시 보낼 때 같은 언어로). 예전 요청은 null. */
  lang: "en" | "ko" | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS captures (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  url        TEXT NOT NULL,
  origin     TEXT NOT NULL,
  title      TEXT NOT NULL,
  dir        TEXT NOT NULL,
  data       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_id   TEXT NOT NULL REFERENCES captures(id),
  text         TEXT NOT NULL,
  session_key  TEXT,
  prompt       TEXT NOT NULL,
  context_file TEXT NOT NULL,
  status       TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_capture ON requests(capture_id);
-- 요청 하나에 대상(캡처) 여러 개. position 0이 대표(requests.capture_id).
CREATE TABLE IF NOT EXISTS request_captures (
  request_id INTEGER NOT NULL REFERENCES requests(id),
  capture_id TEXT NOT NULL REFERENCES captures(id),
  position   INTEGER NOT NULL,
  PRIMARY KEY (request_id, capture_id)
);
CREATE INDEX IF NOT EXISTS request_captures_capture ON request_captures(capture_id);
-- 이전 버전 DB: 대표 캡처를 연결 표에 채운다(여러 번 돌아도 같음)
INSERT OR IGNORE INTO request_captures (request_id, capture_id, position) SELECT id, capture_id, 0 FROM requests;
CREATE TABLE IF NOT EXISTS dispatches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id   INTEGER NOT NULL REFERENCES requests(id),
  session_key  TEXT NOT NULL,
  session_name TEXT NOT NULL,
  pane_id      TEXT,
  mode         TEXT NOT NULL,
  state        TEXT NOT NULL,
  wait_reason  TEXT,
  marker       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER,
  finished_at  INTEGER,
  error        TEXT,
  summary      TEXT
);
CREATE INDEX IF NOT EXISTS dispatches_request ON dispatches(request_id);
CREATE INDEX IF NOT EXISTS dispatches_session_state ON dispatches(session_key, state);
`;

export type NewDispatch = {
  requestId: number;
  sessionKey: string;
  sessionName: string;
  paneId: string | null;
  mode: DispatchMode;
  marker: string;
  createdAt: number;
};

export type DispatchPatch = Partial<Pick<Dispatch, "paneId" | "state" | "waitReason" | "deliveredAt" | "finishedAt" | "error" | "summary" | "reply">>;

const DISPATCH_COLUMNS: Record<keyof DispatchPatch, string> = {
  paneId: "pane_id",
  state: "state",
  waitReason: "wait_reason",
  deliveredAt: "delivered_at",
  finishedAt: "finished_at",
  error: "error",
  summary: "summary",
  reply: "reply",
};

function toDispatch(r: Record<string, string | number | null>): Dispatch {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    id: Number(r.id),
    requestId: Number(r.request_id),
    sessionKey: String(r.session_key),
    sessionName: String(r.session_name),
    paneId: str(r.pane_id),
    mode: String(r.mode) as DispatchMode,
    state: String(r.state) as DispatchState,
    waitReason: str(r.wait_reason) as WaitReason | null,
    marker: String(r.marker),
    createdAt: Number(r.created_at),
    deliveredAt: num(r.delivered_at),
    finishedAt: num(r.finished_at),
    error: str(r.error),
    summary: str(r.summary),
    reply: str(r.reply),
  };
}

type Row = Record<string, string | number | null>;

export class Store {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#db.exec(SCHEMA);
    this.#migrate();
  }

  /** 이전 버전 DB에 새 열을 붙인다. */
  #migrate(): void {
    const has = (table: string, col: string) =>
      (this.#db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((r) => r.name === col);
    if (!has("dispatches", "reply")) this.#db.exec("ALTER TABLE dispatches ADD COLUMN reply TEXT");
    if (!has("requests", "parent_id")) this.#db.exec("ALTER TABLE requests ADD COLUMN parent_id INTEGER");
    if (!has("requests", "lang")) this.#db.exec("ALTER TABLE requests ADD COLUMN lang TEXT");
  }

  close(): void {
    this.#db.close();
  }

  insertCapture(row: CaptureRow): void {
    this.#db
      .prepare("INSERT INTO captures (id, created_at, url, origin, title, dir, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.createdAt, row.url, row.origin, row.title, row.dir, JSON.stringify(row.capture));
  }

  getCapture(id: string): CaptureRow | null {
    const r = this.#db.prepare("SELECT * FROM captures WHERE id = ?").get(id) as Row | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      createdAt: Number(r.created_at),
      url: String(r.url),
      origin: String(r.origin),
      title: String(r.title),
      dir: String(r.dir),
      capture: JSON.parse(String(r.data)) as Capture,
    };
  }

  /** 번호를 먼저 받고(마커에 필요) 프롬프트를 채운다. extra는 연계 대상(대상 2, 3, …). */
  reserveRequest(
    captureId: string,
    text: string,
    sessionKey: string | null,
    createdAt: number,
    extra: readonly string[] = [],
    parentId: number | null = null,
    lang: "en" | "ko" | null = null,
  ): number {
    const res = this.#db
      .prepare(
        "INSERT INTO requests (capture_id, text, session_key, prompt, context_file, status, created_at, parent_id, lang) VALUES (?, ?, ?, '', '', 'pending', ?, ?, ?)",
      )
      .run(captureId, text, sessionKey, createdAt, parentId, lang);
    const id = Number(res.lastInsertRowid);
    const link = this.#db.prepare("INSERT OR IGNORE INTO request_captures (request_id, capture_id, position) VALUES (?, ?, ?)");
    [captureId, ...extra].forEach((c, i) => link.run(id, c, i));
    return id;
  }

  #captureIdsOf(requestId: number, primary: string): string[] {
    const rows = this.#db.prepare("SELECT capture_id FROM request_captures WHERE request_id = ? ORDER BY position").all(requestId) as Row[];
    const ids = rows.map((r) => String(r.capture_id));
    return ids.length ? ids : [primary];
  }

  fillRequest(id: number, prompt: string, contextFile: string): void {
    this.#db.prepare("UPDATE requests SET prompt = ?, context_file = ? WHERE id = ?").run(prompt, contextFile, id);
  }

  getRequest(id: number): RequestRow | null {
    const r = this.#db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Row | undefined;
    if (!r) return null;
    return {
      id: Number(r.id),
      captureId: String(r.capture_id),
      text: String(r.text),
      captureIds: this.#captureIdsOf(Number(r.id), String(r.capture_id)),
      parentId: r.parent_id === null || r.parent_id === undefined ? null : Number(r.parent_id),
      sessionKey: r.session_key === null ? null : String(r.session_key),
      prompt: String(r.prompt),
      contextFile: String(r.context_file),
      status: String(r.status) as RequestStatus,
      createdAt: Number(r.created_at),
      lang: r.lang === "en" || r.lang === "ko" ? r.lang : null,
    };
  }

  setRequestSession(id: number, sessionKey: string): void {
    this.#db.prepare("UPDATE requests SET session_key = ? WHERE id = ?").run(sessionKey, id);
  }

  listRequests(limit = 30): (RequestRow & { url: string })[] {
    const rows = this.#db
      .prepare("SELECT r.*, c.url AS url FROM requests r JOIN captures c ON c.id = r.capture_id ORDER BY r.id DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map((r) => ({ ...this.getRequest(Number(r.id))!, url: String(r.url) }));
  }

  /** 이 오리진에서 마지막으로 고른 세션(추천의 '이전 선택'). */
  lastSessionForOrigin(origin: string): string | null {
    if (!origin) return null;
    const r = this.#db
      .prepare("SELECT r.session_key AS k FROM requests r JOIN captures c ON c.id = r.capture_id WHERE c.origin = ? AND r.session_key IS NOT NULL ORDER BY r.id DESC LIMIT 1")
      .get(origin) as Row | undefined;
    return r ? String(r.k) : null;
  }

  insertDispatch(d: NewDispatch): Dispatch {
    const res = this.#db
      .prepare(
        "INSERT INTO dispatches (request_id, session_key, session_name, pane_id, mode, state, marker, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)",
      )
      .run(d.requestId, d.sessionKey, d.sessionName, d.paneId, d.mode, d.marker, d.createdAt);
    return this.getDispatch(Number(res.lastInsertRowid))!;
  }

  updateDispatch(id: number, patch: DispatchPatch): Dispatch {
    const keys = Object.keys(patch) as (keyof DispatchPatch)[];
    if (keys.length > 0) {
      const sets = keys.map((k) => `${DISPATCH_COLUMNS[k]} = ?`).join(", ");
      const values = keys.map((k) => (patch[k] === undefined ? null : patch[k])) as (string | number | null)[];
      this.#db.prepare(`UPDATE dispatches SET ${sets} WHERE id = ?`).run(...values, id);
    }
    return this.getDispatch(id)!;
  }

  getDispatch(id: number): Dispatch | null {
    const r = this.#db.prepare("SELECT * FROM dispatches WHERE id = ?").get(id) as Row | undefined;
    return r ? toDispatch(r) : null;
  }

  latestDispatch(requestId: number): Dispatch | null {
    const r = this.#db.prepare("SELECT * FROM dispatches WHERE request_id = ? ORDER BY id DESC LIMIT 1").get(requestId) as Row | undefined;
    return r ? toDispatch(r) : null;
  }

  /** 세션별 대기열 맨 앞. */
  nextQueued(sessionKey: string): Dispatch | null {
    const r = this.#db
      .prepare("SELECT * FROM dispatches WHERE session_key = ? AND state = 'queued' ORDER BY id LIMIT 1")
      .get(sessionKey) as Row | undefined;
    return r ? toDispatch(r) : null;
  }

  activeDispatches(): Dispatch[] {
    return (this.#db.prepare("SELECT * FROM dispatches WHERE state NOT IN ('done', 'failed', 'cancelled') ORDER BY id").all() as Row[]).map(toDispatch);
  }

  /**
   * 보관 기간이 지난 캡처. 마지막 활동(캡처·요청·전달 중 가장 늦은 시각) 기준이며,
   * 요청이 없는 캡처(팝업만 열고 안 보낸 것)는 더 짧은 기한을 쓴다. 진행 중인 전달이 있으면 지우지 않는다.
   */
  expiredCaptures(sentCutoff: number, unsentCutoff: number): { id: string; dir: string; lastActivity: number; requests: number }[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM (
           SELECT c.id AS id, c.dir AS dir,
             MAX(c.created_at,
                 IFNULL((SELECT MAX(r.created_at) FROM requests r JOIN request_captures rc ON rc.request_id = r.id WHERE rc.capture_id = c.id), 0),
                 IFNULL((SELECT MAX(IFNULL(d.finished_at, d.created_at)) FROM dispatches d JOIN request_captures rc ON rc.request_id = d.request_id WHERE rc.capture_id = c.id), 0)
             ) AS last,
             (SELECT COUNT(*) FROM request_captures rc WHERE rc.capture_id = c.id) AS nreq,
             (SELECT COUNT(*) FROM dispatches d JOIN request_captures rc ON rc.request_id = d.request_id
                WHERE rc.capture_id = c.id AND d.state NOT IN ('done', 'failed', 'cancelled')) AS nactive
           FROM captures c
         ) WHERE nactive = 0 AND ((nreq = 0 AND last < ?) OR last < ?)
         ORDER BY last`,
      )
      .all(unsentCutoff, sentCutoff) as Row[];
    return rows.map((r) => ({ id: String(r.id), dir: String(r.dir), lastActivity: Number(r.last), requests: Number(r.nreq) }));
  }

  /** 캡처와 그에 딸린 요청·전달 기록을 함께 지운다. 연계 대상으로만 쓰인 경우 연결만 끊는다. */
  deleteCapture(id: string): void {
    this.#db.exec("BEGIN");
    try {
      const owned = "SELECT id FROM requests WHERE capture_id = ?";
      this.#db.prepare(`DELETE FROM dispatches WHERE request_id IN (${owned})`).run(id);
      this.#db.prepare(`DELETE FROM request_captures WHERE request_id IN (${owned}) OR capture_id = ?`).run(id, id);
      this.#db.prepare("DELETE FROM requests WHERE capture_id = ?").run(id);
      this.#db.prepare("DELETE FROM captures WHERE id = ?").run(id);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  captureIds(): Set<string> {
    return new Set((this.#db.prepare("SELECT id FROM captures").all() as Row[]).map((r) => String(r.id)));
  }

  /** 마지막 요청 번호 + 1. 미리보기 마커용 추정치. */
  nextRequestId(): number {
    const r = this.#db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'requests'").get() as Row | undefined;
    return (r ? Number(r.seq) : 0) + 1;
  }
}
