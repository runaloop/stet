import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const root = realpathSync(mkdtempSync(join(process.argv[2] ?? tmpdir(), "stet-demo-")));
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Demo",
  GIT_AUTHOR_EMAIL: "demo@example.com",
  GIT_COMMITTER_NAME: "Demo",
  GIT_COMMITTER_EMAIL: "demo@example.com",
};

function git(...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd: root, env });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function stet(role: "reviewer" | "agent", ...args: string[]): any {
  const r = Bun.spawnSync(["bun", CLI, ...args, "--json"], { cwd: root, env: { ...env, STET_ROLE: role, STET_AUTHOR: role === "reviewer" ? "you" : "claude" } });
  if (r.exitCode !== 0) throw new Error(`stet ${args.join(" ")}: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString() || "null");
}

const repo = `package demo

import kotlin.math.max

class Repository(private val api: Api, private val cache: Cache) {
    fun load(id: String): Item? {
        val cached = cache.get(id)
        if (cached != null) return cached
        val item = api.fetch(id)
        cache.put(id, item)
        cache.put(id, item)
        return item
    }

    fun loadAll(ids: List<String>): List<Item> {
        val result = mutableListOf<Item>()
        for (id in ids) {
            val item = load(id)
            if (item != null) result.add(item)
        }
        return result
    }

    fun score(item: Item): Int {
        return max(0, item.likes - item.dislikes)
    }
}
`;

git("init", "-q", "-b", "main");
write("README.md", "# Demo\n\nA tiny repository for trying stet.\n");
write("src/main/kotlin/demo/Repository.kt", repo);
write("src/main/kotlin/demo/Api.kt", "package demo\n\ninterface Api {\n    fun fetch(id: String): Item\n}\n");
git("add", "-A");
git("commit", "-q", "-m", "base");
git("checkout", "-q", "-b", "feature/cache");

write("src/main/kotlin/demo/Cache.kt", "package demo\n\nclass Cache {\n    private val map = HashMap<String, Item>()\n    fun get(id: String): Item? = map[id]\n    fun put(id: String, item: Item) { map[id] = item }\n}\n");
stet("agent", "version", "create", "--label", "add a cache");

const t1 = stet("reviewer", "comment", "add", "--file", "src/main/kotlin/demo/Repository.kt", "--range", "10-11", "--at", "1", "--body", "`cache.put` is called twice.", "--draft");
const t2 = stet("reviewer", "comment", "add", "--file", "src/main/kotlin/demo/Repository.kt", "--range", "15-21", "--at", "1", "--body", "Could this be `ids.mapNotNull(::load)`?", "--draft");
const t3 = stet("reviewer", "comment", "add", "--file", "src/main/kotlin/demo/Cache.kt", "--range", "4", "--at", "1", "--body", "Is this used from several threads? HashMap is not thread-safe.", "--draft");
const t4 = stet("reviewer", "comment", "add", "--file", "README.md", "--range", "3", "--at", "1", "--body", "Mention the cache here.", "--draft");
stet("reviewer", "review", "submit", "--body", "First pass");

write("src/main/kotlin/demo/Repository.kt", repo
  .replace("        cache.put(id, item)\n        cache.put(id, item)\n", "        cache.put(id, item)\n")
  .replace(/    fun loadAll[\s\S]*?\n    }\n/, "    fun loadAll(ids: List<String>): List<Item> = ids.mapNotNull(::load)\n"));
write("src/main/kotlin/demo/Cache.kt", "package demo\n\nimport java.util.concurrent.ConcurrentHashMap\n\nclass Cache {\n    private val map = ConcurrentHashMap<String, Item>()\n    fun get(id: String): Item? = map[id]\n    fun put(id: String, item: Item) { map[id] = item }\n}\n");
stet("agent", "reply", String(t1.id), "--intent", "fixed", "--body", "Removed the duplicate put.");
stet("agent", "reply", String(t2.id), "--intent", "fixed", "--body", "Done, loadAll is now a one-liner.");
stet("agent", "reply", String(t3.id), "--intent", "fixed", "--body", "Switched to ConcurrentHashMap; load() runs on IO threads.");
stet("agent", "reply", String(t4.id), "--intent", "question", "--body", "Should the README describe the eviction policy too? There is none yet.");
stet("agent", "version", "create", "--label", "fixes for review 1");

stet("reviewer", "resolve", String(t1.id), "--reason", "fixed");
stet("reviewer", "reply", String(t3.id), "--body", "What about the null case in get()?");
write("src/main/kotlin/demo/Cache.kt", "package demo\n\nimport java.util.concurrent.ConcurrentHashMap\n\nclass Cache {\n    private val map = ConcurrentHashMap<String, Item>()\n    fun get(id: String): Item? = map[id]\n    fun put(id: String, item: Item?) {\n        if (item == null) map.remove(id) else map[id] = item\n    }\n}\n");
stet("agent", "reply", String(t3.id), "--intent", "fixed", "--body", "put() now removes the entry for null.");
stet("agent", "version", "create", "--label", "null handling");

console.log(`demo repository: ${root}`);
console.log(`run:  cd ${root} && bun ${CLI} serve --open`);
