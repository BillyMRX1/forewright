// The "Open terminal" button of an agent (Team cards and the CTO view). It knows nothing about xterm: the click
// asks the shell to open the lazy terminal panel.

import { useId } from "react";
import type { TeamMember } from "../runtime/protocol.js";

export interface AttachState {
  label: string;
  disabled: boolean;
  /** Why the button is disabled, shown next to it. */
  reason: string | null;
}

export function attachState(m: Pick<TeamMember, "terminalId" | "canAttach" | "attachProblem">): AttachState {
  if (m.terminalId !== null) return { label: "Return to terminal", disabled: false, reason: null };
  if (!m.canAttach) return { label: "Open terminal", disabled: true, reason: m.attachProblem ?? "This agent cannot be opened in a terminal." };
  return { label: "Open terminal", disabled: false, reason: null };
}

export function AttachButton({ member, name, onOpen }: { member: Pick<TeamMember, "terminalId" | "canAttach" | "attachProblem">; name: string; onOpen: () => void }) {
  const s = attachState(member);
  const id = useId();
  const why = s.reason !== null ? id : undefined;
  return (
    <>
      <button type="button" className="btn" disabled={s.disabled} title={s.reason ?? undefined} aria-describedby={why} aria-label={`${s.label} for ${name}`} onClick={onOpen}>
        {s.label}
      </button>
      {s.reason !== null ? (
        <span id={why} className="muted attach-why">
          {s.reason}
        </span>
      ) : null}
    </>
  );
}
