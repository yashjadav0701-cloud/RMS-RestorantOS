// Shared panel-level sign-out. This clears only the short-lived panel PIN grant;
// the restaurant account's Supabase session remains signed in until account sign-out.
export function hasValidPanelGrant(access = window.__RMS_PANEL_ACCESS__) {
  return Boolean(
    access &&
    typeof access.token === "string" && access.token.length >= 20 &&
    Number.isFinite(access.expiresAt) && access.expiresAt > Date.now() &&
    typeof access.panelId === "string"
  );
}

export function requestPanelSignOut({ confirmExit = true } = {}) {
  if (!confirmExit) {
    completePanelSignOut();
    return true;
  }

  if (document.querySelector("[data-tf-signout-modal]")) return false;

  const root = document.createElement("div");
  root.className = "modal-backdrop tf-signout-backdrop";
  root.dataset.tfSignoutModal = "true";
  root.innerHTML = `
    <section class="app-modal tf-signout-modal" role="dialog"
      aria-modal="true" aria-labelledby="tf-signout-title">
      <header class="modal-head">
        <div class="modal-title-wrap">
          <span class="modal-kicker">
            <i class="ph ph-shield-check"></i> Secure workspace
          </span>
          <h2 id="tf-signout-title">Sign out of this panel?</h2>
          <p>You will need to enter the panel PIN again.</p>
        </div>
        <button type="button" class="icon-btn icon-btn-light"
          data-tf-signout-cancel aria-label="Close">
          <i class="ph ph-x"></i>
        </button>
      </header>
      <div class="modal-body">
        <div class="tf-signout-message">
          <i class="ph ph-sign-out"></i>
          <span>Your current panel access will end. Your restaurant account will remain signed in.</span>
        </div>
      </div>
      <footer class="modal-actions">
        <button type="button" class="btn btn-quiet" data-tf-signout-cancel>
          Stay here
        </button>
        <button type="button" class="btn tf-signout-confirm" data-tf-signout-confirm>
          <i class="ph ph-sign-out"></i> Sign out
        </button>
      </footer>
    </section>`;

  if (!document.getElementById("tf-signout-modal-style")) {
    const style = document.createElement("style");
    style.id = "tf-signout-modal-style";
    style.textContent = `
      .tf-signout-backdrop {
        place-items: center;
        padding: 16px;
        background: rgba(12, 20, 14, .48);
        backdrop-filter: blur(9px);
        -webkit-backdrop-filter: blur(9px);
        z-index: 10000;
      }
      .tf-signout-modal {
        width: min(100%, 420px);
        max-height: 90vh;
        grid-template-rows: auto auto auto;
      }
      .tf-signout-message {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.6;
      }
      .tf-signout-message > i {
        color: #b42332;
        font-size: 23px;
        flex: 0 0 auto;
      }
      .tf-signout-confirm {
        background: linear-gradient(135deg,#b42332,#8f1727) !important;
        color: #fff !important;
        border-color: #8f1727 !important;
        font-weight: 850;
      }
      .tf-signout-confirm:hover { filter: brightness(1.08); }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(root);
  document.body.classList.add("modal-open");

  const close = () => {
    root.remove();
    document.body.classList.remove("modal-open");
    document.removeEventListener("keydown", onKeyDown);
  };

  const cancelButtons = root.querySelectorAll("[data-tf-signout-cancel]");
  cancelButtons.forEach(button => button.addEventListener("click", close));

  root.addEventListener("click", event => {
    if (event.target === root) close();
  });

  const onKeyDown = event => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKeyDown);

  root.querySelector("[data-tf-signout-confirm]")?.addEventListener("click", () => {
    close();
    completePanelSignOut();
  });

  root.querySelector("[data-tf-signout-confirm]")?.focus();
  return false;
}

function completePanelSignOut() {
  window.__RMS_PANEL_ACCESS__ = null;
  window.__RMS_PANEL_MANAGEMENT_TOKEN__ = null;
  window.__RMS_PANEL_PIN_MANAGEMENT__ = null;
  history.replaceState({}, "", `${location.pathname}${location.search}#/panels`);
  window.dispatchEvent(new Event("rms:navigate"));
}

const PANEL_SIGNOUT_STYLE = `
  .tf-panel-signout { display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:38px; padding:0 12px; border:1px solid #cbd5c0; border-radius:10px; background:#fff; color:#183a22; font:inherit; font-size:12px; font-weight:850; white-space:nowrap; cursor:pointer; flex-shrink:0; }
  .tf-panel-signout:hover { background:#f0f5ed; border-color:#7b9a79; }
  .tf-panel-signout:focus-visible { outline:3px solid #a7c59e; outline-offset:2px; }
  @media(max-width:520px) { .tf-panel-signout { min-height:34px; padding:0 9px; font-size:11px; } .tf-panel-signout .tf-signout-label { display:inline; } }
`;

export function installPanelSignOut({ mount, panelId }) {
  if (!mount || panelId === "customer") return () => {};
  const target = mount.querySelector(
    ".pos-topbar .topbar-right, .admin-topbar .topbar-right, .cashier-header, .kot-header, .manager-header, .workspace-header"
  ) || mount.querySelector(".access-card > div:first-child");
  if (!target || target.querySelector("[data-tf-panel-signout]")) return () => {};

  let style = document.getElementById("tf-panel-signout-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "tf-panel-signout-style";
    style.textContent = PANEL_SIGNOUT_STYLE;
    document.head.appendChild(style);
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "tf-panel-signout";
  button.dataset.tfPanelSignout = "true";
  button.title = `Sign out of ${panelId || "this"} workspace`;
  button.setAttribute("aria-label", "Sign out of this workspace");
  button.innerHTML = '<i class="ph-bold ph-sign-out" aria-hidden="true"></i><span class="tf-signout-label">Sign out</span>';
  const handleClick = () => requestPanelSignOut({ confirmExit: true });
  button.addEventListener("click", handleClick);
  target.appendChild(button);

  return () => {
    button.removeEventListener("click", handleClick);
    button.remove();
  };
}
