import { createPresetRange, renderDateRangePicker, bindDateRangePicker, DATE_RANGE_STYLES, dateRangeLabel } from "../components/dateRangePicker.js";


export function renderTopProductsDashboard(area) {
  let dateRange = createPresetRange("7");
  let ranking = "quantity";

  function render() {
    area.innerHTML = `
      <style>
        ${DATE_RANGE_STYLES}
        .top-products-page {
          display: grid;
          gap: 18px;
        }

        .top-products-controls {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          flex-wrap: wrap;
        }

        .top-products-segment {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 4px;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: var(--paper);
        }

        .top-products-segment button {
          min-height: 35px;
          padding: 0 12px;
          border: 1px solid transparent;
          border-radius: 9px;
          background: transparent;
          color: var(--forest-700);
          font: inherit;
          font-size: 12px;
          font-weight: 750;
          cursor: pointer;
        }

        .top-products-segment button.active {
          background: var(--sage-100);
          border-color: var(--sage-200);
          color: var(--forest-950);
        }

        .top-products-note {
          padding: 13px 15px;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: var(--cream-100);
          color: var(--muted);
          font-size: 12px;
          line-height: 1.6;
        }

        .top-products-summary {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
        }

        .top-products-card {
          padding: 16px;
          border: 1px solid var(--line);
          border-radius: 15px;
          background: var(--paper);
        }

        .top-products-card i {
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

        .top-products-card strong {
          display: block;
          margin-bottom: 5px;
          font-size: 23px;
          color: var(--forest-950);
        }

        .top-products-card span {
          display: block;
          color: var(--muted);
          font-size: 12px;
          line-height: 1.5;
        }

        .top-products-panel {
          padding: 19px;
          border: 1px solid var(--line);
          border-radius: 16px;
          background: var(--paper);
        }

        .top-products-panel h2 {
          margin: 0 0 6px;
          font-size: 17px;
        }

        .top-products-panel > p {
          margin: 0;
          color: var(--muted);
          font-size: 12px;
          line-height: 1.6;
        }

        .top-products-empty {
          display: grid;
          place-items: center;
          min-height: 180px;
          margin-top: 16px;
          padding: 20px;
          border: 1px dashed var(--line);
          border-radius: 13px;
          text-align: center;
        }

        .top-products-empty i {
          font-size: 29px;
          color: var(--forest-700);
        }

        .top-products-empty strong {
          margin-top: 10px;
          font-size: 14px;
        }

        .top-products-empty span {
          max-width: 360px;
          margin-top: 6px;
          color: var(--muted);
          font-size: 12px;
          line-height: 1.6;
        }

        @media (max-width: 650px) {
          .top-products-summary {
            grid-template-columns: minmax(0, 1fr);
            gap: 9px;
          }

          .top-products-card {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px;
          }

          .top-products-card i {
            margin: 0;
            flex-shrink: 0;
          }

          .top-products-card strong {
            margin: 0;
            font-size: 20px;
          }

          .top-products-panel {
            padding: 15px;
          }
        }
      </style>

      <section class="section-title-row">
        <div>
          <span class="eyebrow">Product intelligence</span>
          <h1>Top Products</h1>
          <p>Discover which dishes customers order most often.</p>
        </div>
      </section>

      <section class="top-products-page">
        <div class="top-products-controls">
          <div>
            <label
              style="display:block;margin-bottom:7px;color:var(--muted);font-size:11px;font-weight:800;"
            >
              RANK PRODUCTS BY
            </label>

            <div class="top-products-segment" role="group" aria-label="Product ranking">
              <button
                type="button"
                data-ranking="quantity"
                class="${ranking === "quantity" ? "active" : ""}"
                aria-pressed="${ranking === "quantity"}"
              >
                Quantity sold
              </button>

              <button
                type="button"
                data-ranking="revenue"
                class="${ranking === "revenue" ? "active" : ""}"
                aria-pressed="${ranking === "revenue"}"
              >
                Revenue
              </button>
            </div>
          </div>

          <div style="min-width:min(100%, 420px); flex:1 1 420px;">
            <label style="display:block;margin-bottom:7px;color:var(--muted);font-size:11px;font-weight:800;">REPORTING PERIOD</label>
            ${renderDateRangePicker("top-products", dateRange)}
          </div>
        </div>

        <div class="top-products-note">
          Product rankings require verified order-item history and cancellation
          records. No sample rankings or assumed sales figures are displayed.
        </div>

        <div class="top-products-summary">
          <article class="top-products-card">
            <i class="ph-bold ph-trophy"></i>
            <div>
              <strong>—</strong>
              <span>Top-selling dish</span>
            </div>
          </article>

          <article class="top-products-card">
            <i class="ph-bold ph-bowl-food"></i>
            <div>
              <strong>—</strong>
              <span>Total eligible units sold</span>
            </div>
          </article>

          <article class="top-products-card">
            <i class="ph-bold ph-currency-inr"></i>
            <div>
              <strong>—</strong>
              <span>Product sales value</span>
            </div>
          </article>
        </div>

        <article class="top-products-panel">
          <h2>Product ranking</h2>

          <p>
            ${ranking === "quantity"
              ? "Products will be ranked by net quantity sold after excluding cancelled items."
              : "Products will be ranked by net product sales value using saved item prices and verified billing adjustments."}
          </p>

          <div class="top-products-empty">
            <div>
              <i class="ph-bold ph-chart-bar"></i>
              <strong style="display:block;">Ranking data not connected</strong>
              <span>
                Selected period:
                ${dateRangeLabel(dateRange)}.
                Results will appear when the data source is verified and connected.
              </span>
            </div>
          </div>
        </article>
      </section>
    `;

    area.querySelectorAll("[data-ranking]").forEach(button => {
      button.addEventListener("click", () => {
        ranking = button.dataset.ranking;
        render();
      });
    });

    bindDateRangePicker(area, "top-products", dateRange, nextRange => {
      dateRange = nextRange;
      render();
    });
  }

  render();
}
