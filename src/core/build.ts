declare const STET_BUILD: string | undefined;

/**
 * Which code runs: `bun run build` defines it from the version, the commit and a mark for uncommitted changes,
 * and code run from source says `dev`. The server and the page it serves are built together and carry the same one.
 */
export const BUILD: string = typeof STET_BUILD === "string" ? STET_BUILD : "dev";
