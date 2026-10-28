// The phone notification pipeline of one project: reads bus events, maps them to notifications (the shared pure
// mapping), applies the project's mute list, dedupes, rate limits and hands the text to the configured service.
// Opt-in: with no `notify` section in the user config nothing is sent. A failed delivery is logged and shown in
// Settings; it never stops the daemon.
import { NotFoundError } from "../core/errors.js";
import { NOTIFY_MUTE_KEY, type Notification, type NotifyType, isMuted, linkPath, notificationFor, parseMute, plainTitle } from "../core/notify-model.js";
import { type PhoneConfig, phoneSecrets, readPhoneConfig } from "../core/notify-config.js";
import { redactSecrets, sanitizeTerminal } from "../core/safety.js";
import type { ForewrightEvent } from "../core/store-types.js";
import type { Store } from "../core/store.js";
import { type PhoneMessage, type SendOptions, sendPhone } from "./notify-send.js";

/** Redacts secrets, flattens and caps untrusted text before it goes to a phone service. */
export const cleanTitle = (raw: unknown, fallback: string, max?: number): string => plainTitle(typeof raw === "string" ? sanitizeTerminal(redactSecrets(raw)) : raw, fallback, max);

/** At most this many notifications per project per hour; the rest collapse into one "N more updates". */
export const NOTIFY_PER_HOUR = 20;
export const NOTIFY_WINDOW_MS = 60 * 60_000;
/** The same type and item notify once within this long (a task can fail and run out of retries in one go). */
export const NOTIFY_DEDUPE_MS = 10 * 60_000;

export interface PhoneStatus {
  /** The service that is set up, or null when phone notifications are off. Never a secret. */
  service: PhoneConfig["service"] | null;
  /** Why the last delivery failed, or null when the last one worked (or none was tried). */
  lastError: string | null;
}

export interface PipelineOptions {
  store: Store;
  projectName: string;
  home: string;
  now?: () => number;
  send?: SendOptions;
  log?: (line: string) => void;
}

export class NotifyPipeline {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly seen = new Map<string, number>();
  private sent: number[] = [];
  private overflow = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private lastConfigProblem: string | null = null;
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly o: PipelineOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  status(): PhoneStatus {
    let service: PhoneStatus["service"] = null;
    try {
      service = readPhoneConfig(this.o.home)?.service ?? null;
    } catch {
      service = null;
    }
    return { service, lastError: this.lastError };
  }

  /** Waits for deliveries that are under way (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The bus listener. Never throws. */
  handle(ev: ForewrightEvent): void {
    try {
      const n = this.map(ev);
      if (n === null) return;
      const cfg = this.config();
      if (cfg === null) return;
      if (isMuted(this.mute(), n.type)) return;
      if (!this.firstTime(n)) return;
      this.dispatch(cfg, n);
    } catch (err) {
      this.log(`[forewright] phone notification skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private map(ev: ForewrightEvent): Notification | null {
    const store = this.o.store;
    return notificationFor(ev, {
      clean: cleanTitle,
      task: (id) => {
        try {
          const t = store.getTask(id);
          return { shortId: t.shortId, title: t.title };
        } catch (err) {
          if (err instanceof NotFoundError) return null;
          throw err;
        }
      },
      agentName: (id) => {
        try {
          return store.getAgent(id).name;
        } catch (err) {
          if (err instanceof NotFoundError) return null;
          throw err;
        }
      },
    });
  }

  private config(): PhoneConfig | null {
    try {
      const cfg = readPhoneConfig(this.o.home);
      this.lastConfigProblem = null;
      return cfg;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== this.lastConfigProblem) this.log(`[forewright] phone notifications are set up wrongly: ${msg}`);
      this.lastConfigProblem = msg;
      this.lastError = "the notify settings in config.json are not valid; run forewright config notify test";
      return null;
    }
  }

  private mute(): NotifyType[] {
    return parseMute(this.o.store.getSetting(NOTIFY_MUTE_KEY)) ?? [];
  }

  private firstTime(n: Notification): boolean {
    const t = this.now();
    for (const [k, at] of this.seen) if (t - at > NOTIFY_DEDUPE_MS) this.seen.delete(k);
    const key = `${n.type}:${n.itemId}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, t);
    return true;
  }

  private message(n: Notification): PhoneMessage {
    return { title: cleanTitle(`Forewright: ${this.o.projectName}`, "Forewright", 60), body: `${n.text}\nGUI: #${linkPath(n.link)}` };
  }

  private dispatch(cfg: PhoneConfig, n: Notification): void {
    const t = this.now();
    this.sent = this.sent.filter((at) => t - at < NOTIFY_WINDOW_MS);
    if (this.sent.length >= NOTIFY_PER_HOUR) {
      this.overflow += 1;
      this.armFlush();
      return;
    }
    this.sent.push(t);
    this.deliver(cfg, this.message(n));
  }

  /** Sends the collapsed count when the window has room again. Called by the timer; public for tests. */
  flushOverflow(): void {
    this.timer = null;
    if (this.overflow === 0) return;
    const cfg = this.config();
    if (cfg === null) return;
    const t = this.now();
    this.sent = this.sent.filter((at) => t - at < NOTIFY_WINDOW_MS);
    if (this.sent.length >= NOTIFY_PER_HOUR) return this.armFlush();
    const n = this.overflow;
    this.overflow = 0;
    this.sent.push(t);
    this.deliver(cfg, { title: cleanTitle(`Forewright: ${this.o.projectName}`, "Forewright", 60), body: `${n} more ${n === 1 ? "update" : "updates"} in the last hour. Open the GUI to see them.` });
  }

  private armFlush(): void {
    if (this.timer || this.sent.length === 0) return;
    const wait = Math.max(1000, this.sent[0]! + NOTIFY_WINDOW_MS - this.now() + 1000);
    this.timer = setTimeout(() => this.flushOverflow(), wait);
    this.timer.unref();
  }

  private deliver(cfg: PhoneConfig, msg: PhoneMessage): void {
    const p = sendPhone(cfg, msg, { home: this.o.home, ...this.o.send }).then(
      () => {
        this.lastError = null;
      },
      (err: unknown) => {
        const reason = redactSecrets(err instanceof Error ? err.message : String(err), phoneSecrets(cfg));
        this.lastError = reason;
        this.log(`[forewright] phone notification failed: ${reason}`);
      },
    );
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }
}

/** One test message, for `forewright config notify test`. Throws PhoneSendError on failure. */
export function sendTestNotification(cfg: PhoneConfig, home: string, send: SendOptions = {}): Promise<void> {
  return sendPhone(cfg, { title: "Forewright", body: "Test notification. Phone notifications are set up." }, { home, ...send });
}
