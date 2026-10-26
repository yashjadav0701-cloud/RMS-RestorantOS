let activeCleanup = null;
let started = false;

function getRoute() {
  const params = new URLSearchParams(location.search);
  const tableId = params.get("table") || params.get("t");

  // Public customer ordering must keep working independently of staff routing.
  if (tableId) {
    return {
      name: "customer",
      tableId,
      key: `customer:${tableId}`
    };
  }

  // Preserve compatibility with existing links and shortcuts.
  if (location.hash === "#/admin") {
    return {
      name: "panel-pin",
      panelId: "admin",
      key: "panel:admin"
    };
  }

  // Operational workspace URLs require a short-lived, in-memory
  // panel grant issued by the backend PIN-verification RPC.
  // This is a UI guard, not a substitute for database authorization.
  const workspaceMatch = location.hash.match(
    /^#\/workspace\/(captain|kot|cashier|manager|admin)$/i
  );

  if (workspaceMatch) {
    const panelId = workspaceMatch[1].toLowerCase();
    const access = window.__RMS_PANEL_ACCESS__;

    const managerCanOperate =
      access?.panelId === "manager" &&
      ["captain", "kot", "cashier"].includes(panelId);

    const isGranted =
      (
        access?.panelId === panelId ||
        managerCanOperate
      ) &&
      typeof access?.token === "string" &&
      access.token.length >= 20 &&
      Number.isFinite(access?.expiresAt) &&
      access.expiresAt > Date.now();

    if (isGranted) {
      return {
        name: panelId,
        panelId,
        key: `workspace:${panelId}`
      };
    }

    // Fail closed: direct URL access returns to the PIN screen.
    return {
      name: "panel-pin",
      panelId,
      key: `panel:${panelId}`
    };
  }

    const panelMatch = location.hash.match(
    /^#\/panel\/(captain|kot|cashier|manager|admin)$/i
  );

  if (panelMatch) {
    const panelId = panelMatch[1].toLowerCase();

    // Every staff workspace, including Admin, must pass its PIN screen first.
    return {
      name: "panel-pin",
      panelId,
      key: `panel:${panelId}`
    };
  }

  // The authenticated staff landing page is now the workspace dashboard.
  // An unknown hash is not allowed to become an operational panel.
  return {
    name: "panels",
    key: "panels"
  };
}

async function moduleFor(route) {
  if (route.name === "customer") {
    // Resolve QR/table tenant context before opening the customer ordering flow.
    return import("../customer/index.js");
  }

  if (route.name === "panels") {
    return import("../components/panelDashboard.js");
  }

  if (route.name === "admin") {
    return import("../admin/index.js");
  }

  // Captain is a real panel route and reuses the POS engine in dine-in-only mode.
  if (route.name === "captain") {
    return import("../captain/index.js");
  }

  if (route.name === "kot") {
    return import("../kot/index.js");
  }

  if (route.name === "cashier") {
    return import("../cashier/index.js");
  }

  if (route.name === "manager") {
    return import("../manager/index.js");
  }

  if (route.name === "panel-pin") {
  return import("../components/panelPinScreen.js");
  }

  if (route.name === "panel-placeholder") {
    return import("../components/panelPlaceholder.js");
  }

  throw new Error(`Unsupported route: ${route.name}`);
}

export async function renderRoute(mount) {
  const route = getRoute();
  if (activeCleanup) {
    try { await activeCleanup(); } catch (error) { console.warn("View cleanup failed", error); }
    activeCleanup = null;
  }

  mount.innerHTML = `<section class="loading-screen"><div class="loading-mark"><span></span><span></span><span></span></div></section>`;

  // TIER 1 SECURITY: Block POS and Admin from unauthorized access
  if (route.name !== "customer") {
    const { getSession } = await import("./supabase.js");
    const session = await getSession();
    
    // 🔒 FAULT TOLERANCE FIX: If a Supabase session exists in persistent memory, 
    // instantly grant access to the POS floor. If they attempt to enter the Admin area, 
    // the secondary 6-Digit PIN lock will automatically catch them.
    if (!session) {
       const { renderStaffLogin } = await import("../components/lockScreen.js");
       const cleanup = await renderStaffLogin({
           mount,
           onLogin: () => {
               history.replaceState(
                   {},
                   "",
                   `${location.pathname}${location.search}#/panels`
               );

               window.dispatchEvent(new Event("rms:navigate"));
           }
       });
       activeCleanup = typeof cleanup === "function" ? cleanup : null;
       return route;
    }
  }

  const view = await moduleFor(route);
  if (typeof view.render !== "function") throw new Error(`View ${route.name} must export render().`);
  const cleanup = await view.render({ mount, route });
  activeCleanup = typeof cleanup === "function" ? cleanup : null;
  return route;
}

export function startRouter({ mount }) {
  if (started) return;
  started = true;

  // 🔒 FAULT TOLERANCE: Aggressive signOut() removed.
  // The underlying Supabase token persists across power outages.
  // Staff only need to enter their fast 6-digit PIN to unlock the screen.

  let lastGrantedWorkspaceUrl = "";

  let leaveConfirmationOpen = false;

  function mayOpenWorkspace(panelId, access) {
    if (!access || !panelId) return false;
    if (access.panelId === panelId) return true;
    return access.panelId === "manager" && ["captain", "kot", "cashier"].includes(panelId);
  }

  function showWorkspaceLeaveConfirmation() {
    if (leaveConfirmationOpen) return;
    leaveConfirmationOpen = true;

    const root = document.createElement("div");
    root.className = "modal-backdrop workspace-leave-backdrop";
    root.style.placeItems = "center";
    root.style.zIndex = "5000";
    root.innerHTML = `
      <section class="app-modal workspace-leave-modal" role="alertdialog" aria-modal="true" aria-labelledby="workspace-leave-title" aria-describedby="workspace-leave-copy">
        <header class="modal-head">
          <div class="modal-title-wrap">
            <span class="modal-kicker"><i class="ph ph-shield-check"></i>${escapeHtml(window.__ACTIVE_TENANT__?.name || "TableForge")}</span>
            <h2 id="workspace-leave-title">Leave this workspace?</h2>
            <p>Your current panel access will be locked.</p>
          </div>
          <div class="danger-confirm-icon" aria-hidden="true"><i class="ph ph-sign-out"></i></div>
        </header>
        <div class="modal-body">
          <div class="danger-confirm">
            <p id="workspace-leave-copy">Returning to workspaces will end this panel's temporary access. Your restaurant account will remain signed in.</p>
            <div class="modal-form-note warning"><i class="ph ph-shield-warning"></i><span>Financial and administrative panels should be locked when you leave the workstation.</span></div>
          </div>
        </div>
        <footer class="modal-actions">
          <button class="btn btn-quiet" type="button" data-workspace-leave-cancel><i class="ph ph-arrow-left"></i>Stay here</button>
          <button class="btn btn-danger" type="button" data-workspace-leave-confirm><i class="ph ph-lock-key"></i>Lock panel &amp; return</button>
        </footer>
      </section>`;

    const close = () => {
      root.remove();
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKeyDown);
      leaveConfirmationOpen = false;
    };

    const stay = () => {
      close();
      if (lastGrantedWorkspaceUrl) {
        history.replaceState({}, "", lastGrantedWorkspaceUrl);
      }
    };

    const leave = () => {
      window.__RMS_PANEL_ACCESS__ = null;
      window.__RMS_PANEL_MANAGEMENT_TOKEN__ = null;
      window.__RMS_PANEL_PIN_MANAGEMENT__ = null;
      history.replaceState({}, "", `${location.pathname}${location.search}#/panels`);
      lastGrantedWorkspaceUrl = "";
      close();
      window.dispatchEvent(new Event("rms:navigate"));
    };

    const onKeyDown = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        stay();
        return;
      }

      if (event.key === "Tab") {
        const buttons = [...root.querySelectorAll("button:not([disabled])")];
        if (!buttons.length) return;

        const first = buttons[0];
        const last = buttons[buttons.length - 1];

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    root.addEventListener("click", event => {
      if (
        event.target === root ||
        event.target.closest("[data-workspace-leave-cancel]")
      ) {
        stay();
        return;
      }

      if (event.target.closest("[data-workspace-leave-confirm]")) {
        leave();
      }
    });

    document.body.appendChild(root);
    document.body.classList.add("modal-open");
    document.addEventListener("keydown", onKeyDown);
    root.querySelector("[data-workspace-leave-cancel]")?.focus();
  }

  function guardLeavingPanel() {
    const access = window.__RMS_PANEL_ACCESS__;
    const valid = access && typeof access.token === "string" && access.token.length >= 20 &&
      Number.isFinite(access.expiresAt) && access.expiresAt > Date.now();
    if (!valid) {
      lastGrantedWorkspaceUrl = "";
      return true;
    }

    const match = location.hash.match(/^#\/workspace\/(captain|kot|cashier|manager|admin)$/i);
    const targetPanel = match?.[1]?.toLowerCase();
    if (targetPanel && mayOpenWorkspace(targetPanel, access)) {
      lastGrantedWorkspaceUrl = `${location.pathname}${location.search}${location.hash}`;
      return true;
    }

    if (!lastGrantedWorkspaceUrl) return true;
    showWorkspaceLeaveConfirmation();
    return false;
  }

  const rerender = () => {
    if (!guardLeavingPanel()) return;
    renderRoute(mount).catch(error => {
    console.error(error);
    mount.innerHTML = `
      <section class="error-screen">
        <div class="error-card">
          <i class="ph ph-warning-circle"></i>
          <h1>Something went wrong</h1>
          <p>${escapeHtml(error.message)}</p>
          <button class="btn btn-primary" data-reload><i class="ph ph-arrow-clockwise"></i>Reload</button>
        </div>
      </section>`;
    mount.querySelector("[data-reload]")?.addEventListener("click", () => location.reload());
    });
  };

  window.addEventListener("popstate", rerender);
  window.addEventListener("hashchange", rerender);
  window.addEventListener("rms:navigate", rerender);
  window.addEventListener("fourflavours:navigate", rerender); // Kept safely to prevent breaking old buttons
  
  window.addEventListener("keydown", event => {
    const customer = new URLSearchParams(location.search).has("table");
    // Rebranded Secret Shortcut: Ctrl+M (Management) to enter Admin Dashboard
    if (!customer && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "m") {
      event.preventDefault();
      location.hash = "#/panel/admin";
    }
  });

  rerender();
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
