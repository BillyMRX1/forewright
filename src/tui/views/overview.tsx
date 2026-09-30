import { ScrollLines, type DLine } from "../components.js";
import { useCtx, useLoad } from "../context.js";
import { TASK_STATE_LABEL, STATE_COLOR, ago, oneLine, plainBlockReason, progressBar, wrapText } from "../format.js";
import { TASK_STATES } from "../../core/types.js";

export function OverviewView() {
  const ctx = useCtx();
  const { data } = useLoad(() => ctx.api.call("state.overview", { projectId: ctx.projectId }));
  if (!data) return <ScrollLines lines={[{ text: "Loading...", dim: true }]} height={ctx.bodyHeight} />;
  const w = Math.max(20, ctx.cols - 2);
  const lines: DLine[] = [];
  const section = (t: string) => lines.push({ text: t, bold: true, color: "cyan" });

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
    lines.push({ text: `${m.key.padEnd(6)} [${bar}] ${m.done}/${m.total}  ${oneLine(m.text)}`, color: m.total > 0 && m.done === m.total ? "green" : undefined });
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
    lines.push({ text: `${b.shortId}  ${oneLine(b.title)}`, color: "yellow" });
    for (const l of wrapText(plainBlockReason(b.reason, b.detail), w - 4)) lines.push({ text: `    ${l}`, dim: true });
  }

  lines.push({ text: "" });
  section("Recent results");
  if (data.recentCompleted.length === 0) lines.push({ text: "Nothing finished yet.", dim: true });
  for (const r of data.recentCompleted) lines.push({ text: `done  ${r.shortId}  ${oneLine(r.title)}  ${ago(r.at)}`, color: "green" });
  if (data.openDecisions > 0) {
    lines.push({ text: "" });
    lines.push({ text: `${data.openDecisions} decision${data.openDecisions === 1 ? "" : "s"} waiting for you in the Inbox (view 5).`, color: "yellow", bold: true });
  }
  return <ScrollLines lines={lines} height={ctx.bodyHeight} arrows />;
}
