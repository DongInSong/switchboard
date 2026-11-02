import { NATIVE_HOST_NAME, type NativeFrame, type NativeRequest, type NativeResponse } from "@switchboard/protocol";

/**
 * Native Messaging 통로(백그라운드 전용). 브라우저가 호스트(`switchboard native-host`)를 띄우고, 호스트가 데몬을 켜서 전달한다.
 * - 호스트가 등록돼 있지 않으면 곧바로 끊기므로 잠시(5초) 쉬었다 다시 시도하고, 그동안은 HTTP로 간다.
 * - 열린 포트는 서비스 워커를 깨워 두므로, 30초 동안 요청이 없으면 닫는다(호스트만 끝나고 데몬은 남는다).
 * - 응답은 1MB 한도 때문에 조각(NativeFrame)으로 온다.
 */

type Port = ReturnType<typeof browser.runtime.connectNative>;
type Pending = { resolve(r: NativeResponse): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout>; parts: string[] };
type Body = Omit<Extract<NativeRequest, { type: "http" }>, "id"> | Omit<Extract<NativeRequest, { type: "hello" }>, "id">;

const RETRY_MS = 5_000;
const IDLE_MS = 30_000;

class NativeClient {
  #port: Port | null = null;
  #pending = new Map<number, Pending>();
  #seq = 0;
  #downUntil = 0;
  #idle: ReturnType<typeof setTimeout> | undefined;
  /** 마지막으로 확인한 상태: 호스트로 연결됐는지. */
  ok = false;
  /** 마지막 실패 이유(브라우저가 준 문구). 연결되면 지운다. 설정 탭에 보여 준다. */
  lastError: string | null = null;

  get resting(): boolean {
    return Date.now() < this.#downUntil;
  }

  #connect(): Port {
    const port = browser.runtime.connectNative(NATIVE_HOST_NAME);
    port.onMessage.addListener((raw: unknown) => {
      const f = raw as NativeFrame;
      const p = this.#pending.get(f.id);
      if (!p) return;
      p.parts[f.part] = f.data;
      if (p.parts.filter((x) => x !== undefined).length < f.parts) return;
      this.#pending.delete(f.id);
      clearTimeout(p.timer);
      try {
        p.resolve(JSON.parse(p.parts.join("")) as NativeResponse);
      } catch (e) {
        p.reject(e instanceof Error ? e : new Error(String(e)));
      }
      this.#touch();
    });
    port.onDisconnect.addListener(() => {
      // lastError를 읽어야 콘솔에 'Unchecked runtime.lastError'가 남지 않는다
      const reason = browser.runtime.lastError?.message ?? "disconnected";
      if (this.#port === port) this.#port = null;
      const hadPending = this.#pending.size > 0;
      for (const [id, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
        this.#pending.delete(id);
      }
      // 등록이 없거나 호스트가 바로 죽으면 잠시 쉰다(그동안 HTTP)
      if (hadPending || /not found|forbidden|exited/i.test(reason)) {
        this.ok = false;
        this.lastError = reason;
        this.#downUntil = Date.now() + RETRY_MS;
      }
    });
    this.#port = port;
    return port;
  }

  #touch() {
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      if (this.#pending.size === 0 && this.#port) {
        this.#port.disconnect();
        this.#port = null;
      }
    }, IDLE_MS);
  }

  request(body: Body, timeoutMs: number): Promise<NativeResponse> {
    if (this.resting) return Promise.reject(new Error("native-resting"));
    let port: Port;
    try {
      port = this.#port ?? this.#connect();
    } catch (e) {
      this.#downUntil = Date.now() + RETRY_MS;
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    const id = ++this.#seq;
    return new Promise<NativeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("native-timeout"));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (r) => {
          this.ok = true;
          this.lastError = null;
          resolve(r);
        },
        reject,
        timer,
        parts: [],
      });
      port.postMessage({ ...body, id });
      this.#touch();
    });
  }
}

export const native = new NativeClient();
