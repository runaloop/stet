import { mkdirSync } from "node:fs";
import { checkClaim } from "./check-claim.ts";
import { commitsGuide } from "./commits.ts";
import { imagesGuide } from "./images.ts";
import { liveGuide } from "./live.ts";
import { markdownGuide } from "./markdown.ts";
import { conversationGuide } from "./conversation.ts";
import { OUT } from "./lib.ts";
import { navigationGuide } from "./navigation.ts";
import { orderGuide } from "./order.ts";
import { tests } from "./tests.ts";
import { versionsGuide } from "./versions.ts";
import { viewedGuide } from "./viewed.ts";

const guides: Record<string, () => Promise<void>> = { "check-claim": checkClaim, tests, commits: commitsGuide, conversation: conversationGuide, order: orderGuide, navigation: navigationGuide, versions: versionsGuide, images: imagesGuide, markdown: markdownGuide, live: liveGuide, viewed: viewedGuide };
const wanted = process.argv.slice(2);
for (const name of wanted) if (!guides[name]) throw new Error(`unknown guide ${name}; known: ${Object.keys(guides).join(", ")}`);

mkdirSync(OUT, { recursive: true });
for (const [name, shoot] of Object.entries(guides)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const t = performance.now();
  await shoot();
  console.log(`${name}: ${((performance.now() - t) / 1000).toFixed(1)}s`);
}
