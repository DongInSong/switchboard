import { run } from "../exec.ts";

export type PaneInfo = { paneId: string; panePid: number; command: string; inMode: boolean; dead: boolean };

/** Dispatcher가 쓰는 tmux 조작. 테스트에서는 가짜로 바꾼다. */
export interface TmuxLike {
  paneInfo(paneId: string): Promise<PaneInfo | null>;
  capture(paneId: string): Promise<string | null>;
  paste(paneId: string, text: string, buffer: string): Promise<boolean>;
  enter(paneId: string): Promise<boolean>;
}

/** 셸 없이 tmux를 부른다. socket을 주면 `-L socket`(격리된 tmux 서버, 테스트용). */
export class TmuxDriver implements TmuxLike {
  readonly #bin: string;
  readonly #socket: string | undefined;

  constructor(opts: { bin?: string; socket?: string } = {}) {
    this.#bin = opts.bin ?? "tmux";
    this.#socket = opts.socket;
  }

  #args(...a: string[]): string[] {
    return this.#socket ? ["-L", this.#socket, ...a] : a;
  }

  async paneInfo(paneId: string): Promise<PaneInfo | null> {
    const res = await run(this.#bin, this.#args("display-message", "-p", "-t", paneId, "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_in_mode}\t#{pane_dead}"), { timeoutMs: 3000 });
    if (res.code !== 0) return null;
    const [id, pid, command, inMode, dead] = res.stdout.trim().split("\t");
    if (id !== paneId) return null;
    return { paneId: id, panePid: Number(pid), command: command ?? "", inMode: inMode === "1", dead: dead === "1" };
  }

  async capture(paneId: string): Promise<string | null> {
    const res = await run(this.#bin, this.#args("capture-pane", "-p", "-e", "-t", paneId), { timeoutMs: 3000 });
    return res.code === 0 ? res.stdout : null;
  }

  /** bracketed paste(-p)로 한 번에 붙여 넣는다. 줄바꿈이 제출로 처리되지 않는다. */
  async paste(paneId: string, text: string, buffer: string): Promise<boolean> {
    const load = await run(this.#bin, this.#args("load-buffer", "-b", buffer, "-"), { timeoutMs: 3000, input: text });
    if (load.code !== 0) return false;
    const paste = await run(this.#bin, this.#args("paste-buffer", "-p", "-d", "-b", buffer, "-t", paneId), { timeoutMs: 3000 });
    return paste.code === 0;
  }

  async enter(paneId: string): Promise<boolean> {
    const res = await run(this.#bin, this.#args("send-keys", "-t", paneId, "Enter"), { timeoutMs: 3000 });
    return res.code === 0;
  }
}
