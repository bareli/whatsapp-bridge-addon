import { initAuth } from "./auth";
import { log } from "./log";
import { buildServer } from "./server";
import { WhatsAppBridge } from "./whatsapp";

async function main() {
  const port = parseInt(process.env.PORT || "8080", 10);
  await initAuth();

  const bridge = new WhatsAppBridge();
  const app = await buildServer({ port, bridge });

  await app.listen({ host: "0.0.0.0", port });
  log.info({ port }, "HTTP server listening");

  // Start WhatsApp client after the HTTP server is up so /healthz responds
  // immediately to the Supervisor watchdog while puppeteer warms up.
  bridge.start().catch((err) => {
    log.fatal({ err }, "Failed to start WhatsApp bridge");
    process.exit(1);
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "Shutting down");
    try {
      await app.close();
    } catch (err) {
      log.error({ err }, "Failed to close HTTP server");
    }
    try {
      await bridge.stop();
    } catch (err) {
      log.error({ err }, "Failed to stop WhatsApp bridge");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error", err);
  process.exit(1);
});
