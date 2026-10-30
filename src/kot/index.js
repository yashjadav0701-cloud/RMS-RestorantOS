import { supabase } from "../core/supabase.js";
import { installPanelSignOut, requestPanelSignOut } from "../core/panelSession.js";

const ACTIVE_STATUSES = new Set(["pending", "preparing", "ready"]);

function isReadyMarked(row) {
  return String(row?.serving_status || "").toLowerCase() === "served" &&
    Boolean(row?.kot_ready_previous_status);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusLabel(status) {
  const labels = {
    pending: "New",
    preparing: "Preparing",
    ready: "Ready",
    served: "Served",
    cancelled: "Cancelled"
  };

  return labels[status] || "Unknown";
}

function formatTime(value) {
  if (!value) return "Time unavailable";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time unavailable";

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function groupByTable(rows) {
  const groups = new Map();

  for (const row of rows) {
    const isTakeaway = row.order_type === "takeaway";
    // Group by the actual dining-session identity, not the visible table label.
    // A reused table name must never merge two separate service sessions.
    const tableKey = isTakeaway
      ? `takeaway:${row.order_id}`
      : `session:${row.session_id || row.table_id || row.table_label || "unknown"}`;

    if (!groups.has(tableKey)) {
      groups.set(tableKey, {
        key: tableKey,
        orderType: row.order_type,
        tableLabel: row.table_label,
        tableId: row.table_id || null,
        sessionId: row.session_id || null,
        rounds: new Map(),
        createdAt: row.order_created_at
      });
    }

    const tableGroup = groups.get(tableKey);
    const roundNumber = isTakeaway ? 0 : (row.round_number || 1);
    const roundKey = isTakeaway
      ? `order:${row.order_id}`
      : `round:${roundNumber}`;

    if (!tableGroup.rounds.has(roundKey)) {
      tableGroup.rounds.set(roundKey, {
        key: roundKey,
        orderId: row.order_id,
        orderNumber: row.order_number,
        roundNumber,
        orderNote: row.order_note,
        createdAt: row.order_created_at,
        items: []
      });
    }

    tableGroup.rounds.get(roundKey).items.push(row);
  }

  return [...groups.values()]
    .map(tableGroup => ({
      ...tableGroup,
      rounds: [...tableGroup.rounds.values()].sort((a, b) => {
        if (tableGroup.orderType === "takeaway") return 0;
        return a.roundNumber - b.roundNumber;
      })
    }))
    .sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      return aTime - bTime;
    });
}

export async function render({ mount }) {
  const access = window.__RMS_PANEL_ACCESS__;

  // No panel token means no kitchen data or operations are permitted.
  if (
    !["kot", "manager"].includes(access?.panelId) ||
    typeof access.token !== "string" ||
    access.token.length < 20 ||
    !Number.isFinite(access.expiresAt) ||
    access.expiresAt <= Date.now()
  ) {
    mount.innerHTML = `
      <section class="access-screen">
        <div class="access-card" style="text-align:center;">
          <i
            class="ph-bold ph-lock-key"
            style="font-size:38px;color:var(--forest-900);"
          ></i>
          <h1>Kitchen access required</h1>
          <p class="access-copy">
            Verify the KOT panel PIN before accessing kitchen orders.
          </p>
          <button class="btn btn-primary" data-kot-return>
            Return to workspaces
          </button>
        </div>
      </section>
    `;

    const returnButton = mount.querySelector("[data-kot-return]");

    const back = () => {
      window.__RMS_PANEL_ACCESS__ = null;
      history.pushState({}, "", `${location.pathname}${location.search}#/panels`);
      window.dispatchEvent(new Event("rms:navigate"));
    };

    returnButton.addEventListener("click", back);

    return () => {
      returnButton.removeEventListener("click", back);
    };
  }

  if (!supabase) {
    mount.innerHTML = `
      <section class="access-screen">
        <div class="access-card">
          <h1>Kitchen unavailable</h1>
          <p class="access-copy">The database connection is unavailable.</p>
        </div>
      </section>
    `;
    return () => {};
  }

  const tenantId = window.__ACTIVE_TENANT__?.id;

  let rows = [];
  let loadedOnce = false;
  let loading = false;
  let disposed = false;
  let channel = null;
  let pollTimer = null;
  let refreshTimer = null;
  const busyItems = new Set();

  mount.innerHTML = `
    <section class="kot-workspace">
      <style>
        .kot-workspace {
          min-height: 100vh;
          padding: 22px;
          box-sizing: border-box;
          color: var(--forest-950);
          background: var(--cream-100);
          font-family: var(--ui-font);
        }

        .kot-container {
          max-width: 1050px;
          margin: 0 auto;
        }

        .kot-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          margin-bottom: 22px;
        }

        .kot-header-left {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .kot-back {
          width: 42px;
          height: 42px;
          display: grid;
          place-items: center;
          border: 1px solid var(--line);
          border-radius: 13px;
          background: var(--paper);
          color: var(--forest-900);
          cursor: pointer;
          font-size: 18px;
        }

        .kot-title {
          margin: 0;
          font-size: 23px;
          letter-spacing: -.03em;
        }

        .kot-subtitle {
          margin: 4px 0 0;
          color: var(--muted);
          font-size: 12px;
        }

        .kot-refresh {
          width: 42px;
          height: 42px;
          display: grid;
          place-items: center;
          border: 1px solid var(--line);
          border-radius: 13px;
          background: var(--paper);
          color: var(--forest-900);
          cursor: pointer;
          font-size: 18px;
        }

        .kot-summary {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 18px;
          padding: 13px 16px;
          border: 1px solid var(--line);
          border-radius: 15px;
          background: var(--paper);
          font-size: 13px;
        }

        .kot-live {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          color: var(--forest-800);
          font-weight: 700;
        }

        .kot-live-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #16a34a;
        }

        .kot-error {
          margin: 12px 0;
          color: var(--danger);
          font-size: 12px;
          line-height: 1.5;
        }

        .kot-queue {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 14px;
          align-items: start;
        }

        .kot-ticket {
          min-width: 0;
          overflow: hidden;
          border: 1px solid var(--line);
          border-radius: 18px;
          background: var(--paper);
        }

        .kot-ticket-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          padding: 16px;
          border-bottom: 1px solid var(--line);
        }

        .kot-ticket-header-actions {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 7px;
          flex-shrink: 0;
        }

        .kot-table-ready-action {
          min-height: 34px;
          padding: 7px 10px;
          border: 1px solid var(--forest-900);
          border-radius: 9px;
          background: var(--forest-900);
          color: #fff;
          font: inherit;
          font-size: 11px;
          font-weight: 850;
          cursor: pointer;
          white-space: nowrap;
        }

        .kot-table-ready-action.undo {
          background: var(--paper);
          color: var(--forest-900);
          border-color: var(--line);
        }

        .kot-table-ready-action:disabled { opacity: .55; cursor: wait; }

        .kot-ticket-header h3 {
          margin: 0;
          font-size: 16px;
        }

        .kot-ticket-meta {
          margin-top: 5px;
          color: var(--muted);
          font-size: 11px;
        }

        .kot-round {
          flex-shrink: 0;
          padding: 5px 8px;
          border-radius: 8px;
          background: var(--sage-100);
          color: var(--forest-800);
          font-size: 11px;
          font-weight: 800;
        }

        .kot-round-section {
          padding: 12px 18px 16px;
          border-top: 1px solid var(--line);
        }

        .kot-round-heading {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 8px;
          padding: 8px 10px;
          border-radius: 9px;
          background: var(--sage-100);
        }

        .kot-round-heading span {
          color: var(--muted, #64748b);
          font-size: 0.85rem;
        }

        .kot-round-section .kot-items {
          padding: 0;
        }

        .kot-round-section .kot-item:first-child {
          border-top: 0;
        }

        .kot-order-note {
          margin: 12px 14px 0;
          padding: 9px 11px;
          border-radius: 10px;
          background: var(--cream-100);
          color: var(--muted);
          font-size: 12px;
          line-height: 1.5;
        }

        .kot-items {
          padding: 4px 14px 12px;
        }

        .kot-item {
          padding: 13px 0;
          border-bottom: 1px solid var(--line);
        }

        .kot-item:last-child {
          border-bottom: 0;
        }

        .kot-item-top {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 10px;
        }

        .kot-item-name {
          min-width: 0;
          font-size: 14px;
          font-weight: 800;
          overflow-wrap: anywhere;
        }

        .kot-quantity {
          flex-shrink: 0;
          min-width: 30px;
          text-align: center;
          padding: 4px 7px;
          border-radius: 8px;
          background: var(--cream-100);
          font-size: 12px;
          font-weight: 800;
        }

        .kot-item-bottom {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-top: 11px;
        }

        .kot-status {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 5px 8px;
          border-radius: 8px;
          font-size: 10px;
          font-weight: 900;
          text-transform: uppercase;
        }

        .kot-status.pending {
          background: #f1f5f9;
          color: #475569;
        }

        .kot-status.preparing {
          background: #fff7ed;
          color: #9a3412;
        }

        .kot-status.ready {
          background: #e0f2fe;
          color: #075985;
        }

        .kot-item-actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .kot-action {
          padding: 7px 9px;
          border: 1px solid var(--line);
          border-radius: 9px;
          background: var(--paper);
          color: var(--forest-900);
          font-size: 11px;
          font-weight: 800;
          cursor: pointer;
        }

        .kot-action.primary {
          border-color: var(--forest-900);
          background: var(--forest-900);
          color: white;
        }

        .kot-action:disabled,
        .kot-refresh:disabled {
          opacity: .5;
          cursor: wait;
        }

        .kot-empty {
          grid-column: 1 / -1;
          padding: 64px 20px;
          border: 1px dashed var(--line);
          border-radius: 18px;
          background: var(--paper);
          text-align: center;
        }

        .kot-empty i {
          font-size: 34px;
          color: var(--forest-700);
        }

        .kot-empty h3 {
          margin: 12px 0 6px;
          font-size: 17px;
        }

        .kot-empty p {
          margin: 0;
          color: var(--muted);
          font-size: 13px;
          line-height: 1.6;
        }

        .kot-cancellations {
          margin-bottom: 16px;
          border: 1px solid #fecaca;
          border-radius: 15px;
          background: #fff7f7;
          padding: 14px;
        }

        .kot-cancellations h3 {
          margin: 0 0 10px;
          color: #991b1b;
          font-size: 14px;
        }

        .kot-cancellation {
          padding: 9px 0;
          border-top: 1px solid #fee2e2;
          color: #7f1d1d;
          font-size: 12px;
          line-height: 1.5;
        }

        .kot-cancellation:first-of-type {
          border-top: 0;
        }

        .kot-feedback {
          min-height: 18px;
          margin-top: 12px;
          font-size: 12px;
          color: var(--muted);
        }

        @media (max-width: 760px) {
          .kot-workspace {
            padding: 16px 12px;
          }

          .kot-queue {
            grid-template-columns: minmax(0, 1fr);
          }

          .kot-title {
            font-size: 20px;
          }

          .kot-ticket-header {
            padding: 14px;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .kot-workspace * {
            scroll-behavior: auto !important;
          }
        }
      </style>

      <div class="kot-container">
        <header class="kot-header">
          <div class="kot-header-left">
            <button class="kot-back" type="button" data-kot-back
              aria-label="Return to workspaces" title="Return to workspaces">
              <i class="ph-bold ph-arrow-left"></i>
            </button>

            <div>
              <h1 class="kot-title">Kitchen</h1>
              <p class="kot-subtitle">Active preparation queue</p>
            </div>
          </div>

          <button class="kot-refresh" type="button" data-kot-refresh
            aria-label="Refresh kitchen queue" title="Refresh">
            <i class="ph-bold ph-arrows-clockwise"></i>
          </button>
        </header>

        <div class="kot-summary">
          <span><strong data-kot-active-count>0</strong> active dishes</span>
          <span class="kot-live">
            <span class="kot-live-dot"></span>
            Live queue
          </span>
        </div>

        <div class="kot-cancellation-slot"></div>
        <div class="kot-error" data-kot-error role="status" aria-live="polite"></div>
        <div class="kot-queue" data-kot-queue>
          <div class="kot-empty">
            <i class="ph-bold ph-spinner-gap ph-spin"></i>
            <h3>Loading kitchen queue</h3>
          </div>
        </div>
        <div class="kot-feedback" data-kot-feedback role="status" aria-live="polite"></div>
      </div>
    </section>
  `;

  const panelSignOutCleanup = installPanelSignOut({ mount, panelId: "kot" });
  const queueNode = mount.querySelector("[data-kot-queue]");
  const cancellationSlot = mount.querySelector(".kot-cancellation-slot");
  const errorNode = mount.querySelector("[data-kot-error]");
  const feedbackNode = mount.querySelector("[data-kot-feedback]");
  const countNode = mount.querySelector("[data-kot-active-count]");
  const refreshButton = mount.querySelector("[data-kot-refresh]");

  function renderQueue() {
    const activeRows = rows.filter(row => {
      const status = String(row.serving_status || "pending").toLowerCase();
      return ACTIVE_STATUSES.has(status) || isReadyMarked(row);
    });

    const cancelledRows = rows.filter(
      row => String(row.serving_status || "").toLowerCase() === "cancelled"
    );

    const groups = groupByTable(activeRows);
    countNode.textContent = String(activeRows.length);

    cancellationSlot.innerHTML = cancelledRows.length
      ? `
        <section class="kot-cancellations" aria-label="Recent cancellations">
          <h3><i class="ph-bold ph-info"></i> Order updates</h3>
          ${cancelledRows.map(item => `
            <div class="kot-cancellation">
              <strong>${escapeHtml(item.item_name)}</strong>
              · ${escapeHtml(
                item.order_type === "takeaway"
                  ? `Takeaway #${item.order_number}`
                  : `Table ${item.table_label || "—"}`
              )}
              — Cancelled
              ${item.cancellation_reason
                ? `<br>Reason: ${escapeHtml(item.cancellation_reason)}`
                : ""}
            </div>
          `).join("")}
        </section>
      `
      : "";

    if (groups.length === 0) {
      queueNode.innerHTML = `
        <div class="kot-empty">
          <i class="ph-bold ph-check-circle"></i>
          <h3>No active orders</h3>
          <p>
            New kitchen orders will appear here automatically.
          </p>
        </div>
      `;
      return;
    }

    queueNode.innerHTML = groups.map(group => {
      const isTakeaway = group.orderType === "takeaway";
      const label = isTakeaway
        ? group.rounds.map(round => `Takeaway #${round.orderNumber}`).join("")
        : `Table ${group.tableLabel || "—"}`;
      const allGroupItems = group.rounds.flatMap(round => round.items);
      const tableReadyItems = allGroupItems.filter(item => {
        const status = String(item.serving_status || "pending").toLowerCase();
        return status !== "cancelled" &&
          (ACTIVE_STATUSES.has(status) || isReadyMarked(item));
      });
      const isTableAlreadyReady = tableReadyItems.length > 0 && tableReadyItems.every(isReadyMarked);
      const canReadyTable = tableReadyItems.some(item => !isReadyMarked(item) &&
        ACTIVE_STATUSES.has(String(item.serving_status || "pending").toLowerCase()));
      const tableReadyButton = !isTakeaway && tableReadyItems.length && (canReadyTable || isTableAlreadyReady)
        ? `<button class="kot-table-ready-action ${isTableAlreadyReady ? "undo" : ""}"
              type="button" data-kot-table-action="${isTableAlreadyReady ? "undo_ready" : "ready"}"
              data-item-ids="${escapeHtml(JSON.stringify(tableReadyItems.map(item => item.item_id)))}"
              ${tableReadyItems.some(item => busyItems.has(item.item_id)) ? "disabled" : ""}>
              <i class="ph-bold ph-${isTableAlreadyReady ? "arrow-counter-clockwise" : "check-circle"}"></i>
              ${isTableAlreadyReady ? "Undo Ready" : "Ready table"}
           </button>`
        : "";

      return `
        <article class="kot-ticket" data-kot-group="${escapeHtml(group.key)}">
          <header class="kot-ticket-header">
            <div>
              <h3>${escapeHtml(label)}</h3>
              <div class="kot-ticket-meta">
                ${isTakeaway
                  ? `Takeaway order`
                  : `${group.rounds.length} round${group.rounds.length === 1 ? "" : "s"}`}
                · ${escapeHtml(formatTime(group.createdAt))}
              </div>
            </div>
            <div class="kot-ticket-header-actions">
              <span class="kot-round">
                ${isTakeaway ? "Takeaway" : "Table open"}
              </span>
              ${tableReadyButton}
            </div>
          </header>

          ${group.rounds.map(round => `
            <section class="kot-round-section">
              ${!isTakeaway ? `
                <div class="kot-round-heading">
                  <strong>Round ${escapeHtml(round.roundNumber)}</strong>
                  <span>Order #${escapeHtml(round.orderNumber)}</span>
                </div>
              ` : `
                <div class="kot-round-heading">
                  <strong>Order #${escapeHtml(round.orderNumber)}</strong>
                </div>
              `}

              ${round.orderNote ? `
                <div class="kot-order-note">
                  <strong>Order note:</strong>
                  ${escapeHtml(round.orderNote)}
                </div>
              ` : ""}

              <div class="kot-items">
                ${round.items.map(item => {
                  const status = String(
                    item.serving_status || "pending"
                  ).toLowerCase();
                  const readyMarked = isReadyMarked(item);
                  const visibleStatus = readyMarked ? "ready" : status;
                  const busy = busyItems.has(item.item_id);
                  let action = "";

                  if (readyMarked) {
                    action = `
                      <button
                        class="kot-action"
                        type="button"
                        data-kot-action="undo_ready"
                        data-item-id="${escapeHtml(item.item_id)}"
                        ${busy ? "disabled" : ""}
                      >
                        Undo Ready
                      </button>
                    `;
                  } else if (["pending", "preparing", "ready"].includes(status)) {
                    action = `
                      <button
                        class="kot-action primary"
                        type="button"
                        data-kot-action="ready"
                        data-item-id="${escapeHtml(item.item_id)}"
                        ${busy ? "disabled" : ""}
                      >
                        Ready
                      </button>
                    `;
                  }

                  return `
                    <div class="kot-item">
                      <div class="kot-item-top">
                        <span class="kot-item-name">
                          ${escapeHtml(item.item_name)}
                        </span>
                        <span class="kot-quantity">
                          × ${escapeHtml(item.quantity)}
                        </span>
                      </div>

                      <div class="kot-item-bottom">
                        <span class="kot-status ${escapeHtml(visibleStatus)}">
                          ${escapeHtml(statusLabel(visibleStatus))}
                        </span>
                        <div class="kot-item-actions">${action}</div>
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>
            </section>
          `).join("")}
        </article>
      `;
    }).join("");
  }

  async function loadQueue({ quiet = false } = {}) {
    if (disposed || loading) return;

    const previousAccess = window.__RMS_PANEL_ACCESS__;
    const isManagerSession = previousAccess?.panelId === "manager";

    if (
      !["kot", "manager"].includes(previousAccess?.panelId) ||
      !previousAccess?.token ||
      !Number.isFinite(previousAccess?.expiresAt) ||
      previousAccess.expiresAt <= Date.now()
    ) {
      window.__RMS_PANEL_ACCESS__ = null;

      history.replaceState(
        {},
        "",
        `${location.pathname}${location.search}#/panel/${isManagerSession ? "manager" : "kot"}`
      );

      window.dispatchEvent(new Event("rms:navigate"));
      return;
    }

    if (!quiet) refreshButton.disabled = true;

    loading = true;
    errorNode.textContent = "";

    try {
      // The database validates the panel token and scopes every row to its restaurant.
      const { data, error } = await supabase.rpc("get_kot_queue", {
        p_panel_token: window.__RMS_PANEL_ACCESS__.token
      });

      if (error) throw error;

      if (!Array.isArray(data)) {
        throw new Error("The kitchen queue returned an unexpected response.");
      }

      rows = data;
      loadedOnce = true;
      renderQueue();
    } catch (error) {
      console.error("KOT queue load failed:", error);

      if (!loadedOnce) {
        queueNode.innerHTML = `
          <div class="kot-empty">
            <i class="ph-bold ph-warning-circle"></i>
            <h3>Kitchen queue unavailable</h3>
            <p>Check the connection and try again.</p>
          </div>
        `;
      }

      errorNode.textContent = "Couldn't refresh the kitchen queue. Try again.";
    } finally {
      loading = false;
      refreshButton.disabled = false;
    }
  }

  async function changeItemStatus(itemId, newStatus, button) {
    if (busyItems.has(itemId) || disposed) return;

    const currentAccess = window.__RMS_PANEL_ACCESS__;

    if (
      !["kot", "manager"].includes(currentAccess?.panelId) ||
      !currentAccess.token ||
      currentAccess.expiresAt <= Date.now()
    ) {
      errorNode.textContent = "Kitchen access has expired. Please verify the PIN again.";
      return;
    }

    busyItems.add(itemId);
    button.disabled = true;
    feedbackNode.textContent = "Updating dish status…";
    errorNode.textContent = "";

    try {
      // The database validates role, tenant and allowed status transitions.
      const { data, error } = await supabase.rpc("set_kot_item_status", {
        p_panel_token: currentAccess.token,
        p_item_id: itemId,
        p_new_status: newStatus
      });

      if (error) throw error;
      if (data === false || data?.ok === false) {
        throw new Error("The kitchen status change was rejected.");
      }

      feedbackNode.textContent = "Dish status updated.";
      await loadQueue({ quiet: true });
    } catch (error) {
      console.error("KOT status update failed:", error);
      feedbackNode.textContent = "";
      errorNode.textContent = String(error?.message || "").trim() ||
        "The dish status could not be changed. Refresh and try again.";
    } finally {
      busyItems.delete(itemId);
      if (!disposed) renderQueue();
    }
  }

  async function changeTableStatus(itemIds, action, button) {
    if (!Array.isArray(itemIds) || !itemIds.length || !["ready", "undo_ready"].includes(action) || disposed) return;
    const currentAccess = window.__RMS_PANEL_ACCESS__;
    if (!["kot", "manager"].includes(currentAccess?.panelId) || !currentAccess.token || currentAccess.expiresAt <= Date.now()) {
      errorNode.textContent = "Kitchen access has expired. Please verify the PIN again.";
      return;
    }
    const previousHTML = button.innerHTML;
    itemIds.forEach(id => busyItems.add(id));
    button.disabled = true;
    button.innerHTML = '<i class="ph-bold ph-spinner-gap ph-spin"></i> Updating';
    errorNode.textContent = "";
    try {
      const { data, error } = await supabase.rpc("set_kot_table_ready", {
        p_panel_token: currentAccess.token,
        p_item_ids: itemIds,
        p_action: action
      });
      if (error) throw error;
      if (data === false || data?.ok === false) throw new Error("The table status change was rejected.");
      feedbackNode.textContent = action === "ready" ? "All eligible dishes on the table are marked ready." : "Table readiness has been undone.";
      await loadQueue({ quiet: true });
    } catch (error) {
      console.error("KOT table status update failed:", error);
      errorNode.textContent = error?.message || "Could not update the table. Refresh and try again.";
      button.disabled = false;
      button.innerHTML = previousHTML;
    } finally {
      itemIds.forEach(id => busyItems.delete(id));
      if (!disposed) renderQueue();
    }
  }

  function handleQueueClick(event) {
    const tableButton = event.target.closest("[data-kot-table-action]");
    if (tableButton) {
      let itemIds = [];
      try { itemIds = JSON.parse(tableButton.dataset.itemIds || "[]"); } catch { itemIds = []; }
      void changeTableStatus(itemIds, tableButton.dataset.kotTableAction, tableButton);
      return;
    }

    const button = event.target.closest("[data-kot-action]");
    if (!button) return;

    const itemId = button.dataset.itemId;
    const newStatus = button.dataset.kotAction;
    if (!itemId || !newStatus) return;

    changeItemStatus(itemId, newStatus, button);
  }

  function handleRefresh() {
    loadQueue();
  }

  function handleBack() {
    const isManager = window.__RMS_PANEL_ACCESS__?.panelId === "manager";

    if (!isManager) {
      requestPanelSignOut({ confirmExit: true });
      return;
    }

    if (isManager) {
      history.pushState(
        {},
        "",
        `${location.pathname}${location.search}#/workspace/manager`
      );
    } else {
      window.__RMS_PANEL_ACCESS__ = null;

      history.pushState(
        {},
        "",
        `${location.pathname}${location.search}#/panels`
      );
    }

    window.dispatchEvent(new Event("rms:navigate"));
  }

  function scheduleRefresh() {
    if (disposed) return;
    if (refreshTimer) window.clearTimeout(refreshTimer);

    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      loadQueue({ quiet: true });
    }, 250);
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "visible") scheduleRefresh();
  }

  queueNode.addEventListener("click", handleQueueClick);
  refreshButton.addEventListener("click", handleRefresh);
  mount.querySelector("[data-kot-back]").addEventListener("click", handleBack);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  // Realtime helps the kitchen react quickly; polling is the recovery fallback.
  if (tenantId && typeof supabase.channel === "function") {
    channel = supabase
      .channel(`kot-${tenantId}-${Date.now()}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "orders",
          filter: `restaurant_id=eq.${tenantId}`
        },
        scheduleRefresh
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "order_items",
          filter: `restaurant_id=eq.${tenantId}`
        },
        scheduleRefresh
      )
      .subscribe();
  }

  pollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      loadQueue({ quiet: true });
    }
  }, 15000);

  void loadQueue();

  return () => {
    disposed = true;

    if (pollTimer) window.clearInterval(pollTimer);
    if (refreshTimer) window.clearTimeout(refreshTimer);
    panelSignOutCleanup?.();

    document.removeEventListener("visibilitychange", handleVisibilityChange);
    queueNode.removeEventListener("click", handleQueueClick);
    refreshButton.removeEventListener("click", handleRefresh);

    if (channel) {
      supabase.removeChannel(channel).catch(error => {
        console.warn("KOT channel cleanup failed:", error);
      });
    }

    rows = [];
    busyItems.clear();
  };
}