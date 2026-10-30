import { installPanelSignOut, requestPanelSignOut } from "../core/panelSession.js";
export async function render({ mount }) {
  let disposed = false;

  function hasManagerAccess() {
    const access = window.__RMS_PANEL_ACCESS__;

    return (
      access?.panelId === "manager" &&
      typeof access.token === "string" &&
      access.token.length >= 20 &&
      Number.isFinite(access.expiresAt) &&
      access.expiresAt > Date.now()
    );
  }

  function returnToWorkspaces() {
    return requestPanelSignOut({ confirmExit: true });
  }

  function openOperationalWorkspace(panelId) {
    if (disposed || !hasManagerAccess()) {
      window.__RMS_PANEL_ACCESS__ = null;
      history.replaceState(
        {},
        "",
        `${location.pathname}${location.search}#/panel/manager`
      );
      window.dispatchEvent(new Event("rms:navigate"));
      return;
    }

    const allowed = ["captain", "kot", "cashier"];

    if (!allowed.includes(panelId)) return;

    history.pushState(
      {},
      "",
      `${location.pathname}${location.search}#/workspace/${panelId}`
    );

    window.dispatchEvent(new Event("rms:navigate"));
  }

  if (!hasManagerAccess()) {
    mount.innerHTML = `
      <section class="access-screen">
        <div class="access-card" style="text-align:center;">
          <i class="ph-bold ph-lock-key"
             style="font-size:34px;color:var(--forest-900);"></i>
          <h1>Manager access required</h1>
          <p class="access-copy">
            Verify the Manager PIN before accessing operational workspaces.
          </p>
          <button class="btn btn-primary" type="button" data-manager-return>
            Return to workspaces
          </button>
        </div>
      </section>
    `;

    const button = mount.querySelector("[data-manager-return]");
    button?.addEventListener("click", returnToWorkspaces);

    return () => {
      disposed = true;
      button?.removeEventListener("click", returnToWorkspaces);
    };
  }

  mount.innerHTML = `
    <section class="manager-home">
      <style>
        .manager-home {
          min-height: 100vh;
          padding: 24px;
          box-sizing: border-box;
          background: var(--cream-100);
          color: var(--forest-950);
          font-family: var(--ui-font);
        }

        .manager-container {
          width: min(100%, 1000px);
          margin: 0 auto;
        }

        .manager-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          margin-bottom: 30px;
        }

        .manager-title {
          margin: 0;
          font-size: 25px;
          letter-spacing: -.03em;
        }

        .manager-subtitle {
          margin: 5px 0 0;
          color: var(--muted);
          font-size: 13px;
          line-height: 1.5;
        }

        .manager-icon-button {
          display: grid;
          place-items: center;
          width: 42px;
          height: 42px;
          flex-shrink: 0;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: var(--paper);
          color: var(--forest-900);
          font-size: 18px;
          cursor: pointer;
        }

        .manager-section-title {
          margin: 0 0 13px;
          font-size: 15px;
        }

        .manager-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 13px;
        }

        .manager-card {
          display: flex;
          align-items: flex-start;
          flex-direction: column;
          min-width: 0;
          min-height: 155px;
          padding: 19px;
          border: 1px solid var(--line);
          border-radius: 17px;
          background: var(--paper);
          color: inherit;
          text-align: left;
          font: inherit;
          cursor: pointer;
          transition: border-color 160ms ease, background 160ms ease;
        }

        .manager-card:hover {
          border-color: var(--forest-700);
          background: var(--sage-100);
        }

        .manager-card-icon {
          display: grid;
          place-items: center;
          width: 43px;
          height: 43px;
          margin-bottom: 17px;
          border-radius: 13px;
          background: var(--sage-100);
          color: var(--forest-900);
          font-size: 22px;
        }

        .manager-card strong {
          font-size: 15px;
          line-height: 1.4;
        }

        .manager-card span {
          margin-top: 5px;
          color: var(--muted);
          font-size: 12px;
          line-height: 1.5;
        }

        .manager-card-arrow {
          display: flex;
          justify-content: flex-end;
          width: 100%;
          margin-top: auto;
          padding-top: 12px;
          color: var(--forest-800);
          font-size: 17px;
        }

        .manager-note {
          margin-top: 20px;
          color: var(--muted);
          font-size: 12px;
          line-height: 1.6;
        }

        @media (max-width: 750px) {
          .manager-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }

        @media (max-width: 480px) {
          .manager-home {
            padding: 19px 14px;
          }

          .manager-header {
            margin-bottom: 24px;
          }

          .manager-title {
            font-size: 22px;
          }

          .manager-grid {
            grid-template-columns: minmax(0, 1fr);
            gap: 10px;
          }

          .manager-card {
            min-height: 0;
            padding: 15px;
          }

          .manager-card-icon {
            margin-bottom: 11px;
          }

          .manager-card-arrow {
            padding-top: 7px;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .manager-card {
            transition: none;
          }
        }
      </style>

      <div class="manager-container">
        <header class="manager-header">
          <div style="display:flex;align-items:center;gap:12px;">
            <button
              type="button"
              class="manager-icon-button"
              data-manager-back
              title="Return to workspaces"
              aria-label="Return to workspaces"
            >
              <i class="ph-bold ph-arrow-left"></i>
            </button>

            <div>
              <h1 class="manager-title">Manager</h1>
              <p class="manager-subtitle">Restaurant operations</p>
            </div>
          </div>
        </header>

        <h2 class="manager-section-title">Choose an operation</h2>

        <div class="manager-grid">
          <button class="manager-card" type="button" data-manager-panel="captain">
            <span class="manager-card-icon">
              <i class="ph-bold ph-armchair"></i>
            </span>
            <strong>Dine-in service</strong>
            <span>Tables, orders, rounds and bill requests.</span>
            <span class="manager-card-arrow">
              <i class="ph-bold ph-arrow-up-right"></i>
            </span>
          </button>

          <button class="manager-card" type="button" data-manager-panel="kot">
            <span class="manager-card-icon">
              <i class="ph-bold ph-chef-hat"></i>
            </span>
            <strong>Kitchen operations</strong>
            <span>Active tickets, preparation and ready dishes.</span>
            <span class="manager-card-arrow">
              <i class="ph-bold ph-arrow-up-right"></i>
            </span>
          </button>

          <button class="manager-card" type="button" data-manager-panel="cashier">
            <span class="manager-card-icon">
              <i class="ph-bold ph-receipt"></i>
            </span>
            <strong>Takeaway and billing</strong>
            <span>Takeaway orders, bill requests and receipts.</span>
            <span class="manager-card-arrow">
              <i class="ph-bold ph-arrow-up-right"></i>
            </span>
          </button>
        </div>

        <p class="manager-note">
          Manager can supervise operational work but cannot open restaurant
          configuration, manage panel PINs or change menu settings.
        </p>
      </div>
    `;

  const panelSignOutCleanup = installPanelSignOut({ mount, panelId: "manager" });
  const backButton = mount.querySelector("[data-manager-back]");

  const handleBack = () => {
    returnToWorkspaces();
  };

  const handlePanelClick = event => {
    const button = event.target.closest("[data-manager-panel]");
    if (!button) return;

    openOperationalWorkspace(button.dataset.managerPanel);
  };

  backButton?.addEventListener("click", handleBack);
  mount.addEventListener("click", handlePanelClick);

  return () => {
    disposed = true;
    panelSignOutCleanup?.();
    backButton?.removeEventListener("click", handleBack);
    mount.removeEventListener("click", handlePanelClick);
  };
}