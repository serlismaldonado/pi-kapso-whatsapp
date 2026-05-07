# pi-kapso-whatsapp

Pi coding agent extension for WhatsApp via [Kapso AI](https://kapso.ai).  
Gives Pi a full set of WhatsApp tools: send messages, manage contacts, control the webhook service, set up Cloudflare tunnels, and handle incoming messages with access control.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I3177MUT)

---

## Installation

```bash
pi install pi-kapso-whatsapp
```

Or manually:

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/serlismaldonado/pi-kapso-whatsapp
```

Then reload Pi's extensions.

---

## Initial setup

Once installed, tell Pi:

> "Set up the WhatsApp bot"

Pi will run the full autonomous setup — no questions, no manual steps:

1. Checks system requirements (PM2, `pi-whatsapp-service`, `.env`)
2. Installs PM2 if missing
3. Builds and starts the service
4. Sets up a Cloudflare tunnel (temporary or custom domain)
5. Registers the webhook in Kapso
6. Adds you to the contact allowlist
7. Verifies everything is running

The only step that may require you is `pm2 startup` (requires sudo once).

---

## Commands

| Command | Description |
|---|---|
| `/kapso-setup` | Set API key and phone number ID |
| `/kapso-contacts` | List contacts with notes |
| `/kapso-instructions` | Show paths to `SYSTEM.md` and `PROMPT.md` |

---

## Tools reference

### Receiving messages

| Tool | Description |
|---|---|
| `whatsapp_receive` | Process an incoming webhook payload — checks access, loads history, reads `SYSTEM.md` / `PROMPT.md` |
| `whatsapp_history` | Get conversation history for a contact |
| `whatsapp_log_out` | Log an outgoing message to the session history |
| `whatsapp_session_end` | End the active session for a contact |
| `whatsapp_status` | Check current processing status |

### Sending messages

| Tool | Description |
|---|---|
| `whatsapp_send` | Send a text message |
| `whatsapp_send_image` | Send an image (URL or `media_id`) |
| `whatsapp_send_document` | Send a document/file (URL or `media_id`) |
| `whatsapp_send_audio` | Send audio or a voice note (`voice: true` for transcription) |
| `whatsapp_send_video` | Send a video with optional caption |
| `whatsapp_send_sticker` | Send a sticker (WEBP format) |
| `whatsapp_send_reaction` | React to a message with an emoji |
| `whatsapp_send_contact` | Send a contact card (vCard) |
| `whatsapp_send_location` | Send a location pin |
| `whatsapp_send_buttons` | Interactive message with up to 3 quick-reply buttons |
| `whatsapp_send_list` | Interactive list menu (up to 10 sections) |
| `whatsapp_send_cta` | Message with a call-to-action URL button |
| `whatsapp_upload_media` | Upload a local file and get a `media_id` |

### Templates

| Tool | Description |
|---|---|
| `whatsapp_templates_list` | List approved message templates |
| `whatsapp_send_template` | Send a template (works outside the 24h conversation window) |

### Contact management

| Tool | Description |
|---|---|
| `whatsapp_contacts_list` | List all contacts and their access status |
| `whatsapp_contact_add` | Add a contact to the allowlist |
| `whatsapp_contact_remove` | Remove a contact |
| `whatsapp_contact_update` | Update name, notes, or enabled status |
| `whatsapp_check_access` | Check if a phone number has access |

### Webhooks

| Tool | Description |
|---|---|
| `whatsapp_webhook_setup` | Register a new Kapso webhook |
| `whatsapp_webhooks_list` | List all registered webhooks |
| `whatsapp_webhook_register` | Register or update the active webhook URL |
| `whatsapp_numbers_list` | List connected WhatsApp numbers (to get `phone_number_id`) |

### Service management

| Tool | Description |
|---|---|
| `whatsapp_setup_check` | Inspect all system requirements and current state |
| `whatsapp_service_status` | Check if the service is running |
| `whatsapp_service_start` | Build and start the service with PM2 |
| `whatsapp_service_stop` | Stop the service |
| `whatsapp_service_restart` | Restart the service |
| `whatsapp_service_logs` | View recent logs |
| `whatsapp_service_configure` | Write the `.env` file |
| `whatsapp_service_setup_autostart` | Configure PM2 to start on login |
| `whatsapp_tunnel_setup` | Start a Cloudflare tunnel and register the webhook URL |

---

## Customizing the bot

### Identity and behavior

Edit these two files to define who the agent is and how it responds:

- `~/.pi/agent/extensions/pi-kapso-whatsapp/SYSTEM.md` — agent name, personality, scope
- `~/.pi/agent/extensions/pi-kapso-whatsapp/PROMPT.md` — step-by-step response instructions

Changes take effect immediately — no restart needed.

Example: tell Pi:

> "Edit SYSTEM.md and PROMPT.md. The agent is called Javi, responds in Spanish with a professional but direct tone, and only handles questions about my services."

### Access control

Only contacts in the allowlist receive responses. Others are silently ignored.

```
whatsapp_contact_add    with {"name": "Ana", "phone_number": "+50488887777"}
whatsapp_contact_update with {"phone_number": "+50488887777", "enabled": false}
whatsapp_contacts_list
```

---

## Incoming message flow

```
Kapso webhook → whatsapp_receive
  → ACCESS DENIED  → silent ignore
  → ACCESS GRANTED →
      read contact data + notes
      read session history
      read SYSTEM.md + PROMPT.md
      → Pi processes and replies →
          whatsapp_send (or send_image, send_document, etc.)
          whatsapp_log_out
```

---

## Sending files

To send a local file:

```
1. whatsapp_upload_media with {"file_path": "/path/to/file.pdf"}
   → returns media_id

2. whatsapp_send_document with {"to": "+504...", "media_id": "<id>", "filename": "file.pdf"}
```

MIME type is auto-detected from the file extension.

---

## Tunnel modes

**Quick tunnel** (no account, URL changes on restart):
```
whatsapp_tunnel_setup with {"port": 4721}
```
Uses `trycloudflare.com`. The webhook in Kapso is updated automatically on each restart.

**Permanent tunnel** (Cloudflare account + custom domain):
```
whatsapp_tunnel_setup with {"port": 4721, "customDomain": "whatsapp.yourdomain.com"}
```
Requires a DNS CNAME in Cloudflare pointing to your named tunnel UUID.

---

## Related packages

| Package | Description |
|---|---|
| [pi-whatsapp-service](https://github.com/serlismaldonado/pi-whatsapp-service) | The always-on webhook receiver service |
| [pi-mono](https://github.com/badlogic/pi-mono) | Pi coding agent SDK |

---

## License

MIT
