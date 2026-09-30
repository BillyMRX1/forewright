import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** which-style lookup on a PATH string. */
export function resolveBinary(name: string, pathEnv: string | undefined = process.env["PATH"]): string | null {
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not executable here, keep looking
    }
  }
  return null;
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function capture(bin: string, args: string[], env: Record<string, string>, timeoutMs = 12_000): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(err);
      if (err && (err as { killed?: boolean }).killed) return reject(new Error(`${bin} ${args.join(" ")} timed out after ${timeoutMs} ms`));
      const code = err ? ((err as { code?: number }).code ?? 1) : 0;
      resolve({ code: typeof code === "number" ? code : 1, stdout, stderr });
    });
  });
}
