import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { log } from "./log";

const TOKEN_FILE = path.join(process.env.DATA_DIR || "/data", "api_token");
const BOOTSTRAP_DISABLED_FILE = path.join(
  process.env.DATA_DIR || "/data",
  "bootstrap_disabled",
);

let activeToken: string | null = null;
let bootstrapAvailable = false;

function cleanEnv(v: string | undefined): string {
  const t = (v || "").trim();
  if (!t || t.toLowerCase() === "null" || t.toLowerCase() === "undefined") {
    return "";
  }
  return t;
}

export async function initAuth(): Promise<{
  token: string;
  bootstrapAvailable: boolean;
}> {
  const optionToken = cleanEnv(process.env.API_TOKEN);

  if (optionToken.length > 0) {
    activeToken = optionToken;
    bootstrapAvailable = false;
    log.info("Using API token from add-on options.");
    return { token: activeToken, bootstrapAvailable: false };
  }

  let persisted: string | null = null;
  try {
    persisted = (await fs.readFile(TOKEN_FILE, "utf8")).trim();
  } catch {
    persisted = null;
  }

  if (!persisted || persisted.length < 16) {
    persisted = randomBytes(32).toString("hex");
    await fs.writeFile(TOKEN_FILE, persisted, { mode: 0o600 });
    log.warn(
      `Generated API token: ${persisted}. Copy this into add-on options to keep it stable across reinstalls.`,
    );
  } else {
    log.info("Using persisted API token from /data.");
  }

  let bootstrapDisabled = false;
  try {
    await fs.access(BOOTSTRAP_DISABLED_FILE);
    bootstrapDisabled = true;
  } catch {
    bootstrapDisabled = false;
  }

  activeToken = persisted;
  bootstrapAvailable = !bootstrapDisabled;
  return { token: persisted, bootstrapAvailable };
}

export function getToken(): string {
  if (!activeToken) throw new Error("Auth not initialised");
  return activeToken;
}

export function isBootstrapAvailable(): boolean {
  return bootstrapAvailable;
}

export async function disableBootstrap(): Promise<void> {
  bootstrapAvailable = false;
  try {
    await fs.writeFile(BOOTSTRAP_DISABLED_FILE, new Date().toISOString());
  } catch (err) {
    log.error({ err }, "Failed to persist bootstrap_disabled marker");
  }
}

export function checkBearer(authHeader: string | undefined): boolean {
  if (!authHeader || !activeToken) return false;
  const expected = `Bearer ${activeToken}`;
  if (authHeader.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= authHeader.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
