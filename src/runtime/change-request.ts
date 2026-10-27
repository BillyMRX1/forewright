// A change request from Billy on a task's file or diff hunk. It reaches the assignee as review feedback in the
// task thread and the task re-enters the normal loop: a new worker revision, then the same checks, review and
// integration gates. A request from Billy does not count toward the repair limit: Billy is steering that task
// himself, so a limit meant for loops between agents must not block it.
import { ValidationError } from "../core/errors.js";
import { truncate } from "../core/safety.js";
import type { Task } from "../core/store.js";
import { gitTry } from "./git.js";
import type { ProjectRuntime } from "./project-runtime.js";
import { sendBackForRepair } from "./workers.js";
import { INTEGRATION_BRANCH } from "./workspace.js";

export const NOTE_MAX = 4000;
export const HUNK_MAX = 6000;

export interface ChangeRequestInput {
  taskId: string;
  file?: string;
  hunk?: string;
  note: string;
}

/** Plain reason a change request cannot be sent for this task now, or null. Shared wording with the GUI helper. */
export function changeRequestRefusal(t: Pick<Task, "state" | "candidateCommit">): string | null {
  if (t.state === "working") return "Wait for the run to finish or stop it first.";
  if (t.state === "done" || t.state === "cancelled") return "This task is finished; ask the CTO for a follow-up task.";
  if (t.candidateCommit === null) return "There is nothing to change yet.";
  return null;
}

/** The feedback text the worker reads. The hunk goes in a fenced diff block whose fence is longer than any backtick run inside. */
export function changeRequestBody(input: { file?: string | undefined; hunk?: string | undefined; note: string }): string {
  const parts = ["Billy asks for a change."];
  if (input.file) parts.push(`File: ${input.file}`);
  if (input.hunk) {
    const longest = Math.max(2, ...(input.hunk.match(/`+/g) ?? []).map((m) => m.length));
    const fence = "`".repeat(longest + 1);
    parts.push(`The part of the diff it is about:\n${fence}diff\n${input.hunk}\n${fence}`);
  }
  parts.push(`What Billy wants:\n${input.note}`);
  return parts.join("\n\n");
}

function changedFiles(rt: ProjectRuntime, t: Task): string[] | null {
  const r = gitTry(rt.root, ["diff", "--name-only", "-z", `refs/heads/${INTEGRATION_BRANCH}...${t.candidateCommit!}`]);
  return r.code === 0 ? r.stdout.split("\0").filter((f) => f !== "") : null;
}

export async function requestChange(rt: ProjectRuntime, input: ChangeRequestInput): Promise<Task> {
  const { store } = rt;
  const note = input.note.trim();
  if (note === "") throw new ValidationError("Write what you want changed.");
  if (note.length > NOTE_MAX) throw new ValidationError(`The note is too long (at most ${NOTE_MAX} characters).`, { max: NOTE_MAX });
  if (input.hunk !== undefined && input.hunk.length > HUNK_MAX) throw new ValidationError(`The selected part of the diff is too long (at most ${HUNK_MAX} characters).`, { max: HUNK_MAX });
  if (input.hunk !== undefined && !input.file) throw new ValidationError("A diff part needs the file it belongs to.");
  const t = store.getTask(input.taskId);
  const refusal = changeRequestRefusal(t);
  if (refusal) throw new ValidationError(refusal, { taskId: t.id, state: t.state });
  if (t.assigneeAgentId === null) throw new ValidationError(`${t.shortId} has nobody assigned to make the change. Reassign it first.`, { taskId: t.id });
  if (input.file !== undefined) {
    const files = changedFiles(rt, t);
    if (files === null) throw new ValidationError(`Could not read the changes of ${t.shortId}, so the file cannot be checked.`, { taskId: t.id });
    if (!files.includes(input.file)) throw new ValidationError(`${input.file} is not one of the files changed by ${t.shortId}.`, { taskId: t.id, file: input.file });
  }
  const key = `change:${store.recordEvent("task.change_requested", "task", t.id, { kind: "human" }, { file: input.file ?? null, hunk: input.hunk !== undefined, state: t.state })}`;
  const body = changeRequestBody({ file: input.file, hunk: input.hunk, note });
  const where = input.file ? ` on ${input.file}${input.hunk !== undefined ? " (one part of the diff)" : ""}` : "";
  if (t.state === "review") {
    // Send it back first so a verdict from the review that is running now is recorded as stale, then stop that review.
    sendBackForRepair(rt, t.id, key, body, "Billy asked for a change", { countsAsRepair: false });
    rt.stopTaskRuns(t.id, "change_request", "Billy asked for a change");
  } else {
    store.postMessage({ channel: "task", taskId: t.id, sender: { kind: "system" }, body, recipients: [t.assigneeAgentId], dedupeKey: `feedback:${key}` });
    // A block that only the missing fix explains goes away; any other block (a question, quota, the environment) stays.
    if (t.blockReason === "failed_verification") {
      store.resetTaskCounters(t.id);
      store.clearBlocked(t.id, { kind: "human" });
    }
  }
  rt.notifyCto(`change:${t.id}:${key}`, `Billy asked for a change on ${t.shortId} "${t.title}"${where}: ${truncate(note, 300)}`);
  rt.publish();
  rt.emitRuntime();
  rt.scheduler.wake("change_request");
  return store.getTask(t.id);
}
