export function Card({ title, body }: { title: string; body: string }) {
  return (
    <article className="card">
      <h2>{title}</h2>
      <p>{body}</p>
    </article>
  );
}
