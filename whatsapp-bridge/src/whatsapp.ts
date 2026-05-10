import { promises as fs } from "fs";
import path from "path";
import { Client, LocalAuth, MessageMedia } from "whatsapp-web.js";
import QRCode from "qrcode";
import { bus } from "./events";
import { log } from "./log";

type State = "init" | "qr" | "loading" | "ready" | "disconnected";

export interface Status {
  state: State;
  phone: string | null;
  push_name: string | null;
  battery: number | null;
  last_seen_at: string | null;
}

export interface SendTextInput {
  to: string;
  body: string;
  quoted_msg_id?: string;
}

export interface SendMediaInput {
  to: string;
  buffer: Buffer;
  filename: string;
  mimetype: string;
  caption?: string;
  as_document?: boolean;
  as_voice?: boolean;
}

const DATA_DIR = process.env.DATA_DIR || "/data";
const SESSION_DIR = path.join(DATA_DIR, "wwebjs_auth");
const CACHE_DIR = path.join(DATA_DIR, "wwebjs_cache");
const LOCK_FILE = path.join(DATA_DIR, "whatsapp.lock");

function jidFromPhone(input: string): string {
  if (input.includes("@")) return input;
  const digits = input.replace(/[^0-9]/g, "");
  if (!digits) throw new Error("Invalid recipient");
  return `${digits}@c.us`;
}

// bashio::config returns the literal "null" for unset keys; treat that and
// "undefined" as empty so they never leak into puppeteer or other clients.
function cleanEnv(v: string | undefined): string {
  const t = (v || "").trim();
  if (!t || t.toLowerCase() === "null" || t.toLowerCase() === "undefined") {
    return "";
  }
  return t;
}

export class WhatsAppBridge {
  private client: Client | null = null;
  private status: Status = {
    state: "init",
    phone: null,
    push_name: null,
    battery: null,
    last_seen_at: null,
  };
  private qrText: string | null = null;
  private qrPng: Buffer | null = null;
  private qrGeneratedAt: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  async start(): Promise<void> {
    await this.acquireLock();
    await fs.mkdir(SESSION_DIR, { recursive: true });
    await fs.mkdir(CACHE_DIR, { recursive: true });
    this.client = this.buildClient();
    this.wireEvents();
    log.info("Initialising WhatsApp client...");
    await this.client.initialize();
  }

  private buildClient(): Client {
    const executablePath =
      cleanEnv(process.env.PUPPETEER_EXECUTABLE) ||
      cleanEnv(process.env.PUPPETEER_EXECUTABLE_PATH) ||
      "/usr/bin/chromium";

    const proxyUrl = cleanEnv(process.env.PROXY_URL);
    const puppeteerArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
    ];
    if (proxyUrl) puppeteerArgs.push(`--proxy-server=${proxyUrl}`);

    return new Client({
      authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
      puppeteer: {
        headless: true,
        executablePath,
        args: puppeteerArgs,
      },
      webVersionCache: {
        type: "local",
        path: CACHE_DIR,
      },
    });
  }

  private wireEvents(): void {
    if (!this.client) return;
    const client = this.client;

    client.on("qr", async (qr: string) => {
      this.qrText = qr;
      this.qrGeneratedAt = new Date().toISOString();
      try {
        this.qrPng = await QRCode.toBuffer(qr, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 320,
        });
      } catch (err) {
        log.error({ err }, "Failed to render QR PNG");
        this.qrPng = null;
      }
      this.setState("qr");
      bus.emitEvent({
        type: "qr",
        payload: { qr, generated_at: this.qrGeneratedAt },
      });
      log.info("QR generated; awaiting scan.");
    });

    client.on("loading_screen", (percent: number, message: string) => {
      this.setState("loading");
      log.debug({ percent, message }, "Loading screen");
    });

    client.on("authenticated", () => {
      log.info("Authenticated.");
    });

    client.on("auth_failure", (msg: string) => {
      log.error({ msg }, "Authentication failure");
      this.setState("disconnected");
    });

    client.on("ready", async () => {
      this.qrText = null;
      this.qrPng = null;
      this.qrGeneratedAt = null;
      this.reconnectAttempts = 0;
      const info = client.info;
      this.status.phone = info?.wid?._serialized?.split("@")[0] || null;
      this.status.push_name = info?.pushname || null;
      this.status.last_seen_at = new Date().toISOString();
      this.setState("ready");
      log.info({ phone: this.status.phone }, "WhatsApp ready.");
      this.refreshBattery().catch(() => undefined);
    });

    client.on("disconnected", (reason: string) => {
      log.warn({ reason }, "Disconnected");
      this.setState("disconnected");
      this.scheduleReconnect();
    });

    client.on("message", async (msg) => {
      try {
        this.status.last_seen_at = new Date().toISOString();
        bus.emitEvent({
          type: "message",
          payload: {
            id: msg.id?._serialized || "",
            from: msg.from,
            to: msg.to,
            body: msg.body || "",
            timestamp: msg.timestamp,
            has_media: !!msg.hasMedia,
            media_mime: null,
            ack: msg.ack || 0,
          },
        });
      } catch (err) {
        log.error({ err }, "Failed to dispatch message event");
      }
    });

    client.on("message_ack", (msg, ack) => {
      bus.emitEvent({
        type: "ack",
        payload: { id: msg.id?._serialized || "", ack },
      });
    });

    client.on("change_state", (s) => {
      log.debug({ state: s }, "wweb state change");
    });
  }

  private setState(s: State) {
    this.status.state = s;
    bus.emitEvent({ type: "state", payload: { ...this.status } });
  }

  private async refreshBattery() {
    if (!this.client) return;
    try {
      const info = await this.client.getState();
      log.debug({ info }, "client state");
    } catch {
      // best-effort
    }
  }

  private scheduleReconnect() {
    if (this.destroyed) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 10) {
      log.fatal("Reconnect attempts exhausted; exiting for s6 to restart.");
      process.exit(1);
    }
    const delaySec = Math.min(300, 5 * Math.pow(2, this.reconnectAttempts - 1));
    log.warn(
      `Reconnecting in ${delaySec}s (attempt ${this.reconnectAttempts}/10)`,
    );
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.client?.initialize();
      } catch (err) {
        log.error({ err }, "Reconnect failed");
        this.scheduleReconnect();
      }
    }, delaySec * 1000);
  }

  getStatus(): Status {
    return { ...this.status };
  }

  getQrPng(): { png: Buffer; generated_at: string } | null {
    if (!this.qrPng || !this.qrGeneratedAt) return null;
    return { png: this.qrPng, generated_at: this.qrGeneratedAt };
  }

  getQr(): { qr: string; generated_at: string } | null {
    if (!this.qrText || !this.qrGeneratedAt) return null;
    return { qr: this.qrText, generated_at: this.qrGeneratedAt };
  }

  async sendText(input: SendTextInput): Promise<{ message_id: string }> {
    this.assertReady();
    const jid = jidFromPhone(input.to);
    const opts: { quotedMessageId?: string } = {};
    if (input.quoted_msg_id) opts.quotedMessageId = input.quoted_msg_id;
    const msg = await this.client!.sendMessage(jid, input.body, opts);
    return { message_id: msg.id?._serialized || "" };
  }

  async sendMedia(input: SendMediaInput): Promise<{ message_id: string }> {
    this.assertReady();
    const jid = jidFromPhone(input.to);
    const media = new MessageMedia(
      input.mimetype,
      input.buffer.toString("base64"),
      input.filename,
    );
    const msg = await this.client!.sendMessage(jid, media, {
      caption: input.caption,
      sendMediaAsDocument: !!input.as_document,
      sendAudioAsVoice: !!input.as_voice,
    });
    return { message_id: msg.id?._serialized || "" };
  }

  async sendLocation(
    to: string,
    lat: number,
    lng: number,
    name?: string,
  ): Promise<{ message_id: string }> {
    this.assertReady();
    const jid = jidFromPhone(to);
    const { Location } = await import("whatsapp-web.js");
    const loc = new Location(lat, lng, { name });
    const msg = await this.client!.sendMessage(jid, loc);
    return { message_id: msg.id?._serialized || "" };
  }

  async listContacts(): Promise<
    Array<{
      id: string;
      name: string | null;
      push_name: string | null;
      is_business: boolean;
      is_my_contact: boolean;
    }>
  > {
    this.assertReady();
    const contacts = await this.client!.getContacts();
    return contacts
      .filter((c) => c.id?._serialized?.endsWith("@c.us"))
      .map((c) => ({
        id: c.id._serialized,
        name: c.name || null,
        push_name: c.pushname || null,
        is_business: !!c.isBusiness,
        is_my_contact: !!c.isMyContact,
      }));
  }

  async logout(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch (err) {
      log.error({ err }, "Logout error");
    }
    this.setState("disconnected");
  }

  async restart(): Promise<void> {
    if (!this.client) return;
    log.info("Restart requested.");
    try {
      await this.client.destroy();
    } catch (err) {
      log.error({ err }, "Destroy error during restart");
    }
    this.client = this.buildClient();
    this.wireEvents();
    await this.client.initialize();
  }

  async stop(): Promise<void> {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      await this.client?.destroy();
    } catch {
      // ignore
    }
    await this.releaseLock();
  }

  private assertReady(): void {
    if (this.status.state !== "ready") {
      const err: Error & { statusCode?: number } = new Error(
        `WhatsApp not ready (state=${this.status.state})`,
      );
      err.statusCode = 503;
      throw err;
    }
  }

  private async acquireLock(): Promise<void> {
    try {
      const existing = await fs.readFile(LOCK_FILE, "utf8");
      const pid = parseInt(existing.trim(), 10);
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          throw new Error(
            `Another whatsapp-bridge instance is running (pid=${pid}); refusing to start.`,
          );
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") {
            // stale lock, fall through
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // surface non-missing-file errors; permission issues, locked instance
        if ((err as Error).message?.startsWith("Another whatsapp-bridge"))
          throw err;
      }
    }
    await fs.writeFile(LOCK_FILE, String(process.pid));
  }

  private async releaseLock(): Promise<void> {
    try {
      await fs.unlink(LOCK_FILE);
    } catch {
      // ignore
    }
  }
}
