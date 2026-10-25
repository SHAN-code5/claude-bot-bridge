/**
 * Lightweight multi-account support (issue #2).
 *
 * Each `--account <name>` (or `NOTEBOOKLM_ACCOUNT=<name>`) gets its own
 * Chrome profile directory under `<dataDir>/accounts/<slug>/`. Chrome's
 * persistent profile already isolates cookies/state per directory, which
 * is enough for the common case of "two Google accounts, different research
 * notebooks" — no encrypted credential store needed.
 *
 * The function is a no-op when no account flag is present, which preserves
 * the single-profile layout for everyone who never asked for multi-account.
 */

import path from "path";
import type { Config } from "../config.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-_]{0,30}$/i;

export function getRequestedAccount(argv: readonly string[] = process.argv): string | null {
  // CLI flag takes precedence over the env var.
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--account" || arg === "-a") {
      const value = argv[i + 1];
      if (value && !value.startsWith("-")) return normalizeSlug(value);
    } else if (arg.startsWith("--account=")) {
      return normalizeSlug(arg.slice("--account=".length));
    }
  }
  const envValue = process.env.NOTEBOOKLM_ACCOUNT;
  return envValue ? normalizeSlug(envValue) : null;
}

function normalizeSlug(value: string): string {
  const trimmed = value.trim();
  if (!SLUG_RE.test(trimmed)) {
    throw new Error(
      `Invalid account name "${value}". ` +
        "Use letters, numbers, hyphen or underscore (max 31 chars), starting with a letter or digit."
    );
  }
  return trimmed.toLowerCase();
}

/**
 * Mutate-in-place (then return) the global `Config` so all downstream paths
 * (Chrome profile, auth state, isolated instances) live below the account
 * sub-tree. Called once during startup, before any browser launch.
 */
export function applyAccountToConfig(config: Config, account: string | null): Config {
  if (!account) return config;
  const root = path.join(config.dataDir, "accounts", account);
  config.dataDir = root;
  config.browserStateDir = path.join(root, "browser_state");
  config.chromeProfileDir = path.join(root, "chrome_profile");
  config.chromeInstancesDir = path.join(root, "chrome_profile_instances");
  return config;
}
