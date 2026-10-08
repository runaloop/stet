import { MODULES } from "../modules.gen.ts";
import type { Ctx } from "./context.ts";
import type { CommandSpec, FileKind, ModuleSpec } from "./module.ts";

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

/** The kinds of file the enabled modules know. */
export function fileKinds(ctx: Ctx): FileKind[] {
  return enabled(ctx).flatMap((m) => m.fileKinds ?? []);
}

export function kindOf(ctx: Ctx, path: string): FileKind | null {
  return fileKinds(ctx).find((k) => k.match(path)) ?? null;
}

/** The CLI commands modules bring, each with the module it belongs to. */
export function commandsOf(from: readonly ModuleSpec[] = MODULES): { module: ModuleSpec; command: CommandSpec }[] {
  return from.flatMap((m) => (m.cli ?? []).map((command) => ({ module: m, command })));
}
