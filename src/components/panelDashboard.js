
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

function getRoleIcon(panel) {
  const role = `${panel.id ?? ""} ${panel.title ?? ""}`
    .toLowerCase()
    .replace(/[_-]+/g, " ");

  if (/\b(captain|pos|service|waiter)\b/.test(role)) {
    return "ph-fork-knife";
  }

  if (/\b(kot|kitchen|chef)\b/.test(role)) {
    return "ph-chef-hat";
  }

  if (/\b(cashier|cash|billing|bill)\b/.test(role)) {
    return "ph-receipt";
  }

  if (/\b(manager|management)\b/.test(role)) {
    return "ph-chart-line-up";
  }

  if (/\b(admin|administrator|owner)\b/.test(role)) {
    return "ph-shield-check";
  }

  return panel.icon || "ph-squares-four";
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
          padding: 30px;
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
          gap: 16px;
          margin-bottom: 36px;
        }

        .workspace-brand {
          display: flex;
          align-items: center;
          gap: 13px;
          min-width: 0;
        }

        .workspace-brand img {
          width: 54px;
          height: 54px;
          flex-shrink: 0;
          object-fit: contain;
          border-radius: 15px;
          background: #fff;
        }

        .workspace-brand .workspace-kicker {
          margin: 0 0 4px;
          color: var(--forest-700);
          font-size: 11px;
          font-weight: 800;
          letter-spacing: .14em;
          text-transform: uppercase;
        }

        .workspace-brand h1 {
          margin: 0;
          font-size: clamp(19px, 3vw, 27px);
          line-height: 1.25;
          overflow-wrap: anywhere;
        }

        .workspace-signout {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          flex-shrink: 0;
          padding: 11px 15px;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: var(--paper);
          color: var(--forest-900);
          font: inherit;
          font-size: 13px;
          font-weight: 800;
          cursor: pointer;
          transition: background .18s ease, border-color .18s ease;
        }

        .workspace-signout:hover {
          border-color: var(--forest-700);
          background: var(--sage-100);
        }

        .workspace-grid {
          display: grid;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          align-items: stretch;
          gap: 16px;
        }

        .workspace-card {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 20px;
          width: 100%;
          min-width: 0;
          max-width: 220px;
          justify-self: center;
          aspect-ratio: 4 / 5;
          box-sizing: border-box;
          padding: 16px 10px;
          overflow: hidden;
          border: 1px solid var(--line);
          border-radius: 22px;
          background: var(--paper);
          color: var(--forest-950);
          font: inherit;
          text-align: center;
          cursor: pointer;
          transition:
            transform .2s ease,
            border-color .2s ease,
            box-shadow .2s ease,
            background .2s ease;
        }

        .workspace-card::before {
          position: absolute;
          inset: 0 0 auto;
          height: 4px;
          background: var(--forest-700);
          content: "";
          opacity: 0;
          transition: opacity .2s ease;
        }

        .workspace-card:hover {
          transform: translateY(-4px);
          border-color: var(--forest-700);
          background: var(--sage-100);
          box-shadow: 0 12px 28px rgb(29 67 47 / 11%);
        }

        .workspace-card:hover::before {
          opacity: 1;
        }

        .workspace-card:active {
          transform: translateY(-1px) scale(.985);
        }

        .workspace-card:focus-visible,
        .workspace-signout:focus-visible {
          outline: 3px solid var(--forest-700);
          outline-offset: 4px;
        }

        .workspace-card-icon {
          display: grid;
          place-items: center;
          width: 104px;
          height: 104px;
          flex-shrink: 0;
          border: 1px solid rgb(29 67 47 / 8%);
          border-radius: 28px;
          background: var(--sage-100);
          color: var(--forest-900);
          box-shadow: 0 5px 15px rgb(29 67 47 / 5%);
          transition:
            transform .2s ease,
            background .2s ease,
            color .2s ease;
        }

        .workspace-card-icon i {
          display: block;
          font-size: 62px;
          line-height: 1;
        }

        .workspace-card:hover .workspace-card-icon {
          transform: scale(1.06);
          background: var(--forest-900);
          color: #fff;
        }

        .workspace-card-name {
          display: block;
          width: 100%;
          color: var(--forest-950);
          font-size: 15px;
          font-weight: 800;
          line-height: 1.3;
          letter-spacing: .015em;
          overflow-wrap: anywhere;
        }

        .workspace-status {
          margin-top: 14px;
          color: var(--danger);
          font-size: 12px;
          font-weight: 600;
        }

        @media (max-width: 900px) {
          .workspace-home {
            padding: 24px 18px;
          }

          .workspace-header {
            margin-bottom: 28px;
          }

          .workspace-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 12px;
          }

          .workspace-card {
            max-width: 240px;
            gap: 15px;
            border-radius: 19px;
          }

          .workspace-card-icon {
            width: clamp(58px, 9vw, 82px);
            height: clamp(58px, 9vw, 82px);
            border-radius: 22px;
          }

          .workspace-card-icon i {
            font-size: clamp(37px, 6.5vw, 49px);
          }

          .workspace-card-name {
            font-size: 14px;
          }
        }

        @media (max-width: 560px) {
          .workspace-home {
            padding: 18px 12px 24px;
          }

          .workspace-header {
            gap: 10px;
            margin-bottom: 24px;
          }

          .workspace-brand {
            gap: 9px;
          }

          .workspace-brand img {
            width: 42px;
            height: 42px;
            border-radius: 12px;
          }

          .workspace-brand .workspace-kicker {
            margin-bottom: 3px;
            font-size: 9px;
          }

          .workspace-brand h1 {
            font-size: 17px;
          }

          .workspace-signout {
            gap: 5px;
            padding: 9px 10px;
            border-radius: 10px;
            font-size: 11px;
          }

          .workspace-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 9px;
          }

          .workspace-card {
            width: 100%;
            max-width: none;
            aspect-ratio: 4 / 5;
            gap: 13px;
            padding: 9px 4px;
            border-radius: 15px;
          }

          .workspace-card-icon {
            width: clamp(40px, 12vw, 58px);
            height: clamp(40px, 12vw, 58px);
            border-radius: 15px;
          }

          .workspace-card-icon i {
            font-size: clamp(27px, 8vw, 38px);
          }

          .workspace-card-name {
            font-size: clamp(10px, 3.2vw, 13px);
            line-height: 1.25;
          }
        }

        @media (max-width: 360px) {
          .workspace-home {
            padding-right: 9px;
            padding-left: 9px;
          }

          .workspace-grid {
            gap: 7px;
          }

          .workspace-card {
            gap: 10px;
            padding: 7px 3px;
            border-radius: 13px;
          }

          .workspace-card-icon {
            width: 38px;
            height: 38px;
            border-radius: 12px;
          }

          .workspace-card-icon i {
            font-size: 25px;
          }

          .workspace-card-name {
            font-size: 10px;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .workspace-card,
          .workspace-card::before,
          .workspace-card-icon,
          .workspace-signout {
            transition: none;
          }

          .workspace-card:hover,
          .workspace-card:active,
          .workspace-card:hover .workspace-card-icon {
            transform: none;
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
            <i class="ph-bold ph-sign-out" aria-hidden="true"></i>
            Sign out
          </button>
        </header>

        <div class="workspace-grid">
          ${PANEL_REGISTRY.map(panel => `
            <button
              type="button"
              class="workspace-card"
              data-panel-id="${escapePanelText(panel.id)}"
              aria-label="Open ${escapePanelText(panel.title)}"
              title="${escapePanelText(panel.title)}"
            >
              <span class="workspace-card-icon" aria-hidden="true">
                <i class="ph-bold ${escapePanelText(getRoleIcon(panel))}"></i>
              </span>

              <span class="workspace-card-name">
                ${escapePanelText(panel.title)}
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
    const signOutButton = event.target.closest(
      "[data-workspace-signout]"
    );

    if (signOutButton) {
      if (!supabase) return;

      signOutButton.disabled = true;

      const status = mount.querySelector(
        "[data-workspace-status]"
      );

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
