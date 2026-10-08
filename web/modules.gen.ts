// Written by scripts/modules.ts: the modules of this build. `bun run build -- --without <id>` builds without one.
import type { WebModule } from "./modules.tsx";
import images from "../modules/images/web.tsx";

export const WEB_MODULES: WebModule[] = [images];
