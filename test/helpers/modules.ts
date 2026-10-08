import { describe, test } from "bun:test";
import { isBuilt } from "../../src/core/modules.ts";

/**
 * `describe` and `test` for a module's own tests: they run only in a build that has the module. A skipped `describe`
 * does not run its body either, which would make fixtures that no `afterAll` cleans up.
 */
export function forModule(id: string): { describe: typeof describe; test: typeof test } {
  if (isBuilt(id)) return { describe, test };
  const skipped = (name: string) => describe(name, () => test.skip(`the ${id} module is not in this build`, () => {}));
  return { describe: skipped as unknown as typeof describe, test: test.skip as typeof test };
}
