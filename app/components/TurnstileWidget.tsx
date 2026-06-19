"use client";

import { useEffect, useRef } from "react";

declare global {
  interface Window {
    turnstile?: {
      render(container: string | HTMLElement, options: TurnstileRenderOptions): string | null;
      remove(widgetId: string): void;
      reset(widgetId?: string): Promise<string | undefined>;
    };
  }
}

interface TurnstileRenderOptions {
  sitekey: string;
  action?: string;
  cdata?: string;
  theme?: "light" | "dark";
  size?: "normal" | "compact";
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
}

interface TurnstileWidgetProps {
  siteKey: string;
  onTokenReady: (token: string) => void;
  action?: string;
}

/** Track whether the Cloudflare script has already been injected. */
let scriptLoaded = false;

function loadTurnstileScript(): Promise<void> {
  if (scriptLoaded || document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')) {
    scriptLoaded = true;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileApiReady";
    script.async = true;
    script.defer = true;
    (window as any).onTurnstileApiReady = () => {
      scriptLoaded = true;
      resolve();
    };
    script.onerror = () => {
      console.error("[turnstile] Failed to load Cloudflare Turnstile script");
      scriptLoaded = true;
      resolve();
    };
    document.head.appendChild(script);
  });
}

export default function TurnstileWidget({ siteKey, onTokenReady, action = "submit" }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const callbackRef = useRef(onTokenReady);

  useEffect(() => {
    callbackRef.current = onTokenReady;
  }, [onTokenReady]);

  useEffect(() => {
    if (!siteKey) return;

    let mounted = true;

    async function init() {
      await loadTurnstileScript();
      if (!mounted || !containerRef.current || typeof window.turnstile !== "object") return;

      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        action,
        theme: "light",
        size: "normal",
        callback(token) {
          if (mounted && token) callbackRef.current(token);
        },
        "expired-callback"() {
          if (widgetIdRef.current) {
            window.turnstile?.reset(widgetIdRef.current).catch(() => {});
          }
        },
      }) ?? null;
    }

    init();

    return () => {
      mounted = false;
      if (widgetIdRef.current && typeof window.turnstile !== "undefined") {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // ignore cleanup errors on unmount
        }
        widgetIdRef.current = null;
      }
    };
  }, [siteKey, action]);

  return (
    <div className="turnstile-wrapper" ref={containerRef}>
      {/* Container for the Cloudflare Turnstile widget — injected here. */}
    </div>
  );
}
