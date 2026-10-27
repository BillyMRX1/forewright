// The PRD card and the PRD reader, shared by the CTO view and Home.

import type { RequirementDoc } from "../core/store-types.js";
import { Markdown } from "./markdown.js";
import { Modal } from "./ui.js";

export function PrdCard({ doc, approved, onRead, onApprove }: { doc: RequirementDoc; approved: boolean; onRead: () => void; onApprove: () => void }) {
  return (
    <div className="prd-card" role="region" aria-label="PRD waiting for approval">
      <div className="prd-card-text">
        <strong>
          PRD r{doc.revision} {approved ? "approved" : "ready for you"}
        </strong>
        <span>: {doc.title}</span>
      </div>
      <div className="prd-card-actions">
        <button type="button" className="btn" onClick={onRead}>
          Read
        </button>
        {approved ? (
          <span className="chip chip-done">Approved</span>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onApprove}>
            Approve
          </button>
        )}
      </div>
    </div>
  );
}

export function PrdReader({ doc, onClose, onApprove }: { doc: RequirementDoc; onClose: () => void; onApprove: (() => void) | null }) {
  return (
    <Modal title={`PRD r${doc.revision}: ${doc.title}`} onClose={onClose} wide>
      <p className="muted">Status: {doc.status}</p>
      <h3>Requirements</h3>
      {doc.requirements.length === 0 ? (
        <p className="muted">No requirements listed.</p>
      ) : (
        <ul className="reqs">
          {doc.requirements.map((r) => (
            <li key={r.key}>
              <code className="req-key">{r.key}</code> {r.text}
            </li>
          ))}
        </ul>
      )}
      <h3>Document</h3>
      <Markdown text={doc.body} />
      {onApprove ? (
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onApprove}>
            Approve r{doc.revision}
          </button>
        </div>
      ) : null}
    </Modal>
  );
}
