
import { supabase } from "../core/supabase.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(value) {
  if (!value) return "Time unavailable";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Time unavailable";
  }

  return date.toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export async function renderCancellationApprovals(area) {
  let requests = [];
  let loading = false;
  let disposed = false;
  let decisionInFlight = false;

  const tenantId = window.__ACTIVE_TENANT__?.id;

  function renderShell() {
    area.innerHTML = `
      <style>
        .cancel-approval-page {
          display: grid;
          gap: 16px;
        }

        .cancel-approval-note {
          padding: 13px 15px;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: var(--cream-100);
          color: var(--muted);
          font-size: 12px;
          line-height: 1.6;
        }

        .cancel-approval-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .cancel-approval-refresh {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          min-height: 38px;
          padding: 0 12px;
          border: 1px solid var(--line);
          border-radius: 11px;
          background: var(--paper);
          color: var(--forest-900);
          font: inherit;
          font-size: 12px;
          font-weight: 800;
          cursor: pointer;
        }

        .cancel-approval-refresh:disabled,
        .cancel-approval-actions button:disabled {
          opacity: .55;
          cursor: wait;
        }

        .cancel-approval-list {
          display: grid;
          gap: 12px;
        }

        .cancel-approval-card {
          min-width: 0;
          padding: 17px;
          border: 1px solid var(--line);
          border-radius: 15px;
          background: var(--paper);
        }

        .cancel-approval-card-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }

        .cancel-approval-card h3 {
          margin: 0;
          font-size: 15px;
          overflow-wrap: anywhere;
        }

        .cancel-approval-meta {
          margin-top: 5px;
          color: var(--muted);
          font-size: 11px;
          line-height: 1.6;
        }

        .cancel-approval-badge {
          flex-shrink: 0;
          padding: 5px 8px;
          border-radius: 8px;
          background: #fff7ed;
          color: #9a3412;
          font-size: 10px;
          font-weight: 850;
          text-transform: uppercase;
        }

        .cancel-approval-reason {
          margin-top: 14px;
          padding: 11px 12px;
          border-radius: 10px;
          background: var(--cream-100);
          font-size: 12px;
          line-height: 1.6;
          overflow-wrap: anywhere;
        }

        .cancel-approval-reason strong {
          display: block;
          margin-bottom: 4px;
          color: var(--forest-900);
        }

        .cancel-approval-actions {
          display: flex;
          align-items: center;
          gap: 9px;
          flex-wrap: wrap;
          margin-top: 14px;
        }

        .cancel-approval-actions button {
          min-height: 39px;
          padding: 0 12px;
          border-radius: 10px;
          font: inherit;
          font-size: 12px;
          font-weight: 800;
          cursor: pointer;
        }

        .cancel-approval-actions .approve {
          border: 1px solid var(--forest-900);
          background: var(--forest-900);
          color: white;
        }

        .cancel-approval-actions .reject {
          border: 1px solid var(--line);
          background: var(--paper);
          color: var(--forest-900);
        }

        .cancel-approval-actions .reason-input {
          width: 100%;
          min-height: 70px;
          padding: 10px 12px;
          box-sizing: border-box;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: var(--paper);
          color: var(--forest-950);
          font: inherit;
          font-size: 12px;
          resize: vertical;
        }

        .cancel-approval-actions [data-decision-form] {
          display: grid;
          gap: 9px;
          flex: 1 1 100%;
        }

        .cancel-approval-empty {
          display: grid;
          justify-items: center;
          place-content: center;
          min-height: 175px;
          padding: 22px;
          border: 1px dashed var(--line);
          border-radius: 14px;
          background: var(--paper);
          text-align: center;
        }

        .cancel-approval-empty i {
          color: var(--forest-700);
          font-size: 29px;
        }

        .cancel-approval-empty strong {
          margin-top: 10px;
          font-size: 14px;
        }

        .cancel-approval-empty p {
          max-width: 390px;
          margin: 6px 0 0;
          color: var(--muted);
          font-size: 12px;
          line-height: 1.6;
        }

        .cancel-approval-error {
          color: var(--danger);
          font-size: 12px;
          line-height: 1.6;
        }

        @media (max-width: 550px) {
          .cancel-approval-card {
            padding: 14px;
          }

          .cancel-approval-card-head {
            flex-direction: column;
          }

          .cancel-approval-actions button {
            flex: 1;
          }
        }
      </style>

      <section class="section-title-row">
        <div>
          <span class="eyebrow">Admin · Operational control</span>
          <h1>Cancellation Approvals</h1>
          <p>Review requests for dishes already preparing or ready.</p>
        </div>
      </section>

      <section class="cancel-approval-page">
        <div class="cancel-approval-note">
          A dish remains active until an authorized Admin decision is
          confirmed by the server. Approving cancellation must update the
          kitchen queue, billing state and relevant notifications together.
        </div>

        <div class="cancel-approval-toolbar">
          <strong>Pending requests</strong>

          <button
            type="button"
            class="cancel-approval-refresh"
            data-approval-refresh
          >
            <i class="ph-bold ph-arrows-clockwise"></i>
            Refresh
          </button>
        </div>

        <div
          class="cancel-approval-error"
          data-approval-error
          role="status"
          aria-live="polite"
        ></div>

        <div class="cancel-approval-list" data-approval-list>
          <div class="cancel-approval-empty">
            <i class="ph-bold ph-spinner-gap ph-spin"></i>
            <strong>Loading approval requests</strong>
            <p>Please wait while the request list is loaded.</p>
          </div>
        </div>
      </section>
    `;

    area.querySelector("[data-approval-refresh]")
      ?.addEventListener("click", loadRequests);
  }

  function renderRequests() {
    const list = area.querySelector("[data-approval-list]");
    if (!list) return;

    if (!requests.length) {
      list.innerHTML = `
        <div class="cancel-approval-empty">
          <i class="ph-bold ph-check-circle"></i>
          <strong>No pending cancellation requests</strong>
          <p>
            When a Captain requests cancellation of a dish that has started
            preparation, the request will appear here.
          </p>
        </div>
      `;
      return;
    }

    list.innerHTML = requests.map(request => {
      const isTakeaway = request.order_type === "takeaway";

      const location = isTakeaway
        ? `Takeaway #${escapeHtml(request.order_number ?? "")}`
        : `Table ${escapeHtml(request.table_label ?? "—")}`;

      const quantity = Number(request.quantity ?? 1);

      return `
        <article
          class="cancel-approval-card"
          data-approval-card="${escapeHtml(request.request_id)}"
        >
          <div class="cancel-approval-card-head">
            <div>
              <h3>${escapeHtml(request.item_name || "Dish cancellation request")}</h3>
              <div class="cancel-approval-meta">
                ${location}
                · Quantity ${escapeHtml(quantity)}
                <br>
                Requested ${escapeHtml(formatTime(request.requested_at))}
                ${request.requested_by_label
                  ? ` · By ${escapeHtml(request.requested_by_label)}`
                  : ""}
              </div>
            </div>

            <span class="cancel-approval-badge">
              ${escapeHtml(request.item_status || "Pending approval")}
            </span>
          </div>

          <div class="cancel-approval-reason">
            <strong>Captain's reason</strong>
            ${escapeHtml(request.request_reason || "No reason supplied")}
          </div>

          <div class="cancel-approval-actions">
            <button
              type="button"
              class="approve"
              data-approval-decision="approve"
              data-request-id="${escapeHtml(request.request_id)}"
            >
              <i class="ph-bold ph-check"></i>
              Approve cancellation
            </button>

            <button
              type="button"
              class="reject"
              data-approval-decision="reject"
              data-request-id="${escapeHtml(request.request_id)}"
            >
              <i class="ph-bold ph-x"></i>
              Reject request
            </button>
          </div>
        </article>
      `;
    }).join("");
  }

  async function loadRequests() {
    if (disposed || loading) return;

    if (!supabase || !tenantId) {
      const errorNode = area.querySelector("[data-approval-error]");
      if (errorNode) {
        errorNode.textContent =
          "The restaurant context or database client is unavailable.";
      }
      return;
    }

    loading = true;

    const refreshButton = area.querySelector("[data-approval-refresh]");
    const errorNode = area.querySelector("[data-approval-error]");

    if (refreshButton) refreshButton.disabled = true;
    if (errorNode) errorNode.textContent = "";

    try {
      /*
       * Database contract installed by the TableForge master migration:
       *
       * get_admin_cancellation_requests(p_restaurant_id uuid)
       *
       * Must return only pending requests for the authorized restaurant,
       * with request_id, order_type, order_number, table_label, item_name,
       * quantity, item_status, request_reason, requested_at and
       * requested_by_label where available.
       *
       * restaurant_id is client context, NOT proof of Admin authorization.
       * The database must validate ownership and Admin PIN authorization.
       */
      const { data, error } = await supabase.rpc(
        "get_admin_cancellation_requests",
        {
          p_restaurant_id: tenantId,
          p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null
        }
      );

      if (error) throw error;

      if (!Array.isArray(data)) {
        throw new Error("Unexpected approval queue response.");
      }

      if (disposed) return;

      requests = data;
      renderRequests();
    } catch (error) {
      console.error("Cancellation approval list failed:", error);

      if (errorNode) {
        errorNode.textContent =
          "The approval list could not be loaded. The database function may not yet be installed.";
      }

      const list = area.querySelector("[data-approval-list]");

      if (list) {
        list.innerHTML = `
          <div class="cancel-approval-empty">
            <i class="ph-bold ph-warning-circle"></i>
            <strong>Approval service unavailable</strong>
            <p>
              No cancellation decision has been made. Refresh after the
              server-side approval functions are available.
            </p>
          </div>
        `;
      }
    } finally {
      loading = false;

      if (refreshButton) refreshButton.disabled = false;
    }
  }

  async function decideRequest(requestId, decision, reason, button, card) {
    if (decisionInFlight || disposed) return;

    if (!reason.trim()) {
      const errorNode = card.querySelector("[data-approval-decision-error]");

      if (errorNode) {
        errorNode.textContent = "Enter a reason for this decision.";
      }

      return;
    }

    const requestExists = requests.some(
      request => String(request.request_id) === String(requestId)
    );

    if (!requestExists) {
      const errorNode = area.querySelector("[data-approval-error]");

      if (errorNode) {
        errorNode.textContent =
          "This request is no longer in the current list. Refresh and try again.";
      }

      return;
    }

    decisionInFlight = true;

    const originalHTML = button.innerHTML;
    button.disabled = true;
    button.innerHTML =
      '<i class="ph-bold ph-spinner-gap ph-spin"></i> Saving…';

    const errorNode = card.querySelector("[data-approval-decision-error]");

    if (errorNode) errorNode.textContent = "";

    try {
      /*
       * Database contract installed by the TableForge master migration:
       *
       * decide_dish_cancellation(
       *   p_restaurant_id uuid,
       *   p_request_id uuid,
       *   p_decision text,       -- 'approve' or 'reject'
       *   p_reason text
       * )
       *
       * It must atomically:
       * - verify Admin authorization and restaurant ownership;
       * - lock and validate the pending request and current dish status;
       * - on approve, record the cancellation instead of deleting history;
       * - on reject, leave the dish active;
       * - write an audit record and durable notifications for the relevant
       *   roles; and
       * - reject repeated or stale decisions without duplicate side effects.
       */
      const { data, error } = await supabase.rpc(
        "decide_dish_cancellation",
        {
          p_restaurant_id: tenantId,
          p_request_id: requestId,
          p_decision: decision,
          p_reason: reason.trim(),
          p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null
        }
      );

      if (error) throw error;

      if (
        data === false ||
        data?.ok === false ||
        data?.success === false
      ) {
        throw new Error("The server did not confirm this decision.");
      }

      requests = requests.filter(
        request => String(request.request_id) !== String(requestId)
      );

      renderRequests();

      const statusNode = area.querySelector("[data-approval-error]");

      if (statusNode) {
        statusNode.style.color = "var(--forest-800)";
        statusNode.textContent = decision === "approve"
          ? "Cancellation approved by the server. The item and its notifications have been updated."
          : "Request rejected by the server. The dish remains active.";
      }
    } catch (error) {
      console.error("Cancellation decision failed:", error);

      if (errorNode) {
        errorNode.textContent =
          "The decision was not confirmed. The request remains unresolved.";
      }

      button.disabled = false;
      button.innerHTML = originalHTML;
    } finally {
      decisionInFlight = false;
    }
  }

  function handleApprovalClick(event) {
    const button = event.target.closest("[data-approval-decision]");
    if (!button) return;

    const card = button.closest("[data-approval-card]");
    const requestId = button.dataset.requestId;
    const decision = button.dataset.approvalDecision;

    if (!card || !requestId) return;

    const existingForm = card.querySelector("[data-decision-form]");

    if (existingForm) {
      existingForm.remove();
      return;
    }

    const form = document.createElement("form");
    form.dataset.decisionForm = "";
    form.className = "cancel-approval-actions";

    const field = document.createElement("label");
    field.className = "field";
    field.style.width = "100%";

    const label = document.createElement("span");
    label.textContent = decision === "approve"
      ? "Reason for approving cancellation *"
      : "Reason for rejecting request *";

    const textarea = document.createElement("textarea");
    textarea.className = "reason-input";
    textarea.required = true;
    textarea.maxLength = 300;
    textarea.rows = 3;
    textarea.placeholder = decision === "approve"
      ? "Why is cancellation authorized?"
      : "Why is cancellation not approved?";

    const error = document.createElement("p");
    error.dataset.approvalDecisionError = "";
    error.className = "cancel-approval-error";
    error.setAttribute("role", "alert");

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = decision === "approve" ? "approve" : "reject";
    submit.textContent = decision === "approve"
      ? "Confirm approval"
      : "Confirm rejection";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "reject";
    cancel.textContent = "Cancel";

    field.append(label, textarea);
    form.append(field, error, submit, cancel);
    card.appendChild(form);

    textarea.focus();

    form.addEventListener("submit", event => {
      event.preventDefault();

      void decideRequest(
        requestId,
        decision,
        textarea.value,
        submit,
        card
      );
    });

    cancel.addEventListener("click", () => form.remove());
  }

  renderShell();

  area.addEventListener("click", handleApprovalClick);

  await loadRequests();

  return () => {
    disposed = true;
    area.removeEventListener("click", handleApprovalClick);
    requests = [];
  };
}
