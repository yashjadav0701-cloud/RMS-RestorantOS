import { supabase } from "../core/supabase.js";
import { showToast } from "../components/navigation.js";
import { createPresetRange, renderDateRangePicker, bindDateRangePicker, DATE_RANGE_STYLES, dateRangeToServerPeriod } from "../components/dateRangePicker.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


export function renderIngredientUsageDashboard(area) {
  let dateRange = createPresetRange("7");
  let activeView = "ingredients";

  const views = {
    ingredients: {
      title: "Ingredient consumption",
      description: "Review how much of each ingredient was expected to be consumed."
    },
    dishes: {
      title: "Usage by dish",
      description: "See how each menu item contributes to ingredient consumption."
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
        .ingredient-usage-page {
          display: grid;
          gap: 17px;
        }

        .ingredient-usage-controls {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }

        .ingredient-usage-tabs {
          display: flex;
          gap: 7px;
          overflow-x: auto;
          padding: 2px 0 4px;
        }

        .ingredient-usage-tabs button {
          flex-shrink: 0;
          min-height: 39px;
          padding: 0 13px;
          border: 1px solid var(--line);
          border-radius: 11px;
          background: var(--paper);
          color: var(--forest-800);
          font: inherit;
          font-size: 12px;
          font-weight: 750;
          cursor: pointer;
        }

        .ingredient-usage-tabs button.active {
          border-color: var(--sage-200);
          background: var(--sage-100);
          color: var(--forest-950);
        }

        .ingredient-usage-period {
          min-height: 39px;
          max-width: 100%;
          padding: 0 11px;
          border: 1px solid var(--line);
          border-radius: 11px;
          background: var(--paper);
          color: var(--forest-900);
          font: inherit;
          font-size: 12px;
          font-weight: 700;
        }

        .ingredient-usage-note {
          padding: 13px 15px;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: var(--cream-100);
          color: var(--muted);
          font-size: 12px;
          line-height: 1.65;
        }

        .ingredient-usage-metrics {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 11px;
        }

        .ingredient-usage-metric {
          min-width: 0;
          padding: 16px;
          border: 1px solid var(--line);
          border-radius: 15px;
          background: var(--paper);
        }

        .ingredient-usage-metric i {
          display: grid;
          place-items: center;
          width: 36px;
          height: 36px;
          margin-bottom: 13px;
          border-radius: 11px;
          background: var(--sage-100);
          color: var(--forest-900);
          font-size: 19px;
        }

        .ingredient-usage-metric strong {
          display: block;
          margin-bottom: 5px;
          font-size: 22px;
          color: var(--forest-950);
        }

        .ingredient-usage-metric span {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.5;
        }

        .ingredient-usage-panel {
          min-width: 0;
          padding: 19px;
          border: 1px solid var(--line);
          border-radius: 16px;
          background: var(--paper);
        }

        .ingredient-usage-panel h2 {
          margin: 0 0 6px;
          font-size: 17px;
        }

        .ingredient-usage-panel > p {
          margin: 0;
          color: var(--muted);
          font-size: 12px;
          line-height: 1.6;
        }

        .ingredient-usage-empty {
          display: grid;
          justify-items: center;
          place-content: center;
          min-height: 155px;
          margin-top: 16px;
          padding: 20px;
          border: 1px dashed var(--line);
          border-radius: 13px;
          text-align: center;
        }

        .ingredient-usage-empty i {
          color: var(--forest-700);
          font-size: 29px;
        }

        .ingredient-usage-empty strong {
          margin-top: 10px;
          font-size: 14px;
        }

        .ingredient-usage-empty span {
          max-width: 420px;
          margin-top: 6px;
          color: var(--muted);
          font-size: 12px;
          line-height: 1.65;
        }

        @media (max-width: 650px) {
          .ingredient-usage-metrics {
            grid-template-columns: minmax(0, 1fr);
            gap: 9px;
          }

          .ingredient-usage-metric {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px;
          }

          .ingredient-usage-metric i {
            flex-shrink: 0;
            margin: 0;
          }

          .ingredient-usage-metric strong {
            margin: 0 0 3px;
            font-size: 20px;
          }

          .ingredient-usage-panel {
            padding: 15px;
          }
        }
      </style>

      <section class="section-title-row">
        <div>
          <span class="eyebrow">Inventory intelligence</span>
          <h1>Ingredient Usage</h1>
          <p>Understand ingredient demand and recipe consumption.</p>
        </div>
      </section>

      <section class="ingredient-usage-page">
        <div class="ingredient-usage-controls">
          <div>
            <label
              style="display:block;margin-bottom:7px;color:var(--muted);font-size:11px;font-weight:800;"
            >
              REPORTING PERIOD
            </label>

            ${renderDateRangePicker("ingredient-usage", dateRange)}
          </div>
        </div>

        <div class="ingredient-usage-note">
          <i class="ph-bold ph-info"></i>
          Recipe-based consumption is recorded when an order item first reaches
          Served. Historical sales from before a recipe was saved are not backfilled.
          Stock adjustments and wastage are shown separately from recipe consumption.
        </div>

        <div class="ingredient-usage-metrics">
          <article class="ingredient-usage-metric">
            <i class="ph-bold ph-package"></i>
            <div>
              <strong data-usage-metric="ingredientsConsumed">—</strong>
              <span>Ingredients consumed</span>
            </div>
          </article>

          <article class="ingredient-usage-metric">
            <i class="ph-bold ph-cooking-pot"></i>
            <div>
              <strong data-usage-metric="eligibleServings">—</strong>
              <span>Eligible prepared servings</span>
            </div>
          </article>

          <article class="ingredient-usage-metric">
            <i class="ph-bold ph-scales"></i>
            <div>
              <strong data-usage-metric="movementCount">—</strong>
              <span>Recorded stock movements</span>
            </div>
          </article>
        </div>

        <div class="ingredient-usage-tabs" role="tablist" aria-label="Ingredient usage reports">
          ${Object.entries(views).map(([key, item]) => `
            <button
              type="button"
              data-usage-view="${key}"
              class="${key === activeView ? "active" : ""}"
              role="tab"
              aria-selected="${key === activeView}"
            >
              ${item.title}
            </button>
          `).join("")}
        </div>

        <section
          class="ingredient-usage-panel"
          role="tabpanel"
          aria-live="polite"
          data-usage-panel
        ></section>
      </section>
    `;

    const panel = area.querySelector("[data-usage-panel]");

    panel.innerHTML = `
      <h2>${view.title}</h2>
      <p>${view.description}</p>
      <div class="ingredient-usage-empty">
        <i class="ph-bold ph-spinner-gap ph-spin"></i>
        <strong>Loading verified inventory data</strong>
        <span>Reading saved recipes and recorded stock movements from this restaurant.</span>
      </div>
    `;

    async function loadReport() {
      const access = window.__RMS_PANEL_ACCESS__;
      if (access?.panelId !== "admin" || !access.token || !Number.isFinite(access.expiresAt) || access.expiresAt <= Date.now()) {
        panel.innerHTML = `<div class="ingredient-usage-empty"><i class="ph-bold ph-lock-key"></i><strong>Admin access expired</strong><span>Return to the Admin panel and verify its PIN again.</span></div>`;
        return;
      }
      try {
        const { data, error } = await supabase.rpc("get_inventory_usage_report", {
          p_panel_token: access.token,
          p_period: dateRangeToServerPeriod(dateRange)
        });
        if (error) throw error;
        const report = Array.isArray(data) ? data[0] : data;
        if (!report?.ok) throw new Error("The server did not return a valid usage report.");
        const metrics = report.metrics || {};
        area.querySelector('[data-usage-metric="ingredientsConsumed"]')?.replaceChildren(document.createTextNode(String(metrics.ingredientsConsumed ?? 0)));
        area.querySelector('[data-usage-metric="eligibleServings"]')?.replaceChildren(document.createTextNode(String(metrics.eligibleServings ?? 0)));
        area.querySelector('[data-usage-metric="movementCount"]')?.replaceChildren(document.createTextNode(String(metrics.movementCount ?? 0)));

        let rows = [];
        let headers = [];
        if (activeView === "ingredients") {
          headers = ["Ingredient", "Consumed", "Unit"];
          rows = (report.ingredients || []).map(item => [item.ingredient, Number(item.quantity || 0).toLocaleString(), item.unit]);
        } else if (activeView === "dishes") {
          headers = ["Dish", "Servings with recipe consumption"];
          rows = (report.dishes || []).map(item => [item.dish, Number(item.servings || 0).toLocaleString()]);
        } else {
          headers = ["Ingredient", "Movement", "Quantity change", "Reason", "Recorded at"];
          rows = (report.adjustments || []).map(item => [item.ingredient, item.movement_type, `${Number(item.quantity_delta || 0).toLocaleString()} ${item.unit}`, item.reason, item.created_at ? new Date(item.created_at).toLocaleString("en-IN") : "—"]);
        }
        panel.innerHTML = `<h2>${view.title}</h2><p>${view.description}</p>${rows.length ? `<div style="overflow-x:auto;margin-top:16px;"><table class="data-table" style="width:100%;min-width:520px;"><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : `<div class="ingredient-usage-empty"><i class="ph-bold ph-chart-bar"></i><strong>No records for this period</strong><span>${activeView === "ingredients" ? "Recipe consumption will appear when an order item with a saved recipe is marked Served." : activeView === "dishes" ? "Dish serving counts require saved recipes and served order items." : "Stock receipts, wastage and adjustments will appear here after they are recorded."}</span></div>`}`;
      } catch (error) {
        console.error("Inventory usage report failed:", error);
        panel.innerHTML = `<div class="ingredient-usage-empty"><i class="ph-bold ph-warning-circle"></i><strong>Usage report unavailable</strong><span>${escapeHtml(error.message || "Please refresh and try again.")}</span></div>`;
        showToast("Inventory report unavailable", error.message || "Please try again.", "error");
      }
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
