import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const base = new URL("../", import.meta.url);
async function source(path) {
  return readFile(new URL(path, base), "utf8");
}

test("shared receipt uses the square restaurant icon rather than the landscape wordmark", async () => {
  const navigation = await source("src/components/navigation.js");
  const css = await source("styles.css");
  assert.match(navigation, /const iconUrl = tenant\.icon_url \? versionedAsset\(tenant\.icon_url\) : ""/);
  assert.match(navigation, /class="thermal-brand-icon" src="' \+ iconUrl/);
  assert.doesNotMatch(navigation, /receiptLogoUrl|tenant\.logo_url \? versionedAsset\(tenant\.logo_url\)/);
  assert.match(css, /\.thermal-head img\.thermal-brand-icon/);
});

test("shared receipt renders a distinctive Four Flavours title and preserves the UPI QR on paid bill copies", async () => {
  const navigation = await source("src/components/navigation.js");
  const css = await source("styles.css");
  const html = await source("index.html");
  assert.match(navigation, /class="thermal-brand-title"/);
  assert.match(navigation, /settings\.restaurant_name \|\| tenant\.name \|\| "Four Flavours"/);
  assert.match(navigation, /settings\.upi_id && normalizedPaymentMethod === "upi_qr"/);
  assert.doesNotMatch(navigation, /paymentStatus !== "paid"/);
  assert.match(navigation, /logoImg\.src = iconUrl/);
  assert.match(navigation, /logoImg\.style\.cssText[\s\S]*?object-fit: contain/);
  assert.match(css, /font-family: "Bebas Neue", "Arial Narrow", Impact, sans-serif/);
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Bebas\+Neue/);
});

test("Captain cuisine and category pills use clear labels instead of a bare All", async () => {
  const pos = await source("src/pos/index.js");
  assert.match(pos, /activeCuisine \|\| "Cuisines"/);
  assert.match(pos, /activeSubCategory === "All" \? "Categories" : activeSubCategory/);
  assert.match(pos, /sub === "All" \? "All categories" : sub/);
});

test("All cuisines option displays a four-tile collage from cuisine image URLs", async () => {
  const pos = await source("src/pos/index.js");
  const css = await source("styles.css");
  assert.match(pos, /const allCuisineImages = cuisines[\s\S]{0,120}\.slice\(0, 4\)/);
  assert.match(pos, /class="mini-cuisine-bg all-cuisines-collage"/);
  assert.match(pos, /class="all-cuisine-tile"/);
  assert.match(css, /\.all-cuisines-collage\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});
