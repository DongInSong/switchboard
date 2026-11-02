import { execFile } from "node:child_process";

export type ExecResult = {
  stdout: string;
  stderr: string;
  /** 종료 코드. 실행 자체가 실패하면 -1. */
  code: number;
  /** 실행 실패 사유 (ENOENT, timeout 등). */
  error?: string;
};

/** 셸 없이 인자 배열로 실행한다. 절대 reject하지 않는다. */
export function run(
  cmd: string,
  args: readonly string[],
  opts: { timeoutMs?: number; cwd?: string; input?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        timeout: opts.timeoutMs ?? 10_000,
        maxBuffer: 16 * 1024 * 1024,
        cwd: opts.cwd,
        encoding: "utf8",
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, code: 0 });
        const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
        if (typeof e.code === "number") return resolve({ stdout, stderr, code: e.code });
        const reason = e.killed ? "timeout" : String(e.code ?? e.message);
        resolve({ stdout, stderr, code: -1, error: reason });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}
