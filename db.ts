import { createRequire } from "node:module";
import fs from "node:fs";

const _require = createRequire(import.meta.url);

const EXT_DIR = `${process.env.HOME}/.pi/agent/extensions/pi-kapso-whatsapp`;
const DB_PATH = `${EXT_DIR}/contacts.db`;

interface SqliteStatement {
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

// ─── Public types ────────────────────────────────────────────────────────────

export interface Contact {
  id: number;
  name: string;
  phone_number: string;
  enabled: boolean;
  notes: string | null;
  created_at: string;
  last_seen: string | null;
}

export interface Session {
  id: number;
  phone_number: string;
  started_at: string;
  last_active: string;
  is_active: boolean;
}

export interface Message {
  id: number;
  session_id: number;
  phone_number: string;
  direction: "in" | "out";
  type: string;
  content: string;
  wa_message_id: string | null;
  created_at: string;
}

// ─── Raw DB row types ─────────────────────────────────────────────────────────

type RawContact = Omit<Contact, "enabled" | "notes"> & {
  enabled: number;
  notes: string | null;
};
type RawSession = Omit<Session, "is_active"> & { is_active: number };

// ─── DB init ─────────────────────────────────────────────────────────────────

const SESSION_TIMEOUT_MINUTES = 30;

let _db: SqliteDb | null = null;

function getDb(): SqliteDb {
  if (_db) return _db;
  if (!fs.existsSync(EXT_DIR)) fs.mkdirSync(EXT_DIR, { recursive: true });
  const Ctor = _require("better-sqlite3") as new (path: string) => SqliteDb;
  const db = new Ctor(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      phone_number TEXT    NOT NULL UNIQUE,
      enabled      INTEGER NOT NULL DEFAULT 1,
      notes        TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      last_seen    TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT   NOT NULL,
      started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      last_active TEXT    NOT NULL DEFAULT (datetime('now')),
      is_active   INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    INTEGER NOT NULL REFERENCES sessions(id),
      phone_number  TEXT    NOT NULL,
      direction     TEXT    NOT NULL CHECK (direction IN ('in', 'out')),
      type          TEXT    NOT NULL DEFAULT 'text',
      content       TEXT    NOT NULL,
      wa_message_id TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_phone   ON sessions(phone_number, is_active);
  `);

  // Migrate: add notes column if missing (existing DBs)
  try {
    db.prepare("SELECT notes FROM contacts LIMIT 1").get();
  } catch {
    db.exec("ALTER TABLE contacts ADD COLUMN notes TEXT;");
  }

  _db = db;
  return db;
}

// ─── Phone normalization ──────────────────────────────────────────────────────

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.startsWith("0") ? digits.slice(1) : digits;
}

// ─── Contacts ────────────────────────────────────────────────────────────────

function normalizeContact(row: RawContact): Contact {
  return { ...row, enabled: row.enabled === 1 };
}

export function listContacts(): Contact[] {
  return (getDb().prepare("SELECT * FROM contacts ORDER BY name").all() as RawContact[]).map(
    normalizeContact
  );
}

export function getContact(phoneNumber: string): Contact | null {
  const row = getDb()
    .prepare("SELECT * FROM contacts WHERE phone_number = ?")
    .get(normalizePhone(phoneNumber)) as RawContact | undefined;
  return row ? normalizeContact(row) : null;
}

export function hasAccess(phoneNumber: string): boolean {
  const c = getContact(phoneNumber);
  return c !== null && c.enabled;
}

export function addContact(name: string, phoneNumber: string): Contact {
  const phone = normalizePhone(phoneNumber);
  getDb()
    .prepare("INSERT INTO contacts (name, phone_number, enabled) VALUES (?, ?, 1)")
    .run(name, phone);
  return getContact(phone)!;
}

export function updateContact(
  phoneNumber: string,
  updates: { name?: string; enabled?: boolean; notes?: string }
): Contact | null {
  const db = getDb();
  const phone = normalizePhone(phoneNumber);
  if (!getContact(phone)) return null;
  if (updates.name !== undefined)
    db.prepare("UPDATE contacts SET name = ? WHERE phone_number = ?").run(updates.name, phone);
  if (updates.enabled !== undefined)
    db.prepare("UPDATE contacts SET enabled = ? WHERE phone_number = ?").run(
      updates.enabled ? 1 : 0,
      phone
    );
  if (updates.notes !== undefined)
    db.prepare("UPDATE contacts SET notes = ? WHERE phone_number = ?").run(updates.notes, phone);
  return getContact(phone);
}

export function removeContact(phoneNumber: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM contacts WHERE phone_number = ?")
    .run(normalizePhone(phoneNumber));
  return result.changes > 0;
}

export function touchLastSeen(phoneNumber: string): void {
  getDb()
    .prepare("UPDATE contacts SET last_seen = datetime('now') WHERE phone_number = ?")
    .run(normalizePhone(phoneNumber));
}

// ─── Sessions ────────────────────────────────────────────────────────────────

function normalizeSession(row: RawSession): Session {
  const { is_active, ...rest } = row;
  return { ...rest, is_active: is_active === 1 };
}

export function getOrCreateSession(phoneNumber: string): Session {
  const db = getDb();
  const phone = normalizePhone(phoneNumber);

  // Find an active session within the timeout window
  const existing = db
    .prepare(
      `SELECT * FROM sessions
       WHERE phone_number = ? AND is_active = 1
         AND last_active >= datetime('now', '-${SESSION_TIMEOUT_MINUTES} minutes')
       ORDER BY last_active DESC LIMIT 1`
    )
    .get(phone) as RawSession | undefined;

  if (existing) {
    db.prepare("UPDATE sessions SET last_active = datetime('now') WHERE id = ?").run(existing.id);
    return normalizeSession({ ...existing, last_active: new Date().toISOString() });
  }

  // Close stale sessions
  db.prepare("UPDATE sessions SET is_active = 0 WHERE phone_number = ? AND is_active = 1").run(
    phone
  );

  // Start new session
  const result = db
    .prepare("INSERT INTO sessions (phone_number) VALUES (?)")
    .run(phone);
  const id = Number(result.lastInsertRowid);
  return getSession(id)!;
}

export function getSession(id: number): Session | null {
  const row = getDb()
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(id) as RawSession | undefined;
  return row ? normalizeSession(row) : null;
}

export function endSession(phoneNumber: string): void {
  getDb()
    .prepare("UPDATE sessions SET is_active = 0 WHERE phone_number = ? AND is_active = 1")
    .run(normalizePhone(phoneNumber));
}

// ─── Messages ────────────────────────────────────────────────────────────────

export function logMessage(
  phoneNumber: string,
  direction: "in" | "out",
  content: string,
  type: string = "text",
  waMessageId?: string
): Message {
  const db = getDb();
  const phone = normalizePhone(phoneNumber);
  const session = getOrCreateSession(phone);

  const result = db
    .prepare(
      `INSERT INTO messages (session_id, phone_number, direction, type, content, wa_message_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(session.id, phone, direction, type, content, waMessageId ?? null);

  return db
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as Message;
}

export function getConversationHistory(
  phoneNumber: string,
  limit: number = 20
): Message[] {
  const phone = normalizePhone(phoneNumber);
  // Get active session first, fall back to most recent session
  const session = getDb()
    .prepare(
      `SELECT * FROM sessions WHERE phone_number = ? ORDER BY last_active DESC LIMIT 1`
    )
    .get(phone) as RawSession | undefined;

  if (!session) return [];

  return getDb()
    .prepare(
      `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(session.id, limit)
    .reverse() as Message[];
}

export function getAllSessions(phoneNumber: string): Session[] {
  return (
    getDb()
      .prepare("SELECT * FROM sessions WHERE phone_number = ? ORDER BY started_at DESC")
      .all(normalizePhone(phoneNumber)) as RawSession[]
  ).map(normalizeSession);
}

export function getDbPath(): string {
  return DB_PATH;
}
