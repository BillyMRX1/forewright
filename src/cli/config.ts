// `forewright config`: the user-level proxy and certificate settings, for machines where the proxy lives only
// in the system settings and not in environment variables. Stored in <data folder>/config.json.
import {
  clearCaFile, clearProxy, maskProxyUrl, networkConfigPath, readNetworkConfig, setCaFile, setProxy, type NetworkConfig,
} from "../core/network.js";
import { forewrightHome } from "../core/paths.js";

export const CONFIG_HELP = `forewright config: proxy and certificate settings for a company network.

Usage:
  forewright config                         show the current settings (logins are hidden)
  forewright config proxy <url>             use this proxy, e.g. http://proxy.example.com:8080
  forewright config proxy --no-proxy <list> hosts that skip the proxy, e.g. localhost,.corp.example.com
  forewright config proxy --clear           remove the proxy settings
  forewright config ca <file>               trust this company certificate file (PEM)
  forewright config ca --clear              stop using the certificate file

Variables already set in the environment (HTTPS_PROXY, NO_PROXY, NODE_EXTRA_CA_CERTS, ...) win over these settings.
Check the result with: forewright doctor
`;

export function describeConfig(cfg: NetworkConfig, file: string): string {
  const p = cfg.proxy ?? {};
  const lines = [`Settings file: ${file}`];
  lines.push(`Proxy (https): ${p.https ? maskProxyUrl(p.https) : "not set"}`);
  lines.push(`Proxy (http): ${p.http ? maskProxyUrl(p.http) : "not set"}`);
  lines.push(`No proxy for: ${p.noProxy ?? "not set"}`);
  lines.push(`Certificate file: ${p.caFile ?? "not set"}`);
  return `${lines.join("\n")}\n`;
}

/** Returns the exit code; prints to `out` / `err`. Invalid values throw a ValidationError with a plain message. */
export function runConfig(args: string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }, home: string = forewrightHome()): number {
  const [what, ...rest] = args;
  const usage = (msg: string): number => {
    io.err(`${msg}\n\n${CONFIG_HELP}`);
    return 2;
  };
  const file = networkConfigPath(home);
  if (what === undefined || what === "show") return (io.out(describeConfig(readNetworkConfig(home), file)), 0);
  if (what === "--help" || what === "-h" || what === "help") return (io.out(CONFIG_HELP), 0);
  if (what === "proxy") {
    if (rest.length === 1 && rest[0] === "--clear") {
      io.out(`Proxy settings cleared.\n${describeConfig(clearProxy(home), file)}`);
      return 0;
    }
    let url: string | undefined;
    let noProxy: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i] as string;
      if (a === "--no-proxy") {
        noProxy = rest[++i];
        if (noProxy === undefined) return usage("--no-proxy needs a list of hosts.");
      } else if (a.startsWith("--")) return usage(`Unknown option "${a}".`);
      else if (url === undefined) url = a;
      else return usage(`Unexpected argument "${a}".`);
    }
    if (url === undefined && noProxy === undefined) return usage("forewright config proxy needs a proxy URL, --no-proxy <list> or --clear.");
    const next = setProxy({ ...(url !== undefined ? { url } : {}), ...(noProxy !== undefined ? { noProxy } : {}) }, home);
    io.out(`Saved.\n${describeConfig(next, file)}`);
    return 0;
  }
  if (what === "ca") {
    if (rest.length === 1 && rest[0] === "--clear") {
      io.out(`Certificate file cleared.\n${describeConfig(clearCaFile(home), file)}`);
      return 0;
    }
    if (rest.length !== 1 || (rest[0] as string).startsWith("--")) return usage("forewright config ca needs one certificate file, or --clear.");
    io.out(`Saved.\n${describeConfig(setCaFile(rest[0] as string, home), file)}`);
    return 0;
  }
  return usage(`Unknown config setting "${what}".`);
}
