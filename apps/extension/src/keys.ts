/**
 * 단축키: 맥에서는 Option+글자가 다른 글자(å, ¬, π…)로 들어와 e.key로는 못 알아본다.
 * 그래서 글자(e.key)나 물리 키(e.code) 중 하나가 맞으면 받는다. 표시도 맥이면 opt/cmd.
 */

type KeyLike = { altKey: boolean; key: string; code: string };

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test((navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent);

export function isAlt(e: KeyLike, letter: string): boolean {
  return e.altKey && (e.key.toLowerCase() === letter || e.code === `Key${letter.toUpperCase()}`);
}

/** alt+1…9 → 숫자, 아니면 null. */
export function altDigit(e: KeyLike): number | null {
  if (!e.altKey) return null;
  if (/^[1-9]$/.test(e.key)) return Number(e.key);
  const m = /^Digit([1-9])$/.exec(e.code);
  return m ? Number(m[1]) : null;
}

/** 키 힌트 표시. */
export const altLabel = (k: string, mac = IS_MAC) => `${mac ? "opt" : "alt"}+${k}`;
export const sendLabel = (mac = IS_MAC) => (mac ? "cmd+⏎" : "ctrl+⏎");
