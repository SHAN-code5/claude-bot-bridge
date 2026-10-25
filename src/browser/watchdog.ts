/**
 * Browser-page watchdog primitives (issues #16 + #29).
 *
 * Two failure modes that bit users in v1.x:
 *   1. `page.waitForTimeout(N)` returns *immediately* when the underlying
 *      browser process is in a zombie state, which turned poll loops into
 *      busy-spinning consumers of 100 % CPU.
 *   2. `page.evaluate(...)` can hang forever when the renderer is wedged,
 *      so loops never noticed they were operating on dead pages.
 *
 * `safeSleep` falls back to a Node `setTimeout` when the page sleep returns
 * suspiciously fast. `pageIsAlive` runs a tiny `evaluate` with a hard ceiling
 * so callers can detect a dead renderer without blocking. `isRecoverable`
 * recognises the common patchright/playwright disconnect strings so that
 * higher-level recovery code can rebuild the context instead of bailing.
 */

import type { Page } from "patchright";

/**
 * Sleep that is robust against a zombie page returning early. Always honours
 * at least 95 % of the requested duration via a Node-side timer fallback.
 */
export async function safeSleep(page: Page, ms: number): Promise<void> {
  const start = Date.now();
  try {
    await page.waitForTimeout(ms);
  } catch {
    /* page might be closing — fall through to Node timer */
  }
  const elapsed = Date.now() - start;
  const remaining = ms - elapsed;
  if (remaining > ms * 0.05) {
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }
}

/**
 * Returns `true` if the page responds to a trivial `evaluate` within the
 * health-check budget. Returns `false` for crashed, frozen or disconnected
 * pages — never throws.
 */
export async function pageIsAlive(page: Page, budgetMs: number = 1_500): Promise<boolean> {
  if (page.isClosed()) return false;
  try {
    await Promise.race([
      page.evaluate(() => true),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("health check timed out")), budgetMs)
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

const RECOVERABLE_PATTERNS: readonly RegExp[] = [
  /Target page, context or browser has been closed/i,
  /Page closed/i,
  /Target closed/i,
  /Browser has been closed/i,
  /Browser context has been closed/i,
  /Target crashed/i,
  /WebSocket .* (closed|disconnected)/i,
  /page is unresponsive/i,
  /health check timed out/i,
];

/**
 * Heuristic: errors that indicate the browser/page is gone but the higher
 * layer can recover by re-creating the context. Anything else should bubble
 * up unchanged.
 */
export function isRecoverable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return RECOVERABLE_PATTERNS.some((re) => re.test(msg));
}
