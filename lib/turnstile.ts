const TURNSTILE_SECRET_KEY = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY || "";
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY || "";

/**
 * Verify a Cloudflare Turnstile token server-side.
 * Returns true when the token is valid, false otherwise.
 * Skips verification entirely when no secret key is configured (dev fallback).
 */
export async function verifyTurnstile(token: string): Promise<boolean> {
  if (!TURNSTILE_SECRET_KEY) {
    console.warn("[turnstile] No CLOUDFLARE_TURNSTILE_SECRET_KEY set — skipping verification");
    return true;
  }

  if (!token || typeof token !== "string") {
    return false;
  }

  try {
    const formData = new URLSearchParams();
    formData.append("secret", TURNSTILE_SECRET_KEY);
    formData.append("response", token);

    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData,
    });

    if (!res.ok) return false;

    const data = (await res.json()) as { success?: boolean };
    return !!data.success;
  } catch {
    console.error("[turnstile] Verification request failed");
    return false;
  }
}

/** Expose whether the frontend should render a widget. */
export function isTurnstileEnabled(): boolean {
  return TURNSTILE_SITE_KEY.length > 0 && TURNSTILE_SECRET_KEY.length > 0;
}

/** Pass the site key to client-side pages so they can decide whether to load the widget script. */
export function getSiteKey(): string {
  return TURNSTILE_SITE_KEY;
}
