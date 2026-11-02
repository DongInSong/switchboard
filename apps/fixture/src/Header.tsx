import { AvatarMenu } from "./AvatarMenu.tsx";

export function Header() {
  return (
    <header className="header">
      <span className="logo">Fixture</span>
      <nav className="nav">
        <a href="#a">Dashboard</a>
        <a href="#b">Settings</a>
      </nav>
      <AvatarMenu />
    </header>
  );
}
