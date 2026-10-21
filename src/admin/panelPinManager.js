
import { supabase } from "../core/supabase.js";

const PANELS = [
  { id: "captain", title: "Captain", description: "Dine-in operations" },
  { id: "kot", title: "KOT / Kitchen", description: "Kitchen operations" },
  { id: "cashier", title: "Cashier", description: "Takeaway and billing" },
  { id: "manager", title: "Manager", description: "Operational supervision" },
  { id: "admin", title: "Admin", description: "Business and system control" }
];

function normalizeResult(data) {
  return Array.isArray(data) ? data[0] : data;
}

function expiresAtMs(value) {
  if (typeof value === "number") {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  return Date.parse(value);
}

export function openPanelPinManager({ restaurantId, onNotice = () => {}, onAdminPinChanged = () => {} } = {}) {
  if (!supabase || !restaurantId) {
    onNotice(
      "The restaurant database connection is not available.",
      "error"
    );
    return;
  }

  document.querySelector("[data-panel-pin-manager-dialog]")?.remove();

  let managementToken = null;
  let managementExpiresAt = 0;
  let disposed = false;
  let submitting = false;

  const overlay = document.createElement("div");
  overlay.dataset.panelPinManagerDialog = "";

  overlay.innerHTML = `
    <style>
      .pin-manager-overlay {
        position: fixed;
        inset: 0;
        z-index: 2000;
        display: grid;
        place-items: center;
        padding: 18px;
        background: rgba(14, 24, 16, .48);
        backdrop-filter: blur(5px);
        -webkit-backdrop-filter: blur(5px);
      }

      .pin-manager-dialog {
        display: flex;
        flex-direction: column;
        width: min(100%, 880px);
        max-height: min(88vh, 820px);
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 19px;
        background: var(--paper);
        color: var(--forest-950);
        box-shadow: 0 24px 80px rgba(0, 0, 0, .2);
      }

      .pin-manager-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 20px 22px;
        border-bottom: 1px solid var(--line);
      }

      .pin-manager-header h2 {
        margin: 0 0 6px;
        font-size: 21px;
      }

      .pin-manager-header p {
        margin: 0;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.6;
      }

      .pin-manager-close {
        display: grid;
        place-items: center;
        width: 39px;
        height: 39px;
        flex-shrink: 0;
        border: 1px solid var(--line);
        border-radius: 11px;
        background: var(--paper);
        color: var(--forest-900);
        font-size: 18px;
        cursor: pointer;
      }

      .pin-manager-content {
        overflow: auto;
        padding: 20px 22px 24px;
      }

      .pin-manager-notice {
        margin-bottom: 17px;
        padding: 12px 14px;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: var(--cream-100);
        color: var(--muted);
        font-size: 12px;
        line-height: 1.6;
      }

      .pin-manager-status {
        min-height: 18px;
        margin-top: 12px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.5;
      }

      .pin-manager-error {
        color: var(--danger);
      }

      .pin-manager-verify {
        max-width: 430px;
        margin: 0 auto;
        padding: 14px 0 6px;
      }

      .pin-manager-verify h3 {
        margin: 0 0 7px;
        font-size: 16px;
      }

      .pin-manager-verify > p {
        margin: 0 0 20px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.6;
      }

      .pin-manager-verify-inputs {
        display: flex;
        gap: 8px;
      }

      .pin-manager-verify-inputs input,
      .pin-manager-new-pin input {
        width: 43px;
        height: 45px;
        min-width: 0;
        flex: 0 1 43px;
        box-sizing: border-box;
        padding: 0;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: var(--paper);
        color: var(--forest-950);
        text-align: center;
        font: 800 19px "Courier New", monospace;
      }

      .pin-manager-verify-inputs input:focus,
      .pin-manager-new-pin input:focus {
        outline: 2px solid var(--forest-700);
        outline-offset: 1px;
      }

      .pin-manager-panel-list {
        display: grid;
        gap: 11px;
      }

      .pin-manager-row {
        display: grid;
        grid-template-columns: minmax(110px, .85fr) minmax(130px, .9fr) minmax(290px, 1.55fr) auto;
        align-items: center;
        gap: 13px;
        padding: 15px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: var(--paper);
      }

      .pin-manager-role {
        min-width: 0;
      }

      .pin-manager-role strong {
        display: block;
        font-size: 13px;
      }

      .pin-manager-role span {
        display: block;
        margin-top: 4px;
        color: var(--muted);
        font-size: 11px;
        line-height: 1.4;
      }

      .pin-manager-current {
        min-width: 0;
      }

      .pin-manager-current-label,
      .pin-manager-new-label {
        display: block;
        margin-bottom: 7px;
        color: var(--muted);
        font-size: 10px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: .04em;
      }

      .pin-manager-current-value {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .pin-manager-current-value strong {
        font-size: 15px;
        letter-spacing: 3px;
      }

      .pin-manager-current-value span {
        color: var(--muted);
        font-size: 10px;
      }

      .pin-manager-new-pin {
        display: flex;
        gap: 5px;
      }

      .pin-manager-new-pin input {
        width: 34px;
        height: 39px;
        flex-basis: 34px;
        border-radius: 8px;
        font-size: 16px;
      }

      .pin-manager-save {
        min-height: 38px;
        padding: 0 12px;
        border: 1px solid var(--forest-900);
        border-radius: 10px;
        background: var(--forest-900);
        color: #fff;
        font: inherit;
        font-size: 11px;
        font-weight: 800;
        cursor: pointer;
      }

      .pin-manager-save:disabled {
        opacity: .5;
        cursor: wait;
      }

      .pin-manager-row-status {
        grid-column: 1 / -1;
        min-height: 14px;
        color: var(--muted);
        font-size: 11px;
        line-height: 1.5;
      }

      .pin-manager-row-status.error {
        color: var(--danger);
      }

      .pin-manager-row-status.success {
        color: var(--forest-800);
      }

      @media (max-width: 760px) {
        .pin-manager-overlay {
          padding: 8px;
        }

        .pin-manager-dialog {
          max-height: 94vh;
          border-radius: 15px;
        }

        .pin-manager-header {
          padding: 16px;
        }

        .pin-manager-content {
          padding: 15px;
        }

        .pin-manager-row {
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 12px;
          padding: 13px;
        }

        .pin-manager-role {
          grid-column: 1 / -1;
        }

        .pin-manager-current {
          grid-column: 1 / -1;
        }

        .pin-manager-new {
          grid-column: 1;
          min-width: 0;
        }

        .pin-manager-save {
          grid-column: 2;
          align-self: end;
        }
      }

      @media (max-width: 390px) {
        .pin-manager-verify-inputs {
          gap: 5px;
        }

        .pin-manager-verify-inputs input {
          width: 39px;
          flex-basis: 39px;
        }

        .pin-manager-new-pin {
          gap: 3px;
        }

        .pin-manager-new-pin input {
          width: 29px;
          flex-basis: 29px;
        }
      }
    </style>

    <div class="pin-manager-overlay" data-pin-overlay>
      <section
        class="pin-manager-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pin-manager-title"
      >
        <header class="pin-manager-header">
          <div>
            <h2 id="pin-manager-title">Manage Panel PINs</h2>
            <p>Securely manage all five workspace access PINs.</p>
          </div>

          <button
            type="button"
            class="pin-manager-close"
            data-pin-close
            aria-label="Close"
          >
            <i class="ph-bold ph-x"></i>
          </button>
        </header>

        <div class="pin-manager-content" data-pin-content></div>
      </section>
    </div>
  `;

  document.body.appendChild(overlay);

  const content = overlay.querySelector("[data-pin-content]");

  function closeDialog() {
    if (disposed) return;

    disposed = true;
    managementToken = null;
    managementExpiresAt = 0;

    content.querySelectorAll("input").forEach(input => {
      input.value = "";
    });

    overlay.remove();
    document.removeEventListener("keydown", handleGlobalKeydown);
  }

  function setStatus(message, isError = false) {
    const status = content.querySelector("[data-pin-status]");

    if (status) {
      status.textContent = message;
      status.classList.toggle("pin-manager-error", isError);
    }
  }

  function renderVerify(errorMessage = "") {
    content.innerHTML = `
      <div class="pin-manager-notice">
        Enter your current Admin PIN to authorize changes.
        The existing PINs will remain masked.
      </div>

      <form class="pin-manager-verify" data-pin-verify-form>
        <h3>Confirm Admin access</h3>
        <p>
          Enter the six-digit Admin PIN. The next screen will list all five
          panels and let you update each PIN separately.
        </p>

        <div class="pin-manager-verify-inputs" data-admin-pin-inputs>
          ${Array.from({ length: 6 }, (_, index) => `
            <input
              type="password"
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength="1"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              data-admin-pin-digit="${index}"
              aria-label="Admin PIN digit ${index + 1}"
              required
            />
          `).join("")}
        </div>

        <p
          class="pin-manager-status ${errorMessage ? "pin-manager-error" : ""}"
          data-pin-status
          role="status"
          aria-live="polite"
        >${errorMessage}</p>
      </form>
    `;

    const inputs = [...content.querySelectorAll("[data-admin-pin-digit]")];
    const form = content.querySelector("[data-pin-verify-form]");

    inputs.forEach((input, index) => {
      input.addEventListener("input", () => {
        input.value = input.value.replace(/\D/g, "").slice(-1);

        if (input.value && index < inputs.length - 1) {
          inputs[index + 1].focus();
        }

        if (inputs.every(item => /^\d$/.test(item.value))) {
          void verifyAdminPin(inputs.map(item => item.value).join(""));
        }
      });

      input.addEventListener("keydown", event => {
        if (event.key === "Backspace" && !input.value && index > 0) {
          event.preventDefault();
          inputs[index - 1].value = "";
          inputs[index - 1].focus();
        } else if (event.key === "ArrowLeft" && index > 0) {
          event.preventDefault();
          inputs[index - 1].focus();
        } else if (
          event.key === "ArrowRight" &&
          index < inputs.length - 1
        ) {
          event.preventDefault();
          inputs[index + 1].focus();
        }
      });

      input.addEventListener("paste", event => {
        event.preventDefault();

        const pasted = event.clipboardData
          .getData("text")
          .replace(/\D/g, "")
          .slice(0, 6);

        if (!pasted) return;

        inputs.forEach((item, itemIndex) => {
          item.value = pasted[itemIndex] || "";
        });

        if (pasted.length === 6) {
          void verifyAdminPin(pasted);
        } else {
          inputs[Math.min(pasted.length, 5)].focus();
        }
      });
    });

    form.addEventListener("submit", event => event.preventDefault());

    inputs[0]?.focus();
  }

  function renderPanelRows(statusRows) {
    const statusMap = new Map(
      statusRows.map(item => [item.panel_id, item])
    );

    content.innerHTML = `
      <div class="pin-manager-notice">
        <strong>How to change a PIN:</strong>
        Find the panel, enter a new six-digit PIN in its row, and press
        Save. Only that panel's PIN will change. Existing PINs are never
        returned by the database.
      </div>

      <div class="pin-manager-panel-list">
        ${PANELS.map(panel => {
          const status = statusMap.get(panel.id);
          const known = typeof status?.configured === "boolean";

          return `
            <article
              class="pin-manager-row"
              data-pin-panel-row="${panel.id}"
            >
              <div class="pin-manager-role">
                <strong>${panel.title}</strong>
                <span>${panel.description}</span>
              </div>

              <div class="pin-manager-current">
                <span class="pin-manager-current-label">Current PIN</span>
                <div class="pin-manager-current-value">
                  ${status?.configured === true
                    ? "<strong>••••••</strong><span>Configured</span>"
                    : status?.configured === false
                      ? "<strong>—</strong><span>Not configured</span>"
                      : "<strong>—</strong><span>Status unavailable</span>"}
                </div>
              </div>

              <div class="pin-manager-new">
                <span class="pin-manager-new-label">New PIN</span>
                <div
                  class="pin-manager-new-pin"
                  data-new-pin-set="${panel.id}"
                  role="group"
                  aria-label="New PIN for ${panel.title}"
                >
                  ${Array.from({ length: 6 }, (_, index) => `
                    <input
                      type="password"
                      inputmode="numeric"
                      pattern="[0-9]*"
                      maxlength="1"
                      autocomplete="off"
                      autocapitalize="off"
                      spellcheck="false"
                      data-new-pin-digit="${index}"
                      aria-label="${panel.title} new PIN digit ${index + 1}"
                      ${known ? "" : "disabled"}
                    />
                  `).join("")}
                </div>
              </div>

              <button
                type="button"
                class="pin-manager-save"
                data-save-panel-pin="${panel.id}"
                ${known ? "" : "disabled"}
              >
                Save
              </button>

              <div
                class="pin-manager-row-status"
                data-pin-row-status="${panel.id}"
                role="status"
                aria-live="polite"
              ></div>
            </article>
          `;
        }).join("")}
      </div>

      <p class="pin-manager-status" data-pin-status>
        PINs are shown masked. Enter a new PIN only for the panel you want to change.
      </p>
    `;

    content.querySelectorAll("[data-new-pin-set]").forEach(group => {
      const inputs = [...group.querySelectorAll("input")];

      inputs.forEach((input, index) => {
        input.addEventListener("input", () => {
          input.value = input.value.replace(/\D/g, "").slice(-1);

          if (input.value && index < inputs.length - 1) {
            inputs[index + 1].focus();
          }
        });

        input.addEventListener("keydown", event => {
          if (event.key === "Backspace" && !input.value && index > 0) {
            event.preventDefault();
            inputs[index - 1].value = "";
            inputs[index - 1].focus();
          } else if (event.key === "ArrowLeft" && index > 0) {
            event.preventDefault();
            inputs[index - 1].focus();
          } else if (
            event.key === "ArrowRight" &&
            index < inputs.length - 1
          ) {
            event.preventDefault();
            inputs[index + 1].focus();
          }
        });

        input.addEventListener("paste", event => {
          event.preventDefault();

          const pasted = event.clipboardData
            .getData("text")
            .replace(/\D/g, "")
            .slice(0, 6);

          inputs.forEach((item, itemIndex) => {
            item.value = pasted[itemIndex] || "";
          });

          if (pasted.length < 6) {
            inputs[Math.min(pasted.length, 5)].focus();
          }
        });
      });
    });

    content.querySelectorAll("[data-save-panel-pin]").forEach(button => {
      button.addEventListener("click", () => {
        void savePanelPin(button.dataset.savePanelPin, button);
      });
    });
  }

  async function verifyAdminPin(pin) {
    if (submitting || disposed) return;

    submitting = true;

    content.querySelectorAll("[data-admin-pin-digit]")
      .forEach(input => {
        input.value = "";
        input.disabled = true;
      });

    setStatus("Verifying Admin PIN…");

    try {
      /*
       * Database contract installed by the TableForge master migration:
       *
       * authorize_panel_pin_management(
       *   p_restaurant_id uuid,
       *   p_current_admin_pin text
       * ) RETURNS jsonb
       *
       * Expected response:
       * { ok: true, management_token: "...", expires_at: "..." }
       *
       * The database must verify the authenticated restaurant owner,
       * rate-limit attempts and return a short-lived, restricted token.
       */
      const { data, error } = await supabase.rpc(
        "authorize_panel_pin_management",
        {
          p_restaurant_id: restaurantId,
          p_current_admin_pin: pin
        }
      );

      if (error) throw error;

      const result = normalizeResult(data);
      const expires = expiresAtMs(result?.expires_at);

      if (
        result?.ok !== true ||
        typeof result.management_token !== "string" ||
        result.management_token.length < 20 ||
        !Number.isFinite(expires) ||
        expires <= Date.now()
      ) {
        throw new Error("Admin authorization was not confirmed.");
      }

      managementToken = result.management_token;
      managementExpiresAt = expires;

      if (disposed) return;

      /*
       * Database contract installed by the TableForge master migration:
       *
       * get_panel_pin_statuses(
       *   p_management_token text
       * ) RETURNS jsonb
       *
       * Expected response:
       * { ok: true, panels: [{ panel_id, configured }] }
       *
       * Never return actual PINs, hashes or secret verification data.
       */
      const { data: statusData, error: statusError } = await supabase.rpc(
        "get_panel_pin_statuses",
        { p_management_token: managementToken }
      );

      if (statusError) throw statusError;

      const statusResult = normalizeResult(statusData);

      if (
        statusResult?.ok !== true ||
        !Array.isArray(statusResult.panels)
      ) {
        throw new Error("Panel PIN status could not be verified.");
      }

      const allowedPanelIds = new Set(PANELS.map(panel => panel.id));

      const verifiedStatuses = statusResult.panels.filter(item =>
        allowedPanelIds.has(item.panel_id) &&
        typeof item.configured === "boolean"
      );

      renderPanelRows(verifiedStatuses);

    } catch (error) {
      console.error("Panel PIN authorization failed:", error);

      managementToken = null;
      managementExpiresAt = 0;

      renderVerify(
        "PIN verification or panel status loading failed. No PIN was changed."
      );
    } finally {
      submitting = false;
    }
  }

  async function savePanelPin(panelId, button) {
    if (submitting || disposed) return;

    if (
      !managementToken ||
      managementExpiresAt <= Date.now()
    ) {
      managementToken = null;
      managementExpiresAt = 0;
      renderVerify("PIN management authorization expired. Enter the Admin PIN again.");
      return;
    }

    const panel = PANELS.find(item => item.id === panelId);
    const row = content.querySelector(
      `[data-pin-panel-row="${panelId}"]`
    );

    if (!panel || !row) return;

    const inputs = [...row.querySelectorAll("[data-new-pin-digit]")];
    const newPin = inputs.map(input => input.value).join("");

    const status = row.querySelector(
      `[data-pin-row-status="${panelId}"]`
    );

    if (!/^\d{6}$/.test(newPin)) {
      status.textContent = "Enter all six digits before saving.";
      status.classList.add("error");
      return;
    }

    submitting = true;
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = "Saving…";
    status.textContent = "";
    status.classList.remove("error", "success");

    try {
      /*
       * Database contract installed by the TableForge master migration:
       *
       * admin_set_panel_pin(
       *   p_management_token text,
       *   p_panel_id text,
       *   p_new_pin text
       * ) RETURNS jsonb
       *
       * Expected response: { ok: true, panel_id: "..." }
       *
       * The database must enforce authorization, securely hash the new PIN,
       * invalidate relevant previous grants and write an audit event.
       */
      const { data, error } = await supabase.rpc("admin_set_panel_pin", {
        p_management_token: managementToken,
        p_panel_id: panelId,
        p_new_pin: newPin
      });

      if (error) throw error;

      const result = normalizeResult(data);

      if (result?.ok !== true || result.panel_id !== panelId) {
        throw new Error("The server did not confirm this PIN change.");
      }

      inputs.forEach(input => {
        input.value = "";
      });

      status.textContent = "PIN changed successfully.";
      status.classList.add("success");

      onNotice(`${panel.title} PIN updated successfully.`, "success");

      if (panelId === "admin") {
        // The database also revokes Admin panel grants; return to the PIN gate immediately.
        managementToken = null;
        managementExpiresAt = 0;
        closeDialog();
        onAdminPinChanged();
      } else {
        const current = row.querySelector(".pin-manager-current-value");

        if (current) {
          current.innerHTML =
            "<strong>••••••</strong><span>Configured</span>";
        }
      }

    } catch (error) {
      console.error(`PIN update failed for ${panelId}:`, error);

      status.textContent =
        "The server did not confirm the PIN change. Please try again.";
      status.classList.add("error");

    } finally {
      submitting = false;

      if (!disposed && button.isConnected) {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    }
  }

  function handleGlobalKeydown(event) {
    if (event.key === "Escape") closeDialog();
  }

  overlay.querySelector("[data-pin-close]")
    .addEventListener("click", closeDialog);

  overlay.querySelector("[data-pin-overlay]")
    .addEventListener("click", event => {
      if (event.target === event.currentTarget) closeDialog();
    });

  document.addEventListener("keydown", handleGlobalKeydown);

  renderVerify();
}
