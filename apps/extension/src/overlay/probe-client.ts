import { PROBE_ATTR, PROBE_REQUEST, PROBE_RESULT } from "@switchboard/page-probe";
import { SourceHint } from "@switchboard/protocol";

let seq = 0;

/**
 * MAIN world의 probe에 소스 위치를 묻는다. 요소에 임시 속성을 달아 지목하고, 결과는 문자열 이벤트로 받는다.
 * 페이지 스크립트도 이 이벤트를 보낼 수 있으므로 결과는 스키마로 검증한다.
 */
export function probeSource(el: Element, timeoutMs = 300): Promise<SourceHint[]> {
  const id = `p${Date.now().toString(36)}-${++seq}`;
  const doc = el.ownerDocument;
  el.setAttribute(PROBE_ATTR, id);
  return new Promise((resolve) => {
    const finish = (hints: SourceHint[]) => {
      clearTimeout(timer);
      doc.removeEventListener(PROBE_RESULT, onResult);
      el.removeAttribute(PROBE_ATTR);
      resolve(hints);
    };
    const onResult = (ev: Event) => {
      try {
        const data = JSON.parse(String((ev as CustomEvent).detail)) as { id?: unknown; hints?: unknown };
        if (data.id !== id) return;
        const parsed = SourceHint.array().max(8).safeParse(data.hints);
        finish(parsed.success ? parsed.data : []);
      } catch {
        /* 다른 이벤트 */
      }
    };
    doc.addEventListener(PROBE_RESULT, onResult);
    const timer = setTimeout(() => finish([]), timeoutMs);
    doc.dispatchEvent(new CustomEvent(PROBE_REQUEST, { detail: JSON.stringify({ id }) }));
  });
}
