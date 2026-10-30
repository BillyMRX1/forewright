// Map: where every task is in the flow (PRD, Planning, Coding, Review, Integration, Done) and which agent holds it,
// drawn as an SVG from the data the Tasks and Team views already load. Click a task to open it in Tasks, an agent to
// open it in Team. The positions come from map-model.ts.

import { useEffect, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { Verification } from "../../core/store-types.js";
import { oneLine } from "../../tui/format.js";
import { isAgentEvent, isRunEvent, isTaskEvent, useLive, useNeeds, useProject } from "../live.js";
import { CARD_H, CARD_W, NODE_SIZE, cardGlyph, layoutMap, mapSummary, truncate } from "../map-model.js";
import type { MapInput, MapLayout, MapPrd } from "../map-model.js";

export const MAP_HINT = "Each card is a task in the stage it is in. A line joins an agent to the task it holds. Click a task to open it, or an agent to see its card.";

const TITLE_CHARS = 24;

/** The map's data for the layout: tasks, agents, the PRD and the checks of tasks in review. */
export type MapData = Omit<MapInput, "narrow">;

export interface MapActions {
  openTask: (taskId: string) => void;
  openAgent: (agentId: string) => void;
  openPrd: () => void;
}

function activate(e: KeyboardEvent, fn: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
}

/** The picture and its text twin. Pure, so tests render it without a project. */
export function MapDrawing({ layout, actions }: { layout: MapLayout; actions: MapActions }): ReactNode {
  const { prd } = layout;
  const summary = mapSummary(layout);
  const taskCount = layout.cards.length;
  const desc = `${taskCount} ${taskCount === 1 ? "task" : "tasks"} in the flow, ${layout.agents.length} ${layout.agents.length === 1 ? "agent" : "agents"}. A list with the same content follows the picture.`;
  return (
    <>
      <svg className="map-svg" role="img" aria-labelledby="map-title map-desc" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
        <title id="map-title">Task map</title>
        <desc id="map-desc">{desc}</desc>
        {layout.columns.map((c) => (
          <g key={c.id} className={c.id === "done" ? "map-col map-col-done" : "map-col"}>
            <text className="map-col-label" x={c.x} y={c.y + 16}>
              {c.label}
              {c.id !== "prd" ? ` (${c.count})` : ""}
            </text>
          </g>
        ))}
        {layout.lines.map((l) => {
          const mid = (l.y1 + l.y2) / 2;
          return <path key={`${l.agentId}-${l.taskId}`} className="map-line" data-agent={l.agentId} data-task={l.taskId} d={`M ${l.x1} ${l.y1} C ${l.x1} ${mid}, ${l.x2 - 24} ${l.y2}, ${l.x2} ${l.y2}`} fill="none" />;
        })}
        {layout.agents.map((a) => (
          <g key={a.agentId} className="map-node" tabIndex={0} role="link" aria-label={`Agent ${oneLine(a.name)}`} onClick={() => actions.openAgent(a.agentId)} onKeyDown={(e) => activate(e, () => actions.openAgent(a.agentId))}>
            <rect x={a.x} y={a.y} width={NODE_SIZE.w} height={NODE_SIZE.h} rx={15} />
            <text x={a.x + NODE_SIZE.w / 2} y={a.y + NODE_SIZE.h / 2 + 4} textAnchor="middle">
              {truncate(oneLine(a.name), 14)}
            </text>
          </g>
        ))}
        <g className="map-card map-prd" tabIndex={0} role="link" aria-label={prd.revision === null ? "PRD, none yet" : `PRD revision ${prd.revision}, ${prd.status}`} onClick={actions.openPrd} onKeyDown={(e) => activate(e, actions.openPrd)}>
          <rect x={prd.x} y={prd.y} width={prd.w} height={prd.h} rx={8} />
          <text className="map-card-id" x={prd.x + 10} y={prd.y + 22}>
            {prd.revision === null ? "No PRD yet" : `PRD r${prd.revision}`}
          </text>
          <text className="map-card-sub" x={prd.x + 10} y={prd.y + 42}>
            {prd.status ?? "The CTO writes one"}
          </text>
        </g>
        {layout.cards.map((c) => {
          const g = cardGlyph(c);
          const cls = ["map-card", c.blocked ? "map-card-blocked" : "", c.column === "done" ? "map-card-done" : ""].filter(Boolean).join(" ");
          return (
            <g key={c.taskId} className={cls} tabIndex={0} role="link" aria-label={`${c.shortId} ${oneLine(c.title)}, ${g.words}`} onClick={() => actions.openTask(c.taskId)} onKeyDown={(e) => activate(e, () => actions.openTask(c.taskId))}>
              <rect x={c.x} y={c.y} width={CARD_W} height={CARD_H} rx={8} />
              <text className="map-card-glyph" x={c.x + CARD_W - 14} y={c.y + 22} textAnchor="middle">
                {g.glyph}
              </text>
              <text className="map-card-id" x={c.x + 10} y={c.y + 22}>
                {c.shortId}
              </text>
              <text className="map-card-title" x={c.x + 10} y={c.y + 38}>
                {truncate(oneLine(c.title), TITLE_CHARS)}
              </text>
              <text className="map-card-sub" x={c.x + 10} y={c.y + 51}>
                {c.agentName ? truncate(oneLine(c.agentName), 18) : "unassigned"}
              </text>
            </g>
          );
        })}
      </svg>
      <ul className="sr-only" aria-label="Task map as a list">
        {summary.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </>
  );
}

export function MapView({ data, narrow, actions }: { data: MapData; narrow: boolean; actions: MapActions }): ReactNode {
  const layout = layoutMap({ ...data, narrow });
  return (
    <div className={narrow ? "map map-narrow" : "map"}>
      <h1 className="sr-only">Map</h1>
      <p className="map-hint muted">{MAP_HINT}</p>
      <div className="map-scroll">
        <MapDrawing layout={layout} actions={actions} />
      </div>
    </div>
  );
}

const NARROW_QUERY = "(max-width: 759px)";

/** True below 760 px, where the columns stack instead of sitting side by side. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY).matches : false));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

function prdOf(snap: { prd: { doc: { revision: number; status: string } | null; approved: { revision: number; status: string } | null } }): MapPrd | null {
  const d = snap.prd.doc;
  return d ? { revision: d.revision, status: d.status } : null;
}

export function ProjectMap(): ReactNode {
  const { rpc, projectId, go } = useProject();
  const needs = useNeeds();
  const narrow = useNarrow();
  const snap = needs.snapshot;
  const reviewIds = snap ? snap.tasks.filter((t) => t.state === "review").map((t) => t.id) : [];

  // Only tasks in review need their checks, to tell Review from Integration.
  const checks = useLive<Map<string, Verification[]>>(
    async () => {
      const details = await Promise.all(reviewIds.map((id) => rpc.call("state.task", { projectId, taskId: id })));
      return new Map(details.map((d) => [d.task.id, d.verifications]));
    },
    { events: (t) => isTaskEvent(t) || isRunEvent(t) || isAgentEvent(t) || t.startsWith("verification."), deps: [reviewIds.join(",")] },
  );

  if (snap === null) {
    return needs.error ? (
      <p className="form-error pad" role="alert">
        Could not load the map: {needs.error}
      </p>
    ) : (
      <p className="muted pad" role="status">
        Loading the map.
      </p>
    );
  }

  return (
    <>
      {(needs.error ?? checks.error) ? (
        <p className="form-error pad" role="alert">
          Could not refresh: {needs.error ?? checks.error}
        </p>
      ) : null}
      <MapView
        data={{ tasks: snap.tasks, agents: snap.agents, prd: prdOf(snap), verifications: checks.data ?? new Map() }}
        narrow={narrow}
        actions={{ openTask: (id) => go("tasks", id), openAgent: (id) => go("team", id), openPrd: () => go("cto") }}
      />
    </>
  );
}
