import { timingSafeEqual } from "node:crypto";

/**
 * /api/setup is authorised by TELEGRAM_WEBHOOK_SECRET sent in a header —
 * `Authorization: Bearer <secret>` or `X-Setup-Key: <secret>`.
 * Not in the query string: URLs end up in Vercel request logs and browser history.
 */
export function setupKeyFromHeaders(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1]!.trim();
  }
  const key = headers.get("x-setup-key");
  return key ? key.trim() : null;
}

/** Constant-time comparison of the provided key with the secret. */
export function isValidSetupKey(provided: string | null, secret: string): boolean {
  if (!provided || !secret) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(secret, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
