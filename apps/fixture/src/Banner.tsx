/** 다른 페이지 연계(레퍼런스) 시험용: 이 배너를 다른 페이지 요청에 참고 대상으로 붙인다. */
export function Banner() {
  return (
    <section className="banner" data-testid="banner">
      <h1>New feature</h1>
      <p>Spacing and corners like this banner</p>
    </section>
  );
}
