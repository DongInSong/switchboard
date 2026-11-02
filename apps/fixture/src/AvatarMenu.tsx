import { useState } from "react";

export function AvatarMenu() {
  const [open, setOpen] = useState(false);
  return (
    <div className="avatar-menu">
      <button className="avatar" data-testid="avatar-button" aria-label="Account menu" onClick={() => setOpen((v) => !v)}>
        DS
      </button>
      {open && (
        <ul className="dropdown">
          <li>Profile</li>
          <li>Sign out</li>
        </ul>
      )}
    </div>
  );
}
