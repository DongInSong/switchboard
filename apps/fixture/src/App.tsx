import { CardList } from "./CardList.tsx";
import { Header } from "./Header.tsx";

export function App() {
  return (
    <div className="shell">
      <Header />
      <main>
        <h1>Settings</h1>
        <CardList />
      </main>
    </div>
  );
}
