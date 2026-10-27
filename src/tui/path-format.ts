// Path wording for the terminal UI. Kept apart from format.ts because it needs node:os, and format.ts is shared with the web app.

import os from "node:os";

export function abbreviatePath(p: string, max: number): string {
  const home = os.homedir();
  const shown = p === home || p.startsWith(`${home}/`) || p.startsWith(`${home}\\`) ? `~${p.slice(home.length)}` : p;
  if (shown.length <= max) return shown;
  return `...${shown.slice(shown.length - Math.max(1, max - 3))}`;
}
