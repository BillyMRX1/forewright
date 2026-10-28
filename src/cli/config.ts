// `forewright config`: the user-level proxy and certificate settings, for machines where the proxy lives only
// in the system settings and not in environment variables, and the GUI settings. Stored in <data folder>/config.json.
import {
  clearCaFile, clearProxy, maskProxyUrl, networkConfigPath, readNetworkConfig, setCaFile, setProxy, type NetworkConfig,
} from "../core/network.js";
import { forewrightHome } from "../core/paths.js";
import { NTFY_DEFAULT_SERVER, clearPhoneConfig, describePhone, readPhoneConfig, setPhoneConfig } from "../core/notify-config.js";
import { PhoneSendError } from "../runtime/notify-send.js";
import { sendTestNotification } from "../runtime/notify.js";
import { addGuiAllowHost, clearGuiAllowHosts, readGuiConfig, setGuiAutostart, setGuiEditorHost, setGuiPort, type GuiConfig } from "../core/gui-config.js";

export const CONFIG_HELP = `forewright config: proxy and certificate settings for a company network, and GUI settings.

Usage:
  forewright config                         show the current settings (logins are hidden)
  forewright config proxy <url>             use this proxy, e.g. http://proxy.example.com:8080
  forewright config proxy --no-proxy <list> hosts that skip the proxy, e.g. localhost,.corp.example.com
  forewright config proxy --clear           remove the proxy settings
  forewright config ca <file>               trust this company certificate file (PEM)
  forewright config ca --clear              stop using the certificate file
  forewright config gui port <n>            port of the GUI on this machine (1024 to 65535, default 7420)
  forewright config gui allow-host <name>   also answer to this host name, e.g. a Tailscale Serve name
  forewright config gui allow-host --clear  answer to 127.0.0.1 and localhost only
  forewright config gui autostart on|off    start the GUI whenever the service starts
  forewright config gui editor-host <name>  SSH host name for "Open in editor" when the GUI runs on a remote server
  forewright config gui editor-host --clear open files in an editor on the browser's own machine
  forewright config notify ntfy <topic> [--server URL] [--token T]   phone notifications through ntfy (default server https://ntfy.sh)
  forewright config notify telegram <botToken> <chatId>              phone notifications through a Telegram bot
  forewright config notify pushover <appToken> <userKey>             phone notifications through Pushover
  forewright config notify test             send one test notification now
  forewright config notify --clear          turn phone notifications off

Phone notifications are off until you set a service. They carry titles and ids only, never code or secrets. Mute single types per project in the GUI Settings.

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

export function describeGui(cfg: GuiConfig): string {
  const lines = [`GUI port: ${cfg.port}`];
  lines.push(`GUI extra host names: ${cfg.allowHosts.length > 0 ? cfg.allowHosts.join(", ") : "none (127.0.0.1 and localhost only)"}`);
  lines.push(`GUI starts with the service: ${cfg.autostart ? "on" : "off"}`);
  lines.push(`GUI editor SSH host: ${cfg.editorSshHost ?? "none (open files in an editor on this machine)"}`);
  return `${lines.join("\n")}\n`;
}

const GUI_APPLY_NOTE = "A GUI that is already running keeps its port until the service restarts; host names apply at once.";

/** Returns the exit code; prints to `out` / `err`. Invalid values throw a ValidationError with a plain message. */
export function runConfig(args: string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }, home: string = forewrightHome()): number {
  const [what, ...rest] = args;
  const usage = (msg: string): number => {
    io.err(`${msg}\n\n${CONFIG_HELP}`);
    return 2;
  };
  const file = networkConfigPath(home);
  if (what === undefined || what === "show") return (io.out(describeConfig(readNetworkConfig(home), file) + describeGui(readGuiConfig(home)) + `${describePhone(readPhoneConfig(home))}\n`), 0);
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
  if (what === "gui") {
    const [key, ...vals] = rest;
    const saved = (cfg: GuiConfig): number => (io.out(`Saved.\n${describeGui(cfg)}${GUI_APPLY_NOTE}\n`), 0);
    if (key === "port") {
      if (vals.length !== 1) return usage("forewright config gui port needs one port number.");
      return saved(setGuiPort(vals[0], home));
    }
    if (key === "allow-host") {
      if (vals.length === 1 && vals[0] === "--clear") return saved(clearGuiAllowHosts(home));
      if (vals.length !== 1 || (vals[0] as string).startsWith("--")) return usage("forewright config gui allow-host needs one host name, or --clear.");
      return saved(addGuiAllowHost(vals[0] as string, home));
    }
    if (key === "autostart") {
      if (vals.length !== 1 || (vals[0] !== "on" && vals[0] !== "off")) return usage("forewright config gui autostart needs on or off.");
      return saved(setGuiAutostart(vals[0] === "on", home));
    }
    if (key === "editor-host") {
      if (vals.length === 1 && vals[0] === "--clear") return saved(setGuiEditorHost(null, home));
      if (vals.length !== 1 || (vals[0] as string).startsWith("--")) return usage("forewright config gui editor-host needs one host name, or --clear.");
      return saved(setGuiEditorHost(vals[0] as string, home));
    }
    return usage(key === undefined ? "forewright config gui needs a setting: port, allow-host, autostart or editor-host." : `Unknown GUI setting "${key}".`);
  }
  if (what === "notify") {
    const [service, ...vals] = rest;
    const saved = (): number => (io.out(`Saved.\n${describePhone(readPhoneConfig(home))}\nSend a test with: forewright config notify test\n`), 0);
    if (service === "--clear") return (clearPhoneConfig(home), io.out(`Phone notifications are off.\n`), 0);
    if (service === "ntfy") {
      let topic: string | undefined;
      let server = NTFY_DEFAULT_SERVER;
      let token: string | undefined;
      for (let i = 0; i < vals.length; i++) {
        const a = vals[i] as string;
        if (a === "--server" || a === "--token") {
          const v = vals[++i];
          if (v === undefined) return usage(`${a} needs a value.`);
          if (a === "--server") server = v;
          else token = v;
        } else if (a.startsWith("--")) return usage(`Unknown option "${a}".`);
        else if (topic === undefined) topic = a;
        else return usage(`Unexpected argument "${a}".`);
      }
      if (topic === undefined) return usage("forewright config notify ntfy needs a topic.");
      setPhoneConfig({ service: "ntfy", server, topic, ...(token !== undefined ? { token } : {}) }, home);
      return saved();
    }
    if (service === "telegram" || service === "pushover") {
      if (vals.length !== 2 || vals.some((v) => v.startsWith("--"))) return usage(service === "telegram" ? "forewright config notify telegram needs a bot token and a chat id." : "forewright config notify pushover needs an app token and a user key.");
      setPhoneConfig(service === "telegram" ? { service, botToken: vals[0] as string, chatId: vals[1] as string } : { service, appToken: vals[0] as string, userKey: vals[1] as string }, home);
      return saved();
    }
    if (service === "test") return usage("Use: forewright config notify test (it needs the service to run it).");
    return usage(service === undefined ? "forewright config notify needs ntfy, telegram, pushover, test or --clear." : `Unknown notify service "${service}".`);
  }
  return usage(`Unknown config setting "${what}".`);
}

/** `forewright config notify test`: one test message to the configured phone service. Returns the exit code. */
export async function runNotifyTest(io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }, home: string = forewrightHome(), send: Parameters<typeof sendTestNotification>[2] = {}): Promise<number> {
  const cfg = readPhoneConfig(home);
  if (cfg === null) {
    io.err("Phone notifications are not set up. Run: forewright config notify ntfy <topic>\n");
    return 1;
  }
  try {
    await sendTestNotification(cfg, home, send);
  } catch (err) {
    if (err instanceof PhoneSendError) {
      io.err(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  io.out(`Test notification sent through ${cfg.service}.\n`);
  return 0;
}
