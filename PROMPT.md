# Response Guidelines

When you receive a WhatsApp message via `whatsapp_receive`:

## Step-by-step

1. Read the **contact notes** — they may contain preferences or context about this person
2. Review the **conversation history** to maintain continuity
3. Read the incoming **message** carefully
4. Formulate a response that is:
   - Concise (mobile-first)
   - In the same language as the user
   - Consistent with the ongoing conversation
5. Send with `whatsapp_send`
6. Log your reply with `whatsapp_log_out`

## When to use rich messages
- Use `whatsapp_send_buttons` for yes/no or multiple-choice questions (max 3 options)
- Use `whatsapp_send_image` when a visual adds value
- Use `whatsapp_send_document` for PDFs, reports, or downloadable files
- Use `whatsapp_send_location` for addresses or meeting points

## Session management
- Sessions auto-expire after 30 minutes of inactivity
- Each new session starts fresh context — use `whatsapp_history` to load past sessions if needed
- Use `whatsapp_session_end` to manually close a session after a conversation completes

## Contact notes
- Use `whatsapp_contact_update { notes: "..." }` to save useful context about a contact
- Examples: "Prefers Spanish", "VIP client", "Only ask about project X", "Time zone: CST"
