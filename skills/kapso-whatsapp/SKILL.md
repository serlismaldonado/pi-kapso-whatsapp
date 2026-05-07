---
name: kapso-whatsapp
description: Routing skill for WhatsApp agent work via Kapso AI. Use when handling incoming WhatsApp messages, managing contacts, sending messages, or viewing conversation history.
---

# WhatsApp Agent (Kapso AI)

Pi extension that connects WhatsApp to the Pi agent via Kapso AI.
- SQLite contacts DB with access control
- Per-contact notes for agent context
- Full conversation history per session
- Customizable agent behavior via SYSTEM.md and PROMPT.md

## Architecture

```
WhatsApp user → Kapso webhook → your server → Pi (whatsapp_receive)
                                                      ↓
                                              access check + history
                                                      ↓
                                              Pi crafts reply
                                                      ↓
                                              whatsapp_send + whatsapp_log_out
```

## Incoming message flow (ALWAYS follow this order)

```
1. whatsapp_receive { payload: "<raw webhook JSON>" }
   → Returns: contact info, notes, session history, SYSTEM.md, PROMPT.md
   → If ACCESS DENIED: stop here

2. Read the context and craft a response

3. whatsapp_send { to: "+50488887777", message: "..." }

4. whatsapp_log_out { phone_number: "+50488887777", content: "..." }
```

## Setup (one-time)

```
1. whatsapp_numbers_list           → find phone_number_id
2. /kapso-setup                    → save API key + phone_number_id
3. whatsapp_contact_add            → add allowed contacts
4. whatsapp_webhook_setup          → register webhook URL
5. Edit SYSTEM.md and PROMPT.md    → customize agent behavior
   (/kapso-instructions shows the file paths)
```

## Commands

| Command | Description |
|---------|-------------|
| `/kapso-setup` | Configure API key and phone_number_id |
| `/kapso-contacts` | List contacts with status and notes |
| `/kapso-instructions` | Show SYSTEM.md and PROMPT.md paths |

## Tools reference

### Receive & respond
| Tool | Description |
|------|-------------|
| `whatsapp_receive` | Process incoming webhook payload → full context |
| `whatsapp_send` | Send text message |
| `whatsapp_send_image` | Send image (URL or media ID) |
| `whatsapp_send_document` | Send document/PDF |
| `whatsapp_send_buttons` | Send interactive quick-reply buttons (max 3) |
| `whatsapp_send_location` | Send location pin |
| `whatsapp_log_out` | Log an outgoing message to session history |

### Contacts
| Tool | Description |
|------|-------------|
| `whatsapp_check_access` | Check if a phone number has access |
| `whatsapp_contacts_list` | List contacts (filter: all/allowed/blocked) |
| `whatsapp_contact_add` | Add contact + optional notes |
| `whatsapp_contact_remove` | Remove contact |
| `whatsapp_contact_update` | Update name, access, or notes |

### Sessions & history
| Tool | Description |
|------|-------------|
| `whatsapp_history` | Get conversation history for a contact |
| `whatsapp_session_end` | Manually end the active session |

### Config & infra
| Tool | Description |
|------|-------------|
| `whatsapp_status` | Full status: config + API + DB stats |
| `whatsapp_webhook_setup` | Register Kapso webhook URL |
| `whatsapp_webhooks_list` | List registered webhooks |
| `whatsapp_numbers_list` | List connected phone numbers |

## Webhook payload (Kapso v2)

```json
{
  "event": "whatsapp.message.received",
  "data": {
    "message": {
      "from": "50488887777",
      "type": "text",
      "text": { "body": "Hola!" },
      "id": "wamid.xxx"
    }
  }
}
```

Pass the entire raw payload to `whatsapp_receive`.

## Agent instructions

- `SYSTEM.md` — who the agent is, general behavior rules
- `PROMPT.md` — step-by-step response guidelines and rich message usage
- Both files auto-created at first run in `~/.pi/agent/extensions/pi-kapso-whatsapp/`
- Edit them to customize behavior per your use case

## Contact notes

Use notes to give the agent context about a specific contact:
```
whatsapp_contact_update {
  phone_number: "+50488887777",
  notes: "VIP client. Prefers Spanish. Only ask about Project X."
}
```
Notes are returned inside `whatsapp_receive` so the agent reads them before replying.

## Storage

- Config: `~/.pi/agent/extensions/pi-kapso-whatsapp/config.json`
- SQLite DB: `~/.pi/agent/extensions/pi-kapso-whatsapp/contacts.db`
- Tables: `contacts`, `sessions`, `messages`
- Session timeout: 30 minutes of inactivity
- Env fallback: `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_API_BASE_URL`
