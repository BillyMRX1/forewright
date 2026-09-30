import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IsolationError } from "./errors.js";

// Worker children must never inherit the user's config home: global hooks,
// memory protocols and profiles caused junk writes into the Obsidian vault.

const CODEX_CONFIG = `# Owned by forewright. Workers run without the user's Codex profile, hooks or memory.
approval_policy = "never"
`;

/**
 * <forewrightHome>/provider-homes/codex containing only a symlink to the user's
 * auth.json (never a copy) and a config.toml that Forewright owns.
 */
export function isolatedCodexHome(forewrightHome: string, realHome: string = os.homedir()): string {
  const dir = path.join(forewrightHome, "provider-homes", "codex");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const source = path.join(realHome, ".codex", "auth.json");
  if (!fs.existsSync(source)) {
    throw new IsolationError("Codex is not logged in: ~/.codex/auth.json does not exist", { source });
  }
  const link = path.join(dir, "auth.json");
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing) {
    if (!existing.isSymbolicLink()) {
      throw new IsolationError("Refusing to replace a real file with the auth symlink", { link });
    }
    if (fs.readlinkSync(link) !== source) fs.unlinkSync(link);
  }
  if (!safeIsLink(link)) fs.symlinkSync(source, link);
  if (fs.readlinkSync(link) !== source) {
    throw new IsolationError("auth.json symlink does not point at the expected target", { link, source });
  }

  const config = path.join(dir, "config.toml");
  if (!fs.existsSync(config) || fs.readFileSync(config, "utf8") !== CODEX_CONFIG) {
    fs.writeFileSync(config, CODEX_CONFIG, { mode: 0o600 });
  }
  return dir;
}

function safeIsLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
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
