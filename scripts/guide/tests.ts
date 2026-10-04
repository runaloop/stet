import { Demo, withBrowser } from "./lib.ts";

const MAIN = "app/src/main/java/shop";
const TEST = "app/src/test/java/shop";

const cart = (extra = "") => `package shop

class Cart(private val prices: Prices) {
    private val items = mutableListOf<Item>()

    fun add(item: Item) {
        items += item
    }

    fun total(): Money = items.fold(Money.ZERO) { sum, item -> sum + prices.of(item) }
${extra}}
`;
const cartTest = (extra = "") => `package shop

class CartTest {
    @Test
    fun emptyCartCostsNothing() {
        assertEquals(Money.ZERO, Cart(FakePrices()).total())
    }
${extra}}
`;
const priceTest = (expected: string) => `package shop

class PriceTest {
    @Test
    fun roundsToCents() {
        assertEquals(${expected}, Price(10.005).rounded())
    }

    @Test
    fun keepsCurrency() {
        assertEquals("EUR", Price(1.0, "EUR").currency)
    }
}
`;
const discountTest = (ignored: boolean) => `package shop

class DiscountTest {
${ignored ? "    @Ignore(\"flaky on CI\")\n" : ""}    @Test
    fun tenPercentOff() {
        assertEquals(Money(90), Discount(10).apply(Money(100)))
    }
}
`;

export async function tests() {
  const demo = new Demo();
  try {
    demo.write(`${MAIN}/Cart.kt`, cart());
    demo.write(`${TEST}/CartTest.kt`, cartTest());
    demo.write(`${TEST}/PriceTest.kt`, priceTest("Money(10.01)"));
    demo.write(`${TEST}/DiscountTest.kt`, discountTest(false));
    demo.write(`${TEST}/LegacyCartTest.kt`, "package shop\n\nclass LegacyCartTest {\n    @Test\n    fun oldTotal() = assertEquals(0, LegacyCart().total())\n}\n");
    demo.commitBase();
    demo.write(`${MAIN}/Cart.kt`, cart("\n    fun remove(item: Item) {\n        items -= item\n    }\n"));
    demo.write(`${MAIN}/Checkout.kt`, "package shop\n\nclass Checkout(private val cart: Cart) {\n    fun pay(card: Card): Receipt = card.charge(cart.total())\n}\n");
    demo.write(`${TEST}/CartTest.kt`, cartTest("\n    @Test\n    fun removedItemIsNotCounted() {\n        val cart = Cart(FakePrices())\n        cart.add(apple)\n        cart.remove(apple)\n        assertEquals(Money.ZERO, cart.total())\n    }\n"));
    demo.write(`${TEST}/CheckoutTest.kt`, "package shop\n\nclass CheckoutTest {\n    @Test\n    fun paysTheTotal() {\n        val card = FakeCard()\n        Checkout(cartWith(apple)).pay(card)\n        assertEquals(apple.price, card.charged)\n    }\n}\n");
    demo.write(`${TEST}/PriceTest.kt`, priceTest("Money(10.0)"));
    demo.write(`${TEST}/DiscountTest.kt`, discountTest(true));
    demo.remove(`${TEST}/LegacyCartTest.kt`);
    demo.stet("version", "create", "--label", "cart: remove items, checkout");

    await withBrowser(demo, async (p) => {
      await p.go("#/compare/base..1");
      await p.waitFor(`document.querySelectorAll(".file-list .file-row").length >= 7`, 15000);
      await p.sleep(1500);
      await p.eval(`[...document.querySelectorAll(".side-tabs button")].find(b => b.textContent === "Files").click(); true`);
      await p.sleep(500);
      const fold = await p.need(".fold-summary .fold-tests");
      const kept = await p.need(".fold-summary .kept");
      const section = await p.need(".file-list section h4", "Tests with only new code");
      const ignore = await p.need(".file-meta .kept", "@Ignore");
      await p.shot("tests-1.png", [
        { html: "① Tests that only add code are folded: nothing removed or changed, no @Ignore. Click to show them, or <b style=\"white-space:nowrap\">Space u t</b>", at: { x: fold.x - 20, y: fold.y + 175 }, to: { x: fold.x + fold.w / 2, y: fold.y + fold.h + 4 }, ring: fold, w: 380 },
        { html: "Tests that remove or change lines, add a skip marker or get deleted never fold: that is how a test gets weakened", at: { x: kept.x + 170, y: kept.y + 175 }, to: { x: kept.x + kept.w / 2, y: kept.y + kept.h + 4 }, ring: kept, w: 400 },
        { html: "The folded tests are listed here. A click on one opens the group and jumps to that file", at: { x: section.x + 30, y: section.y + 110 }, to: { x: section.x + 90, y: section.y + section.h + 50 }, ring: { x: section.x, y: section.y, w: 560, h: 60 }, w: 420 },
        { html: "⚠ says why a test stays: here it adds @Ignore. The same ⚠ is in the file list", at: { x: ignore.x - 420, y: ignore.y - 130 }, to: { x: ignore.x + ignore.w / 2, y: ignore.y - 4 }, ring: ignore, w: 360 },
      ]);

      await p.click(fold);
      await p.waitFor(`document.querySelector(".fold-footer")?.textContent.includes("hide 2 test files")`);
      await p.sleep(1500);
      const hide = await p.need(".fold-summary .fold-tests");
      const footer = await p.need(".fold-footer .btn");
      await p.shot("tests-2.png", [
        { html: "② Shown now, at the end of the diff. Click again, or <b style=\"white-space:nowrap\">Space u t</b>, to fold them", at: { x: hide.x + 220, y: hide.y + 45 }, to: { x: hide.x + hide.w / 2, y: hide.y + hide.h + 4 }, ring: hide, w: 460 },
        { html: "The same switch sits at the end of the diff", at: { x: footer.x + 560, y: footer.y - 150 }, to: { x: footer.x + footer.w + 4, y: footer.y + footer.h / 2 }, ring: footer, w: 300 },
      ]);
    });
  } finally {
    demo.dispose();
  }
}
