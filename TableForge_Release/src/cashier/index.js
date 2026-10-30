
import { render as renderPOS } from "../pos/index.js";
import { supabase } from "../core/supabase.js";
import { showToast, openAppModal } from "../components/navigation.js";
import { installPanelSignOut, requestPanelSignOut } from "../core/panelSession.js";

let cashierPaymentOutsideClickInstalled = false;

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

export async function render({ mount, route }) {
  let disposed = false;
  let posCleanup = null;
  let activeView = "home";
  let queueRows = [];
  let panelSignOutCleanup = null;

  function hasCashierAccess() {
    const access = window.__RMS_PANEL_ACCESS__;

    return (
      ["cashier", "manager"].includes(access?.panelId) &&
      typeof access.token === "string" &&
      access.token.length >= 20 &&
      Number.isFinite(access.expiresAt) &&
      access.expiresAt > Date.now()
    );
  }

  function returnToWorkspaces() {
    const isManager = window.__RMS_PANEL_ACCESS__?.panelId === "manager";

    if (isManager) {
      history.pushState(
        {},
        "",
        `${location.pathname}${location.search}#/workspace/manager`
      );
    } else {
      requestPanelSignOut({ confirmExit: true });
      return;
    }

    window.dispatchEvent(new Event("rms:navigate"));
  }

  function renderLockedState() {
    mount.innerHTML = `
      <section class="access-screen">
        <div class="access-card" style="text-align:center;">
          <i
            class="ph-bold ph-lock-key"
            style="font-size:32px;color:var(--forest-900);"
          ></i>

          <h1>Cashier access required</h1>

          <p class="access-copy">
            Verify the Cashier panel PIN before accessing orders and bills.
          </p>

          <button
            type="button"
            class="btn btn-primary"
            data-cashier-return
            style="width:100%;justify-content:center;"
          >
            Return to workspaces
          </button>
        </div>
      </section>
    `;

    mount.querySelector("[data-cashier-return]")
      ?.addEventListener("click", returnToWorkspaces);
  }

  function renderHome() {
    activeView = "home";

    mount.innerHTML = `
      <section class="cashier-home">
        <style>
          .cashier-home {
            min-height: 100vh;
            padding: 24px;
            box-sizing: border-box;
            background: var(--cream-100);
            color: var(--forest-950);
            font-family: var(--ui-font);
          }

          .cashier-container {
            width: min(920px, 100%);
            margin: 0 auto;
          }

          .cashier-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 14px;
            margin-bottom: 32px;
          }

          .cashier-header h1 {
            margin: 0;
            font-size: 25px;
            letter-spacing: -.03em;
          }

          .cashier-header p {
            margin: 5px 0 0;
            color: var(--muted);
            font-size: 13px;
          }

          .cashier-icon-button {
            width: 42px;
            height: 42px;
            display: grid;
            place-items: center;
            flex-shrink: 0;
            border: 1px solid var(--line);
            border-radius: 13px;
            background: var(--paper);
            color: var(--forest-900);
            cursor: pointer;
            font-size: 18px;
          }

          .cashier-actions {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 14px;
          }

          .cashier-action {
            display: flex;
            align-items: center;
            gap: 14px;
            min-height: 104px;
            padding: 20px;
            border: 1px solid var(--line);
            border-radius: 18px;
            background: var(--paper);
            text-align: left;
            color: inherit;
            cursor: pointer;
            font: inherit;
            transition: border-color .18s ease, background .18s ease;
          }

          .cashier-action:hover {
            border-color: var(--forest-700);
            background: var(--sage-100);
          }

          .cashier-action-icon {
            display: grid;
            place-items: center;
            width: 48px;
            height: 48px;
            flex-shrink: 0;
            border-radius: 14px;
            background: var(--sage-100);
            color: var(--forest-900);
            font-size: 23px;
          }

          .cashier-action-copy {
            flex: 1;
            min-width: 0;
          }

          .cashier-action-copy strong {
            display: block;
            font-size: 15px;
          }

          .cashier-action-copy small {
            display: block;
            margin-top: 5px;
            color: var(--muted);
            font-size: 12px;
            line-height: 1.5;
          }

          .cashier-action-arrow {
            flex-shrink: 0;
            color: var(--forest-800);
            font-size: 17px;
          }

          .cashier-access-note {
            margin-top: 20px;
            color: var(--muted);
            font-size: 12px;
            line-height: 1.6;
          }

          .cashier-status {
            margin-top: 14px;
            color: var(--danger);
            font-size: 13px;
          }

          @media (max-width: 600px) {
            .cashier-home {
              padding: 18px 14px;
            }

            .cashier-actions {
              grid-template-columns: minmax(0, 1fr);
              gap: 10px;
            }

            .cashier-action {
              min-height: 82px;
              padding: 15px;
            }

            .cashier-header {
              margin-bottom: 24px;
            }

            .cashier-header h1 {
              font-size: 22px;
            }
          }
        </style>

        <div class="cashier-container">
          <header class="cashier-header">
            <div style="display:flex;align-items:center;gap:12px;">
              <button
                type="button"
                class="cashier-icon-button"
                data-cashier-workspaces
                aria-label="Return to workspaces"
                title="Return to workspaces"
              >
                <i class="ph-bold ph-arrow-left"></i>
              </button>

              <div>
                <h1>Cashier</h1>
                <p>Takeaway and billing</p>
              </div>
            </div>
          </header>

          <div class="cashier-actions">
            <button
              class="cashier-action"
              type="button"
              data-cashier-new-order
            >
              <span class="cashier-action-icon">
                <i class="ph-bold ph-shopping-bag"></i>
              </span>
              <span class="cashier-action-copy">
                <strong>New takeaway order</strong>
                <small>Create an order and send it to the kitchen.</small>
              </span>
              <i class="ph-bold ph-arrow-up-right cashier-action-arrow"></i>
            </button>

            <button
              class="cashier-action"
              type="button"
              data-cashier-bill-queue
            >
              <span class="cashier-action-icon">
                <i class="ph-bold ph-receipt"></i>
              </span>
              <span class="cashier-action-copy">
                <strong>Bill requests</strong>
                <small>View requests from dine-in and takeaway orders.</small>
              </span>
              <i class="ph-bold ph-arrow-up-right cashier-action-arrow"></i>
            </button>
          </div>

          <p class="cashier-access-note">
            The Cashier creates takeaway orders and manages billing.
            A bill request does not mean payment has been received.
          </p>

          <div class="cashier-status" data-cashier-status role="status" aria-live="polite"></div>
        </div>
      </section>
    `;

    panelSignOutCleanup?.();
    panelSignOutCleanup = installPanelSignOut({ mount, panelId: "cashier" });

    mount.querySelector("[data-cashier-workspaces]")
      ?.addEventListener("click", returnToWorkspaces);

    mount.querySelector("[data-cashier-new-order]")
      ?.addEventListener("click", openNewTakeawayOrder);

    mount.querySelector("[data-cashier-bill-queue]")
      ?.addEventListener("click", loadBillQueue);
  }

  async function openNewTakeawayOrder() {
    panelSignOutCleanup?.();
    panelSignOutCleanup = null;
    if (disposed || !hasCashierAccess()) {
      const previousAccess = window.__RMS_PANEL_ACCESS__;
      const isManagerSession = previousAccess?.panelId === "manager";

      window.__RMS_PANEL_ACCESS__ = null;

      if (disposed) return;

      history.replaceState(
        {},
        "",
        `${location.pathname}${location.search}#/panel/${isManagerSession ? "manager" : "cashier"}`
      );

      window.dispatchEvent(new Event("rms:navigate"));
      return;
    }

    activeView = "order";

    try {
      const pos = await import("../pos/index.js");

      if (disposed) return;

      posCleanup = await pos.render({
        mount,
        route: {
          ...(route || {}),
          name: "cashier",
          panelId: "cashier"
        }
      });
    } catch (error) {
      console.error("Cashier order screen failed to open:", error);
      renderHome();

      const status = mount.querySelector("[data-cashier-status]");

      if (status) {
        status.textContent =
          "The takeaway order screen could not be opened. Please try again.";
      }
    }
  }

  function renderBillQueueLoading() {
    activeView = "queue";

    mount.innerHTML = `
      <section class="access-screen">
        <div class="access-card">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;">
            <button
              type="button"
              class="cashier-icon-button"
              data-cashier-home
              aria-label="Back to Cashier"
            >
              <i class="ph-bold ph-arrow-left"></i>
            </button>

            <div>
              <h1 style="margin:0;font-size:23px;">Bill requests</h1>
              <p class="access-copy" style="margin:5px 0 0;">
                Requests waiting for cashier attention
              </p>
            </div>
          </div>

          <div data-cashier-queue-content>
            <div style="text-align:center;padding:30px 0;color:var(--muted);">
              <i class="ph-bold ph-spinner-gap ph-spin" style="font-size:26px;"></i>
              <p>Loading requests…</p>
            </div>
          </div>

          <p
            data-cashier-queue-error
            role="status"
            aria-live="polite"
            style="color:var(--danger);font-size:12px;"
          ></p>
        </div>
      </section>
    `;

    panelSignOutCleanup?.();
    panelSignOutCleanup = installPanelSignOut({ mount, panelId: "cashier" });

    mount.querySelector("[data-cashier-home]")
      ?.addEventListener("click", renderHome);
  }

  function renderQueueRows(rows) {
    const content = mount.querySelector("[data-cashier-queue-content]");
    if (!content) return;

    if (!rows.length) {
      content.innerHTML = `
        <div class="empty-state compact" style="padding:28px 10px;text-align:center;">
          <i class="ph ph-check-circle" style="font-size:28px;"></i>
          <strong>No pending bill requests</strong>
          <span>New requests will appear here when available.</span>
        </div>
      `;
      return;
    }

    content.innerHTML = rows.map(row => {
      const orderType = String(row.order_type || "");
      const isTakeaway = orderType === "takeaway";
      const billingStatus = String(row.billing_status || "bill_requested");

      const title = isTakeaway
        ? `Takeaway #${escapeHtml(row.order_number ?? "")}`
        : `Table ${escapeHtml(row.table_label ?? "—")}`;

      const time = escapeHtml(formatTime(row.bill_requested_at));

      const total = row.grand_total == null
        ? ""
        : `<strong>${escapeHtml(row.currency_symbol || "")}${escapeHtml(row.grand_total)}</strong>`;

      const canOpenBill = isTakeaway
        ? Boolean(row.order_id)
        : Boolean(row.session_id);

      const actionLabel = ["bill_ready", "issued"].includes(billingStatus)
        ? "Open / Reprint Bill"
        : "Generate Bill";

      return `
        <article
          style="padding:14px 0;border-bottom:1px solid var(--line);"
        >
          <div
            style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;"
          >
            <div style="min-width:0;">
              <strong style="font-size:14px;">${title}</strong>
              <div style="margin-top:5px;color:var(--muted);font-size:12px;">
                ${time}
              </div>
            </div>

            ${total}
          </div>

          <div
            style="margin-top:8px;color:var(--muted);font-size:11px;"
          >
            ${isTakeaway ? "Takeaway bill" : "Dine-in bill request"}
          </div>

          <div class="field tf-payment-field" style="display:block;margin-top:12px;">
            <span class="tf-payment-field-label">Payment method <b>Required</b></span>
            <div class="tf-payment-picker" data-cashier-payment-picker>
              <button
                type="button"
                class="tf-payment-trigger"
                data-payment-trigger
                aria-haspopup="listbox"
                aria-expanded="false"
              >
                <span class="tf-payment-selected-icon"><i class="ph-bold ph-wallet"></i></span>
                <span class="tf-payment-selected-text" data-payment-label>Choose payment method</span>
                <i class="ph-bold ph-caret-down tf-payment-caret"></i>
              </button>
              <div class="tf-payment-options" data-payment-options role="listbox" hidden>
                <button type="button" role="option" aria-selected="false" data-payment-value="upi_qr">
                  <span class="tf-payment-option-icon"><i class="ph-bold ph-qr-code"></i></span>
                  <span><strong>UPI QR</strong><small>Scan and pay</small></span>
                  <i class="ph-bold ph-check tf-payment-option-check"></i>
                </button>
                <button type="button" role="option" aria-selected="false" data-payment-value="cash">
                  <span class="tf-payment-option-icon"><i class="ph-bold ph-money"></i></span>
                  <span><strong>Cash</strong><small>Pay at the counter</small></span>
                  <i class="ph-bold ph-check tf-payment-option-check"></i>
                </button>
                <button type="button" role="option" aria-selected="false" data-payment-value="card">
                  <span class="tf-payment-option-icon"><i class="ph-bold ph-credit-card"></i></span>
                  <span><strong>Card</strong><small>Debit or credit card</small></span>
                  <i class="ph-bold ph-check tf-payment-option-check"></i>
                </button>
                <button type="button" role="option" aria-selected="false" data-payment-value="bank_transfer">
                  <span class="tf-payment-option-icon"><i class="ph-bold ph-bank"></i></span>
                  <span><strong>Bank transfer</strong><small>Direct account transfer</small></span>
                  <i class="ph-bold ph-check tf-payment-option-check"></i>
                </button>
              </div>
            </div>
          </div>
          <button
            type="button"
            class="btn btn-primary"
            data-cashier-generate-bill
            data-order-type="${escapeHtml(orderType)}"
            data-order-id="${escapeHtml(row.order_id || "")}"
            data-session-id="${escapeHtml(row.session_id || "")}"
            ${canOpenBill ? "disabled" : "disabled"}
            style="width:100%;justify-content:center;margin-top:12px;"
          >
            <i class="ph-bold ph-receipt"></i>
            ${actionLabel}
          </button>
        </article>
      `;
    }).join("");

    const errorNode = mount.querySelector("[data-cashier-queue-error]");

    // One delegated listener is enough for every queue row. Installing a
    // document listener inside each picker would leak handlers on every refresh.
    if (!cashierPaymentOutsideClickInstalled) {
      document.addEventListener("click", event => {
        const clickedPicker = event.target?.closest?.("[data-cashier-payment-picker]");
        document.querySelectorAll("[data-cashier-payment-picker]").forEach(openPicker => {
          if (openPicker === clickedPicker) return;
          const menu = openPicker.querySelector("[data-payment-options]");
          const trigger = openPicker.querySelector("[data-payment-trigger]");
          if (menu) menu.hidden = true;
          trigger?.setAttribute("aria-expanded", "false");
          openPicker.classList.remove("is-open");
        });
      });
      cashierPaymentOutsideClickInstalled = true;
    }

    content.querySelectorAll("[data-cashier-payment-picker]").forEach(picker => {
      const trigger = picker.querySelector("[data-payment-trigger]");
      const options = picker.querySelector("[data-payment-options]");
      const label = picker.querySelector("[data-payment-label]");
      const article = picker.closest("article");
      const generateButton = article?.querySelector("[data-cashier-generate-bill]");

      const closeOptions = () => {
        options.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        picker.classList.remove("is-open");
      };

      trigger.addEventListener("click", () => {
        const willOpen = options.hidden;
        content.querySelectorAll("[data-payment-options]").forEach(menu => {
          menu.hidden = true;
          menu.closest("[data-cashier-payment-picker]")?.classList.remove("is-open");
          menu.closest("[data-cashier-payment-picker]")?.querySelector("[data-payment-trigger]")?.setAttribute("aria-expanded", "false");
        });

        options.hidden = !willOpen;
        trigger.setAttribute("aria-expanded", String(willOpen));
        picker.classList.toggle("is-open", willOpen);
      });

      picker.querySelectorAll("[data-payment-value]").forEach(option => {
        option.addEventListener("click", () => {
          const value = option.dataset.paymentValue;
          const title = option.querySelector("strong")?.textContent || "Payment method";
          const icon = option.querySelector(".tf-payment-option-icon")?.innerHTML || "";

          picker.dataset.value = value;
          label.textContent = title;
          picker.querySelector(".tf-payment-selected-icon").innerHTML = icon;

          picker.querySelectorAll("[data-payment-value]").forEach(item => {
            const selected = item.dataset.paymentValue === value;
            item.setAttribute("aria-selected", String(selected));
            item.classList.toggle("is-selected", selected);
          });

          if (generateButton) generateButton.disabled = false;
          closeOptions();
        });
      });

      if (generateButton) generateButton.disabled = true;
    });

    content.querySelectorAll("[data-cashier-generate-bill]").forEach(button => {
      button.addEventListener("click", async () => {
        if (button.disabled) return;

        const access = window.__RMS_PANEL_ACCESS__;

        if (
          access?.panelId !== "cashier" ||
          !access.token ||
          !Number.isFinite(access.expiresAt) ||
          access.expiresAt <= Date.now()
        ) {
          window.__RMS_PANEL_ACCESS__ = null;

          history.replaceState(
            {},
            "",
            `${location.pathname}${location.search}#/panel/cashier`
          );

          window.dispatchEvent(new Event("rms:navigate"));
          return;
        }

        const orderType = button.dataset.orderType;
        const orderId = button.dataset.orderId || null;
        const sessionId = button.dataset.sessionId || null;
        const paymentMethod = button.closest("article")?.querySelector("[data-cashier-payment-picker]")?.dataset.value;
        if (!["upi_qr", "cash", "card", "bank_transfer"].includes(paymentMethod)) {
          if (errorNode) errorNode.textContent = "Choose a payment method before generating the bill.";
          return;
        }

        if (
          (orderType === "takeaway" && !orderId) ||
          (orderType === "dine_in" && !sessionId)
        ) {
          if (errorNode) {
            errorNode.textContent =
              "The required order or dining session ID is missing.";
          }
          return;
        }

        const originalHTML = button.innerHTML;

        button.disabled = true;
        button.innerHTML = `
          <i class="ph-bold ph-spinner-gap ph-spin"></i>
          Preparing bill…
        `;

        if (errorNode) errorNode.textContent = "";

        let billWasGenerated = false;
        try {
          /*
           * Database contract installed by the TableForge master migration:
           *
           * generate_cashier_bill(
           *   p_panel_token text,
           *   p_order_id uuid,
           *   p_session_id uuid
           * ) RETURNS jsonb
           *
           * The response must contain:
           * {
           *   order: {...authoritative saved totals},
           *   items: [...billable item snapshots],
           *   settings: {...receipt settings},
           *   tables: [...relevant table records],
           *   table_string: "Takeaway #123" or "Dine-in · Table 8"
           * }
           *
           * Exactly one of p_order_id and p_session_id is supplied.
           * The database must enforce tenant and panel authorization,
           * idempotency, item cancellation rules and correct bill totals.
           */

          const { data, error } = await supabase.rpc(
            "generate_cashier_bill",
            {
              p_panel_token: access.token,
              p_order_id: orderType === "takeaway" ? orderId : null,
              p_session_id: orderType === "dine_in" ? sessionId : null
            }
          );

          if (error) throw error;

          const bill = Array.isArray(data) ? data[0] : data;

          if (
            !bill ||
            !bill.order ||
            !Array.isArray(bill.items) ||
            !bill.settings
          ) {
            throw new Error(
              "The server did not return a complete bill. No receipt was opened."
            );
          }

          if (
            orderType === "takeaway" &&
            bill.order.id !== orderId
          ) {
            throw new Error(
              "The returned bill does not match the selected takeaway order."
            );
          }

          if (orderType === "dine_in" && !sessionId) {
            throw new Error("The dining session could not be verified.");
          }
          billWasGenerated = true;

          if (paymentMethod === "upi_qr" && !String(bill.settings.upi_id || "").trim()) {
            throw new Error("UPI QR is not configured for this restaurant. Add the UPI ID under Admin → Settings, or choose another payment method.");
          }

          const { openUniversalReceipt } = await import(
            "../components/navigation.js"
          );

          const { error: methodError } = await supabase.rpc("set_bill_payment_method", {
            p_order_id: orderType === "takeaway" ? orderId : null,
            p_session_id: orderType === "dine_in" ? sessionId : null,
            p_payment_method: paymentMethod,
            p_panel_token: access.token
          });
          if (methodError) throw methodError;

          openUniversalReceipt({
            order: bill.order,
            items: bill.items,
            settings: bill.settings,
            tables: Array.isArray(bill.tables) ? bill.tables : [],
            tableString: bill.table_string ||
              (orderType === "takeaway"
                ? `Takeaway #${bill.order.order_number ?? ""}`
                : `Dine-in · Table ${bill.table_label ?? ""}`),
            modalTitle: `Bill #${bill.order.order_number ?? ""}`,
            modalSubtitle:
              `Payment method: ${{ upi_qr: "UPI QR", cash: "Cash", card: "Card", bank_transfer: "Bank transfer" }[paymentMethod] || "Selected method"}. Confirm payment only after the customer has paid.`,
            paymentMethod,
            allowPdf: true,
            extraActions: [{
              label: "Confirm payment received",
              icon: "ph-bold ph-check-circle",
              className: "btn-primary",
              onClick: ({ close }) => {
                openAppModal({
                  title: "Confirm payment",
                  subtitle: "Choose the method the customer actually used.",
                  body: `
                    <label class="field">
                      <span>Payment method *</span>
                      <select data-cashier-payment-method required disabled>
                        <option value="upi_qr" ${paymentMethod === "upi_qr" ? "selected" : ""}>UPI QR</option>
                        <option value="cash" ${paymentMethod === "cash" ? "selected" : ""}>Cash</option>
                        <option value="card" ${paymentMethod === "card" ? "selected" : ""}>Card</option>
                        <option value="bank_transfer" ${paymentMethod === "bank_transfer" ? "selected" : ""}>Bank transfer</option>
                      </select>
                    </label>
                    <p style="font-size:12px;color:var(--muted);margin-top:12px;">
                      Confirm only after you have verified receipt of payment.
                    </p>
                  `,
                  actions: [
                    { label: "Back", className: "btn-quiet", onClick: ({ close: closeMethodModal }) => closeMethodModal() },
                    {
                      label: "Confirm payment",
                      className: "btn-primary",
                      onClick: async ({ root, close: closeMethodModal, button }) => {
                        const method = root.querySelector("[data-cashier-payment-method]")?.value;
                        const access = window.__RMS_PANEL_ACCESS__;
                        if (!["upi_qr", "cash", "card", "bank_transfer"].includes(method)) {
                          showToast("Choose a method", "Select a valid payment method.", "error");
                          return;
                        }
                        if (!access?.token || !["cashier", "manager"].includes(access.panelId) || !Number.isFinite(access.expiresAt) || access.expiresAt <= Date.now()) {
                          window.__RMS_PANEL_ACCESS__ = null;
                          showToast("Access expired", "Verify the Cashier PIN again.", "error");
                          return;
                        }
                        const originalHTML = button.innerHTML;
                        button.disabled = true;
                        button.innerHTML = '<i class="ph ph-spinner-gap ph-spin"></i> Confirming…';
                        try {
                          const rpcName = orderType === "takeaway" ? "complete_takeaway_payment" : "complete_session_payment";
                          const args = orderType === "takeaway"
                            ? { p_order_id: orderId, p_payment_method: method, p_panel_token: access.token }
                            : { p_session_id: sessionId, p_payment_method: method, p_panel_token: access.token };
                          const { error } = await supabase.rpc(rpcName, args);
                          if (error) throw error;
                          closeMethodModal();
                          close();
                          const methodLabel = {
                            upi_qr: "UPI QR",
                            cash: "Cash",
                            card: "Card",
                            bank_transfer: "Bank transfer"
                          }[method] || method;
                          showToast("Payment confirmed", `Payment recorded as ${methodLabel}.`, "success");
                          if (activeView === "queue") await loadBillQueue();
                          else renderHome();
                        } catch (error) {
                          console.error("Payment confirmation failed:", error);
                          showToast("Payment not confirmed", error.message || "Please verify payment and try again.", "error");
                          button.disabled = false;
                          button.innerHTML = originalHTML;
                        }
                      }
                    }
                  ]
                });
              }
            }]
          });

        } catch (error) {
          console.error("Cashier bill generation failed:", error);

          if (errorNode) {
            const message = String(error?.message || "").trim();
            errorNode.textContent = billWasGenerated
              ? `The bill was generated, but its payment method was not saved: ${message || "Database error"}. Apply the SQL fix, then retry; do not mark this bill paid until payment is received.`
              : message
                ? `Bill generation failed: ${message}`
                : "Bill generation failed. Check your connection and try again.";
          }

          button.disabled = false;
          button.innerHTML = originalHTML;
        }
      });
    });
  }

  async function loadBillQueue() {
    if (disposed || !hasCashierAccess()) {
      window.__RMS_PANEL_ACCESS__ = null;
      renderLockedState();
      return;
    }

    if (!supabase) {
      renderHome();
      const status = mount.querySelector("[data-cashier-status]");

      if (status) {
        status.textContent = "The database connection is unavailable.";
      }

      return;
    }

    renderBillQueueLoading();

    try {
      /*
       * Database contract installed by the TableForge master migration:
       *
       * public.get_cashier_bill_queue(p_panel_token text)
       *
       * Returns an array of tenant-authorized pending billing requests:
       * order_id, order_type, order_number, table_label,
       * bill_requested_at, billing_status, grand_total, currency_symbol.
       *
       * This RPC will be implemented in the final database phase.
       */

      const { data, error } = await supabase.rpc("get_cashier_bill_queue", {
        p_panel_token: window.__RMS_PANEL_ACCESS__.token
      });

      if (error) throw error;

      if (!Array.isArray(data)) {
        throw new Error("Unexpected bill queue response.");
      }

      if (disposed || activeView !== "queue") return;

      queueRows = data;
      renderQueueRows(queueRows);
    } catch (error) {
      console.error("Cashier bill queue failed:", error);

      const content = mount.querySelector("[data-cashier-queue-content]");
      const errorNode = mount.querySelector("[data-cashier-queue-error]");

      if (content) {
        content.innerHTML = `
          <div style="padding:20px 0;color:var(--muted);font-size:13px;line-height:1.6;">
            The bill-request service is temporarily unavailable.
            Refresh after the connection is restored.
          </div>
        `;
      }

      if (errorNode) {
        errorNode.textContent = "Requests could not be loaded.";
      }
    }
  }

  if (!hasCashierAccess()) {
    renderLockedState();
  } else {
    renderHome();
  }

  return async () => {
    disposed = true;

    panelSignOutCleanup?.();
    panelSignOutCleanup = null;

    if (typeof posCleanup === "function") {
      await posCleanup();
      posCleanup = null;
    }

    queueRows = [];
  };
}
