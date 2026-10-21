import { createPresetRange, renderDateRangePicker, bindDateRangePicker, DATE_RANGE_STYLES, dateRangeLabel } from "../components/dateRangePicker.js";


export function renderAuditDashboard(area) {
  let selectedCategory = "all";
  let dateRange = createPresetRange("7");
  let searchText = "";

  const categories = [
    { id: "all", label: "All activity" },
    { id: "orders", label: "Orders" },
    { id: "billing", label: "Billing" },
    { id: "inventory", label: "Inventory" },
    { id: "security", label: "Security" }
  ];


  function render() {
    area.innerHTML = `
      <style>
        ${DATE_RANGE_STYLES}
        .audit-dashboard {
          display: grid;
          gap: 17px;
        }

        .audit-controls {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }

        .audit-search {
          width: min(100%, 320px);
          min-height: 40px;
          box-sizing: border-box;
          padding: 0 12px;
          border: 1px solid var(--line);
          border-radius: 11px;
          background: var(--paper);
          color: var(--forest-950);
          font: inherit;
          font-size: 13px;
        }

        .audit-period {
          min-height: 40px;
          max-width: 100%;
          padding: 0 12px;
          border: 1px solid var(--line);
          border-radius: 11px;
          background: var(--paper);
          color: var(--forest-900);
          font: inherit;
          font-size: 12px;
          font-weight: 700;
        }

        .audit-category-list {
          display: flex;
          gap: 7px;
          overflow-x: auto;
          padding: 2px 0 5px;
          scrollbar-width: thin;
          scrollbar-color: var(--sage-300) transparent;
        }

        .audit-category {
          flex: 0 0 auto;
          min-height: 37px;
          padding: 0 12px;
          border: 1px solid var(--line);
          border-radius: 999px;
          background: var(--paper);
          color: var(--forest-700);
          font: inherit;
          font-size: 12px;
          font-weight: 750;
          cursor: pointer;
        }

        .audit-category.active {
          border-color: var(--sage-200);
          background: var(--sage-100);
          color: var(--forest-950);
        }

        .audit-integrity-note {
          padding: 13px 15px;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: var(--cream-100);
          color: var(--muted);
          font-size: 12px;
          line-height: 1.65;
        }

        .audit-summary {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 11px;
        }

        .audit-summary-card {
          padding: 15px;
          border: 1px solid var(--line);
          border-radius: 14px;
          background: var(--paper);
        }

        .audit-summary-card i {
          display: grid;
          place-items: center;
          width: 35px;
          height: 35px;
          margin-bottom: 12px;
          border-radius: 11px;
          background: var(--sage-100);
          color: var(--forest-900);
          font-size: 19px;
        }

        .audit-summary-card strong {
          display: block;
          margin-bottom: 4px;
          color: var(--forest-950);
          font-size: 22px;
        }

        .audit-summary-card span {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.5;
        }

        .audit-log-panel {
          min-width: 0;
          padding: 18px;
          border: 1px solid var(--line);
          border-radius: 15px;
          background: var(--paper);
        }

        .audit-log-panel h2 {
          margin: 0 0 5px;
          font-size: 17px;
        }

        .audit-log-panel > p {
          margin: 0;
          color: var(--muted);
          font-size: 12px;
          line-height: 1.6;
        }

        .audit-empty {
          display: grid;
          justify-items: center;
          place-content: center;
          min-height: 160px;
          margin-top: 15px;
          padding: 20px;
          border: 1px dashed var(--line);
          border-radius: 12px;
          text-align: center;
        }

        .audit-empty i {
          color: var(--forest-700);
          font-size: 29px;
        }

        .audit-empty strong {
          margin-top: 10px;
          font-size: 14px;
        }

        .audit-empty span {
          max-width: 420px;
          margin-top: 6px;
          color: var(--muted);
          font-size: 12px;
          line-height: 1.65;
        }

        @media (max-width: 650px) {
          .audit-summary {
            grid-template-columns: minmax(0, 1fr);
            gap: 9px;
          }

          .audit-summary-card {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px;
          }

          .audit-summary-card i {
            flex-shrink: 0;
            margin: 0;
          }

          .audit-summary-card strong {
            margin: 0 0 3px;
            font-size: 20px;
          }

          .audit-log-panel {
            padding: 15px;
          }
        }
      </style>

      <section class="section-title-row">
        <div>
          <span class="eyebrow">Control and accountability</span>
          <h1>Activity & Audit</h1>
          <p>Review sensitive actions and investigate operational exceptions.</p>
        </div>
      </section>

      <section class="audit-dashboard">
        <div class="audit-integrity-note">
          Audit records must be written by trusted backend operations and
          preserved independently of frontend navigation. This screen will
          display verified stored events after the audit-log database
          integration is complete.
        </div>

        <div class="audit-summary">
          <article class="audit-summary-card">
            <i class="ph-bold ph-list-checks"></i>
            <div>
              <strong>—</strong>
              <span>Recorded actions</span>
            </div>
          </article>

          <article class="audit-summary-card">
            <i class="ph-bold ph-clipboard-text"></i>
            <div>
              <strong>—</strong>
              <span>Exceptions requiring review</span>
            </div>
          </article>

          <article class="audit-summary-card">
            <i class="ph-bold ph-shield-check"></i>
            <div>
              <strong>—</strong>
              <span>Security events</span>
            </div>
          </article>
        </div>

        <div class="audit-controls">
          <input
            class="audit-search"
            type="search"
            data-audit-search
            value="${searchText.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"
            placeholder="Search actions, records or reasons"
            aria-label="Search audit activity"
          />

          ${renderDateRangePicker("audit", dateRange)}
        </div>

        <div
          class="audit-category-list"
          role="group"
          aria-label="Filter audit category"
        >
          ${categories.map(category => `
            <button
              type="button"
              class="audit-category ${selectedCategory === category.id ? "active" : ""}"
              data-audit-category="${category.id}"
              aria-pressed="${selectedCategory === category.id}"
            >
              ${category.label}
            </button>
          `).join("")}
        </div>

        <section class="audit-log-panel">
          <h2>Activity history</h2>
          <p>
            Filter recorded events by category, date and searchable details.
          </p>

          <div class="audit-empty">
            <i class="ph-bold ph-shield-check"></i>
            <strong>Audit history not connected</strong>
            <span>
              The selected period is
              ${dateRangeLabel(dateRange)}.
              ${selectedCategory === "all"
                ? "All audit categories are selected."
                : `Category: ${categories.find(item => item.id === selectedCategory)?.label || "All activity"}.`}
              Stored records will appear here once the verified audit service
              is available. Search text: ${searchText ? "entered" : "not entered"}.
            </span>
          </div>
        </section>

        <div class="audit-integrity-note">
          High-risk examples to record include post-preparation dish
          cancellations, bill revisions after issue, payment adjustments,
          stock corrections, panel PIN changes, failed authorization attempts
          and privileged overrides. Each event should include its actor,
          timestamp, affected record, reason and outcome when applicable.
        </div>
      </section>
    `;

    area.querySelectorAll("[data-audit-category]").forEach(button => {
      button.addEventListener("click", () => {
        selectedCategory = button.dataset.auditCategory;
        render();
      });
    });

    bindDateRangePicker(area, "audit", dateRange, nextRange => {
      dateRange = nextRange;
      render();
    });

    area.querySelector("[data-audit-search]")
      ?.addEventListener("input", event => {
        searchText = event.target.value;
      });
  }

  render();
}
