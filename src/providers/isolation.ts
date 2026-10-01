import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IsolationError } from "./errors.js";
import { LinkManager, type LinkResult } from "./links.js";

// Worker children must never inherit the user's config home: global hooks,
// memory protocols and profiles caused junk writes into the Obsidian vault.

const CODEX_CONFIG = `# Owned by forewright. Workers run without the user's Codex profile, hooks or memory.
approval_policy = "never"
`;

export interface IsolatedCodex {
  dir: string;
  /** How auth.json is reachable from the private home. "none" means the caller must run unisolated, loudly. */
  auth: LinkResult;
}

/**
 * <forewrightHome>/provider-homes/codex containing only a link to the user's auth.json
 * (a symlink, or a hard link on Windows without Developer Mode; never a copy) and a
 * config.toml that Forewright owns. Calling it again re-verifies and repairs the link.
 */
export function isolatedCodexHome(forewrightHome: string, realHome: string = os.homedir(), links: LinkManager = new LinkManager()): IsolatedCodex {
  const dir = path.join(forewrightHome, "provider-homes", "codex");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const source = path.join(realHome, ".codex", "auth.json");
  if (!fs.existsSync(source)) {
    throw new IsolationError("Codex is not logged in: ~/.codex/auth.json does not exist", { source });
  }
  const auth = links.linkFile(source, path.join(dir, "auth.json"));
  const config = path.join(dir, "config.toml");
  if (!fs.existsSync(config) || fs.readFileSync(config, "utf8") !== CODEX_CONFIG) {
    fs.writeFileSync(config, CODEX_CONFIG, { mode: 0o600 });
  }
  return { dir, auth };
}

/**
 * Claude keeps its subscription login in the macOS keychain and only finds it
 * with the default config dir, so CLAUDE_CONFIG_DIR cannot be used. Instead:
 * user-level settings (hooks, plugins) are excluded with --setting-sources,
 * only our MCP config is loaded, and auto memory is disabled.
 */
export function claudeIsolation(opts: { loadInstructionFiles: boolean }): { args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
  if (!opts.loadInstructionFiles) env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"] = "1";
  return { args: ["--setting-sources", "project", "--strict-mcp-config"], env };
}
