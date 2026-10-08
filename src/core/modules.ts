import { MODULES } from "../modules.gen.ts";
import { CORE_PRESETS, type OrderPreset } from "../ui/order.ts";
import { CORE_ACTIONS } from "./actions.ts";
import { StetError, usage, type Ctx } from "./context.ts";
import { CORE_KINDS } from "./kinds.ts";
import type { ActionDef, CommandSpec, FileKind, ModuleSpec } from "./module.ts";

/** The modules of this build, from the list `scripts/modules.ts` writes. */
export const built = (): readonly ModuleSpec[] => MODULES;

export const isBuilt = (id: string): boolean => MODULES.some((m) => m.id === id);

/** The modules of `from` that are on in the repository: `modules.<id>` not `off`, and every module they need on too. */
export function enabled(ctx: Ctx, from: readonly ModuleSpec[] = MODULES): ModuleSpec[] {
  const memo = new Map<string, boolean>();
  const on = (m: ModuleSpec): boolean => {
    const known = memo.get(m.id);
    if (known !== undefined) return known;
    memo.set(m.id, false);
    const switched = (ctx.store.meta(`modules.${m.id}`) ?? m.default) === "on";
    const result = switched && (m.needs ?? []).every((id) => {
      const need = from.find((x) => x.id === id);
      return need !== undefined && on(need);
    });
    memo.set(m.id, result);
    return result;
  };
  return from.filter(on);
}

/** The kinds of file the core and the enabled modules know. */
export function fileKinds(ctx: Ctx): FileKind[] {
  return [...CORE_KINDS, ...enabled(ctx).flatMap((m) => m.fileKinds ?? [])];
}

export function kindOf(ctx: Ctx, path: string): FileKind | null {
  return fileKinds(ctx).find((k) => k.match(path)) ?? null;
}

/** The orders of files `compare.order` may name: the core's presets, then the enabled modules'. */
export function orderPresets(ctx: Ctx, from: readonly ModuleSpec[] = MODULES): OrderPreset[] {
  return [...CORE_PRESETS, ...enabled(ctx, from).flatMap((m) => m.orderPresets ?? [])];
}

/** The CLI commands modules bring, each with the module it belongs to. */
export function commandsOf(from: readonly ModuleSpec[] = MODULES): { module: ModuleSpec; command: CommandSpec }[] {
  return from.flatMap((m) => (m.cli ?? []).map((command) => ({ module: m, command })));
}

/** The actions a UI may offer: the core's, then the enabled modules'. */
export function actionsOf(ctx: Ctx, from: readonly ModuleSpec[] = MODULES): ActionDef[] {
  return [...CORE_ACTIONS, ...enabled(ctx, from).flatMap((m) => m.actions ?? [])];
}

/** The action `id`, or an error that says why there is none: its module is off, or this build has no such action. */
export function actionOf(ctx: Ctx, id: string, from: readonly ModuleSpec[] = MODULES): ActionDef {
  const on = actionsOf(ctx, from);
  const action = on.find((a) => a.id === id);
  if (action) return action;
  const owner = from.find((m) => m.actions?.some((a) => a.id === id));
  if (owner) throw usage(`the action ${id} belongs to the ${owner.id} module, which is off in this repository: stet config set modules.${owner.id} on`);
  throw new StetError(`no action ${id} in this build; it has ${on.map((a) => a.id).join(", ")}`, 2, "not_found");
}
