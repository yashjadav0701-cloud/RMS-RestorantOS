import { supabase } from "../core/supabase.js";
import { openAppModal, showToast } from "../components/navigation.js";
import {
  createPresetRange,
  renderDateRangePicker,
  bindDateRangePicker,
  DATE_RANGE_STYLES,
  dateRangeToServerPeriod
} from "../components/dateRangePicker.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatQuantity(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number)
    ? number.toLocaleString("en-IN", { maximumFractionDigits: 3 })
    : "0";
}

function normalizeRpcData(data) {
  return Array.isArray(data) ? data[0] : data;
}

function statusLabel(kind) {
  if (kind === "expected") return "Expected · not deducted";
  if (kind === "not_backfilled") return "Not backfilled";
  return "Recorded net consumption";
}

export function renderIngredientUsageDashboard(area) {
  let dateRange = createPresetRange("7");
  let activeView = "ingredients";

  const views = {
    ingredients: {
      title: "Ingredient consumption",
      description: "Actual stock deductions are separated from estimated usage that was never deducted."
    },
    dishes: {
      title: "Usage by dish",
      description: "See servings with recorded deductions, expected usage, and historical items that cannot be reconstructed."
    },
    variance: {
      title: "Stock adjustments",
      description: "Review receipts, wastage and manual stock corrections separately from recipe consumption."
    }
  };

  function render() {
    const view = views[activeView];

    area.innerHTML = `
      <style>
        ${DATE_RANGE_STYLES}
        .ingredient-usage-page { display:grid; gap:17px; }
        .ingredient-usage-controls { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
        .ingredient-usage-tabs { display:flex; gap:7px; overflow-x:auto; padding:2px 0 4px; }
        .ingredient-usage-tabs button {
          flex-shrink:0; min-height:39px; padding:0 13px; border:1px solid var(--line);
          border-radius:11px; background:var(--paper); color:var(--forest-800); font:inherit;
          font-size:12px; font-weight:750; cursor:pointer;
        }
        .ingredient-usage-tabs button.active { border-color:var(--sage-200); background:var(--sage-100); color:var(--forest-950); }
        .ingredient-usage-note {
          padding:13px 15px; border:1px solid var(--line); border-radius:12px;
          background:var(--cream-100); color:var(--muted); font-size:12px; line-height:1.65;
        }
        .ingredient-usage-setup {
          display:grid; gap:12px; padding:16px; border:1px solid var(--line);
          border-radius:15px; background:var(--paper);
        }
        .ingredient-usage-setup-head { display:flex; gap:12px; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; }
        .ingredient-usage-setup h2 { margin:0 0 5px; font-size:15px; }
        .ingredient-usage-setup p { margin:0; color:var(--muted); font-size:12px; line-height:1.6; }
        .ingredient-usage-mode {
          display:inline-flex; align-items:center; gap:7px; border:1px solid var(--line);
          border-radius:999px; padding:6px 10px; font-size:11px; font-weight:850; white-space:nowrap;
        }
        .ingredient-usage-mode::before { content:""; width:7px; height:7px; border-radius:50%; background:var(--muted); }
        .ingredient-usage-mode.is-on { background:var(--sage-100); border-color:var(--sage-200); color:var(--forest-900); }
        .ingredient-usage-mode.is-on::before { background:#168047; }
        .ingredient-usage-mode.is-off { background:var(--cream-100); }
        .ingredient-usage-setup-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
        .ingredient-usage-setup-stat { min-width:0; padding:10px 11px; border:1px solid var(--line); border-radius:11px; background:var(--cream-50); }
        .ingredient-usage-setup-stat strong { display:block; font-size:18px; color:var(--forest-950); }
        .ingredient-usage-setup-stat span { display:block; color:var(--muted); font-size:10px; line-height:1.45; }
        .ingredient-usage-blockers { margin:0; padding-left:18px; color:var(--muted); font-size:12px; line-height:1.7; }
        .ingredient-usage-setup-actions { display:flex; gap:8px; flex-wrap:wrap; }
        .ingredient-usage-action {
          min-height:38px; padding:0 13px; border:1px solid var(--forest-900); border-radius:10px;
          background:var(--forest-900); color:#fff; font:inherit; font-size:12px; font-weight:800; cursor:pointer;
        }
        .ingredient-usage-action.secondary { background:var(--paper); color:var(--forest-900); border-color:var(--line); }
        .ingredient-usage-action:disabled { opacity:.55; cursor:wait; }
        .ingredient-usage-metrics { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:11px; }
        .ingredient-usage-metric { min-width:0; padding:16px; border:1px solid var(--line); border-radius:15px; background:var(--paper); }
        .ingredient-usage-metric i {
          display:grid; place-items:center; width:36px; height:36px; margin-bottom:13px;
          border-radius:11px; background:var(--sage-100); color:var(--forest-900); font-size:19px;
        }
        .ingredient-usage-metric strong { display:block; margin-bottom:5px; font-size:22px; color:var(--forest-950); }
        .ingredient-usage-metric span { color:var(--muted); font-size:12px; line-height:1.5; }
        .ingredient-usage-panel { min-width:0; padding:19px; border:1px solid var(--line); border-radius:16px; background:var(--paper); }
        .ingredient-usage-panel h2 { margin:0 0 6px; font-size:17px; }
        .ingredient-usage-panel > p { margin:0; color:var(--muted); font-size:12px; line-height:1.6; }
        .ingredient-usage-empty {
          display:grid; justify-items:center; place-content:center; min-height:155px; margin-top:16px;
          padding:20px; border:1px dashed var(--line); border-radius:13px; text-align:center;
        }
        .ingredient-usage-empty i { color:var(--forest-700); font-size:29px; }
        .ingredient-usage-empty strong { margin-top:10px; font-size:14px; }
        .ingredient-usage-empty span { max-width:520px; margin-top:6px; color:var(--muted); font-size:12px; line-height:1.65; }
        .ingredient-usage-table-wrap { overflow-x:auto; margin-top:16px; }
        .ingredient-usage-table { width:100%; min-width:620px; border-collapse:collapse; }
        .ingredient-usage-table th,.ingredient-usage-table td { padding:11px 10px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; font-size:12px; }
        .ingredient-usage-table th { color:var(--muted); font-size:10px; font-weight:850; text-transform:uppercase; letter-spacing:.04em; }
        .ingredient-usage-row-status { display:inline-flex; padding:4px 7px; border-radius:7px; background:var(--cream-100); color:var(--forest-800); font-size:10px; font-weight:800; white-space:nowrap; }
        .ingredient-usage-row-status.expected { background:#fff7e6; color:#82520b; }
        .ingredient-usage-row-status.not_backfilled { background:#f2f0f0; color:#666; }
        .ingredient-usage-row-note { display:block; margin-top:4px; color:var(--muted); font-size:11px; line-height:1.45; }
        @media (max-width:850px) { .ingredient-usage-setup-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
        @media (max-width:650px) {
          .ingredient-usage-metrics { grid-template-columns:minmax(0,1fr); gap:9px; }
          .ingredient-usage-metric { display:flex; align-items:center; gap:12px; padding:12px; }
          .ingredient-usage-metric i { flex-shrink:0; margin:0; }
          .ingredient-usage-metric strong { margin:0 0 3px; font-size:20px; }
          .ingredient-usage-panel { padding:15px; }
          .ingredient-usage-setup-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
        }
      </style>

      <section class="section-title-row">
        <div>
          <span class="eyebrow">Inventory intelligence</span>
          <h1>Ingredient Usage</h1>
          <p>Review recorded stock deductions, expected usage and stock adjustments.</p>
        </div>
      </section>

      <section class="ingredient-usage-page">
        <div class="ingredient-usage-controls">
          <div>
            <label style="display:block;margin-bottom:7px;color:var(--muted);font-size:11px;font-weight:800;">REPORTING PERIOD</label>
            ${renderDateRangePicker("ingredient-usage", dateRange)}
          </div>
        </div>

        <div class="ingredient-usage-note">
          <i class="ph-bold ph-info"></i>
          Strict inventory deducts a verified recipe when an order item first enters Preparing. Recorded usage is reduced by any ingredients returned during an audited prepared-item cancellation.
          Expected usage is only an estimate and is never included in stock balances. Historical items without a reconstructable recipe are never backfilled.
          Receipts, wastage and stock corrections remain separate from consumption.
        </div>

        <section class="ingredient-usage-setup" data-usage-setup aria-live="polite">
          <div class="ingredient-usage-empty"><i class="ph-bold ph-spinner-gap ph-spin"></i><strong>Checking stock setup</strong><span>Validating recipes, opening stock and the current restaurant's inventory mode.</span></div>
        </section>

        <div class="ingredient-usage-metrics">
          <article class="ingredient-usage-metric"><i class="ph-bold ph-package"></i><div><strong data-usage-metric="ingredientsConsumed">—</strong><span>Ingredient types with recorded net consumption</span></div></article>
          <article class="ingredient-usage-metric"><i class="ph-bold ph-cooking-pot"></i><div><strong data-usage-metric="eligibleServings">—</strong><span>Order servings with recorded stock activity</span></div></article>
          <article class="ingredient-usage-metric"><i class="ph-bold ph-scales"></i><div><strong data-usage-metric="movementCount">—</strong><span>Recorded stock movements</span></div></article>
        </div>

        <div class="ingredient-usage-tabs" role="tablist" aria-label="Ingredient usage reports">
          ${Object.entries(views).map(([key, item]) => `
            <button type="button" data-usage-view="${key}" class="${key === activeView ? "active" : ""}"
              role="tab" aria-selected="${key === activeView}">${item.title}</button>
          `).join("")}
        </div>

        <section class="ingredient-usage-panel" role="tabpanel" aria-live="polite" data-usage-panel></section>
      </section>
    `;

    const panel = area.querySelector("[data-usage-panel]");
    panel.innerHTML = `
      <h2>${view.title}</h2><p>${view.description}</p>
      <div class="ingredient-usage-empty"><i class="ph-bold ph-spinner-gap ph-spin"></i><strong>Loading inventory report</strong><span>Reading the permanent stock ledger and order-item records.</span></div>
    `;

    async function changeInventoryMode(nextMode, access) {
      const enabling = nextMode === "strict";
      const modal = openAppModal({
        title: enabling ? "Enable strict stock deduction?" : "Disable automatic stock deduction?",
        subtitle: "This setting applies only to the currently authenticated restaurant.",
        body: enabling
          ? `<p style="margin:0;color:var(--muted);line-height:1.65;">From the next eligible Preparing transition, verified recipe quantities will be deducted from stock. Insufficient stock or an unverified recipe will block that preparation. Existing historical orders will not be backfilled.</p>`
          : `<p style="margin:0;color:var(--muted);line-height:1.65;">New order items will stop creating automatic recipe deductions. Existing ledger movements and stock balances will remain unchanged; disabling does not reverse previous deductions.</p>`,
        actions: [
          { label: "Cancel", className: "btn-quiet", onClick: ({ close }) => close() },
          {
            label: enabling ? "Enable strict mode" : "Disable strict mode",
            className: enabling ? "btn-primary" : "btn-danger",
            onClick: async ({ button, close }) => {
              button.disabled = true;
              const oldLabel = button.textContent;
              button.textContent = "Saving…";
              try {
                const { data, error } = await supabase.rpc("set_inventory_mode", {
                  p_inventory_mode: nextMode,
                  p_panel_token: access.token
                });
                if (error) throw error;
                const result = normalizeRpcData(data);
                if (!result?.ok) throw new Error("The database did not confirm the inventory-mode change.");
                close();
                showToast(enabling ? "Strict inventory enabled" : "Automatic deductions disabled", enabling
                  ? "Verified recipes will be deducted when preparation starts."
                  : "Existing stock ledger entries were preserved.", "success");
                await loadReport();
              } catch (error) {
                button.disabled = false;
                button.textContent = oldLabel;
                showToast("Could not change inventory mode", error?.message || "Please try again.", "error");
              }
            }
          }
        ]
      });
      return modal;
    }

    function renderSetup(setup, setupError, access) {
      const host = area.querySelector("[data-usage-setup]");
      if (!host) return;
      if (setupError || !setup) {
        host.innerHTML = `
          <div class="ingredient-usage-setup-head"><div><h2>Automatic stock deduction</h2><p>Setup readiness could not be checked. The usage report can still be read, but inventory mode cannot be changed from this page until the database patch is installed.</p></div><span class="ingredient-usage-mode is-off">Status unavailable</span></div>
          <p class="ingredient-usage-row-note">${escapeHtml(setupError?.message || "Missing get_inventory_setup_status RPC.")}</p>
        `;
        return;
      }
      const strict = setup.inventoryMode === "strict";
      const blockers = [];
      if (Number(setup.activeProducts || 0) === 0) blockers.push("There are no active menu products to validate.");
      if (Number(setup.productsMissingRecipe || 0) > 0) blockers.push(`${formatQuantity(setup.productsMissingRecipe)} active dishes still have no recipe.`);
      if (Number(setup.productsWithEstimatedRecipe || 0) > 0) blockers.push(`${formatQuantity(setup.productsWithEstimatedRecipe)} active dishes still contain estimated recipe quantities. Verify them in Admin → Inventory → Recipes.`);
      if (Number(setup.invalidRecipeIngredients || 0) > 0) blockers.push(`${formatQuantity(setup.invalidRecipeIngredients)} recipe rows contain missing/inactive ingredients or invalid quantities.`);
      if (Number(setup.invalidMovementUnits || 0) > 0) blockers.push(`${formatQuantity(setup.invalidMovementUnits)} stock movements use a different unit from the ingredient's current base unit. Reconcile these ledgers before enabling strict tracking.`);
      if (Number(setup.invalidMovementQuantities || 0) > 0) blockers.push(`${formatQuantity(setup.invalidMovementQuantities)} ledger movements have zero or non-finite quantities. Investigate these rows before enabling strict tracking.`);
      if (Number(setup.invalidStockBalances || 0) > 0) blockers.push(`${formatQuantity(setup.invalidStockBalances)} recipe ingredient balances are negative or invalid. Reconcile those ledgers before enabling strict tracking.`);
      if (Number(setup.invalidOpeningStockEntries || 0) > 0) blockers.push(`${formatQuantity(setup.invalidOpeningStockEntries)} recipe ingredients have duplicate, zero, negative or invalid opening-stock entries. Reconcile each opening balance before enabling strict tracking.`);
      if (Number(setup.recipeIngredientsMissingOpeningStock || 0) > 0) blockers.push(`${formatQuantity(setup.recipeIngredientsMissingOpeningStock)} recipe ingredients need opening stock before strict tracking can start.`);
      if (!strict && Number(setup.activeOrderItems || 0) > 0) blockers.push(`${formatQuantity(setup.activeOrderItems)} active order items must be completed or reconciled before enabling strict tracking.`);

      const readiness = strict
        ? "Strict mode is active. Each first Preparing transition validates the saved recipe and available stock; invalid or understocked items are rejected."
        : setup.canEnableStrict
          ? "All validation checks passed. You can enable automatic deductions when the kitchen is ready to use the recorded stock balances."
          : "Automatic deductions are OFF. Strict mode is locked until every listed requirement is resolved; this prevents estimated recipes or missing opening stock from corrupting balances.";

      host.innerHTML = `
        <div class="ingredient-usage-setup-head">
          <div><h2>Automatic stock deduction</h2><p>${readiness}</p></div>
          <span class="ingredient-usage-mode ${strict ? "is-on" : "is-off"}">${strict ? "Strict mode ON" : "Automatic deduction OFF"}</span>
        </div>
        <div class="ingredient-usage-setup-grid">
          <div class="ingredient-usage-setup-stat"><strong>${formatQuantity(setup.activeProducts)}</strong><span>Active menu dishes</span></div>
          <div class="ingredient-usage-setup-stat"><strong>${formatQuantity(setup.productsMissingRecipe)}</strong><span>Dishes without recipes</span></div>
          <div class="ingredient-usage-setup-stat"><strong>${formatQuantity(setup.productsWithEstimatedRecipe)}</strong><span>Dishes with estimated recipes</span></div>
          <div class="ingredient-usage-setup-stat"><strong>${formatQuantity(setup.recipeIngredientsMissingOpeningStock)}</strong><span>Recipe ingredients missing opening stock</span></div>
        </div>
        ${blockers.length ? `<ul class="ingredient-usage-blockers">${blockers.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : strict ? `<p class="ingredient-usage-row-note">Do not edit stock balances outside the Inventory ledger. Turning strict mode off will not reverse historical deductions.</p>` : `<p class="ingredient-usage-row-note">No setup blockers detected.</p>`}
        <div class="ingredient-usage-setup-actions">
          ${strict
            ? `<button type="button" class="ingredient-usage-action secondary" data-change-inventory-mode="disabled">Disable automatic deductions</button>`
            : setup.canEnableStrict
              ? `<button type="button" class="ingredient-usage-action" data-change-inventory-mode="strict">Enable strict stock deduction</button>`
              : `<button type="button" class="ingredient-usage-action" disabled title="Resolve all setup blockers first">Strict mode locked until setup is complete</button>`}
        </div>
      `;

      host.querySelector("[data-change-inventory-mode]")?.addEventListener("click", event => {
        const nextMode = event.currentTarget.dataset.changeInventoryMode;
        if (!access?.token || !["strict", "disabled"].includes(nextMode)) return;
        void changeInventoryMode(nextMode, access);
      });
    }

    function renderRows(report) {
      let headers = [];
      let rows = [];
      if (activeView === "ingredients") {
        headers = ["Ingredient", "Quantity", "Unit", "Record status"];
        rows = (report.ingredients || []).map(item => ({
          cells: [item.ingredient, formatQuantity(item.quantity), item.unit, statusLabel(item.kind)],
          kind: item.kind || "recorded",
          note: item.note || (item.recipeEstimate ? "Recipe quantities are provisional; no stock was deducted." : "")
        }));
      } else if (activeView === "dishes") {
        headers = ["Dish", "Servings", "Record status"];
        rows = (report.dishes || []).map(item => ({
          cells: [item.dish, formatQuantity(item.servings), statusLabel(item.kind)],
          kind: item.kind || "recorded",
          note: item.kind === "expected" ? "Calculated from recipe rows; this is not a stock deduction." : item.kind === "not_backfilled" ? "No reliable recipe snapshot was available for this historical item." : ""
        }));
      } else {
        headers = ["Ingredient", "Movement", "Quantity change", "Reason", "Recorded at"];
        rows = (report.adjustments || []).map(item => ({
          cells: [item.ingredient, item.movement_type, `${formatQuantity(item.quantity_delta)} ${item.unit}`, item.reason, item.created_at ? new Date(item.created_at).toLocaleString("en-IN") : "—"],
          kind: "recorded",
          note: ""
        }));
      }

      const emptyText = activeView === "ingredients"
        ? "There are no recorded or expected ingredient rows for this period. Stock is only deducted when strict mode is ON and a verified recipe successfully passes the stock checks."
        : activeView === "dishes"
          ? "There are no served dish items with recorded deductions or reconstructable expected usage in this period."
          : "Stock receipts, wastage and corrections will appear here after they are recorded.";

      panel.innerHTML = `
        <h2>${view.title}</h2><p>${view.description}</p>
        ${rows.length ? `
          <div class="ingredient-usage-table-wrap"><table class="data-table ingredient-usage-table">
            <thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
            <tbody>${rows.map(row => `<tr>${row.cells.map((cell, index) => {
              if (index === headers.length - 1 && activeView !== "variance") {
                const cls = row.kind === "expected" ? "expected" : row.kind === "not_backfilled" ? "not_backfilled" : "";
                return `<td><span class="ingredient-usage-row-status ${cls}">${escapeHtml(cell)}</span>${row.note ? `<span class="ingredient-usage-row-note">${escapeHtml(row.note)}</span>` : ""}</td>`;
              }
              return `<td>${escapeHtml(cell)}${index === 0 && row.note && activeView === "variance" ? `<span class="ingredient-usage-row-note">${escapeHtml(row.note)}</span>` : ""}</td>`;
            }).join("")}</tr>`).join("")}</tbody>
          </table></div>
        ` : `<div class="ingredient-usage-empty"><i class="ph-bold ph-chart-bar"></i><strong>No records for this period</strong><span>${emptyText}</span></div>`}
      `;
    }

    async function loadReport() {
      const access = window.__RMS_PANEL_ACCESS__;
      if (access?.panelId !== "admin" || !access.token || !Number.isFinite(access.expiresAt) || access.expiresAt <= Date.now()) {
        panel.innerHTML = `<div class="ingredient-usage-empty"><i class="ph-bold ph-lock-key"></i><strong>Admin access expired</strong><span>Return to the Admin panel and verify its PIN again.</span></div>`;
        return;
      }
      let reportResponse;
      let setupResponse;
      try {
        [reportResponse, setupResponse] = await Promise.all([
          supabase.rpc("get_inventory_usage_report", {
            p_panel_token: access.token,
            p_period: dateRangeToServerPeriod(dateRange)
          }),
          supabase.rpc("get_inventory_setup_status", { p_panel_token: access.token })
        ]);
      } catch (error) {
        console.error("Inventory usage RPC request failed:", error);
        panel.innerHTML = `<div class="ingredient-usage-empty"><i class="ph-bold ph-warning-circle"></i><strong>Usage report unavailable</strong><span>${escapeHtml(error?.message || "The server could not be reached.")}</span></div>`;
        renderSetup(null, error, access);
        showToast("Inventory report unavailable", error?.message || "Please refresh and try again.", "error");
        return;
      }

      const reportError = reportResponse?.error;
      if (reportError) {
        console.error("Inventory usage report failed:", reportError);
        panel.innerHTML = `<div class="ingredient-usage-empty"><i class="ph-bold ph-warning-circle"></i><strong>Usage report unavailable</strong><span>${escapeHtml(reportError.message || "Please refresh and try again.")}</span></div>`;
        showToast("Inventory report unavailable", reportError.message || "Please try again.", "error");
        renderSetup(null, setupResponse?.error || new Error("Inventory setup status could not be read."), access);
        return;
      }

      const report = normalizeRpcData(reportResponse.data);
      if (!report?.ok) {
        panel.innerHTML = `<div class="ingredient-usage-empty"><i class="ph-bold ph-warning-circle"></i><strong>Invalid inventory report</strong><span>The database returned an unexpected report payload.</span></div>`;
        const failedReportSetupPayload = setupResponse?.error ? null : normalizeRpcData(setupResponse?.data);
        renderSetup(failedReportSetupPayload?.setup || failedReportSetupPayload, setupResponse?.error, access);
        return;
      }

      const setupPayload = setupResponse?.error ? null : normalizeRpcData(setupResponse?.data);
      const setup = setupPayload?.setup || setupPayload;
      renderSetup(setupPayload?.ok === false ? null : setup, setupResponse?.error || (!setup ? new Error("The setup status RPC returned no data.") : null), access);

      const metrics = report.metrics || {};
      area.querySelector('[data-usage-metric="ingredientsConsumed"]')?.replaceChildren(document.createTextNode(formatQuantity(metrics.ingredientsConsumed)));
      area.querySelector('[data-usage-metric="eligibleServings"]')?.replaceChildren(document.createTextNode(formatQuantity(metrics.eligibleServings)));
      area.querySelector('[data-usage-metric="movementCount"]')?.replaceChildren(document.createTextNode(formatQuantity(metrics.movementCount)));
      renderRows(report);
    }

    void loadReport();

    area.querySelectorAll("[data-usage-view]").forEach(button => {
      button.addEventListener("click", () => {
        activeView = button.dataset.usageView;
        render();
      });
    });

    bindDateRangePicker(area, "ingredient-usage", dateRange, nextRange => {
      dateRange = nextRange;
      render();
    });
  }

  render();
}
