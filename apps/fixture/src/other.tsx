import { createRoot } from "react-dom/client";
import { Banner } from "./Banner.tsx";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <main>
    <Banner />
  </main>,
);
