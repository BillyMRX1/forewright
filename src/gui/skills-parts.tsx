// Small pieces shared by the Skills view and the Inbox skill install body: the source link, the tool lines
// and the instructions box. Instructions always go through the sanitized Markdown component.

import { useState } from "react";
import type { SkillTool } from "../core/store-types.js";
import { Markdown, safeHref } from "./markdown.js";
import { toolLine } from "./skills-model.js";

/** The source as a link when it is a plain http(s) address, otherwise as text. */
export function SourceLink({ url }: { url: string }) {
  const href = safeHref(url);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className="skill-url">
      {url}
    </a>
  ) : (
    <span className="skill-url">{url}</span>
  );
}

/** One code line per tool, e.g. `npx -y package@1.2.3`. */
export function ToolLines({ tools }: { tools: SkillTool[] }) {
  if (tools.length === 0) return null;
  return (
    <ul className="skill-tools">
      {tools.map((t) => (
        <li key={t.name}>
          <code className="skill-tool">{toolLine(t)}</code>
        </li>
      ))}
    </ul>
  );
}

/** The instructions in a bordered, scrollable box, collapsed to a fixed height until "Show all". */
export function InstructionsBox({ text, collapsible = false }: { text: string; collapsible?: boolean }) {
  const [all, setAll] = useState(false);
  const collapsed = collapsible && !all;
  return (
    <div className="skill-instructions-wrap">
      <div className={collapsed ? "skill-instructions skill-collapsed" : "skill-instructions"} tabIndex={0} role="region" aria-label="Skill instructions">
        {text.trim() === "" ? <p className="muted">No instructions.</p> : <Markdown text={text} />}
      </div>
      {collapsible ? (
        <button type="button" className="btn btn-quiet btn-inline" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}
