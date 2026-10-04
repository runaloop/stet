import { Demo, withBrowser } from "./lib.ts";

const APP = "app/src/main";
const TEST = "app/src/test/java/shop";

export async function orderGuide() {
  const demo = new Demo();
  try {
    demo.write("README.md", "# Shop\n");
    demo.write("docs/pricing.md", "# Pricing\n\nPrices come from the pricing service.\n");
    demo.write("app/build.gradle.kts", 'plugins {\n    id("com.android.application")\n}\n\ndependencies {\n    implementation(libs.okhttp)\n}\n');
    demo.write("gradle/libs.versions.toml", '[versions]\nokhttp = "4.12.0"\n\n[libraries]\nokhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }\n');
    demo.write(`${APP}/AndroidManifest.xml`, '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <application android:label="@string/app_name" />\n</manifest>\n');
    demo.write(`${APP}/res/values/strings.xml`, '<resources>\n    <string name="app_name">Shop</string>\n</resources>\n');
    demo.write(`${APP}/java/shop/Cart.kt`, "package shop\n\nclass Cart {\n    val items = mutableListOf<Item>()\n}\n");
    demo.write(`${TEST}/CartTest.kt`, "package shop\n\nclass CartTest {\n    @Test\n    fun emptyCart() = assertEquals(0, Cart().items.size)\n}\n");
    demo.commitBase();
    demo.write("README.md", "# Shop\n\nRun `./gradlew installDebug`.\n");
    demo.write("docs/pricing.md", "# Pricing\n\nPrices come from the pricing service and are cached for ten minutes.\n");
    demo.write("app/build.gradle.kts", 'plugins {\n    id("com.android.application")\n}\n\ndependencies {\n    implementation(libs.okhttp)\n    implementation(libs.work)\n}\n');
    demo.write("gradle/libs.versions.toml", '[versions]\nokhttp = "4.12.0"\nwork = "2.10.0"\n\n[libraries]\nokhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }\nwork = { module = "androidx.work:work-runtime-ktx", version.ref = "work" }\n');
    demo.write(`${APP}/res/values/strings.xml`, '<resources>\n    <string name="app_name">Shop</string>\n    <string name="price_stale">Price may have changed</string>\n</resources>\n');
    demo.write(`${APP}/java/shop/Cart.kt`, "package shop\n\nclass Cart(private val cache: PriceCache) {\n    val items = mutableListOf<Item>()\n\n    fun total(): Money = items.sumOf { cache.price(it.sku) }\n}\n");
    demo.write(`${APP}/java/shop/PriceCache.kt`, "package shop\n\nclass PriceCache(private val api: PriceApi) {\n    fun price(sku: Sku): Money = api.fetch(sku)\n}\n");
    demo.write(`${APP}/java/shop/sync/PriceSync.kt`, "package shop.sync\n\nclass PriceSync(private val cache: PriceCache) : CoroutineWorker() {\n    override suspend fun doWork() = Result.success()\n}\n");
    demo.write(`${TEST}/CartTest.kt`, "package shop\n\nclass CartTest {\n    @Test\n    fun emptyCart() = assertEquals(0, Cart(FakeCache()).items.size)\n}\n");
    demo.write(`${TEST}/PriceCacheTest.kt`, "package shop\n\nclass PriceCacheTest {\n    @Test\n    fun fetchesOnce() = assertEquals(1, FakeApi().also { PriceCache(it).price(apple) }.calls)\n}\n");
    demo.stet("version", "create", "--label", "price cache");

    await withBrowser(demo, async (p) => {
      await p.go("#/compare/base..1");
      await p.waitFor(`document.querySelectorAll(".file-list .file-row").length >= 10`, 15000);
      await p.eval(`[...document.querySelectorAll(".side-tabs button")].find(b => b.textContent === "Files").click(); true`);
      await p.sleep(1500);
      const code = await p.need(".file-list section h4", "Code");
      const config = await p.need(".file-list section h4", "Resources, build and config");
      const tests = await p.need(".file-list section h4", "Changed tests");
      const docs = await p.need(".file-list section h4", "Docs");
      const tag = await p.need(".file-meta .section-tag");
      await p.shot("order-1.png", [
        { html: "Code first, in path order, so a module's files stay together", at: { x: code.x + 250, y: code.y - 10 }, to: { x: code.x + 90, y: code.y + code.h / 2 }, ring: { x: code.x, y: code.y, w: 120, h: code.h }, w: 260 },
        { html: "Then resources, build and config: JSON, YAML, TOML, properties, Android XML and res/, Gradle", at: { x: config.x + 300, y: config.y - 40 }, to: { x: config.x + 240, y: config.y + config.h / 2 }, ring: { x: config.x, y: config.y, w: 250, h: config.h }, w: 300 },
        { html: "Tests that change or remove lines (⚠), then docs. Tests that only add code are folded at the very end", at: { x: tests.x + 300, y: tests.y + 10 }, to: { x: tests.x + 160, y: tests.y + tests.h / 2 }, ring: { x: docs.x, y: tests.y, w: 170, h: docs.y + docs.h - tests.y }, w: 300 },
        { html: "The diff has the same order; the first file of each group says so", at: { x: tag.x - 520, y: tag.y + 80 }, to: { x: tag.x + tag.w / 2, y: tag.y + tag.h + 4 }, ring: tag, w: 360 },
      ]);
    });
  } finally {
    demo.dispose();
  }
}
