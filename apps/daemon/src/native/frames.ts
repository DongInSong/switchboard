import { NATIVE_CHUNK_CHARS, type NativeFrame, type NativeResponse } from "@switchboard/protocol";

/**
 * Native Messaging 틀: 메시지마다 4바이트 길이(호스트 바이트 순서 = 리틀 엔디언) + UTF-8 JSON.
 * 브라우저 → 호스트 한 메시지는 64MB, 호스트 → 브라우저는 1MB까지라 응답은 조각으로 나눠 보낸다.
 */

export function encodeFrame(msg: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(json.length, 0);
  return Buffer.concat([head, json]);
}

/** 들어오는 바이트를 모아 완성된 메시지를 꺼낸다. */
export class FrameReader {
  #buf: Buffer = Buffer.alloc(0);
  readonly #max: number;

  constructor(maxBytes = 64 * 1024 * 1024) {
    this.#max = maxBytes;
  }

  push(chunk: Buffer): unknown[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out: unknown[] = [];
    while (this.#buf.length >= 4) {
      const len = this.#buf.readUInt32LE(0);
      if (len > this.#max) throw new Error(`frame too large: ${len}`);
      if (this.#buf.length < 4 + len) break;
      const body = this.#buf.subarray(4, 4 + len).toString("utf8");
      this.#buf = this.#buf.subarray(4 + len);
      out.push(JSON.parse(body));
    }
    return out;
  }
}

/** 응답을 조각으로. 작아도 한 조각짜리로 보내 받는 쪽 처리를 하나로 한다. */
export function splitResponse(res: NativeResponse, chunk = NATIVE_CHUNK_CHARS): NativeFrame[] {
  const s = JSON.stringify(res);
  const parts = Math.max(1, Math.ceil(s.length / chunk));
  return Array.from({ length: parts }, (_, i) => ({ id: res.id, part: i, parts, data: s.slice(i * chunk, (i + 1) * chunk) }));
}
