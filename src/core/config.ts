import { usage } from "./context.ts";
import { GUIDE_KEY } from "./guide.ts";

/** The repository's settings, `stet config get/set`. */
export const CONFIG_KEYS = new Set([
  "snapshot.exclude", "snapshot.max_untracked_bytes",
  "compare.tests", "compare.skip_markers", "compare.collapse", "compare.order", "compare.markdown",
  GUIDE_KEY,
]);

/** The values a setting takes, for those that take only a few. */
export const CONFIG_VALUES: Record<string, string[]> = { "compare.markdown": ["rendered", "code"], [GUIDE_KEY]: ["on", "off"] };

/** The settings the web UI may write; the rest only the CLI. */
export const UI_CONFIG_KEYS = new Set([GUIDE_KEY]);

export function configKey(key: string | undefined, usageText: string): string {
  if (!key) throw usage(usageText);
  if (!CONFIG_KEYS.has(key)) throw usage(`unknown config key '${key}'; known: ${[...CONFIG_KEYS].join(", ")}`);
  return key;
}

/** A value `key` takes; null unsets it. */
export function configValue(key: string, value: string | null): string | null {
  const allowed = CONFIG_VALUES[key];
  if (allowed && value !== null && !allowed.includes(value)) throw usage(`${key} takes ${allowed.join(" or ")}`);
  return value;
}
