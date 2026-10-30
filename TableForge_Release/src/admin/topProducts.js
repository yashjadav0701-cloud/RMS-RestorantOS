import { supabase } from "../core/supabase.js";
import { escapeHtml, money } from "../components/navigation.js";
import {
  createPresetRange,
  renderDateRangePicker,
  bindDateRangePicker,
  DATE_RANGE_STYLES,
  dateRangeLabel,
  indiaDateStartISOString,
  indiaDateAfterISOString
} from "../components/dateRangePicker.js";

export function renderTopProductsDashboard(area) {
  let dateRange = createPresetRange("7");
  let ranking = "quantity";
  let requestId = 0;

  const escape = value => escapeHtml(String(value ?? ""));
  const formatUnits = value => Number(value || 0).toLocaleString("en-IN");

  function periodArgs() {
    if (dateRange.preset === "all") return { p_period_start: null, p_period_end: null };
    return {
      p_period_start: indiaDateStartISOString(dateRange.startDate),
      p_period_end: indiaDateAfterISOString(dateRange.endDate)
    };
  }

  function render() {
    area.innerHTML = `
      <style>
        ${DATE_RANGE_STYLES}
        .top-products-page{display:grid;gap:18px}
        .top-products-controls{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
        .top-products-segment{display:inline-flex;align-items:center;gap:4px;padding:4px;border:1px solid var(--line);border-radius:12px;background:var(--paper)}
        .top-products-segment button{min-height:35px;padding:0 12px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--forest-700);font:inherit;font-size:12px;font-weight:750;cursor:pointer}
        .top-products-segment button.active{background:var(--sage-100);border-color:var(--sage-200);color:var(--forest-950)}
        .top-products-note{padding:13px 15px;border:1px solid var(--line);border-radius:12px;background:var(--cream-100);color:var(--muted);font-size:12px;line-height:1.6}
        .top-products-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
        .top-products-card{padding:16px;border:1px solid var(--line);border-radius:15px;background:var(--paper);min-width:0}
        .top-products-card i{display:grid;place-items:center;width:36px;height:36px;margin-bottom:13px;border-radius:11px;background:var(--sage-100);color:var(--forest-900);font-size:19px}
        .top-products-card strong{display:block;margin-bottom:5px;font-size:21px;color:var(--forest-950);overflow-wrap:anywhere}
        .top-products-card span{display:block;color:var(--muted);font-size:12px;line-height:1.5}
        .top-products-panel{padding:19px;border:1px solid var(--line);border-radius:16px;background:var(--paper);min-width:0}
        .top-products-panel h2{margin:0 0 6px;font-size:17px}.top-products-panel>p{margin:0;color:var(--muted);font-size:12px;line-height:1.6}
        .tf-report-table-wrap{overflow-x:auto;margin-top:14px}.tf-report-table{width:100%;border-collapse:collapse;font-size:12px}.tf-report-table th,.tf-report-table td{padding:11px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.tf-report-table th{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em}.tf-report-table td:last-child,.tf-report-table th:last-child{text-align:right;white-space:nowrap}.tf-report-empty{padding:24px 15px;text-align:center;color:var(--muted);font-size:12px;line-height:1.6}
        @media(max-width:650px){.top-products-summary{grid-template-columns:1fr;gap:9px}.top-products-card{display:flex;align-items:center;gap:12px;padding:12px}.top-products-card i{margin:0;flex-shrink:0}.top-products-card strong{margin:0;font-size:18px}.top-products-panel{padding:15px}}
      </style>
      <section class="section-title-row"><div><span class="eyebrow">Product intelligence</span><h1>Top Products</h1><p>Rank dishes using paid order-item history for this restaurant.</p></div></section>
      <section class="top-products-page">
        <div class="top-products-controls">
          <div><label style="display:block;margin-bottom:7px;color:var(--muted);font-size:11px;font-weight:800">RANK PRODUCTS BY</label>
            <div class="top-products-segment" role="group" aria-label="Product ranking">
              <button type="button" data-ranking="quantity" class="${ranking === "quantity" ? "active" : ""}" aria-pressed="${ranking === "quantity"}">Quantity sold</button>
              <button type="button" data-ranking="revenue" class="${ranking === "revenue" ? "active" : ""}" aria-pressed="${ranking === "revenue"}">Revenue</button>
            </div>
          </div>
          <div style="min-width:min(100%,420px);flex:1 1 420px"><label style="display:block;margin-bottom:7px;color:var(--muted);font-size:11px;font-weight:800">REPORTING PERIOD</label>${renderDateRangePicker("top-products", dateRange)}</div>
        </div>
        <div class="top-products-note" data-top-products-status role="status">Loading verified sales records for ${escape(dateRangeLabel(dateRange))}…</div>
        <div class="top-products-summary">
          <article class="top-products-card"><i class="ph-bold ph-trophy"></i><div><strong data-top-products-leader>—</strong><span>Top-selling dish</span></div></article>
          <article class="top-products-card"><i class="ph-bold ph-bowl-food"></i><div><strong data-top-products-units>—</strong><span>Total eligible units sold</span></div></article>
          <article class="top-products-card"><i class="ph-bold ph-currency-inr"></i><div><strong data-top-products-revenue>—</strong><span>Paid product sales value</span></div></article>
        </div>
        <article class="top-products-panel"><h2>Product ranking</h2><p>${ranking === "quantity" ? "Sorted by net quantity sold." : "Sorted by recorded paid product sales value."}</p><div data-top-products-results class="tf-report-empty">Loading report…</div></article>
      </section>
    `;

    area.querySelectorAll("[data-ranking]").forEach(button => button.addEventListener("click", () => {
      ranking = button.dataset.ranking;
      render();
    }));
    bindDateRangePicker(area, "top-products", dateRange, nextRange => { dateRange = nextRange; render(); });
    void load();
  }

  async function load() {
    const id = ++requestId;
    const status = area.querySelector("[data-top-products-status]");
    const results = area.querySelector("[data-top-products-results]");
    const access = window.__RMS_PANEL_ACCESS__;
    if (!supabase || access?.panelId !== "admin" || !access.token) {
      if (status) status.textContent = "A valid Admin session is required to load reporting data.";
      if (results) results.textContent = "Sign in to the Admin panel and reopen this report.";
      return;
    }
    try {
      const { data, error } = await supabase.rpc("get_admin_reporting_data", {
        p_panel_token: access.token,
        ...periodArgs()
      });
      if (error) throw error;
      if (id !== requestId || !area.querySelector("[data-top-products-results]")) return;
      const products = Array.isArray(data?.top_products) ? [...data.top_products] : [];
      products.sort((a,b) => ranking === "quantity"
        ? Number(b.quantity_sold || 0) - Number(a.quantity_sold || 0) || Number(b.revenue || 0) - Number(a.revenue || 0)
        : Number(b.revenue || 0) - Number(a.revenue || 0) || Number(b.quantity_sold || 0) - Number(a.quantity_sold || 0));
      const totalUnits = products.reduce((sum,item) => sum + Number(item.quantity_sold || 0), 0);
      const totalRevenue = products.reduce((sum,item) => sum + Number(item.revenue || 0), 0);
      area.querySelector("[data-top-products-leader]").textContent = products[0]?.name || "No paid sales";
      area.querySelector("[data-top-products-units]").textContent = formatUnits(totalUnits);
      area.querySelector("[data-top-products-revenue]").textContent = money(totalRevenue);
      if (status) status.textContent = `${products.length} product groups · ${dateRangeLabel(dateRange)}. Only paid, non-cancelled order items are included.`;
      if (!products.length) {
        results.className = "tf-report-empty";
        results.textContent = "No paid product sales were found in this period.";
      } else {
        results.className = "tf-report-table-wrap";
        results.innerHTML = `<table class="tf-report-table"><thead><tr><th>#</th><th>Dish</th><th>Category</th><th>Units</th><th>Sales</th></tr></thead><tbody>${products.slice(0,100).map((item,index)=>`<tr><td>${index+1}</td><td>${escape(item.name)}</td><td>${escape(item.category || "Uncategorized")}</td><td>${formatUnits(item.quantity_sold)}</td><td>${escape(money(item.revenue || 0))}</td></tr>`).join("")}</tbody></table>`;
      }
    } catch (error) {
      console.error("Top Products report failed:", error);
      if (id !== requestId) return;
      if (status) status.textContent = `Report could not load: ${String(error?.message || "Unknown database error")}`;
      if (results) { results.className = "tf-report-empty"; results.textContent = "The reporting request failed. Verify the included SQL migration has been applied, then refresh."; }
    }
  }

  render();
}
