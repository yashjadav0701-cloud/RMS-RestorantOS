import { PANEL_REGISTRY } from "../core/panelRegistry.js";
import { versionedAsset } from "../core/config.js";
import { supabase } from "../core/supabase.js";

function escapePanelText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function render({ mount }) {
  const tenant = window.__ACTIVE_TENANT__ || {};

  const tenantName = escapePanelText(
    tenant.name || "Restaurant Workspace"
  );

  const iconPath = tenant.icon_url
    ? versionedAsset(tenant.icon_url)
    : versionedAsset("assets/images/RMS_icon.svg");

  const tenantIcon = escapePanelText(iconPath);

  mount.innerHTML = `
    <section class="workspace-home">
      <style>
        .workspace-home {
          min-height: 100vh;
          padding: 32px;
          box-sizing: border-box;
          color: var(--forest-950);
          background: var(--cream-100);
          font-family: var(--ui-font);
        }

        .workspace-container {
          width: min(1120px, 100%);
          margin: 0 auto;
        }

        .workspace-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 20px;
          margin-bottom: 38px;
        }

        .workspace-brand {
          display: flex;
          align-items: center;
          gap: 14px;
          min-width: 0;
        }

        .workspace-brand img {
          width: 58px;
          height: 58px;
          border-radius: 16px;
          object-fit: contain;
          background: #fff;
          flex-shrink: 0;
        }

        .workspace-brand .workspace-kicker {
          margin: 0 0 5px;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: .13em;
          text-transform: uppercase;
          color: var(--forest-700);
        }

        .workspace-brand h1 {
          margin: 0;
          font-size: clamp(20px, 3vw, 28px);
          line-height: 1.2;
          overflow-wrap: anywhere;
        }

        .workspace-signout {
          flex-shrink: 0;
          border: 1px solid var(--line);
          border-radius: 12px;
          padding: 11px 15px;
          background: var(--paper);
          color: var(--forest-900);
          font: inherit;
          font-size: 13px;
          font-weight: 800;
          cursor: pointer;
        }

        .workspace-intro {
          margin-bottom: 18px;
        }

        .workspace-intro h2 {
          margin: 0 0 5px;
          font-size: clamp(23px, 3vw, 29px);
          letter-spacing: -.03em;
        }

        .workspace-intro p {
          margin: 0;
          color: var(--muted);
          line-height: 1.5;
          font-size: 13px;
        }

        .workspace-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
        }

        .workspace-card {
          display: flex;
          align-items: center;
          gap: 12px;
          width: 100%;
          min-width: 0;
          min-height: 88px;
          box-sizing: border-box;
          padding: 14px 15px;
          border: 1px solid var(--line);
          border-radius: 16px;
          background: var(--paper);
          text-align: left;
          color: inherit;
          font: inherit;
          cursor: pointer;
          transition: border-color .18s ease,
                      background .18s ease;
        }

        .workspace-card:hover {
          border-color: var(--forest-700);
          background: var(--sage-100);
        }

        .workspace-card:focus-visible,
        .workspace-signout:focus-visible {
          outline: 3px solid var(--forest-700);
          outline-offset: 3px;
        }

        .workspace-card-icon {
          width: 42px;
          height: 42px;
          border-radius: 13px;
          display: grid;
          place-items: center;
          flex-shrink: 0;
          background: var(--sage-100);
          color: var(--forest-900);
        }

        .workspace-card-icon i {
          font-size: 21px;
        }

        .workspace-card-copy {
          flex: 1;
          min-width: 0;
        }

        .workspace-card-copy h3 {
          margin: 0;
          font-size: 15px;
          line-height: 1.3;
          font-weight: 800;
        }

        .workspace-card-subtitle {
          display: block;
          margin-top: 4px;
          color: var(--muted);
          font-size: 12px;
          line-height: 1.35;
          font-weight: 600;
        }

        .workspace-card-arrow {
          display: grid;
          place-items: center;
          flex-shrink: 0;
          color: var(--forest-800);
          font-size: 17px;
        }

        .workspace-status {
          min-height: 18px;
          margin-top: 8px;
          color: var(--danger);
          font-size: 12px;
          font-weight: 600;
        }

        @media (max-width: 900px) {
          .workspace-home {
            padding: 24px 18px;
          }

          .workspace-header {
            margin-bottom: 26px;
          }

          .workspace-brand img {
            width: 48px;
            height: 48px;
            border-radius: 13px;
          }

          .workspace-signout {
            padding: 9px 11px;
            font-size: 12px;
          }

          .workspace-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 11px;
          }

          .workspace-card {
            min-height: 82px;
            padding: 13px;
          }
        }

        @media (max-width: 560px) {
          .workspace-home {
            padding: 20px 14px;
          }

          .workspace-header {
            align-items: center;
            gap: 12px;
            margin-bottom: 25px;
          }

          .workspace-brand {
            gap: 10px;
          }

          .workspace-brand img {
            width: 42px;
            height: 42px;
          }

          .workspace-brand h1 {
            font-size: 18px;
          }

          .workspace-grid {
            grid-template-columns: minmax(0, 1fr);
            gap: 10px;
          }

          .workspace-card {
            min-height: 74px;
            padding: 12px 14px;
          }

          .workspace-card-icon {
            width: 40px;
            height: 40px;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .workspace-card {
            transition: none;
          }
        }
      </style>

      <div class="workspace-container">
        <header class="workspace-header">
          <div class="workspace-brand">
            <img src="${tenantIcon}" alt="" />
            <div>
              <p class="workspace-kicker">TableForge</p>
              <h1>${tenantName}</h1>
            </div>
          </div>

          <button
            type="button"
            class="workspace-signout"
            data-workspace-signout
          >
            <i class="ph-bold ph-sign-out"></i>
            Sign out
          </button>
        </header>

        <div class="workspace-intro">
          <h2>Choose a workspace</h2>
          <p>Select where you want to work.</p>
        </div>

        <div class="workspace-grid">
          ${PANEL_REGISTRY.map(panel => `
            <button
              type="button"
              class="workspace-card"
              data-panel-id="${panel.id}"
              aria-label="Open ${panel.title} workspace"
            >
              <span class="workspace-card-icon">
                <i class="ph-bold ${panel.icon}"></i>
              </span>

              <span class="workspace-card-copy">
                <h3>${panel.title}</h3>
                <span class="workspace-card-subtitle">
                  ${panel.subtitle}
                </span>
              </span>

              <span class="workspace-card-arrow">
                <i class="ph-bold ph-arrow-up-right"></i>
              </span>
            </button>
          `).join("")}
        </div>

        <div
          class="workspace-status"
          data-workspace-status
          aria-live="polite"
        ></div>
      </div>
    </section>
  `;

  const handleClick = async event => {
    const signOutButton = event.target.closest("[data-workspace-signout]");

    if (signOutButton) {
      if (!supabase) return;

      signOutButton.disabled = true;

      const status = mount.querySelector("[data-workspace-status]");
      status.textContent = "";

      try {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;

        history.replaceState({}, "", location.pathname);
        window.dispatchEvent(new Event("rms:navigate"));
      } catch (error) {
        status.textContent =
          error?.message || "Sign-out failed. Please try again.";
        signOutButton.disabled = false;
      }

      return;
    }

    const card = event.target.closest("[data-panel-id]");
    if (!card) return;

    const panel = PANEL_REGISTRY.find(
      item => item.id === card.dataset.panelId
    );

    if (!panel) return;

    history.pushState(
      {},
      "",
      `${location.pathname}${location.search}${panel.route}`
    );

    window.dispatchEvent(new Event("rms:navigate"));
  };

  mount.addEventListener("click", handleClick);

  return () => {
    mount.removeEventListener("click", handleClick);
  };
}