// Written by scripts/modules.ts: the modules of this build. `bun run build -- --without <id>` builds without one.
import type { ModuleSpec } from "./core/module.ts";
import images from "../modules/images/core.ts";

export const MODULES: ModuleSpec[] = [images];
