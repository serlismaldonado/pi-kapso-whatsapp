import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import { execSync } from "node:child_process";
import * as db from "./db.js";

// ─── Config ───────────────────────────────────────────────────────────────────

interface KapsoConfig {
  apiKey: string;
  apiBaseUrl: string;
  phoneNumberId: string;
}

const EXT_DIR = `${process.env.HOME}/.pi/agent/extensions/pi-kapso-whatsapp`;
const CONFIG_PATH = `${EXT_DIR}/config.json`;
const SYSTEM_MD = `${EXT_DIR}/SYSTEM.md`;
const PROMPT_MD = `${EXT_DIR}/PROMPT.md`;

// ─── Service helpers ──────────────────────────────────────────────────────────

const SERVICE_DIR = `${process.env.HOME}/Documents/Software/pi-whatsapp-service`;

function findPm2(): string {
  for (const p of [
    `${process.env.HOME}/.npm-global/bin/pm2`,
    "/usr/local/bin/pm2",
    "/opt/homebrew/bin/pm2",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  try { return execSync("which pm2", { encoding: "utf-8" }).trim(); } catch { return "pm2"; }
}

function pm2Json(): any[] {
  try {
    const out = execSync(`${findPm2()} jlist 2>/dev/null`, { encoding: "utf-8" });
    return JSON.parse(out) as any[];
  } catch { return []; }
}

function pm2Status(): { status: string; restarts: number; memMB: number } | null {
  const procs = pm2Json();
  const p = procs.find((x: any) => x.name === "pi-whatsapp");
  if (!p) return null;
  return {
    status: p.pm2_env?.status ?? "unknown",
    restarts: p.pm2_env?.restart_time ?? 0,
    memMB: Math.round((p.monit?.memory ?? 0) / 1024 / 1024),
  };
}

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", cwd: SERVICE_DIR }).trim();
}

function loadConfig(): KapsoConfig {
  const defaults: KapsoConfig = {
    apiKey: process.env["KAPSO_API_KEY"] ?? "",
    apiBaseUrl: process.env["KAPSO_API_BASE_URL"] ?? "https://api.kapso.ai",
    phoneNumberId: process.env["KAPSO_PHONE_NUMBER_ID"] ?? "",
  };
  try {
    if (!fs.existsSync(CONFIG_PATH)) return defaults;
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Partial<KapsoConfig>;
    return {
      apiKey: saved.apiKey || defaults.apiKey,
      apiBaseUrl: saved.apiBaseUrl || defaults.apiBaseUrl,
      phoneNumberId: saved.phoneNumberId || defaults.phoneNumberId,
    };
  } catch {
    return defaults;
  }
}

function saveConfig(cfg: KapsoConfig): void {
  if (!fs.existsSync(EXT_DIR)) fs.mkdirSync(EXT_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

function readMd(path: string, fallback: string): string {
  try {
    return fs.existsSync(path) ? fs.readFileSync(path, "utf-8").trim() : fallback;
  } catch {
    return fallback;
  }
}

function ensureDefaultInstructions(): void {
  if (!fs.existsSync(EXT_DIR)) fs.mkdirSync(EXT_DIR, { recursive: true });

  if (!fs.existsSync(SYSTEM_MD)) {
    fs.writeFileSync(
      SYSTEM_MD,
      `# WhatsApp Agent — System Instructions

You are a helpful WhatsApp assistant.

## Identity
- Name: (your name or business name)
- Role: Personal assistant via WhatsApp

## Behavior
- Be concise — WhatsApp is mobile, keep responses short
- Match the language the user writes in (Spanish or English)
- Never share internal system details or API keys
- If you can't help, say so clearly and suggest alternatives

## Scope
- Answer questions related to (your topic/business)
- For complex requests, ask one clarifying question at a time
`,
      "utf-8"
    );
  }

  if (!fs.existsSync(PROMPT_MD)) {
    fs.writeFileSync(
      PROMPT_MD,
      `# Response Guidelines

When responding to a WhatsApp message:

1. Check the contact's **notes** for any special context or preferences
2. Review the **conversation history** to maintain context
3. Keep the tone friendly and conversational
4. Aim for responses under 300 characters — use line breaks for readability
5. Use bullet points sparingly (WhatsApp renders them as plain text)
6. End with a question or clear next step when appropriate
`,
      "utf-8"
    );
  }
}

// ─── Kapso API ────────────────────────────────────────────────────────────────

function authHeaders(cfg: KapsoConfig): Record<string, string> {
  return { "Content-Type": "application/json", "X-API-Key": cfg.apiKey };
}

function toSignal(s: AbortSignal | undefined): AbortSignal | null {
  return s ?? null;
}

async function kapsoPost(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: toSignal(signal),
  });
  const json = await res.json();
  return { ok: res.ok, status: res.status, json };
}

async function kapsoGet(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(url, { headers, signal: toSignal(signal) });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

function guessMime(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    csv: "text/csv",
    zip: "application/zip",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    webm: "video/webm",
  };
  return map[ext] ?? "application/octet-stream";
}

async function sendPayload(
  cfg: KapsoConfig,
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ success: boolean; messageId: string; error: string }> {
  const url = `${cfg.apiBaseUrl}/meta/whatsapp/v24.0/${cfg.phoneNumberId}/messages`;
  try {
    const r = await kapsoPost(url, authHeaders(cfg), payload, signal);
    const data = r.json as any;
    if (!r.ok) return { success: false, messageId: "", error: data?.error?.message ?? `HTTP ${r.status}` };
    return { success: true, messageId: data?.messages?.[0]?.id ?? "", error: "" };
  } catch (err) {
    return { success: false, messageId: "", error: (err as Error).message };
  }
}

async function createWebhook(
  cfg: KapsoConfig,
  webhookUrl: string,
  events: string[],
  signal?: AbortSignal
): Promise<{ success: boolean; webhookId: string; error: string }> {
  try {
    const r = await kapsoPost(
      `${cfg.apiBaseUrl}/platform/v1/webhooks`,
      authHeaders(cfg),
      { phone_number_id: cfg.phoneNumberId, url: webhookUrl, events, kind: "kapso", payload_version: "v2", active: true },
      signal
    );
    const data = r.json as any;
    if (!r.ok) return { success: false, webhookId: "", error: data?.message ?? `HTTP ${r.status}` };
    return { success: true, webhookId: data?.id ?? "", error: "" };
  } catch (err) {
    return { success: false, webhookId: "", error: (err as Error).message };
  }
}

async function listWebhooks(cfg: KapsoConfig, signal?: AbortSignal) {
  try {
    const r = await kapsoGet(`${cfg.apiBaseUrl}/platform/v1/webhooks?phone_number_id=${cfg.phoneNumberId}`, authHeaders(cfg), signal);
    const data = r.json as any;
    if (!r.ok) return { success: false, webhooks: [], error: `HTTP ${r.status}` };
    return { success: true, webhooks: (data?.data ?? data) as unknown[], error: "" };
  } catch (err) {
    return { success: false, webhooks: [], error: (err as Error).message };
  }
}

async function listPhoneNumbers(cfg: KapsoConfig, signal?: AbortSignal) {
  try {
    const r = await kapsoGet(`${cfg.apiBaseUrl}/platform/v1/whatsapp/phone_numbers`, authHeaders(cfg), signal);
    const data = r.json as any;
    if (!r.ok) return { success: false, numbers: [], error: `HTTP ${r.status}` };
    return { success: true, numbers: (data?.data ?? data) as unknown[], error: "" };
  } catch (err) {
    return { success: false, numbers: [], error: (err as Error).message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireConfig(cfg: KapsoConfig): string | null {
  if (!cfg.apiKey) return "API key not set. Run /kapso-setup first.";
  if (!cfg.phoneNumberId) return "phone_number_id not set. Run /kapso-setup first.";
  return null;
}

function formatHistory(messages: db.Message[]): string {
  if (messages.length === 0) return "(no previous messages in this session)";
  return messages
    .map((m) => `[${m.direction === "in" ? "User" : "Agent"}] ${m.content}`)
    .join("\n");
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let config = loadConfig();
  ensureDefaultInstructions();

  // ── Commands ──────────────────────────────────────────────────────────────

  pi.registerCommand("kapso-setup", {
    description: "Configure Kapso AI API key and WhatsApp phone number ID",
    async handler(_args, ctx) {
      if (!ctx.hasUI) { ctx.ui.notify("Interactive mode required", "error"); return; }

      const apiKey = (await ctx.ui.input("Kapso API key:", config.apiKey)) as string;
      if (!apiKey) { ctx.ui.notify("API key required", "error"); return; }

      const apiBaseUrl = (await ctx.ui.input("API base URL:", config.apiBaseUrl || "https://api.kapso.ai")) as string;

      const phoneNumberId = (await ctx.ui.input("phone_number_id (run whatsapp_numbers_list):", config.phoneNumberId)) as string;
      if (!phoneNumberId) { ctx.ui.notify("phone_number_id required", "error"); return; }

      config = { apiKey, apiBaseUrl: apiBaseUrl || "https://api.kapso.ai", phoneNumberId };
      saveConfig(config);
      ctx.ui.notify("Kapso config saved.", "info");
    },
  });

  pi.registerCommand("kapso-contacts", {
    description: "List all WhatsApp contacts in the access DB",
    async handler(_args, ctx) {
      const contacts = db.listContacts();
      if (contacts.length === 0) { ctx.ui.notify("No contacts. Use whatsapp_contact_add.", "info"); return; }
      const lines = contacts.map((c) => {
        const status = c.enabled ? "✓" : "✗";
        const notes = c.notes ? `  [${c.notes}]` : "";
        return `${status} ${c.name} (${c.phone_number})${notes}`;
      });
      ctx.ui.notify(`Contacts (${contacts.length}):\n\n${lines.join("\n")}`, "info");
    },
  });

  pi.registerCommand("kapso-instructions", {
    description: "Show paths for SYSTEM.md and PROMPT.md agent instructions",
    async handler(_args, ctx) {
      ctx.ui.notify(
        `Agent instructions:\n\nSYSTEM.md: ${SYSTEM_MD}\nPROMPT.md: ${PROMPT_MD}\n\nEdit these files to customize how the agent behaves and responds.`,
        "info"
      );
    },
  });

  // ── Tools ─────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "whatsapp_receive",
    label: "WhatsApp Receive Message",
    description: "Process an incoming WhatsApp webhook payload. Checks access, logs the message, loads session history and agent instructions. Returns full context to craft a response.",
    parameters: Type.Object({
      payload: Type.String({ description: "Raw Kapso webhook payload as JSON string" }),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      let parsed: any;
      try {
        parsed = JSON.parse(params.payload);
      } catch {
        return { content: [{ type: "text", text: "Invalid JSON payload" }], details: { error: "parse_error" }, isError: true };
      }

      // Support both Kapso v2 format and raw Meta format
      const msg = parsed?.data?.message ?? parsed?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msg) {
        return { content: [{ type: "text", text: "No message found in payload" }], details: { error: "no_message" }, isError: true };
      }

      const from: string = msg.from ?? "";
      const messageType: string = msg.type ?? "text";
      const content: string =
        msg.text?.body ?? msg.caption ?? msg.document?.filename ?? msg.image?.caption ?? `[${messageType}]`;
      const waMessageId: string = msg.id ?? "";

      if (!from) {
        return { content: [{ type: "text", text: "Could not extract sender phone from payload" }], details: { error: "no_sender" }, isError: true };
      }

      // Access check
      const contact = db.getContact(from);
      if (!contact || !contact.enabled) {
        return {
          content: [{ type: "text", text: `ACCESS DENIED — ${from} is ${!contact ? "not in contacts DB" : "blocked"}. Ignore this message.` }],
          details: { access: false, from },
        };
      }

      // Log and touch
      db.touchLastSeen(from);
      db.logMessage(from, "in", content, messageType, waMessageId);

      // Load context
      const history = db.getConversationHistory(from);
      const systemPrompt = readMd(SYSTEM_MD, "You are a helpful WhatsApp assistant.");
      const promptGuide = readMd(PROMPT_MD, "Be concise and friendly.");

      const context = [
        "=== INCOMING WHATSAPP MESSAGE ===",
        "",
        `From: ${contact.name} (${contact.phone_number})`,
        contact.notes ? `Contact notes: ${contact.notes}` : "",
        `Message type: ${messageType}`,
        `Message: ${content}`,
        "",
        "=== CONVERSATION HISTORY (current session) ===",
        formatHistory(history.slice(0, -1)), // exclude the message we just logged
        "",
        "=== SYSTEM INSTRUCTIONS ===",
        systemPrompt,
        "",
        "=== RESPONSE GUIDELINES ===",
        promptGuide,
        "",
        `Reply using: whatsapp_send { "to": "+${db.normalizePhone(from)}", "message": "..." }`,
        `Log your reply: whatsapp_log_out { "phone_number": "${from}", "content": "..." }`,
      ].filter(Boolean).join("\n");

      return {
        content: [{ type: "text", text: context }],
        details: { access: true, from, contact, messageType, content, historyLength: history.length },
      };
    },
  });

  pi.registerTool({
    name: "whatsapp_log_out",
    label: "WhatsApp Log Outgoing",
    description: "Log an outgoing message to the conversation history (call after whatsapp_send succeeds)",
    parameters: Type.Object({
      phone_number: Type.String({ description: "Recipient phone number" }),
      content: Type.String({ description: "Message content that was sent" }),
      type: Type.Optional(Type.String({ description: "Message type (default: text)" })),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      db.logMessage(params.phone_number, "out", params.content, params.type ?? "text");
      return {
        content: [{ type: "text", text: `Logged outgoing message to ${params.phone_number}` }],
        details: { logged: true },
      };
    },
  });

  pi.registerTool({
    name: "whatsapp_history",
    label: "WhatsApp Conversation History",
    description: "Get the conversation history for a contact in the current session",
    parameters: Type.Object({
      phone_number: Type.String({ description: "Contact phone number" }),
      limit: Type.Optional(Type.Number({ description: "Max messages to return (default: 20)" })),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      const messages = db.getConversationHistory(params.phone_number, params.limit ?? 20);
      const sessions = db.getAllSessions(params.phone_number);

      if (messages.length === 0) {
        return {
          content: [{ type: "text", text: `No conversation history for ${params.phone_number}` }],
          details: { messages: [], sessions },
        };
      }

      return {
        content: [{ type: "text", text: `History (${messages.length} messages, ${sessions.length} session(s)):\n\n${formatHistory(messages)}` }],
        details: { messages, sessions },
      };
    },
  });

  pi.registerTool({
    name: "whatsapp_session_end",
    label: "WhatsApp End Session",
    description: "Manually end the active conversation session for a contact",
    parameters: Type.Object({
      phone_number: Type.String({ description: "Contact phone number" }),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      db.endSession(params.phone_number);
      return {
        content: [{ type: "text", text: `Session ended for ${params.phone_number}. Next message will start a new session.` }],
        details: { ended: true },
      };
    },
  });

  pi.registerTool({
    name: "whatsapp_status",
    label: "WhatsApp Status",
    description: "Show Kapso configuration, contacts DB stats, and API connection check",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate) {
      const contacts = db.listContacts();
      const allowed = contacts.filter((c) => c.enabled).length;
      const cfgInfo = config.phoneNumberId
        ? `Phone ID: ${config.phoneNumberId}\nAPI: ${config.apiBaseUrl}\nKey: ${config.apiKey ? "set" : "NOT SET"}`
        : "Not configured — run /kapso-setup";

      let connectionLine = "";
      if (config.apiKey && config.phoneNumberId) {
        const r = await listPhoneNumbers(config, signal);
        connectionLine = r.success ? `\nAPI: connected (${r.numbers.length} number(s))` : `\nAPI: error — ${r.error}`;
      }

      return {
        content: [{
          type: "text",
          text: [
            "=== WhatsApp / Kapso Status ===",
            "",
            cfgInfo + connectionLine,
            "",
            `Contacts: ${contacts.length} total, ${allowed} allowed`,
            `DB: ${db.getDbPath()}`,
            `SYSTEM.md: ${SYSTEM_MD}`,
            `PROMPT.md: ${PROMPT_MD}`,
            "",
            "Commands: /kapso-setup  /kapso-contacts  /kapso-instructions",
          ].join("\n"),
        }],
        details: { phoneNumberId: config.phoneNumberId, contacts: contacts.length, allowed },
      };
    },
  });

  pi.registerTool({
    name: "whatsapp_contacts_list",
    label: "WhatsApp Contacts List",
    description: "List contacts in the SQLite access DB",
    parameters: Type.Object({
      filter: Type.Optional(
        Type.Union([Type.Literal("all"), Type.Literal("allowed"), Type.Literal("blocked")], {
          description: "Filter: all | allowed | blocked (default: all)",
        })
      ),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      let contacts = db.listContacts();
      const filter = params.filter ?? "all";
      if (filter === "allowed") contacts = contacts.filter((c) => c.enabled);
      if (filter === "blocked") contacts = contacts.filter((c) => !c.enabled);
      if (contacts.length === 0) return { content: [{ type: "text", text: `No contacts (filter: ${filter})` }], details: { contacts } };
      const rows = contacts.map((c) => `${c.id}. ${c.name} | ${c.phone_number} | ${c.enabled ? "allowed" : "blocked"} | notes: ${c.notes ?? "—"} | seen: ${c.last_seen ?? "never"}`);
      return { content: [{ type: "text", text: `Contacts (${contacts.length}):\n\n${rows.join("\n")}` }], details: { contacts } };
    },
  });

  pi.registerTool({
    name: "whatsapp_contact_add",
    label: "WhatsApp Contact Add",
    description: "Add a contact to the SQLite access DB and grant WhatsApp agent access",
    parameters: Type.Object({
      name: Type.String({ description: "Contact display name" }),
      phone_number: Type.String({ description: "Phone number with country code" }),
      notes: Type.Optional(Type.String({ description: "Optional notes about this contact" })),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      const existing = db.getContact(params.phone_number);
      if (existing) return { content: [{ type: "text", text: `Already exists: ${existing.name} (${existing.phone_number})` }], details: { contact: existing, created: false }, isError: true };
      const contact = db.addContact(params.name, params.phone_number);
      if (params.notes) db.updateContact(params.phone_number, { notes: params.notes });
      return { content: [{ type: "text", text: `Added: ${contact.name} (${contact.phone_number}) — access granted` }], details: { contact, created: true } };
    },
  });

  pi.registerTool({
    name: "whatsapp_contact_remove",
    label: "WhatsApp Contact Remove",
    description: "Remove a contact from the SQLite access DB",
    parameters: Type.Object({
      phone_number: Type.String({ description: "Contact phone number" }),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      const removed = db.removeContact(params.phone_number);
      return { content: [{ type: "text", text: removed ? `Removed: ${params.phone_number}` : `Not found: ${params.phone_number}` }], details: { removed }, isError: !removed };
    },
  });

  pi.registerTool({
    name: "whatsapp_contact_update",
    label: "WhatsApp Contact Update",
    description: "Update a contact's name, notes, or access (enabled: true/false)",
    parameters: Type.Object({
      phone_number: Type.String({ description: "Contact phone number" }),
      name: Type.Optional(Type.String({ description: "New display name" })),
      enabled: Type.Optional(Type.Boolean({ description: "true = allow, false = block" })),
      notes: Type.Optional(Type.String({ description: "Notes about this contact (context for the agent)" })),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      const contact = db.updateContact(params.phone_number, {
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        ...(params.notes !== undefined ? { notes: params.notes } : {}),
      });
      if (!contact) return { content: [{ type: "text", text: `Not found: ${params.phone_number}` }], details: { contact: null }, isError: true };
      return { content: [{ type: "text", text: `Updated: ${contact.name} (${contact.phone_number}) — ${contact.enabled ? "allowed" : "blocked"}${contact.notes ? ` | notes: ${contact.notes}` : ""}` }], details: { contact } };
    },
  });

  pi.registerTool({
    name: "whatsapp_check_access",
    label: "WhatsApp Check Access",
    description: "Check whether a phone number is allowed to use the agent",
    parameters: Type.Object({
      phone_number: Type.String({ description: "WhatsApp sender phone number" }),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      const contact = db.getContact(params.phone_number);
      if (!contact) return { content: [{ type: "text", text: `ACCESS DENIED — ${params.phone_number} not in contacts DB.` }], details: { access: false, reason: "not_found" } };
      if (!contact.enabled) return { content: [{ type: "text", text: `ACCESS DENIED — ${contact.name} is blocked.` }], details: { access: false, reason: "blocked", contact } };
      db.touchLastSeen(params.phone_number);
      return { content: [{ type: "text", text: `ACCESS GRANTED — ${contact.name} (${contact.phone_number})` }], details: { access: true, contact } };
    },
  });

  // ── Send tools ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "whatsapp_send",
    label: "WhatsApp Send Text",
    description: "Send a WhatsApp text message via Kapso",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient phone number with country code" }),
      message: Type.String({ description: "Message body text" }),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { sent: false }, isError: true };

      const r = await sendPayload(config, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: `+${db.normalizePhone(params.to)}`,
        type: "text",
        text: { body: params.message },
      }, signal);

      if (!r.success) return { content: [{ type: "text", text: `Send failed: ${r.error}` }], details: { sent: false, error: r.error }, isError: true };
      return { content: [{ type: "text", text: `Sent to ${params.to} (ID: ${r.messageId || "unknown"})` }], details: { sent: true, messageId: r.messageId } };
    },
  });

  pi.registerTool({
    name: "whatsapp_send_image",
    label: "WhatsApp Send Image",
    description: "Send an image via WhatsApp (public URL or Kapso media ID)",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient phone number" }),
      url: Type.Optional(Type.String({ description: "Public image URL" })),
      media_id: Type.Optional(Type.String({ description: "Kapso/Meta media ID (alternative to url)" })),
      caption: Type.Optional(Type.String({ description: "Image caption" })),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { sent: false }, isError: true };
      if (!params.url && !params.media_id) return { content: [{ type: "text", text: "Provide url or media_id" }], details: { sent: false }, isError: true };

      const image: Record<string, string> = {};
      if (params.url) image["link"] = params.url;
      if (params.media_id) image["id"] = params.media_id;
      if (params.caption) image["caption"] = params.caption;

      const r = await sendPayload(config, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: `+${db.normalizePhone(params.to)}`,
        type: "image",
        image,
      }, signal);

      if (!r.success) return { content: [{ type: "text", text: `Send failed: ${r.error}` }], details: { sent: false, error: r.error }, isError: true };
      return { content: [{ type: "text", text: `Image sent to ${params.to}` }], details: { sent: true, messageId: r.messageId } };
    },
  });

  pi.registerTool({
    name: "whatsapp_send_document",
    label: "WhatsApp Send Document",
    description: "Send a document/file via WhatsApp. Use url for public files or media_id from whatsapp_upload_media for local files.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient phone number" }),
      url: Type.Optional(Type.String({ description: "Public document URL" })),
      media_id: Type.Optional(Type.String({ description: "Media ID from whatsapp_upload_media (alternative to url)" })),
      filename: Type.String({ description: "File name shown to the recipient" }),
      caption: Type.Optional(Type.String({ description: "Document caption" })),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { sent: false }, isError: true };
      if (!params.url && !params.media_id) return { content: [{ type: "text", text: "Provide url or media_id" }], details: { sent: false }, isError: true };

      const document: Record<string, string> = { filename: params.filename };
      if (params.url) document["link"] = params.url;
      if (params.media_id) document["id"] = params.media_id;
      if (params.caption) document["caption"] = params.caption;

      const r = await sendPayload(config, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: `+${db.normalizePhone(params.to)}`,
        type: "document",
        document,
      }, signal);

      if (!r.success) return { content: [{ type: "text", text: `Send failed: ${r.error}` }], details: { sent: false, error: r.error }, isError: true };
      return { content: [{ type: "text", text: `Document "${params.filename}" sent to ${params.to}` }], details: { sent: true, messageId: r.messageId } };
    },
  });

  pi.registerTool({
    name: "whatsapp_upload_media",
    label: "WhatsApp Upload Media",
    description: "Upload a local file to WhatsApp/Meta and get a media_id to use with whatsapp_send_document, whatsapp_send_image, etc.",
    parameters: Type.Object({
      file_path: Type.String({ description: "Absolute path to the local file" }),
      mime_type: Type.Optional(Type.String({ description: "MIME type (e.g. application/pdf, image/jpeg). Auto-detected if omitted." })),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { media_id: "" }, isError: true };

      if (!fs.existsSync(params.file_path)) {
        return { content: [{ type: "text", text: `File not found: ${params.file_path}` }], details: { media_id: "" }, isError: true };
      }

      const mimeType = params.mime_type ?? guessMime(params.file_path);
      const fileBuffer = fs.readFileSync(params.file_path);
      const fileName = params.file_path.split("/").pop() ?? "file";

      const formData = new FormData();
      formData.append("messaging_product", "whatsapp");
      formData.append("type", mimeType);
      formData.append("file", new Blob([fileBuffer], { type: mimeType }), fileName);

      const url = `${config.apiBaseUrl}/meta/whatsapp/v24.0/${config.phoneNumberId}/media`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "X-API-Key": config.apiKey },
          body: formData,
          signal: toSignal(signal),
        });
        const data = await res.json() as any;
        if (!res.ok) return { content: [{ type: "text", text: `Upload failed: ${data?.error?.message ?? `HTTP ${res.status}`}` }], details: { media_id: "" }, isError: true };
        const mediaId: string = data?.id ?? "";
        return { content: [{ type: "text", text: `Uploaded "${fileName}" — media_id: ${mediaId}` }], details: { media_id: mediaId } };
      } catch (e) {
        return { content: [{ type: "text", text: `Upload failed: ${(e as Error).message}` }], details: { media_id: "" }, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "whatsapp_send_buttons",
    label: "WhatsApp Send Interactive Buttons",
    description: "Send a message with up to 3 quick-reply buttons (requires active 24h conversation window)",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient phone number" }),
      body: Type.String({ description: "Message body text" }),
      buttons: Type.Array(
        Type.Object({
          id: Type.String({ description: "Button ID (returned when user taps)" }),
          title: Type.String({ description: "Button label (max 20 chars)" }),
        }),
        { description: "Up to 3 buttons", minItems: 1, maxItems: 3 }
      ),
      header: Type.Optional(Type.String({ description: "Optional header text" })),
      footer: Type.Optional(Type.String({ description: "Optional footer text" })),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { sent: false }, isError: true };

      const interactive: Record<string, unknown> = {
        type: "button",
        body: { text: params.body },
        action: {
          buttons: params.buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title },
          })),
        },
      };
      if (params.header) (interactive as any).header = { type: "text", text: params.header };
      if (params.footer) (interactive as any).footer = { text: params.footer };

      const r = await sendPayload(config, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: `+${db.normalizePhone(params.to)}`,
        type: "interactive",
        interactive,
      }, signal);

      if (!r.success) return { content: [{ type: "text", text: `Send failed: ${r.error}` }], details: { sent: false, error: r.error }, isError: true };
      return { content: [{ type: "text", text: `Buttons sent to ${params.to}` }], details: { sent: true, messageId: r.messageId } };
    },
  });

  pi.registerTool({
    name: "whatsapp_send_location",
    label: "WhatsApp Send Location",
    description: "Send a location pin via WhatsApp",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient phone number" }),
      latitude: Type.Number({ description: "Latitude" }),
      longitude: Type.Number({ description: "Longitude" }),
      name: Type.Optional(Type.String({ description: "Location name" })),
      address: Type.Optional(Type.String({ description: "Address" })),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { sent: false }, isError: true };

      const location: Record<string, unknown> = { latitude: params.latitude, longitude: params.longitude };
      if (params.name) location["name"] = params.name;
      if (params.address) location["address"] = params.address;

      const r = await sendPayload(config, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: `+${db.normalizePhone(params.to)}`,
        type: "location",
        location,
      }, signal);

      if (!r.success) return { content: [{ type: "text", text: `Send failed: ${r.error}` }], details: { sent: false, error: r.error }, isError: true };
      return { content: [{ type: "text", text: `Location sent to ${params.to}` }], details: { sent: true, messageId: r.messageId } };
    },
  });

  pi.registerTool({
    name: "whatsapp_send_audio",
    label: "WhatsApp Send Audio",
    description: "Send an audio file or voice note via WhatsApp. Use voice=true to send as voice note (enables transcription on recipient's side).",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient phone number" }),
      url: Type.Optional(Type.String({ description: "Public audio URL (mp3, ogg, etc.)" })),
      media_id: Type.Optional(Type.String({ description: "Media ID from whatsapp_upload_media" })),
      voice: Type.Optional(Type.Boolean({ description: "Send as voice note (true) or regular audio file (false, default)" })),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { sent: false }, isError: true };
      if (!params.url && !params.media_id) return { content: [{ type: "text", text: "Provide url or media_id" }], details: { sent: false }, isError: true };

      const audio: Record<string, unknown> = {};
      if (params.url) audio["link"] = params.url;
      if (params.media_id) audio["id"] = params.media_id;
      if (params.voice) audio["voice"] = true;

      const r = await sendPayload(config, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: `+${db.normalizePhone(params.to)}`,
        type: "audio",
        audio,
      }, signal);

      if (!r.success) return { content: [{ type: "text", text: `Send failed: ${r.error}` }], details: { sent: false, error: r.error }, isError: true };
      return { content: [{ type: "text", text: `Audio sent to ${params.to}` }], details: { sent: true, messageId: r.messageId } };
    },
  });

  pi.registerTool({
    name: "whatsapp_send_video",
    label: "WhatsApp Send Video",
    description: "Send a video via WhatsApp",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient phone number" }),
      url: Type.Optional(Type.String({ description: "Public video URL (mp4, etc.)" })),
      media_id: Type.Optional(Type.String({ description: "Media ID from whatsapp_upload_media" })),
      caption: Type.Optional(Type.String({ description: "Video caption (max 1024 chars)" })),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { sent: false }, isError: true };
      if (!params.url && !params.media_id) return { content: [{ type: "text", text: "Provide url or media_id" }], details: { sent: false }, isError: true };

      const video: Record<string, unknown> = {};
      if (params.url) video["link"] = params.url;
      if (params.media_id) video["id"] = params.media_id;
      if (params.caption) video["caption"] = params.caption;

      const r = await sendPayload(config, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: `+${db.normalizePhone(params.to)}`,
        type: "video",
        video,
      }, signal);

      if (!r.success) return { content: [{ type: "text", text: `Send failed: ${r.error}` }], details: { sent: false, error: r.error }, isError: true };
      return { content: [{ type: "text", text: `Video sent to ${params.to}` }], details: { sent: true, messageId: r.messageId } };
    },
  });

  pi.registerTool({
    name: "whatsapp_send_sticker",
    label: "WhatsApp Send Sticker",
    description: "Send a sticker via WhatsApp (must be WEBP format)",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient phone number" }),
      url: Type.Optional(Type.String({ description: "Public WEBP sticker URL" })),
      media_id: Type.Optional(Type.String({ description: "Media ID from whatsapp_upload_media" })),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { sent: false }, isError: true };
      if (!params.url && !params.media_id) return { content: [{ type: "text", text: "Provide url or media_id" }], details: { sent: false }, isError: true };

      const sticker: Record<string, unknown> = {};
      if (params.url) sticker["link"] = params.url;
      if (params.media_id) sticker["id"] = params.media_id;

      const r = await sendPayload(config, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: `+${db.normalizePhone(params.to)}`,
        type: "sticker",
        sticker,
      }, signal);

      if (!r.success) return { content: [{ type: "text", text: `Send failed: ${r.error}` }], details: { sent: false, error: r.error }, isError: true };
      return { content: [{ type: "text", text: `Sticker sent to ${params.to}` }], details: { sent: true, messageId: r.messageId } };
    },
  });

  pi.registerTool({
    name: "whatsapp_send_reaction",
    label: "WhatsApp Send Reaction",
    description: "React to a specific WhatsApp message with an emoji. Use empty string emoji to remove a reaction.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient phone number" }),
      message_id: Type.String({ description: "ID of the message to react to (wamid.xxx)" }),
      emoji: Type.String({ description: "Emoji to react with (e.g. '👍'). Empty string to remove reaction." }),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { sent: false }, isError: true };

      const r = await sendPayload(config, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: `+${db.normalizePhone(params.to)}`,
        type: "reaction",
        reaction: { message_id: params.message_id, emoji: params.emoji },
      }, signal);

      if (!r.success) return { content: [{ type: "text", text: `Send failed: ${r.error}` }], details: { sent: false, error: r.error }, isError: true };
      return { content: [{ type: "text", text: `Reaction sent to message ${params.message_id}` }], details: { sent: true, messageId: r.messageId } };
    },
  });

  pi.registerTool({
    name: "whatsapp_send_contact",
    label: "WhatsApp Send Contact",
    description: "Send a contact card (vCard) via WhatsApp",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient phone number" }),
      name: Type.String({ description: "Contact full name" }),
      phone: Type.String({ description: "Contact phone number" }),
      email: Type.Optional(Type.String({ description: "Contact email" })),
      organization: Type.Optional(Type.String({ description: "Contact organization/company" })),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { sent: false }, isError: true };

      const contact: Record<string, unknown> = {
        name: { formatted_name: params.name, first_name: params.name },
        phones: [{ phone: params.phone, type: "CELL" }],
      };
      if (params.email) (contact as any).emails = [{ email: params.email, type: "WORK" }];
      if (params.organization) (contact as any).org = { company: params.organization };

      const r = await sendPayload(config, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: `+${db.normalizePhone(params.to)}`,
        type: "contacts",
        contacts: [contact],
      }, signal);

      if (!r.success) return { content: [{ type: "text", text: `Send failed: ${r.error}` }], details: { sent: false, error: r.error }, isError: true };
      return { content: [{ type: "text", text: `Contact "${params.name}" sent to ${params.to}` }], details: { sent: true, messageId: r.messageId } };
    },
  });

  pi.registerTool({
    name: "whatsapp_send_list",
    label: "WhatsApp Send Interactive List",
    description: "Send an interactive list menu (up to 10 sections, 10 rows total). Requires active 24h conversation window.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient phone number" }),
      body: Type.String({ description: "Message body text" }),
      button_label: Type.String({ description: "Label for the list button (e.g. 'Ver opciones')" }),
      sections: Type.Array(
        Type.Object({
          title: Type.String({ description: "Section title" }),
          rows: Type.Array(
            Type.Object({
              id: Type.String({ description: "Row ID (returned when user selects)" }),
              title: Type.String({ description: "Row title (max 24 chars)" }),
              description: Type.Optional(Type.String({ description: "Row description (max 72 chars)" })),
            }),
            { minItems: 1 }
          ),
        }),
        { description: "Up to 10 sections", minItems: 1, maxItems: 10 }
      ),
      header: Type.Optional(Type.String({ description: "Optional header text" })),
      footer: Type.Optional(Type.String({ description: "Optional footer text" })),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { sent: false }, isError: true };

      const interactive: Record<string, unknown> = {
        type: "list",
        body: { text: params.body },
        action: {
          button: params.button_label,
          sections: params.sections.map((s) => ({
            title: s.title,
            rows: s.rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })),
          })),
        },
      };
      if (params.header) (interactive as any).header = { type: "text", text: params.header };
      if (params.footer) (interactive as any).footer = { text: params.footer };

      const r = await sendPayload(config, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: `+${db.normalizePhone(params.to)}`,
        type: "interactive",
        interactive,
      }, signal);

      if (!r.success) return { content: [{ type: "text", text: `Send failed: ${r.error}` }], details: { sent: false, error: r.error }, isError: true };
      return { content: [{ type: "text", text: `List sent to ${params.to}` }], details: { sent: true, messageId: r.messageId } };
    },
  });

  pi.registerTool({
    name: "whatsapp_send_cta",
    label: "WhatsApp Send CTA URL",
    description: "Send a message with a call-to-action URL button. Requires active 24h conversation window.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient phone number" }),
      body: Type.String({ description: "Message body text" }),
      button_text: Type.String({ description: "Button label (e.g. 'Ver más', 'Agendar')" }),
      url: Type.String({ description: "URL the button opens" }),
      header: Type.Optional(Type.String({ description: "Optional header text" })),
      footer: Type.Optional(Type.String({ description: "Optional footer text" })),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { sent: false }, isError: true };

      const interactive: Record<string, unknown> = {
        type: "cta_url",
        body: { text: params.body },
        action: {
          name: "cta_url",
          parameters: { display_text: params.button_text, url: params.url },
        },
      };
      if (params.header) (interactive as any).header = { type: "text", text: params.header };
      if (params.footer) (interactive as any).footer = { text: params.footer };

      const r = await sendPayload(config, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: `+${db.normalizePhone(params.to)}`,
        type: "interactive",
        interactive,
      }, signal);

      if (!r.success) return { content: [{ type: "text", text: `Send failed: ${r.error}` }], details: { sent: false, error: r.error }, isError: true };
      return { content: [{ type: "text", text: `CTA button sent to ${params.to}` }], details: { sent: true, messageId: r.messageId } };
    },
  });

  pi.registerTool({
    name: "whatsapp_templates_list",
    label: "WhatsApp Templates List",
    description: "List all approved message templates for the connected WhatsApp number",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "Filter by status: APPROVED, PENDING, REJECTED (default: all)" })),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { templates: [] }, isError: true };

      const qs = params.status ? `?status=${params.status}` : "";
      const url = `${config.apiBaseUrl}/meta/whatsapp/v24.0/${config.phoneNumberId}/message_templates${qs}`;
      try {
        const res = await fetch(url, { headers: { "X-API-Key": config.apiKey }, signal: toSignal(signal) });
        const data = await res.json() as any;
        if (!res.ok) return { content: [{ type: "text", text: `Error: ${data?.error?.message ?? `HTTP ${res.status}`}` }], details: { templates: [] }, isError: true };
        const templates = data?.data ?? [];
        if (templates.length === 0) return { content: [{ type: "text", text: "No templates found." }], details: { templates: [] } };
        const lines = templates.map((t: any) => `${t.name} | ${t.status} | ${t.language} | ${t.category}`);
        return { content: [{ type: "text", text: `Templates (${templates.length}):\n\n${lines.join("\n")}` }], details: { templates } };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], details: { templates: [] }, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "whatsapp_send_template",
    label: "WhatsApp Send Template",
    description: "Send an approved message template. Use this to initiate conversations outside the 24h window. Use whatsapp_templates_list to find available templates.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient phone number" }),
      template_name: Type.String({ description: "Exact template name from whatsapp_templates_list" }),
      language: Type.String({ description: "Language code (e.g. es, en_US)" }),
      components: Type.Optional(Type.Array(
        Type.Object({
          type: Type.String({ description: "HEADER, BODY, or BUTTON" }),
          parameters: Type.Array(
            Type.Object({
              type: Type.String({ description: "text, image, document, video, or payload" }),
              text: Type.Optional(Type.String()),
              payload: Type.Optional(Type.String()),
            })
          ),
          sub_type: Type.Optional(Type.String({ description: "For BUTTON: url, quick_reply" })),
          index: Type.Optional(Type.Number({ description: "For BUTTON: button index (0-based)" })),
        }),
        { description: "Template component parameters (for variable substitution)" }
      )),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { sent: false }, isError: true };

      const template: Record<string, unknown> = {
        name: params.template_name,
        language: { code: params.language },
      };
      if (params.components && params.components.length > 0) {
        template["components"] = params.components;
      }

      const r = await sendPayload(config, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: `+${db.normalizePhone(params.to)}`,
        type: "template",
        template,
      }, signal);

      if (!r.success) return { content: [{ type: "text", text: `Send failed: ${r.error}` }], details: { sent: false, error: r.error }, isError: true };
      return { content: [{ type: "text", text: `Template "${params.template_name}" sent to ${params.to}` }], details: { sent: true, messageId: r.messageId } };
    },
  });

  pi.registerTool({
    name: "whatsapp_webhook_setup",
    label: "WhatsApp Webhook Setup",
    description: "Register a Kapso webhook to receive incoming WhatsApp messages",
    parameters: Type.Object({
      url: Type.String({ description: "Public HTTPS URL that will receive webhook events" }),
      events: Type.Optional(Type.String({ description: "Comma-separated event types (default: whatsapp.message.received)" })),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { registered: false }, isError: true };
      const events = params.events ? params.events.split(",").map((e) => e.trim()) : ["whatsapp.message.received"];
      const r = await createWebhook(config, params.url, events, signal);
      if (!r.success) return { content: [{ type: "text", text: `Webhook creation failed: ${r.error}` }], details: { registered: false, error: r.error }, isError: true };
      return { content: [{ type: "text", text: `Webhook registered (ID: ${r.webhookId})\nURL: ${params.url}\nEvents: ${events.join(", ")}` }], details: { registered: true, webhookId: r.webhookId } };
    },
  });

  pi.registerTool({
    name: "whatsapp_webhooks_list",
    label: "WhatsApp Webhooks List",
    description: "List all Kapso webhooks for the configured phone number",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate) {
      const err = requireConfig(config);
      if (err) return { content: [{ type: "text", text: err }], details: { webhooks: [] }, isError: true };
      const r = await listWebhooks(config, signal);
      if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }], details: { webhooks: [], error: r.error }, isError: true };
      if (r.webhooks.length === 0) return { content: [{ type: "text", text: "No webhooks registered." }], details: { webhooks: [] } };
      const lines = (r.webhooks as any[]).map((w) => `${w.id} | ${w.url} | ${(w.events ?? []).join(", ")} | active: ${w.active}`);
      return { content: [{ type: "text", text: `Webhooks (${r.webhooks.length}):\n\n${lines.join("\n")}` }], details: { webhooks: r.webhooks } };
    },
  });

  pi.registerTool({
    name: "whatsapp_numbers_list",
    label: "WhatsApp Numbers List",
    description: "List connected WhatsApp numbers in the Kapso project to find phone_number_id",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate) {
      if (!config.apiKey) return { content: [{ type: "text", text: "API key not set. Run /kapso-setup first." }], details: { numbers: [] }, isError: true };
      const r = await listPhoneNumbers(config, signal);
      if (!r.success) return { content: [{ type: "text", text: `Error: ${r.error}` }], details: { numbers: [], error: r.error }, isError: true };
      if (r.numbers.length === 0) return { content: [{ type: "text", text: "No connected numbers. Run 'kapso setup' in terminal." }], details: { numbers: [] } };
      const lines = (r.numbers as any[]).map((n) => `${n.id} | ${n.display_phone_number ?? n.phone_number ?? "(unknown)"} | ${n.verified_name ?? ""}`);
      return { content: [{ type: "text", text: `Numbers (${r.numbers.length}):\n\n${lines.join("\n")}\n\nCopy the ID → /kapso-setup` }], details: { numbers: r.numbers } };
    },
  });

  // ── Service management ────────────────────────────────────────────────────

  function svcResult(text: string, extra: Record<string, unknown> = {}) {
    return { content: [{ type: "text" as const, text }], details: { message: text, ...extra } };
  }

  function which(bin: string): string | null {
    try { return execSync(`which ${bin} 2>/dev/null`, { encoding: "utf-8" }).trim() || null; }
    catch { return null; }
  }

  function cmdOut(cmd: string): string {
    try { return execSync(cmd, { encoding: "utf-8" }).trim(); } catch { return ""; }
  }

  pi.registerTool({
    name: "whatsapp_setup_check",
    label: "WhatsApp Setup Check",
    description: "Inspect all system requirements and current state needed to run the pi-whatsapp service. Run this first before any setup to know exactly what needs to be done.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate) {
      const checks: Record<string, unknown> = {};

      // PM2
      const pm2Bin = findPm2();
      checks["pm2_installed"] = !!which("pm2") || fs.existsSync(pm2Bin);
      checks["pm2_process"] = pm2Status();

      // Node / npm
      checks["node_version"] = cmdOut("node --version");
      checks["npm_version"] = cmdOut("npm --version");

      // Homebrew
      checks["brew_installed"] = !!which("brew");

      // cloudflared
      checks["cloudflared_installed"] = !!which("cloudflared");
      if (checks["cloudflared_installed"]) {
        const tunnels = cmdOut("cloudflared tunnel list 2>/dev/null");
        checks["cloudflared_tunnel_exists"] = tunnels.includes("pi-whatsapp");
        checks["cloudflared_tunnel_list"] = tunnels;

        // Check if cloudflared service is running
        const svcStatus = cmdOut("launchctl list 2>/dev/null | grep cloudflared");
        checks["cloudflared_service_running"] = svcStatus.length > 0;

        // Try to get tunnel URL from config
        const cfgPath = `${process.env.HOME}/.cloudflared/pi-whatsapp.yml`;
        checks["cloudflared_config_exists"] = fs.existsSync(cfgPath);
        if (fs.existsSync(cfgPath)) {
          checks["cloudflared_config"] = fs.readFileSync(cfgPath, "utf-8");
        }

        // Credentials file (means login was done)
        const certPath = `${process.env.HOME}/.cloudflared/cert.pem`;
        checks["cloudflared_authenticated"] = fs.existsSync(certPath);
      }

      // Service dir and .env
      checks["service_dir_exists"] = fs.existsSync(SERVICE_DIR);
      checks["env_file_exists"] = fs.existsSync(`${SERVICE_DIR}/.env`);
      if (fs.existsSync(`${SERVICE_DIR}/.env`)) {
        const env = fs.readFileSync(`${SERVICE_DIR}/.env`, "utf-8");
        checks["env_has_webhook_secret"] = env.includes("KAPSO_WEBHOOK_SECRET=") && !env.includes("KAPSO_WEBHOOK_SECRET=\n");
        checks["env_port"] = (env.match(/^PORT=(.+)$/m) ?? [])[1] ?? null;
      }

      // Built dist
      checks["dist_built"] = fs.existsSync(`${SERVICE_DIR}/dist/index.js`);

      // Kapso config
      const cfg = loadConfig();
      checks["kapso_api_key_set"] = !!cfg.apiKey;
      checks["kapso_phone_number_id_set"] = !!cfg.phoneNumberId;

      // Pi auth
      const authPath = `${process.env.HOME}/.pi/agent/auth.json`;
      checks["pi_auth_exists"] = fs.existsSync(authPath);

      const lines = Object.entries(checks).map(([k, v]) => {
        const icon = v === true ? "✅" : v === false ? "❌" : "ℹ️";
        const val = typeof v === "boolean" ? "" : ` — ${String(v).slice(0, 120)}`;
        return `${icon} ${k}${val}`;
      });

      return svcResult(lines.join("\n"), { checks });
    },
  });

  pi.registerTool({
    name: "whatsapp_service_status",
    label: "WhatsApp Service Status",
    description: "Check if the pi-whatsapp background service is running (PM2 process status).",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate) {
      const s = pm2Status();
      if (!s) return svcResult("pi-whatsapp not found in PM2. Use whatsapp_service_start to launch it.", { running: false });
      const icon = s.status === "online" ? "🟢" : "🔴";
      return svcResult(`${icon} pi-whatsapp: ${s.status} | RAM: ${s.memMB} MB | Restarts: ${s.restarts}`, { running: s.status === "online", ...s });
    },
  });

  pi.registerTool({
    name: "whatsapp_service_start",
    label: "WhatsApp Service Start",
    description: "Build and start the pi-whatsapp service with PM2.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate) {
      if (!fs.existsSync(SERVICE_DIR)) return svcResult(`Service directory not found: ${SERVICE_DIR}`, { ok: false });
      try {
        const pm2 = findPm2();
        run("npm install");
        run("npm run build");
        run(`${pm2} start ecosystem.config.cjs --env production`);
        run(`${pm2} save`);
        const s = pm2Status();
        return svcResult(`✅ pi-whatsapp started. Status: ${s?.status ?? "unknown"}`, { ok: true });
      } catch (e: any) {
        return svcResult(`Failed to start service: ${String(e.message)}`, { ok: false });
      }
    },
  });

  pi.registerTool({
    name: "whatsapp_service_stop",
    label: "WhatsApp Service Stop",
    description: "Stop the pi-whatsapp PM2 service.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate) {
      try {
        run(`${findPm2()} stop pi-whatsapp`);
        return svcResult("⏹ pi-whatsapp stopped.", { ok: true });
      } catch (e: any) {
        return svcResult(`Failed to stop: ${String(e.message)}`, { ok: false });
      }
    },
  });

  pi.registerTool({
    name: "whatsapp_service_restart",
    label: "WhatsApp Service Restart",
    description: "Restart the pi-whatsapp PM2 service.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate) {
      try {
        run(`${findPm2()} restart pi-whatsapp`);
        const s = pm2Status();
        return svcResult(`🔄 pi-whatsapp restarted. Status: ${s?.status ?? "unknown"}`, { ok: true });
      } catch (e: any) {
        return svcResult(`Failed to restart: ${String(e.message)}`, { ok: false });
      }
    },
  });

  pi.registerTool({
    name: "whatsapp_service_logs",
    label: "WhatsApp Service Logs",
    description: "Get the last N lines of pi-whatsapp service logs.",
    parameters: Type.Object({ lines: Type.Optional(Type.Number({ description: "Number of log lines to return (default 50)" })) }),
    async execute(_id, params, _signal, _onUpdate) {
      const n = (params as { lines?: number }).lines ?? 50;
      try {
        const out = execSync(`${findPm2()} logs pi-whatsapp --lines ${n} --nostream 2>&1`, { encoding: "utf-8" });
        return svcResult(out || "(no logs)", { ok: true });
      } catch (e: any) {
        return svcResult(`Failed to get logs: ${String(e.message)}`, { ok: false });
      }
    },
  });

  pi.registerTool({
    name: "whatsapp_service_configure",
    label: "WhatsApp Service Configure",
    description: "Write the .env file for the pi-whatsapp service. API keys are optional — the service reuses Pi's existing credentials from ~/.pi/agent/auth.json. Call this before whatsapp_service_start.",
    parameters: Type.Object({
      kapsoWebhookSecret: Type.Optional(Type.String({ description: "Random secret to verify Kapso webhook signatures (recommended)" })),
      port: Type.Optional(Type.Number({ description: "HTTP port (default 4721)" })),
      agentModelProvider: Type.Optional(Type.String({ description: "Override model provider, e.g. anthropic" })),
      agentModelId: Type.Optional(Type.String({ description: "Override model ID, e.g. claude-sonnet-4-6" })),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      const p = params as { kapsoWebhookSecret?: string; port?: number; agentModelProvider?: string; agentModelId?: string };
      try {
        const envLines = [
          `KAPSO_WEBHOOK_SECRET=${p.kapsoWebhookSecret ?? ""}`,
          `PORT=${p.port ?? 4721}`,
          `HOST=0.0.0.0`,
          `WEBHOOK_PATH=/webhook`,
          `AGENT_MODEL_PROVIDER=${p.agentModelProvider ?? ""}`,
          `AGENT_MODEL_ID=${p.agentModelId ?? ""}`,
          `SESSIONS_DIR=./sessions`,
          `SESSION_IDLE_TIMEOUT_MINUTES=30`,
          `LOG_LEVEL=info`,
          `LOG_DIR=./logs`,
        ];
        fs.writeFileSync(`${SERVICE_DIR}/.env`, envLines.join("\n") + "\n", "utf-8");
        return svcResult(`✅ .env written to ${SERVICE_DIR}/.env`, { ok: true });
      } catch (e: any) {
        return svcResult(`Failed to write .env: ${String(e.message)}`, { ok: false });
      }
    },
  });

  pi.registerTool({
    name: "whatsapp_service_setup_autostart",
    label: "WhatsApp Service Setup Autostart",
    description: "Register PM2 to auto-start pi-whatsapp on system boot (runs pm2 startup and pm2 save).",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate) {
      try {
        const pm2 = findPm2();
        const startupOut = execSync(`${pm2} startup 2>&1`, { encoding: "utf-8" });
        const sudoLine = startupOut.split("\n").find((l) => l.trim().startsWith("sudo")) ?? null;
        run(`${pm2} save`);
        const msg = sudoLine
          ? `PM2 save done. To complete auto-start, run this in your terminal:\n\n${sudoLine}`
          : "✅ Auto-start configured. PM2 will restart pi-whatsapp on boot.";
        return svcResult(msg, { ok: true, sudoCommand: sudoLine });
      } catch (e: any) {
        return svcResult(`Failed to set up autostart: ${String(e.message)}`, { ok: false });
      }
    },
  });

  pi.registerTool({
    name: "whatsapp_webhook_register",
    label: "WhatsApp Webhook Register",
    description: "Register a webhook in Kapso to forward WhatsApp messages to the local pi-whatsapp service.",
    parameters: Type.Object({
      phoneNumberId: Type.String({ description: "Kapso phone_number_id" }),
      webhookUrl: Type.String({ description: "Public HTTPS URL, e.g. https://abc.ngrok.io/webhook" }),
      secret: Type.Optional(Type.String({ description: "Webhook secret (must match KAPSO_WEBHOOK_SECRET in .env)" })),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const p = params as { phoneNumberId: string; webhookUrl: string; secret?: string };
      const cfg = loadConfig();
      if (!cfg.apiKey) return svcResult("Kapso API key not configured. Run /kapso-setup first.", { ok: false });
      const body: Record<string, unknown> = {
        url: p.webhookUrl,
        events: ["whatsapp.message.received"],
        kind: "kapso",
        payload_version: "v2",
        active: true,
      };
      if (p.secret) body["secret"] = p.secret;
      const res = await kapsoPost(
        `${cfg.apiBaseUrl}/platform/v1/whatsapp/phone_numbers/${p.phoneNumberId}/webhooks`,
        authHeaders(cfg),
        body,
        signal
      );
      if (res.ok) return svcResult(`✅ Webhook registered at ${p.webhookUrl}`, { ok: true });
      return svcResult(`Failed to register webhook: ${JSON.stringify(res.json)}`, { ok: false });
    },
  });

  pi.registerTool({
    name: "whatsapp_tunnel_setup",
    label: "WhatsApp Cloudflare Tunnel Setup",
    description: "Set up a permanent Cloudflare Tunnel named 'pi-whatsapp', register the public URL as webhook in Kapso, and install the tunnel as a macOS launchd service. Handles everything end-to-end. NOTE: if cloudflared is not yet authenticated it returns step='needs_login' — show the user the login command, wait for confirmation, then call again.",
    parameters: Type.Object({
      port: Type.Optional(Type.Number({ description: "Local port (default 4721)" })),
      customDomain: Type.Optional(Type.String({ description: "Custom domain already pointing to this tunnel via CNAME in Cloudflare DNS, e.g. whatsapp-tunnel.serlismaldonado.com. If omitted, uses trycloudflare.com (URL changes on restart)." })),
    }),
    async execute(_id, params, signal, _onUpdate) {
      const p = params as { port?: number; customDomain?: string };
      const port = p.port ?? 4721;
      const cfDir = `${process.env.HOME}/.cloudflared`;

      try {
        // 1. Install cloudflared if missing
        if (!which("cloudflared")) {
          if (!which("brew")) return svcResult("Homebrew not installed. Install from https://brew.sh then retry.", { ok: false, step: "brew_missing" });
          execSync("brew install cloudflare/cloudflare/cloudflared 2>&1", { encoding: "utf-8" });
        }

        // ── Quick tunnel path (no domain, no auth needed) ──────────────────
        // Uses trycloudflare.com — URL changes on restart, but auto-updates Kapso webhook.
        if (!p.customDomain && !fs.existsSync(`${cfDir}/cert.pem`)) {
          // Kill any existing quick tunnel
          execSync("pkill -f 'cloudflared tunnel --url' 2>/dev/null || true", { encoding: "utf-8", shell: "/bin/bash" });
          // Start quick tunnel and capture URL
          execSync(
            `cloudflared tunnel --url http://localhost:${port} --no-autoupdate > /tmp/cf-quick.log 2>&1 &`,
            { encoding: "utf-8", shell: "/bin/bash" }
          );
          // Wait for URL to appear in log
          await new Promise((r) => setTimeout(r, 5000));
          const quickLog = cmdOut("cat /tmp/cf-quick.log 2>/dev/null");
          const urlMatch = quickLog.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
          if (!urlMatch) {
            return svcResult(
              "Could not start quick tunnel. For a permanent URL, run `cloudflared tunnel login` then call whatsapp_tunnel_setup again.",
              { ok: false, step: "quick_tunnel_failed" }
            );
          }
          const publicUrl = urlMatch[0];
          const webhookUrl = `${publicUrl}/webhook`;
          // Register webhook in Kapso
          const cfg = loadConfig();
          let webhookMsg = "Kapso not configured";
          if (cfg.apiKey && cfg.phoneNumberId) {
            const listRes = await fetch(`${cfg.apiBaseUrl}/platform/v1/whatsapp/phone_numbers/${cfg.phoneNumberId}/webhooks`, { headers: { "X-API-Key": cfg.apiKey } });
            const hooks: any[] = listRes.ok ? ((await listRes.json() as any)?.whatsapp_webhooks ?? []) : [];
            const hook = hooks.find((h: any) => h.events?.includes("whatsapp.message.received"));
            const body = JSON.stringify({ whatsapp_webhook: { url: webhookUrl, events: ["whatsapp.message.received"], payload_version: "v2", active: true } });
            const res = hook
              ? await fetch(`${cfg.apiBaseUrl}/platform/v1/whatsapp/phone_numbers/${cfg.phoneNumberId}/webhooks/${hook.id}`, { method: "PUT", headers: { "X-API-Key": cfg.apiKey, "Content-Type": "application/json" }, body, signal: toSignal(signal) })
              : await fetch(`${cfg.apiBaseUrl}/platform/v1/whatsapp/phone_numbers/${cfg.phoneNumberId}/webhooks`, { method: "POST", headers: { "X-API-Key": cfg.apiKey, "Content-Type": "application/json" }, body, signal: toSignal(signal) });
            webhookMsg = res.ok ? "webhook registered in Kapso" : `webhook failed: ${await res.text()}`;
          }
          return svcResult(
            [`✅ Quick tunnel ready (trycloudflare.com)`, ``, `Public URL:  ${publicUrl}`, `Webhook URL: ${webhookUrl}`, `Kapso:       ${webhookMsg}`, ``, `⚠️  URL changes on restart. For a permanent URL run \`cloudflared tunnel login\` then call whatsapp_tunnel_setup again.`].join("\n"),
            { ok: true, publicUrl, webhookUrl, mode: "quick" }
          );
        }

        // ── Named tunnel path (permanent URL, requires auth) ───────────────

        // 2. Check authentication
        if (!fs.existsSync(`${cfDir}/cert.pem`)) {
          return svcResult(
            "cloudflared needs one-time browser authentication.\n\nRun in your terminal:\n\n  cloudflared tunnel login\n\nThen call whatsapp_tunnel_setup again.",
            { ok: false, step: "needs_login" }
          );
        }

        // 3. Create tunnel if it doesn't exist
        const tunnelList = cmdOut("cloudflared tunnel list 2>/dev/null");
        if (!tunnelList.includes("pi-whatsapp")) {
          execSync("cloudflared tunnel create pi-whatsapp 2>&1", { encoding: "utf-8" });
        }

        // 4. Get tunnel UUID
        const tunnelId = cmdOut("cloudflared tunnel list 2>/dev/null | grep pi-whatsapp | awk '{print $1}'").trim();
        if (!tunnelId) return svcResult("Could not get tunnel UUID.", { ok: false, step: "tunnel_id" });

        // 5. Write config.yml
        // With customDomain: add hostname entry so Cloudflare routes that domain to this service.
        // The customDomain must already have a CNAME DNS record pointing to <uuid>.cfargotunnel.com.
        if (!fs.existsSync(cfDir)) fs.mkdirSync(cfDir, { recursive: true });
        const ingressLines = p.customDomain
          ? [`  - hostname: ${p.customDomain}`, `    service: http://localhost:${port}`, `  - service: http_status:404`]
          : [`  - service: http://localhost:${port}`];
        fs.writeFileSync(`${cfDir}/config.yml`, [
          `tunnel: ${tunnelId}`,
          `credentials-file: ${cfDir}/${tunnelId}.json`,
          `ingress:`,
          ...ingressLines,
        ].join("\n") + "\n", "utf-8");

        // 6. Install launchd service so tunnel starts on boot
        execSync("cloudflared service install 2>&1 || true", { encoding: "utf-8" });

        // 7. Start tunnel (restart if already running to pick up config changes)
        execSync("launchctl stop com.cloudflare.cloudflared 2>/dev/null || true", { encoding: "utf-8", shell: "/bin/bash" });
        execSync("pkill -f 'cloudflared tunnel run' 2>/dev/null || true", { encoding: "utf-8", shell: "/bin/bash" });
        await new Promise((r) => setTimeout(r, 1000));
        execSync("launchctl start com.cloudflare.cloudflared 2>/dev/null || cloudflared tunnel run pi-whatsapp > /tmp/cf-tunnel.log 2>&1 &", { encoding: "utf-8", shell: "/bin/bash" });
        await new Promise((r) => setTimeout(r, 4000));

        // 8. Determine public URL
        const publicUrl = p.customDomain ? `https://${p.customDomain}` : `https://${tunnelId}.cfargotunnel.com`;
        const webhookUrl = `${publicUrl}/webhook`;

        // 9. Register webhook in Kapso automatically
        const cfg = loadConfig();
        let webhookRegistered = false;
        let webhookMsg = "";
        if (cfg.apiKey && cfg.phoneNumberId) {
          // Check if a webhook already exists
          const listRes = await fetch(
            `${cfg.apiBaseUrl}/platform/v1/whatsapp/phone_numbers/${cfg.phoneNumberId}/webhooks`,
            { headers: { "X-API-Key": cfg.apiKey, "Content-Type": "application/json" }, signal: toSignal(signal) }
          );
          const existing = listRes.ok ? (await listRes.json() as any) : null;
          const hooks: any[] = existing?.whatsapp_webhooks ?? [];
          const hook = hooks.find((h: any) => h.events?.includes("whatsapp.message.received"));

          const webhookBody = JSON.stringify({
            whatsapp_webhook: { url: webhookUrl, events: ["whatsapp.message.received"], payload_version: "v2", active: true },
          });

          if (hook) {
            // Update existing webhook
            const upd = await fetch(
              `${cfg.apiBaseUrl}/platform/v1/whatsapp/phone_numbers/${cfg.phoneNumberId}/webhooks/${hook.id}`,
              { method: "PUT", headers: { "X-API-Key": cfg.apiKey, "Content-Type": "application/json" }, body: webhookBody, signal: toSignal(signal) }
            );
            webhookRegistered = upd.ok;
            webhookMsg = upd.ok ? "webhook updated in Kapso" : `webhook update failed: ${await upd.text()}`;
          } else {
            // Create new webhook
            const cre = await fetch(
              `${cfg.apiBaseUrl}/platform/v1/whatsapp/phone_numbers/${cfg.phoneNumberId}/webhooks`,
              { method: "POST", headers: { "X-API-Key": cfg.apiKey, "Content-Type": "application/json" }, body: webhookBody, signal: toSignal(signal) }
            );
            webhookRegistered = cre.ok;
            webhookMsg = cre.ok ? "webhook registered in Kapso" : `webhook registration failed: ${await cre.text()}`;
          }
        } else {
          webhookMsg = "Kapso not configured — register webhook manually with whatsapp_webhook_register";
        }

        return svcResult(
          [
            `✅ Cloudflare Tunnel ready!`,
            ``,
            `Public URL:  ${publicUrl}`,
            `Webhook URL: ${webhookUrl}`,
            `Kapso:       ${webhookMsg}`,
            ``,
            `Tunnel starts automatically on system boot.`,
          ].join("\n"),
          { ok: true, publicUrl, webhookUrl, tunnelId, webhookRegistered }
        );
      } catch (e: any) {
        return svcResult(`Tunnel setup failed: ${String(e.message)}`, { ok: false, step: "error" });
      }
    },
  });

  // ── Session start ──────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const contacts = db.listContacts();
    const allowed = contacts.filter((c) => c.enabled).length;
    if (config.phoneNumberId && config.apiKey) {
      ctx.ui.notify(`WhatsApp (Kapso): ${config.phoneNumberId} | ${allowed} contact(s) allowed`, "info");
    } else {
      ctx.ui.notify("WhatsApp: run /kapso-setup to configure", "info");
    }
  });
}
