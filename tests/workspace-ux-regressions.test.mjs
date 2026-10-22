import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createPresetRange,
  dateRangeLabel,
  dateRangeToServerPeriod,
  normalizeDateRange
} from "../src/components/dateRangePicker.js";

const base = new URL("../", import.meta.url);
async function source(path) {
  return readFile(new URL(path, base), "utf8");
}

test("Captain workspace URL is mapped to its actual module", async () => {
  const router = await source("src/core/router.js");
  assert.match(router, /if\s*\(route\.name\s*===\s*"captain"\)\s*\{\s*return import\("\.\.\/captain\/index\.js"\)/s);
});

test("Cashier POS cannot offer a second order-type selector", async () => {
  const pos = await source("src/pos/index.js");
  assert.match(pos, /\$\{isCashierPanel\s*\?\s*""\s*:/);
  assert.match(pos, /if\s*\(isCashierPanel\s*&&\s*nextType\s*!==\s*"takeaway"\)/);
});

test("every operational panel has a sign-out action and panel-only sign-out semantics", async () => {
  const session = await source("src/core/panelSession.js");
  assert.match(session, /window\.__RMS_PANEL_ACCESS__\s*=\s*null/);
  assert.match(session, /requestPanelSignOut/);
  for (const path of ["src/pos/index.js", "src/kot/index.js", "src/cashier/index.js", "src/manager/index.js", "src/admin/index.js"]) {
    assert.match(await source(path), /SignOut|signOut|requestPanelSignOut|installPanelSignOut/);
  }
  const admin = await source("src/admin/index.js");
  assert.match(admin, /admin-logout[\s\S]{0,220}requestPanelSignOut/);
});

test("back navigation prompts before leaving an active PIN-protected workspace", async () => {
  const router = await source("src/core/router.js");
  assert.match(router, /function guardLeavingPanel\(/);
  assert.match(router, /You are leaving the current workspace/);
  assert.match(router, /lastGrantedWorkspaceUrl/);
});

test("shared date range presets create valid local inclusive date ranges", () => {
  const now = new Date(2026, 9, 19, 12, 0, 0);
  assert.deepEqual(createPresetRange("today", now), {
    preset: "today", startDate: "2026-10-19", endDate: "2026-10-19"
  });
  assert.deepEqual(createPresetRange("yesterday", now), {
    preset: "yesterday", startDate: "2026-10-18", endDate: "2026-10-18"
  });
  assert.deepEqual(createPresetRange("7", now), {
    preset: "7", startDate: "2026-10-13", endDate: "2026-10-19"
  });
  assert.deepEqual(createPresetRange("month", now), {
    preset: "month", startDate: "2026-10-01", endDate: "2026-10-19"
  });
  assert.deepEqual(createPresetRange("all", now), {
    preset: "all", startDate: "", endDate: ""
  });
});

test("date range payloads are suitable for the inventory RPC and invalid ranges reset safely", () => {
  const custom = normalizeDateRange({ preset: "custom", startDate: "2026-10-01", endDate: "2026-10-19" });
  assert.equal(dateRangeToServerPeriod(custom), "range:2026-10-01:2026-10-19");
  assert.equal(dateRangeToServerPeriod(createPresetRange("all")), "all");
  assert.deepEqual(normalizeDateRange({ preset: "custom", startDate: "2026-10-19", endDate: "2026-10-01" }), createPresetRange("today"));
  assert.equal(dateRangeLabel(createPresetRange("all")), "All time");
});

test("all four Admin reporting areas use the shared date-range control", async () => {
  for (const path of ["src/admin/index.js", "src/admin/topProducts.js", "src/admin/ingredientUsage.js", "src/admin/auditDashboard.js"]) {
    const text = await source(path);
    assert.match(text, /renderDateRangePicker\(/, `${path} must render the shared picker`);
    assert.match(text, /bindDateRangePicker\(/, `${path} must bind the shared picker`);
  }
});

test("inventory report migration handles custom ranges and applies date bounds to report data", async () => {
  const sql = await source("sql/MASTER_MIGRATION_TABLEFORGE.sql");
  assert.match(sql, /p_period LIKE 'range:%'/);
  assert.match(sql, /m\.created_at < v_until/);
  const patch = await source("sql/DATE_RANGE_REPORT_PATCH.sql");
  assert.match(patch, /CREATE OR REPLACE FUNCTION public\.get_inventory_usage_report/);
  assert.match(patch, /GRANT EXECUTE ON FUNCTION public\.get_inventory_usage_report\(text,text\) TO authenticated/);
});


test("menu opens directly with All cuisine and All category instead of a cuisine landing page", async () => {
  const pos = await source("src/pos/index.js");
  assert.match(pos, /let activeCuisine = null/);
  assert.match(pos, /let activeSubCategory = "All"/);
  assert.match(pos, /data-mega-cuisine="All"/);
  assert.match(pos, /activeCuisine\s*&&\s*pCuisine\s*!==\s*activeCuisine/);
  assert.doesNotMatch(pos, /Choose a Cuisine/);
});
