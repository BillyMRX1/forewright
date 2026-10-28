// The automation settings items (issues #27, #36), shared by the terminal UI and the web app: their order, labels
// and help. The rows of the Automations lists are worded by the service (src/runtime/automation-rows.ts).
import { AUTOMATION_KEYS, type AutomationSettings } from "../core/store-types.js";

export type AutomationName = keyof AutomationSettings;

/** The automation settings in the order both UIs show them. */
export const AUTOMATION_NAMES: AutomationName[] = ["heartbeatHours", "githubIssues", "githubLabel", "ciFailures"];

export const AUTOMATION_LABEL: Record<AutomationName, string> = {
  heartbeatHours: "Heartbeat: hours between CTO check-ins (0 is off)",
  githubIssues: "Brief the CTO on open GitHub issues with the label",
  githubLabel: "GitHub label that hands an issue to Forewright",
  ciFailures: "Brief the CTO when CI fails on the default branch",
};

export const automationKey = (name: AutomationName): string => AUTOMATION_KEYS[name];

export const AUTOMATION_HELP =
  "Off by default. The GitHub triggers check every 5 minutes with your own gh login; issue text and CI logs reach the CTO as untrusted data. All automation follows pause, plan only, budgets, the wakeup limit and the usual gates, and never merges or publishes without you.";

