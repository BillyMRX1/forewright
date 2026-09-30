import { ScrollLines, type DLine } from "../components.js";
import { useCtx, useLoad } from "../context.js";
import { TASK_STATE_LABEL, STATE_COLOR, ago, clip, fit, oneLine, plainBlockReason, progressBar, shortAge, wrapText } from "../format.js";
import { STATUS_LABEL, statusColor, statusGlyph } from "../theme.js";
import { TASK_STATES } from "../../core/types.js";
import { palette } from "../theme.js";

export function OverviewView() {
  const ctx = useCtx();
  const { data } = useLoad(() => ctx.api.call("state.overview", { projectId: ctx.projectId }));
  if (!data) return <ScrollLines lines={[{ text: "Loading...", dim: true }]} height={ctx.bodyHeight} />;
  const w = Math.max(20, ctx.cols - 2);
  const lines: DLine[] = [];
  const section = (t: string) => lines.push({ text: t, bold: true, color: palette.accent });

  section("Now");
  if (ctx.attention.length === 0) lines.push({ text: "No agents yet. Press 2 to brief the CTO.", dim: true });
  else if (!ctx.attention.some((a) => a.status === "working" || a.status === "needs_you")) lines.push({ text: "No agents working. Press 2 to brief the CTO.", dim: true });
  for (const a of ctx.attention) {
    const said = a.reason.length > 0 ? a.reason : (a.lastEventSummary ?? "no activity yet");
    const head = `${statusGlyph(a.status)} ${fit(clip(oneLine(a.agent.name), 10), 10)} ${fit(STATUS_LABEL[a.status], 9)} ${fit(a.taskShortId ?? "-", 5)}`;
    lines.push({ text: clip(`${head} ${oneLine(said)}  ${shortAge(a.lastEventAt)}`, w), color: statusColor(a.status), bold: a.status === "needs_you", dim: a.status === "idle" });
  }
  for (const d of ctx.openDecisions) {
    lines.push({ text: `${statusGlyph("needs_you")} Waiting for you: ${oneLine(d.title)}`, color: statusColor("needs_you"), bold: true });
    for (const l of wrapText(d.question, w - 4).slice(0, 2)) lines.push({ text: `    ${l}`, dim: true });
  }

  lines.push({ text: "" });
  section("Goals");
  if (data.goals) {
    lines.push({ text: `${oneLine(data.goals.title)} (approved revision ${data.goals.revision})`, bold: true });
    for (const r of data.goals.requirements.slice(0, 4)) for (const l of wrapText(`${r.key}  ${r.text}`, w - 2).slice(0, 2)) lines.push({ text: `  ${l}` });
    if (data.goals.requirements.length > 4) lines.push({ text: `  and ${data.goals.requirements.length - 4} more requirements`, dim: true });
  } else lines.push({ text: "No approved scope yet. Talk to the CTO (view 2) to agree on one.", dim: true });

  lines.push({ text: "" });
  section("Milestones");
  if (data.milestones.length === 0) lines.push({ text: "None yet.", dim: true });
  for (const m of data.milestones) {
    const bar = progressBar(m.done, m.total, 10);
    lines.push({ text: `${m.key.padEnd(6)} [${bar}] ${m.done}/${m.total}  ${oneLine(m.text)}`, color: m.total > 0 && m.done === m.total ? palette.done : undefined });
  }

  lines.push({ text: "" });
  section("Tasks");
  lines.push({ text: TASK_STATES.map((s) => `${TASK_STATE_LABEL[s]} ${data.countsByState[s]}`).join("   ") });
  const working = data.countsByState.working;
  lines.push({ text: working > 0 ? `${working} being worked on now.` : "Nothing is being worked on right now.", color: STATE_COLOR.working, dim: working === 0 });

  lines.push({ text: "" });
  section("Blockers");
  if (data.blockers.length === 0) lines.push({ text: "No blockers.", dim: true });
  for (const b of data.blockers) {
    lines.push({ text: `${b.shortId}  ${oneLine(b.title)}`, color: palette.attention });
    for (const l of wrapText(plainBlockReason(b.reason, b.detail), w - 4)) lines.push({ text: `    ${l}`, dim: true });
  }

  lines.push({ text: "" });
  section("Recent results");
  if (data.recentCompleted.length === 0) lines.push({ text: "Nothing finished yet.", dim: true });
  for (const r of data.recentCompleted) lines.push({ text: `done  ${r.shortId}  ${oneLine(r.title)}  ${ago(r.at)}`, color: palette.done });
  if (data.openDecisions > 0) {
    lines.push({ text: "" });
    lines.push({ text: `${data.openDecisions} decision${data.openDecisions === 1 ? "" : "s"} waiting for you in the Inbox (view 5).`, color: palette.attention, bold: true });
  }
  return <ScrollLines lines={lines} height={ctx.bodyHeight} arrows />;
}
