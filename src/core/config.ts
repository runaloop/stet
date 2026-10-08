import type { Ctx } from "./context.ts";
import { usage } from "./context.ts";
import { GUIDE_KEY } from "./guide.ts";
import type { ConfigKeySpec, ModuleSpec } from "./module.ts";
import { built, enabled, orderPresets } from "./modules.ts";
import { orderProblem } from "../ui/order.ts";

/** The repository's settings of the core, `stet config get/set`; enabled modules add their own. */
export const CORE_CONFIG: ConfigKeySpec[] = [
  { key: "snapshot.exclude", ui: false, scope: "repo" },
  { key: "snapshot.max_untracked_bytes", ui: false, scope: "repo" },
  { key: "compare.tests", ui: "read", scope: "repo" },
  { key: "compare.skip_markers", ui: "read", scope: "repo" },
  { key: "compare.collapse", ui: "read", scope: "repo" },
  {
    key: "compare.order",
    help: "kinds or a module's preset, or groups of your own; default kinds",
    ui: "read",
    scope: "repo",
    check: (value, ctx, from) => orderProblem(value, orderPresets(ctx, from)),
  },
  {
    key: "compare.markdown",
    values: ["rendered", "code"],
    default: "rendered",
    help: "rendered or code: how Markdown files open on the Changes page; default rendered",
    ui: "read",
    scope: "repo",
  },
  {
    key: GUIDE_KEY,
    values: ["on", "off"],
    default: "on",
    help: `on: the agent adds a guide to the first version and to rounds that changed more than the threads asked; off: only when a review asks with --guide; default on; also the Drafts page's "Guides in this repository" switch`,
    ui: "write",
    scope: "repo",
  },
];

/** `modules.<id>`: whether a module of this build is on in the repository. */
export function switchOf(m: ModuleSpec): ConfigKeySpec {
  const tag = m.experimental ? " (experimental)" : "";
  return { key: `modules.${m.id}`, values: ["on", "off"], default: m.default, help: `on or off: ${m.label}${tag}; default ${m.default}`, ui: false, scope: "repo" };
}

/** Every setting this build knows of, for `stet --help`: modules that are off in a repository still list theirs. */
export function builtConfig(from: readonly ModuleSpec[] = built()): ConfigKeySpec[] {
  return [...CORE_CONFIG, ...from.map(switchOf), ...from.flatMap((m) => m.config ?? [])];
}

/** The settings of the repository: the core's, a switch per module of the build, and the keys of the enabled ones. */
export function configKeys(ctx: Ctx, from: readonly ModuleSpec[] = built()): ConfigKeySpec[] {
  return [...CORE_CONFIG, ...from.map(switchOf), ...enabled(ctx, from).flatMap((m) => m.config ?? [])];
}

export function configKey(ctx: Ctx, key: string | undefined, usageText: string): ConfigKeySpec {
  if (!key) throw usage(usageText);
  const known = configKeys(ctx);
  const spec = known.find((k) => k.key === key);
  if (!spec) throw usage(`unknown config key '${key}'; known: ${known.map((k) => k.key).join(", ")}`);
  return spec;
}

/** A value `spec` takes in the repository of `ctx` with the modules `from`; null unsets it. Without `ctx`, only `spec.values` are checked. */
export function configValue(spec: ConfigKeySpec, value: string | null, ctx?: Ctx, from: readonly ModuleSpec[] = built()): string | null {
  if (spec.values && value !== null && !spec.values.includes(value)) throw usage(`${spec.key} takes ${spec.values.join(" or ")}`);
  const problem = ctx && value !== null ? spec.check?.(value, ctx, from) : null;
  if (problem) throw usage(problem);
  return value;
}

/** The settings a UI sees, by key: those marked `ui`. */
export function uiConfig(ctx: Ctx): Record<string, string | null> {
  return Object.fromEntries(configKeys(ctx).filter((k) => k.ui).map((k) => [k.key, ctx.store.meta(k.key)]));
}
