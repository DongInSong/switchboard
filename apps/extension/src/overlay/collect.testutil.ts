/** 테스트 도우미: 선택자가 정확히 한 요소를 가리키면 그 요소. */
export function crossCheck(selector: string): Element | null {
  const found = document.querySelectorAll(selector);
  return found.length === 1 ? found[0]! : null;
}
