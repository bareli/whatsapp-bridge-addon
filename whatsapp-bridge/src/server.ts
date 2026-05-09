import Fastify, { FastifyInstance, FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import {
  checkBearer,
  disableBootstrap,
  getToken,
  isBootstrapAvailable,
} from "./auth";
import { bus, BridgeEvent } from "./events";
import { log } from "./log";
import { WhatsAppBridge } from "./whatsapp";

export interface ServerOptions {
  port: number;
  bridge: WhatsAppBridge;
}

const PUBLIC_PATHS = new Set(["/healthz", "/bootstrap"]);

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

  await app.register(multipart, {
    limits: { fileSize: 32 * 1024 * 1024, files: 1 },
  });
  await app.register(websocket);

  app.addHook("onRequest", async (req, reply) => {
    if (PUBLIC_PATHS.has(req.url.split("?")[0])) return;
    if (req.url.startsWith("/ws")) return; // upgrade handled separately
    if (!checkBearer(req.headers.authorization)) {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/bootstrap", async (_req, reply) => {
    if (!isBootstrapAvailable()) {
      reply.code(404).send({ error: "bootstrap_disabled" });
      return;
    }
    const token = getToken();
    await disableBootstrap();
    reply.send({ token });
  });

  app.get("/status", async () => opts.bridge.getStatus());

  app.get("/qr", async (_req, reply) => {
    const q = opts.bridge.getQr();
    if (!q) {
      reply.code(404).send({ error: "no_qr" });
      return;
    }
    reply.send(q);
  });

  app.get("/qr.png", async (_req, reply) => {
    const q = opts.bridge.getQrPng();
    if (!q) {
      reply.code(404).send({ error: "no_qr" });
      return;
    }
    reply
      .header("Content-Type", "image/png")
      .header("Cache-Control", "no-store")
      .header("X-QR-Generated-At", q.generated_at)
      .send(q.png);
  });

  app.post<{
    Body: { to: string; body: string; quoted_msg_id?: string };
  }>("/send/text", async (req, reply) => {
    const { to, body, quoted_msg_id } = req.body || ({} as never);
    if (!to || typeof body !== "string") {
      reply.code(400).send({ error: "invalid_body" });
      return;
    }
    try {
      const out = await opts.bridge.sendText({ to, body, quoted_msg_id });
      reply.send(out);
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.post("/send/media", async (req: FastifyRequest, reply) => {
    if (!req.isMultipart()) {
      reply.code(400).send({ error: "expected_multipart" });
      return;
    }
    let to = "";
    let caption: string | undefined;
    let asDocument = false;
    let asVoice = false;
    let buffer: Buffer | null = null;
    let filename = "file.bin";
    let mimetype = "application/octet-stream";

    try {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) chunks.push(chunk as Buffer);
          buffer = Buffer.concat(chunks);
          filename = part.filename || filename;
          mimetype = part.mimetype || mimetype;
        } else {
          const v = String(part.value ?? "");
          switch (part.fieldname) {
            case "to":
              to = v;
              break;
            case "caption":
              caption = v;
              break;
            case "as_document":
              asDocument = v === "true" || v === "1";
              break;
            case "as_voice":
              asVoice = v === "true" || v === "1";
              break;
          }
        }
      }
    } catch (err) {
      handleError(reply, err);
      return;
    }

    if (!to || !buffer) {
      reply.code(400).send({ error: "missing_to_or_file" });
      return;
    }
    try {
      const out = await opts.bridge.sendMedia({
        to,
        buffer,
        filename,
        mimetype,
        caption,
        as_document: asDocument,
        as_voice: asVoice,
      });
      reply.send(out);
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.post<{
    Body: { to: string; lat: number; lng: number; name?: string };
  }>("/send/location", async (req, reply) => {
    const { to, lat, lng, name } = req.body || ({} as never);
    if (!to || typeof lat !== "number" || typeof lng !== "number") {
      reply.code(400).send({ error: "invalid_body" });
      return;
    }
    try {
      const out = await opts.bridge.sendLocation(to, lat, lng, name);
      reply.send(out);
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.get("/contacts", async (_req, reply) => {
    try {
      const contacts = await opts.bridge.listContacts();
      reply.send(contacts);
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.post("/session/logout", async (_req, reply) => {
    try {
      await opts.bridge.logout();
      reply.send({ ok: true });
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.post("/session/restart", async (_req, reply) => {
    try {
      await opts.bridge.restart();
      reply.send({ ok: true });
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (conn, req) => {
      if (!checkBearer(req.headers.authorization)) {
        conn.socket.close(4401, "unauthorized");
        return;
      }
      // Send initial state snapshot
      try {
        conn.socket.send(
          JSON.stringify({ type: "state", payload: opts.bridge.getStatus() }),
        );
        const qr = opts.bridge.getQr();
        if (qr) {
          conn.socket.send(JSON.stringify({ type: "qr", payload: qr }));
        }
      } catch (err) {
        log.error({ err }, "Failed to send initial WS snapshot");
      }

      const listener = (evt: BridgeEvent) => {
        try {
          conn.socket.send(JSON.stringify(evt));
        } catch (err) {
          log.error({ err }, "WS send failed");
        }
      };
      bus.on("event", listener);
      conn.socket.on("close", () => bus.off("event", listener));
    });
  });

  // Tiny ingress status page (no auth — admin-gated by Supervisor ingress).
  app.get("/", async (req, reply) => {
    if (req.url.startsWith("/ws")) return;
    const s = opts.bridge.getStatus();
    reply
      .type("text/html")
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><title>WhatsApp Bridge</title>` +
          `<style>body{font-family:sans-serif;margin:2rem;max-width:42rem}code{background:#eee;padding:.1rem .3rem;border-radius:3px}` +
          `.pill{display:inline-block;padding:.25rem .75rem;border-radius:1rem;color:#fff}` +
          `.ready{background:#16a34a}.qr{background:#f59e0b}.disconnected{background:#dc2626}` +
          `.loading{background:#3b82f6}.init{background:#6b7280}</style></head><body>` +
          `<h1>WhatsApp Bridge</h1>` +
          `<p>State: <span class="pill ${s.state}">${s.state}</span></p>` +
          `<p>Phone: <code>${s.phone || "—"}</code></p>` +
          `<p>Push name: <code>${s.push_name || "—"}</code></p>` +
          `<p>Last seen: <code>${s.last_seen_at || "—"}</code></p>` +
          `<p>The QR code is shown in Home Assistant via the Lovelace card.</p>` +
          `</body></html>`,
      );
  });

  return app;
}

function handleError(reply: import("fastify").FastifyReply, err: unknown) {
  const e = err as Error & { statusCode?: number };
  const status = e.statusCode || 500;
  log.error({ err: e?.message }, "Request failed");
  reply.code(status).send({ error: e?.message || "internal_error" });
}
