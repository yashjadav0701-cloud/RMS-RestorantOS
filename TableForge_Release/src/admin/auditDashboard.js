import { supabase } from "../core/supabase.js";
import { escapeHtml } from "../components/navigation.js";
import {
  createPresetRange,
  renderDateRangePicker,
  bindDateRangePicker,
  DATE_RANGE_STYLES,
  dateRangeLabel,
  indiaDateStartISOString,
  indiaDateAfterISOString
} from "../components/dateRangePicker.js";

export function renderAuditDashboard(area) {
  let selectedCategory = "all";
  let dateRange = createPresetRange("7");
  let searchText = "";
  let requestId = 0;
  const categories = [
    { id: "all", label: "All activity" },
    { id: "orders", label: "Orders" },
    { id: "billing", label: "Billing" },
    { id: "inventory", label: "Inventory" },
    { id: "security", label: "Security" }
  ];
  const escape = value => escapeHtml(String(value ?? ""));
  const fmtDate = value => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
  };
  function periodArgs() {
    if (dateRange.preset === "all") return { p_period_start: null, p_period_end: null };
    return { p_period_start: indiaDateStartISOString(dateRange.startDate), p_period_end: indiaDateAfterISOString(dateRange.endDate) };
  }
  function render() {
    area.innerHTML = `
      <style>
        ${DATE_RANGE_STYLES}
        .audit-dashboard{display:grid;gap:17px}.audit-controls{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
        .audit-search{width:min(100%,320px);min-height:40px;box-sizing:border-box;padding:0 12px;border:1px solid var(--line);border-radius:11px;background:var(--paper);color:var(--forest-950);font:inherit;font-size:13px}
        .audit-category-list{display:flex;gap:7px;overflow-x:auto;padding:2px 0 5px}.audit-category{flex:0 0 auto;min-height:37px;padding:0 12px;border:1px solid var(--line);border-radius:999px;background:var(--paper);color:var(--forest-700);font:inherit;font-size:12px;font-weight:750;cursor:pointer}.audit-category.active{border-color:var(--sage-200);background:var(--sage-100);color:var(--forest-950)}
        .audit-integrity-note{padding:13px 15px;border:1px solid var(--line);border-radius:12px;background:var(--cream-100);color:var(--muted);font-size:12px;line-height:1.65}.audit-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:11px}.audit-summary-card{padding:15px;border:1px solid var(--line);border-radius:14px;background:var(--paper)}.audit-summary-card i{display:grid;place-items:center;width:35px;height:35px;margin-bottom:12px;border-radius:11px;background:var(--sage-100);color:var(--forest-900);font-size:19px}.audit-summary-card strong{display:block;margin-bottom:4px;color:var(--forest-950);font-size:22px}.audit-summary-card span{color:var(--muted);font-size:12px;line-height:1.5}
        .audit-log-panel{min-width:0;padding:18px;border:1px solid var(--line);border-radius:15px;background:var(--paper)}.audit-log-panel h2{margin:0 0 5px;font-size:17px}.audit-log-panel>p{margin:0;color:var(--muted);font-size:12px;line-height:1.6}.audit-table-wrap{overflow-x:auto;margin-top:15px}.audit-table{width:100%;border-collapse:collapse;font-size:12px}.audit-table th,.audit-table td{padding:11px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.audit-table th{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}.audit-table td:first-child{white-space:nowrap}.audit-event{font-weight:800;color:var(--forest-950)}.audit-subtext{display:block;margin-top:4px;color:var(--muted);font-size:11px;line-height:1.45;overflow-wrap:anywhere}.audit-empty{padding:25px 15px;text-align:center;color:var(--muted);font-size:12px;line-height:1.65}
        @media(max-width:650px){.audit-summary{grid-template-columns:1fr;gap:9px}.audit-summary-card{display:flex;align-items:center;gap:12px;padding:12px}.audit-summary-card i{flex-shrink:0;margin:0}.audit-summary-card strong{margin:0 0 3px;font-size:20px}.audit-log-panel{padding:15px}}
      </style>
      <section class="section-title-row"><div><span class="eyebrow">Control and accountability</span><h1>Activity & Audit</h1><p>Review stored actions scoped to the active restaurant.</p></div></section>
      <section class="audit-dashboard">
        <div class="audit-integrity-note" data-audit-status role="status">Loading audit records for ${escape(dateRangeLabel(dateRange))}…</div>
        <div class="audit-summary">
          <article class="audit-summary-card"><i class="ph-bold ph-list-checks"></i><div><strong data-audit-metric="recorded_actions">—</strong><span>Recorded actions in filter</span></div></article>
          <article class="audit-summary-card"><i class="ph-bold ph-clipboard-text"></i><div><strong data-audit-metric="exceptions">—</strong><span>Exceptions requiring review</span></div></article>
          <article class="audit-summary-card"><i class="ph-bold ph-shield-check"></i><div><strong data-audit-metric="security_events">—</strong><span>Security events</span></div></article>
        </div>
        <div class="audit-controls"><input class="audit-search" type="search" data-audit-search value="${escape(searchText)}" placeholder="Search actions, records or reasons" aria-label="Search audit activity" />${renderDateRangePicker("audit", dateRange)}</div>
        <div class="audit-category-list" role="group" aria-label="Filter audit category">${categories.map(category => `<button type="button" class="audit-category ${selectedCategory === category.id ? "active" : ""}" data-audit-category="${category.id}" aria-pressed="${selectedCategory === category.id}">${category.label}</button>`).join("")}</div>
        <section class="audit-log-panel"><h2>Activity history</h2><p>Showing the latest 250 matching stored events. Records are not created by opening this screen.</p><div class="audit-empty" data-audit-events>Loading audit history…</div></section>
        <div class="audit-integrity-note">For meaningful history, sensitive database operations must call the server-side audit writer. This view only displays records actually stored in the restaurant's audit log.</div>
      </section>`;
    area.querySelectorAll("[data-audit-category]").forEach(button => button.addEventListener("click", () => { selectedCategory = button.dataset.auditCategory; render(); }));
    bindDateRangePicker(area, "audit", dateRange, nextRange => { dateRange = nextRange; render(); });
    area.querySelector("[data-audit-search]")?.addEventListener("change", event => { searchText = event.target.value.trim(); void load(); });
    area.querySelector("[data-audit-search]")?.addEventListener("keydown", event => { if (event.key === "Enter") { searchText = event.currentTarget.value.trim(); void load(); } });
    void load();
  }
  async function load() {
    const id = ++requestId;
    const status = area.querySelector("[data-audit-status]");
    const eventsNode = area.querySelector("[data-audit-events]");
    const access = window.__RMS_PANEL_ACCESS__;
    if (!supabase || access?.panelId !== "admin" || !access.token) {
      if (status) status.textContent = "A valid Admin session is required to read audit records.";
      if (eventsNode) eventsNode.textContent = "Sign in to the Admin panel and reopen this report.";
      return;
    }
    try {
      const { data, error } = await supabase.rpc("get_admin_audit_dashboard", {
        p_panel_token: access.token,
        ...periodArgs(),
        p_category: selectedCategory,
        p_search: searchText || null
      });
      if (error) throw error;
      if (id !== requestId || !area.querySelector("[data-audit-events]")) return;
      const metrics = data?.metrics || {};
      for (const key of ["recorded_actions", "exceptions", "security_events"]) {
        const node = area.querySelector(`[data-audit-metric="${key}"]`);
        if (node) node.textContent = Number(metrics[key] || 0).toLocaleString("en-IN");
      }
      const events = Array.isArray(data?.events) ? data.events : [];
      if (status) status.textContent = `${Number(metrics.recorded_actions || 0).toLocaleString("en-IN")} matching stored actions · ${dateRangeLabel(dateRange)} · ${categories.find(c => c.id === selectedCategory)?.label || "All activity"}.`;
      if (!events.length) {
        eventsNode.className = "audit-empty";
        eventsNode.textContent = "No stored audit events match these filters.";
        return;
      }
      eventsNode.className = "audit-table-wrap";
      eventsNode.innerHTML = `<table class="audit-table"><thead><tr><th>Time (IST)</th><th>Event</th><th>Target</th><th>Reason / details</th></tr></thead><tbody>${events.map(event => {
        const metadata = event.metadata && typeof event.metadata === "object" ? JSON.stringify(event.metadata) : String(event.metadata || "");
        const target = [event.target_table, event.target_id].filter(Boolean).join(" · ") || "—";
        return `<tr><td>${escape(fmtDate(event.created_at))}</td><td><span class="audit-event">${escape(event.event_type || "Action")}</span>${event.actor_id ? `<span class="audit-subtext">Actor: ${escape(event.actor_id)}</span>` : ""}</td><td>${escape(target)}</td><td>${escape(event.reason || "—")}${metadata ? `<span class="audit-subtext">${escape(metadata.slice(0,500))}</span>` : ""}</td></tr>`;
      }).join("")}</tbody></table>`;
    } catch (error) {
      console.error("Activity & Audit report failed:", error);
      if (id !== requestId) return;
      if (status) status.textContent = `Audit report could not load: ${String(error?.message || "Unknown database error")}`;
      if (eventsNode) { eventsNode.className = "audit-empty"; eventsNode.textContent = "Verify the included SQL migration has been applied, then refresh this screen."; }
    }
  }
  render();
}
