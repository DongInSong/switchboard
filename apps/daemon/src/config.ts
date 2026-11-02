import { homedir } from "node:os";
import { join } from "node:path";
import { requireSettings } from "./settings.ts";

export const VERSION = "0.2.1";

export type Paths = {
  /** 토큰, 페어링 코드 (사용자만 읽기). */
  stateDir: string;
  /** SQLite, 캡처 파일. */
  dataDir: string;
  capturesDir: string;
  dbFile: string;
  tokensFile: string;
  pairFile: string;
  /** CLI(`switchboard send` 등)가 데몬을 부를 때 쓰는 토큰. 0600. */
  cliTokenFile: string;
  /** 실행 중인 데몬 pid(`switchboard stop`, 호스트가 켠 데몬 끄기). */
  pidFile: string;
};

export function pathsFrom(stateDir: string, dataDir: string): Paths {
  return {
    stateDir,
    dataDir,
    capturesDir: join(dataDir, "captures"),
    dbFile: join(dataDir, "switchboard.db"),
    tokensFile: join(stateDir, "tokens.json"),
    pairFile: join(stateDir, "pair-code.json"),
    cliTokenFile: join(stateDir, "cli-token"),
    pidFile: join(stateDir, "daemon.pid"),
  };
}

export function defaultPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = homedir();
  const state = env.SWITCHBOARD_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "switchboard");
  const data = env.SWITCHBOARD_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "switchboard");
  return pathsFrom(state, data);
}

/** 설정(환경변수 > 설정 파일 > 기본값)의 포트. 설정이 잘못됐으면 SettingsError. */
export function defaultPort(): number {
  return requireSettings().port;
}
