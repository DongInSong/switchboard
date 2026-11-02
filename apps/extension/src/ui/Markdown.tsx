import { Lexer, type Token, type Tokens } from "marked";
import type { ReactNode } from "react";

/**
 * Claude 답변(마크다운)을 React 요소로 그린다. innerHTML을 쓰지 않으므로 답변 안의 HTML은 글자로만 보인다
 * (페이지에서 수집한 텍스트가 답변에 섞여 들어와도 실행되지 않게).
 * 링크는 http(s)만 새 탭으로, 이미지는 불러오지 않고 대체 글자만 보여 준다.
 */

function safeHref(href: string): string | undefined {
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function inline(tokens: Token[] | undefined, key: string): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => {
    const k = `${key}.${i}`;
    switch (t.type) {
      case "strong":
        return <strong key={k}>{inline((t as Tokens.Strong).tokens, k)}</strong>;
      case "em":
        return <em key={k}>{inline((t as Tokens.Em).tokens, k)}</em>;
      case "del":
        return <del key={k}>{inline((t as Tokens.Del).tokens, k)}</del>;
      case "codespan":
        return <code key={k}>{(t as Tokens.Codespan).text}</code>;
      case "br":
        return <br key={k} />;
      case "link": {
        const l = t as Tokens.Link;
        const href = safeHref(l.href);
        return href ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer" title={href}>
            {inline(l.tokens, k)}
          </a>
        ) : (
          <span key={k}>{inline(l.tokens, k)}</span>
        );
      }
      case "image":
        return <span key={k} className="md-dim">[{(t as Tokens.Image).text || "이미지"}]</span>;
      case "checkbox":
        return <span key={k}>{(t as Tokens.Checkbox).checked ? "[x] " : "[ ] "}</span>;
      case "text": {
        const tt = t as Tokens.Text;
        return tt.tokens ? <span key={k}>{inline(tt.tokens, k)}</span> : <span key={k}>{tt.text}</span>;
      }
      default:
        // escape, html 등: 원문 그대로 글자로
        return <span key={k}>{"text" in t && typeof t.text === "string" ? t.text : t.raw}</span>;
    }
  });
}

function block(tokens: Token[], key: string): ReactNode[] {
  return tokens.map((t, i) => {
    const k = `${key}.${i}`;
    switch (t.type) {
      case "space":
      case "def":
        return null;
      case "heading": {
        const h = t as Tokens.Heading;
        return (
          <div key={k} className={`md-h md-h${Math.min(h.depth, 4)}`}>
            {inline(h.tokens, k)}
          </div>
        );
      }
      case "paragraph":
        return <p key={k}>{inline((t as Tokens.Paragraph).tokens, k)}</p>;
      case "code":
        return (
          <pre key={k} className="md-code">
            <code>{(t as Tokens.Code).text}</code>
          </pre>
        );
      case "blockquote":
        return <blockquote key={k}>{block((t as Tokens.Blockquote).tokens, k)}</blockquote>;
      case "hr":
        return <hr key={k} />;
      case "list": {
        const l = t as Tokens.List;
        const items = l.items.map((it, j) => <li key={`${k}.${j}`}>{block(it.tokens, `${k}.${j}`)}</li>);
        return l.ordered ? (
          <ol key={k} start={typeof l.start === "number" ? l.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        );
      }
      case "table": {
        const tb = t as Tokens.Table;
        const align = (a: Tokens.TableCell["align"]) => (a ? { textAlign: a } : undefined);
        return (
          <div key={k} className="md-table">
            <table>
              <thead>
                <tr>
                  {tb.header.map((c, j) => (
                    <th key={j} style={align(c.align)}>
                      {inline(c.tokens, `${k}.h${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tb.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((c, j) => (
                      <td key={j} style={align(c.align)}>
                        {inline(c.tokens, `${k}.${r}.${j}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      case "text": {
        const tt = t as Tokens.Text;
        return <span key={k}>{tt.tokens ? inline(tt.tokens, k) : tt.text}</span>;
      }
      case "html":
        return (
          <p key={k} className="md-dim">
            {t.raw}
          </p>
        );
      default:
        return <p key={k}>{t.raw}</p>;
    }
  });
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  let tokens: Token[];
  try {
    tokens = Lexer.lex(text, { gfm: true, breaks: true });
  } catch {
    return <pre className={className}>{text}</pre>;
  }
  return <div className={`md${className ? ` ${className}` : ""}`}>{block(tokens, "m")}</div>;
}
