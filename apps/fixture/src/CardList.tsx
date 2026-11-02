import { Card } from "./Card.tsx";

const items = [
  { title: "Notifications", body: "Email and push notifications." },
  { title: "Security", body: "Password and two-step verification." },
  { title: "Billing", body: "Payment methods and invoices." },
];

export function CardList() {
  return (
    <section className="cards">
      {items.map((it) => (
        <Card key={it.title} title={it.title} body={it.body} />
      ))}
      <form className="login">
        <input name="email" defaultValue="me@example.com" />
        <input name="password" type="password" defaultValue="hunter2" />
      </form>
    </section>
  );
}
