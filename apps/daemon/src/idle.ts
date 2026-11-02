/**
 * 브라우저(네이티브 호스트)가 켠 데몬은 안 쓰면 스스로 꺼진다. 다음에 필요하면 호스트가 다시 켠다.
 * - 요청: 토큰이 필요한 API 요청(확장·CLI)만 활동으로 친다. /v1/health(호스트의 생존 확인)는 빼고.
 * - 진행 중인 전달(예약·전달·작업 중)이 있으면 끄지 않는다(끝날 때까지 추적해야 하므로).
 */
export function shouldIdleExit(o: { now: number; lastActivity: number; idleMs: number; activeDispatches: number }): boolean {
  return o.idleMs > 0 && o.activeDispatches === 0 && o.now - o.lastActivity >= o.idleMs;
}
