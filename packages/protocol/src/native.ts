/**
 * 브라우저 Native Messaging: 확장이 필요할 때 브라우저가 호스트(`switchboard native-host`)를 띄우고,
 * 호스트는 데몬을 켜 둔 채 확장의 요청을 데몬에 전달한다(페어링·포트 설정 없이).
 * 호스트 매니페스트의 allowed_origins는 이 확장 ID만 허용하므로, manifest `key`로 ID를 고정한다
 * (압축 해제 로드·zip 설치 어디서든 같은 ID).
 */

export const NATIVE_HOST_NAME = "com.github.donginsong.switchboard";

/** manifest `key`(공개 키, SPKI DER base64). 비밀 키는 쓰지 않는다(스토어 배포 시 스토어가 따로 ID를 준다). */
export const EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5gjjjQBAGskLlRn2FtshhWrOK7npIUy9jYXOcoJp9be7SAe0nEvzy3Gm1gynsZ2l99TyMgfaAMRaSFZ/WseWOfhv2A9BJGaxt8CFH10pKORz2mmDrBKc8UEf2bBTXkM1DDlOzqa+545+pnFZZNyeXJaQFQ6NI5Qy+J3n5hl4xCNGXI6b9AnsMnr0xuUduf3ekmn6Jwp5kZ5CqO2W+22Wc+yp5VXJoLUvtBSZVr7iQs3F7SKgxl/UeetgdpNRGKwUORWLOIoleaf3UlIJtczBxMxn836W2i1h31k33erK6m4HECH1uk/Qv+zQtbgO/W1nKd1V1+icPJBOddpUFw1XQQIDAQAB";

/** EXTENSION_KEY에서 나오는 확장 ID(sha256 앞 32자리를 a–p로). */
export const EXTENSION_ID = "fpmdebikcimghncoobpmccpagblaibig";

/** 호스트 → 확장 메시지 한도(1MB)보다 작게 나눠 보낸다. 한글은 UTF-8로 3바이트라 글자 수로 넉넉히. */
export const NATIVE_CHUNK_CHARS = 200_000;

export type NativeRequest =
  | { id: number; type: "hello" }
  | { id: number; type: "http"; method: string; path: string; contentType?: string; body?: string; bodyB64?: string };

export type NativeResponse = {
  id: number;
  status: number;
  contentType: string;
  body?: string;
  bodyB64?: string;
  /** hello 응답 */
  version?: string;
  daemon?: { port: number; started: boolean };
};

/** 실제로 오가는 단위: 응답 JSON을 나눈 조각. parts개가 모이면 이어 붙여 JSON.parse. */
export type NativeFrame = { id: number; part: number; parts: number; data: string };
