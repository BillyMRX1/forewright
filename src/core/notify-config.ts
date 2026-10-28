// The "notify" section of the user-level config file (<data folder>/config.json, kept private to the owner):
// where phone notifications go. Off unless a service is set. The secrets here (ntfy topic and token, Telegram
// bot token, Pushover keys) are never logged, never sent to the GUI and always masked when shown.
import { ValidationError } from "./errors.js";
import { networkConfigPath, readConfigFile, writeConfigSection } from "./network.js";
import { forewrightHome } from "./paths.js";

export const NTFY_DEFAULT_SERVER = "https://ntfy.sh";

export type NotifyService = "ntfy" | "telegram" | "pushover";

export type PhoneConfig =
  | { service: "ntfy"; server: string; topic: string; token?: string }
  | { service: "telegram"; botToken: string; chatId: string }
  | { service: "pushover"; appToken: string; userKey: string };

const isLoopback = (host: string): boolean => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** An ntfy server: an https URL (http only for this machine), without a login, path or query. Returned without a trailing slash. */
export function validateNtfyServer(value: string): string {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new ValidationError(`"${value}" is not a server URL. Give it like https://ntfy.sh.`, { value });
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u.hostname))) {
    throw new ValidationError("The ntfy server must use https (http is allowed only for localhost).", { value });
  }
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "" || (u.pathname !== "/" && u.pathname !== "")) {
    throw new ValidationError("Give the ntfy server as just a host URL, such as https://ntfy.sh. The access token has its own option.", {});
  }
  return u.origin;
}

function required(value: string | undefined, what: string, pattern: RegExp, hint: string): string {
  const v = (value ?? "").trim();
  if (!pattern.test(v)) throw new ValidationError(`The ${what} is not valid: ${hint}.`, {});
  return v;
}

/** Checks and normalizes a service setting typed on the command line. Messages never repeat the secret. */
export function validatePhoneConfig(c: PhoneConfig): PhoneConfig {
  if (c.service === "ntfy") {
    const topic = required(c.topic, "ntfy topic", /^[A-Za-z0-9_-]{1,64}$/, "use letters, digits, - and _ (up to 64)");
    const token = c.token === undefined ? undefined : required(c.token, "ntfy access token", /^[\x21-\x7e]{4,200}$/, "no spaces, 4 to 200 characters");
    return { service: "ntfy", server: validateNtfyServer(c.server), topic, ...(token !== undefined ? { token } : {}) };
  }
  if (c.service === "telegram") {
    return {
      service: "telegram",
      botToken: required(c.botToken, "Telegram bot token", /^\d{3,}:[A-Za-z0-9_-]{10,}$/, "it looks like 123456:ABC-def..."),
      chatId: required(c.chatId, "Telegram chat id", /^(-?\d{1,20}|@[A-Za-z0-9_]{3,64})$/, "a number such as 123456789, or @channelname"),
    };
  }
  return {
    service: "pushover",
    appToken: required(c.appToken, "Pushover app token", /^[A-Za-z0-9]{20,40}$/, "30 letters and digits"),
    userKey: required(c.userKey, "Pushover user key", /^[A-Za-z0-9]{20,40}$/, "30 letters and digits"),
  };
}

/** Reads the notify section, or null when phone notifications are off. An invalid section is an error naming the file. */
export function readPhoneConfig(home: string = forewrightHome()): PhoneConfig | null {
  const file = networkConfigPath(home);
  const raw = readConfigFile(home)["notify"];
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ValidationError(`"notify" in ${file} must be an object.`, { file });
  const r = raw as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof r[k] === "string" ? (r[k] as string) : undefined);
  try {
    if (r["service"] === "ntfy") return validatePhoneConfig({ service: "ntfy", server: str("server") ?? NTFY_DEFAULT_SERVER, topic: str("topic") ?? "", ...(str("token") !== undefined ? { token: str("token") as string } : {}) });
    if (r["service"] === "telegram") return validatePhoneConfig({ service: "telegram", botToken: str("botToken") ?? "", chatId: str("chatId") ?? "" });
    if (r["service"] === "pushover") return validatePhoneConfig({ service: "pushover", appToken: str("appToken") ?? "", userKey: str("userKey") ?? "" });
  } catch (err) {
    if (err instanceof ValidationError) throw new ValidationError(`${err.message} (in ${file})`, { file });
    throw err;
  }
  throw new ValidationError(`"notify.service" in ${file} must be ntfy, telegram or pushover.`, { file });
}

/** Validates and saves one service (it replaces any other). */
export function setPhoneConfig(c: PhoneConfig, home: string = forewrightHome()): PhoneConfig {
  const v = validatePhoneConfig(c);
  writeConfigSection("notify", v, home);
  return v;
}

export function clearPhoneConfig(home: string = forewrightHome()): void {
  writeConfigSection("notify", undefined, home);
}

const mask = (v: string): string => (v.length <= 6 ? "***" : `${v.slice(0, 2)}***`);

/** The setting in words with every secret masked, for `forewright config`. */
export function describePhone(c: PhoneConfig | null): string {
  if (c === null) return "Phone notifications: off";
  if (c.service === "ntfy") return `Phone notifications: ntfy at ${c.server}, topic ${mask(c.topic)}, access token ${c.token ? "set" : "not set"}`;
  if (c.service === "telegram") return `Phone notifications: Telegram, bot token ${mask(c.botToken)}, chat ${mask(c.chatId)}`;
  return `Phone notifications: Pushover, app token ${mask(c.appToken)}, user key ${mask(c.userKey)}`;
}

/** Every secret value of the setting, for redacting error text. */
export function phoneSecrets(c: PhoneConfig): string[] {
  if (c.service === "ntfy") return [c.topic, ...(c.token ? [c.token] : [])];
  if (c.service === "telegram") return [c.botToken, c.chatId];
  return [c.appToken, c.userKey];
}
