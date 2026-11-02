import { z } from "zod";

/** `claude agents --json`의 프로세스 상태. */
export const SessionStatus = z.enum(["busy", "waiting", "idle"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** 백그라운드 세션의 작업 상태. */
export const BackgroundState = z.enum(["working", "blocked", "done", "failed", "stopped"]);
export type BackgroundState = z.infer<typeof BackgroundState>;

export const SessionKind = z.enum(["interactive", "background"]);
export type SessionKind = z.infer<typeof SessionKind>;

export const TmuxLocation = z.object({
  session: z.string(),
  windowId: z.string(),
  windowIndex: z.number().int(),
  paneId: z.string(),
  paneCommand: z.string(),
  inMode: z.boolean(),
  /** 어떻게 찾았는지: pid 계보(공식 정보만 사용) 또는 Claude Code 내부 레지스트리 파일. */
  via: z.enum(["ancestry", "registry-file"]),
});
export type TmuxLocation = z.infer<typeof TmuxLocation>;

export const GitInfo = z.object({
  root: z.string(),
  branch: z.string().optional(),
});
export type GitInfo = z.infer<typeof GitInfo>;

export const NotDispatchableReason = z.enum(["background", "no-tmux", "not-alive"]);

/** 세션을 띄운 곳. Claude Code 세션 레지스트리의 entrypoint(cli / claude-vscode …)에서. */
export const SessionSurface = z.enum(["terminal", "vscode", "other"]);
export type SessionSurface = z.infer<typeof SessionSurface>;

/** 보내는 방법: tmux에 붙여넣기 / VS Code 탭을 띄우고 사용자가 붙여넣기(클립보드). */
export const Delivery = z.enum(["tmux", "vscode"]);
export type Delivery = z.infer<typeof Delivery>;
export type NotDispatchableReason = z.infer<typeof NotDispatchableReason>;

export const RecentFile = z.object({
  path: z.string(),
  op: z.enum(["edit", "write", "read"]),
  at: z.number(),
});
export type RecentFile = z.infer<typeof RecentFile>;

export const Session = z.object({
  /** 안정 키: sessionId, 없으면 pid 또는 백그라운드 ID 기반. */
  key: z.string(),
  sessionId: z.string().optional(),
  name: z.string(),
  kind: SessionKind,
  cwd: z.string(),
  startedAt: z.number(),
  pid: z.number().int().optional(),
  /** /proc/<pid>/stat 22번째 필드. pid 재사용 판별용. */
  procStart: z.string().optional(),
  status: SessionStatus.optional(),
  waitingFor: z.string().optional(),
  backgroundId: z.string().optional(),
  backgroundState: BackgroundState.optional(),
  git: GitInfo.optional(),
  tmux: TmuxLocation.optional(),
  dispatchable: z.boolean(),
  notDispatchableReason: NotDispatchableReason.optional(),
  surface: SessionSurface.optional(),
  /** dispatchable일 때 보내는 방법. */
  delivery: Delivery.optional(),
  // 아래는 Activity Tracker(P2)가 채운다.
  title: z.string().optional(),
  recentPrompts: z.array(z.string()),
  recentFiles: z.array(RecentFile),
  lastAssistantSummary: z.string().optional(),
  lastActivityAt: z.number().optional(),
});
export type Session = z.infer<typeof Session>;

export const SessionSnapshot = z.object({
  sessions: z.array(Session),
  takenAt: z.number(),
  tmuxRunning: z.boolean(),
  warnings: z.array(z.string()),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;
