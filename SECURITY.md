# Security

Fit Check is a single-user, self-hosted app. When you expose it through a tunnel, anyone who has the link can reach the
login.

- **Always set `APP_PASSWORD`** before exposing the app. The password protects your photos and your API keys, which
  anyone using the app spends on your behalf. Use a long, random value.
- The password is sent as a header and exchanged for an HttpOnly, Secure, SameSite=Strict session cookie. It never
  appears in URLs.
- API keys stay on the server, in `.env`. They are never sent to the browser.
- Your data stays in `data/` and `BACKUP_DIR` on your machine. Images are sent only to the AI providers you configure
  (Google Gemini, Amazon Bedrock, and fal.ai if enabled), under their terms.
- Cloudflare tunnel credentials (`~/.cloudflared/*.json`) let anyone run your tunnel. Keep them private.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security tab → "Report a vulnerability") rather than a public
issue. I'll respond as soon as I can.
