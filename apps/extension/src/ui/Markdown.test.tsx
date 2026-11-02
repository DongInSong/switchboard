// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown.tsx";

/** 글자 조각을 감싸는 span은 비교에서 뺀다. */
const html = (md: string) => renderToStaticMarkup(<Markdown text={md} />).replace(/<\/?span>/g, "");

describe("Markdown", () => {
  it("GFM 표를 표로 그린다(정렬 포함)", () => {
    const out = html("| 항목 | 값 |\n| :--- | ---: |\n| 길이 | **12** |");
    expect(out).toContain("<table>");
    expect(out).toContain('<th style="text-align:left">항목</th>');
    expect(out).toContain('<td style="text-align:right"><strong>12</strong></td>');
  });

  it("제목·목록·코드·인라인 코드", () => {
    const out = html("## 결과\n\n- `Card.tsx` 수정\n- 간격 8px\n\n```ts\nconst a = 1;\n```");
    expect(out).toContain('<div class="md-h md-h2">결과</div>');
    expect(out).toContain("<ul><li>");
    expect(out).toContain("<code>Card.tsx</code>");
    expect(out).toContain('<pre class="md-code"><code>const a = 1;</code></pre>');
  });

  it("HTML은 실행하지 않고 글자로, 위험한 링크는 링크로 만들지 않는다", () => {
    const out = html('<img src=x onerror="alert(1)">\n\n[클릭](javascript:alert(1)) [문서](https://example.com)');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('<a href="https://example.com/" target="_blank" rel="noopener noreferrer"');
  });
});
