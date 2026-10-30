
import { getPanelDefinition } from "../core/panelRegistry.js";
import { versionedAsset } from "../core/config.js";
import { supabase } from "../core/supabase.js";

function escapePinText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function render({ mount, route }) {
  const panel = getPanelDefinition(route?.panelId);

  if (!panel) {
    throw new Error("Invalid panel PIN screen.");
  }

  const tenant = window.__ACTIVE_TENANT__ || {};
  const tenantName = escapePinText(
    tenant.name || "TableForge Workspace"
  );

  const tenantIcon = escapePinText(
    tenant.icon_url
      ? versionedAsset(tenant.icon_url)
      : versionedAsset("assets/images/RMS_icon.svg")
  );

  mount.innerHTML = `
    <section class="access-screen panel-pin-screen">
      <style>
        /* Six masked PIN boxes using the requested 6:7 width-to-height ratio. */
        .panel-pin-screen #panel-pin-container.pin-box-container {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 8px;
          margin-bottom: 0;
          width: 100%;
          min-width: 0;
        }

        .panel-pin-screen #panel-pin-container .pin-box {
          flex: 0 1 42px;
          width: 42px;
          height: 49px;
          min-width: 0;
          aspect-ratio: 6 / 7;
          box-sizing: border-box;
          padding: 0;
          border: 1px solid var(--line);
          outline: none;
          border-radius: 11px;
          font-family: "Courier New", Courier, monospace;
          font-size: 24px;
          text-align: center;
        }

        .panel-pin-screen #panel-pin-container .pin-box:focus {
          outline: none;
          outline-offset: 0;
          border-color: var(--forest-700);
          box-shadow: 0 0 0 3px rgba(54, 91, 56, .12);
          transform: none;
        }

        .panel-pin-screen #panel-pin-container .pin-box:disabled {
          opacity: 1;
          cursor: default;
        }

        .panel-pin-screen #panel-pin-error {
          color: var(--danger);
          font-size: .85rem;
          display: none;
          text-align: center;
          margin-bottom: 12px;
          font-weight: 800;
          line-height: 1.5;
        }

        .panel-pin-screen #panel-pin-loading {
          display: none;
          height: 52px;
          align-items: center;
          justify-content: center;
          color: var(--forest-900);
          font-weight: 800;
          font-size: 16px;
          margin-bottom: 16px;
          background: var(--sage-100);
          border-radius: 12px;
        }

        .panel-pin-screen #panel-pin-status {
          text-align: center;
          margin-top: 10px;
          font-weight: 700;
          color: var(--forest-700);
          font-size: 12px;
        }

        @media (max-width: 420px) {
          .panel-pin-screen #panel-pin-container.pin-box-container {
            gap: 6px;
          }

          .panel-pin-screen #panel-pin-container .pin-box {
            flex: 0 1 36px;
            width: 36px;
            height: 42px;
            font-size: 21px;
          }
        }

        @media (max-width: 360px) {
          .panel-pin-screen #panel-pin-container.pin-box-container {
            gap: 4px;
          }

          .panel-pin-screen #panel-pin-container .pin-box {
            flex: 0 1 32px;
            width: 32px;
            height: 37.333px;
            font-size: 19px;
          }
        }
      </style>

      <div class="access-card">
        <div class="access-brand">
          <img
            class="access-logo"
            src="${tenantIcon}"
            alt=""
            style="border-radius: 12px; object-fit: cover;"
          />
          <div>
            <span class="eyebrow">${escapePinText(panel.title)} workspace</span>
            <strong>${tenantName}</strong>
          </div>
        </div>

        <h1>Secure ${escapePinText(panel.title)} access</h1>

        <p class="access-copy">
          Enter your 6-digit ${escapePinText(panel.title)} PIN to continue.
          ${panel.id === "admin"
            ? "For a newly provisioned restaurant, the first Admin PIN entered is securely set as the initial PIN."
            : ""}
        </p>

        <p id="panel-pin-error" role="alert" aria-live="assertive"></p>

        <form
          id="panel-pin-form"
          class="stack-form"
          style="display: flex; flex-direction: column; gap: 14px;"
        >
          <label class="field">
            <span
              style="font-size: .8rem; font-weight: 800; color: var(--forest-800);"
            >
              6-digit PIN
            </span>

            <div
              class="pin-box-container"
              id="panel-pin-container"
              aria-label="Six-digit PIN"
            >
              ${Array.from({ length: 6 }, (_, index) => `
                <input
                  type="password"
                  class="pin-box"
                  maxlength="1"
                  pattern="[0-9]*"
                  inputmode="numeric"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  aria-label="PIN digit ${index + 1}"
                  required
                />
              `).join("")}
            </div>

            <div id="panel-pin-loading">
              <i
                class="ph-bold ph-spinner-gap ph-spin"
                style="margin-right: 8px;"
              ></i>
              Verifying PIN...
            </div>
          </label>

          <button
            class="btn btn-quiet"
            id="panel-pin-back"
            type="button"
            style="width: 100%; margin-top: 8px;"
          >
            <i class="ph-bold ph-arrow-left"></i>
            Return to workspaces
          </button>

          <div
            class="access-status"
            id="panel-pin-status"
            role="status"
            aria-live="polite"
          ></div>
        </form>
      </div>
    </section>
  `;

  const form = mount.querySelector("#panel-pin-form");
  const container = mount.querySelector("#panel-pin-container");
  const errorMsg = mount.querySelector("#panel-pin-error");
  const status = mount.querySelector("#panel-pin-status");
  const loader = mount.querySelector("#panel-pin-loading");
  const backButton = mount.querySelector("#panel-pin-back");

  let inputs = [];
  let inputListeners = [];
  let isProcessing = false;
  let disposed = false;
  const timers = new Set();

  function schedule(callback, delay) {
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      if (!disposed) callback();
    }, delay);

    timers.add(timer);
    return timer;
  }

  function clearTimers() {
    timers.forEach(timer => window.clearTimeout(timer));
    timers.clear();
  }

  function removeInputListeners() {
    inputListeners.forEach(({ input, type, handler }) => {
      input.removeEventListener(type, handler);
    });

    inputListeners = [];
  }

  function attachInputListener(input, type, handler) {
    input.addEventListener(type, handler);
    inputListeners.push({ input, type, handler });
  }

  function hideError() {
    errorMsg.textContent = "";
    errorMsg.style.display = "none";
  }

  function getPin() {
    return inputs.map(input => input.value).join("");
  }

  function focusFirstInput() {
    if (!disposed) inputs[0]?.focus();
  }

  function createInputs(animate = false) {
    removeInputListeners();
    container.replaceChildren();

    for (let index = 0; index < 6; index++) {
      const input = document.createElement("input");

      input.type = "password";
      input.className = "pin-box";
      input.maxLength = 1;
      input.pattern = "[0-9]*";
      input.inputMode = "numeric";
      input.autocomplete = "off";
      input.autocapitalize = "off";
      input.spellcheck = false;
      input.required = true;
      input.setAttribute("aria-label", `PIN digit ${index + 1}`);

      if (animate) {
        input.classList.add("dropping-in");
        input.style.animationDelay = `${index * 50}ms`;
      }

      container.appendChild(input);
    }

    inputs = Array.from(container.querySelectorAll(".pin-box"));
    bindInputs();

    if (animate) {
      schedule(() => {
        inputs.forEach(input => {
          input.classList.remove("dropping-in");
          input.style.animationDelay = "";
        });

        focusFirstInput();
      }, 500);
    } else {
      focusFirstInput();
    }
  }

  function rejectPin(message) {
    if (disposed) return;

    isProcessing = true;
    loader.style.display = "none";
    status.textContent = "";
    errorMsg.textContent = message;
    errorMsg.style.display = "block";

    const rejectedInputs = [...inputs];

    rejectedInputs.forEach((input, index) => {
      input.disabled = true;

      schedule(() => {
        input.classList.add("falling-out");
        input.style.borderColor = "var(--danger)";
        input.style.color = "var(--danger)";
      }, (5 - index) * 60);
    });

    schedule(() => {
      if (disposed) return;

      createInputs(true);
      isProcessing = false;
    }, 800);
  }

  async function submitPin() {
    if (isProcessing || inputs.length !== 6 || disposed) return;

    const pin = getPin();

    if (!/^\d{6}$/.test(pin)) return;

    hideError();
    isProcessing = true;

    // Clear visible inputs immediately. Never persist the PIN.
    inputs.forEach(input => {
      input.value = "";
      input.disabled = true;
    });

    loader.style.display = "flex";
    status.textContent = "";

    try {
      if (!supabase) {
        throw new Error("Secure verification service is unavailable.");
      }

      const { data, error } = await supabase.rpc("verify_panel_pin", {
        p_panel_id: panel.id,
        p_pin: pin
      });

      if (error) {
        throw new Error("PIN verification failed.");
      }

      const result = Array.isArray(data) ? data[0] : data;

      const expiresAt = typeof result?.expires_at === "number"
        ? (
            result.expires_at < 1_000_000_000_000
              ? result.expires_at * 1000
              : result.expires_at
          )
        : Date.parse(result?.expires_at);

      if (
        result?.ok !== true ||
        typeof result.panel_token !== "string" ||
        result.panel_token.length < 20 ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now()
      ) {
        throw new Error("PIN verification failed.");
      }

      if (disposed) return;

      // Keep access in memory only, never in localStorage.
      window.__RMS_PANEL_ACCESS__ = {
        panelId: panel.id,
        token: result.panel_token,
        expiresAt,
        issuedAt: Date.now()
      };

      const issuedToken = result.panel_token;

      window.setTimeout(() => {
        if (window.__RMS_PANEL_ACCESS__?.token !== issuedToken) return;

        window.__RMS_PANEL_ACCESS__ = null;

        history.replaceState(
          {},
          "",
          `${location.pathname}${location.search}#/panel/${panel.id}`
        );

        window.dispatchEvent(new Event("rms:navigate"));
      }, Math.max(0, expiresAt - Date.now()));

      loader.style.display = "none";
      status.textContent = result.first_setup === true
        ? "Admin PIN created securely. Access verified."
        : "Access verified.";
      status.style.color = "var(--forest-800)";

      history.replaceState(
        {},
        "",
        `${location.pathname}${location.search}#/workspace/${panel.id}`
      );

      window.dispatchEvent(new Event("rms:navigate"));
    } catch {
      if (disposed) return;

      loader.style.display = "none";

      rejectPin(
        "Access could not be verified. Check the PIN or try again later."
      );
    }
  }

  function bindInputs() {
    inputs.forEach((input, index) => {
      attachInputListener(input, "input", event => {
        if (isProcessing) {
          event.target.value = "";
          return;
        }

        event.target.value = event.target.value
          .replace(/[^0-9]/g, "")
          .slice(-1);

        hideError();
        status.textContent = "";

        if (!event.target.value) return;

        if (index < inputs.length - 1) {
          inputs[index + 1].focus();
        } else {
          // Automatically submit after the sixth digit.
          submitPin();
        }
      });

      attachInputListener(input, "keydown", event => {
        if (isProcessing) return;

        if (
          event.key === "Backspace" &&
          event.currentTarget.value === "" &&
          index > 0
        ) {
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
        } else if (event.key === "Enter") {
          event.preventDefault();
          submitPin();
        }
      });

      attachInputListener(input, "paste", event => {
        if (isProcessing) return;

        event.preventDefault();

        const pastedPin = event.clipboardData
          .getData("text")
          .replace(/[^0-9]/g, "")
          .slice(0, 6);

        if (!pastedPin) return;

        hideError();

        inputs.forEach((box, boxIndex) => {
          box.value = pastedPin[boxIndex] || "";
        });

        if (pastedPin.length === 6) {
          submitPin();
        } else {
          inputs[Math.min(pastedPin.length, 5)]?.focus();
        }
      });
    });
  }

  function handleSubmit(event) {
    event.preventDefault();
    submitPin();
  }

  function handleBack() {
    window.__RMS_PANEL_ACCESS__ = null;

    history.pushState(
      {},
      "",
      `${location.pathname}${location.search}#/panels`
    );

    window.dispatchEvent(new Event("rms:navigate"));
  }

  createInputs();
  form.addEventListener("submit", handleSubmit);
  backButton.addEventListener("click", handleBack);

  return () => {
    disposed = true;
    clearTimers();
    removeInputListeners();

    form.removeEventListener("submit", handleSubmit);
    backButton.removeEventListener("click", handleBack);

    inputs.forEach(input => {
      input.value = "";
    });
  };
}
