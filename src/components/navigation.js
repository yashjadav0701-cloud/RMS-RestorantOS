import { versionedAsset } from "../core/config.js";
import { supabase, signOut } from "../core/supabase.js";

window.__orderTotalsCache = window.__orderTotalsCache || new Map();
window.__sessionStatusCache = window.__sessionStatusCache || new Map();

// 💾 TABLE ALERT ENGINE: Binds seen/unseen states strictly to Table IDs
try {
  window.__tableAlerts = JSON.parse(localStorage.getItem('rms_table_alerts') || '{}');
} catch(e) {
  window.__tableAlerts = {};
}

export function updateGlobalNotificationBadge() {
  const drawerDot = document.getElementById("admin-drawer-dot");
  const hamburgerDots = document.querySelectorAll(".hamburger-dot");
  const unreadCount = Object.keys(window.__tableAlerts || {}).length;
  const show = unreadCount > 0;
  
  if (drawerDot) drawerDot.style.display = show ? "block" : "none";
  hamburgerDots.forEach(dot => { dot.style.display = show ? "block" : "none"; });
}
window.updateGlobalNotificationBadge = updateGlobalNotificationBadge;

export function setTableAlert(tableId, type, message) {
  if (!tableId) return;
  window.__tableAlerts = window.__tableAlerts || {};
  window.__tableAlerts[tableId] = { type, message, timestamp: Date.now() };
  localStorage.setItem('rms_table_alerts', JSON.stringify(window.__tableAlerts));
  updateGlobalNotificationBadge();
  window.dispatchEvent(new Event("ff_admin_alert_received"));
}
window.setTableAlert = setTableAlert;

export function clearTableAlert(tableId) {
  if (!tableId || !window.__tableAlerts[tableId]) return;
  delete window.__tableAlerts[tableId];
  localStorage.setItem('rms_table_alerts', JSON.stringify(window.__tableAlerts));
  updateGlobalNotificationBadge();
  window.dispatchEvent(new Event("ff_admin_alert_received"));
}
window.clearTableAlert = clearTableAlert;

export function clearGlobalNotification() {
  window.__tableAlerts = {};
  localStorage.setItem('rms_table_alerts', '{}');
  updateGlobalNotificationBadge();
  window.dispatchEvent(new Event("ff_admin_alert_received"));
}
window.clearGlobalNotification = clearGlobalNotification;

const isCustomerMode = Boolean(new URLSearchParams(window.location.search).get("table") || new URLSearchParams(window.location.search).get("t"));

if (!isCustomerMode && !window.__FF_GLOBAL_LISTENER__) {
  window.__FF_GLOBAL_LISTENER__ = true;

  supabase.channel('ff-admin-alerts')
    .on('broadcast', { event: 'customer_order' }, payload => {
       if (payload.payload.isNew) setTableAlert(payload.payload.tableId, "new_order", "New Order Received");
       else setTableAlert(payload.payload.tableId, "added_items", "Additional Items Added");
    })
    .on('broadcast', { event: 'customer_bill' }, payload => {
       setTableAlert(payload.payload.tableId, "bill_requested", "Bill Requested");
    })
    .subscribe();
}

export function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function money(value, symbol = "₹") { return `${symbol}${Number(value || 0).toFixed(2)}`; }

export function showToast(title, message, type = "success") {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="toast-icon"><i class="ph ${type === "error" ? "ph-warning-circle" : "ph-check-circle"}"></i></div><div class="toast-copy"><strong>${escapeHtml(title)}</strong>${message ? `<span>${escapeHtml(message)}</span>` : ""}</div>`;
  root.appendChild(toast);
  window.setTimeout(() => { toast.classList.add("leaving"); window.setTimeout(() => toast.remove(), 180); }, 3400);
}

export function mountNavigation({ active = "pos" }) {
  const root = document.createElement("div");
  
  // Dynamic Contextual Configuration
  const isPos = active === "pos";
  const actionIcon = isPos ? "ph-sign-out" : "ph-lock-key";
  const actionText = isPos ? "Sign Out" : "Lock & Return to Workspaces";
  const actionColor = isPos ? "var(--danger)" : "var(--forest-900)";
  const actionId = isPos ? "staff-sign-out" : "admin-lock-workspace";

  // Fetch dynamic branding securely populated by the SaaS Bootstrapper
  const tenantName = window.__ACTIVE_TENANT__?.name || "RMS Cloud";
  const tenantIcon = window.__ACTIVE_TENANT__?.icon_url ? versionedAsset(window.__ACTIVE_TENANT__.icon_url) : versionedAsset("assets/images/RMS_icon.svg");

  root.innerHTML = `
    <div class="drawer-overlay" data-drawer-overlay></div>
    <aside class="app-drawer" data-app-drawer aria-label="Application navigation">
      <div class="drawer-head">
        <img src="${tenantIcon}" alt="Logo" style="border-radius: 8px; object-fit: cover;"/>
        <div><strong>${escapeHtml(tenantName)}</strong><small>Restaurant OS</small></div>
        <button class="icon-btn icon-btn-dark" data-close-drawer title="Close menu" aria-label="Close menu"><i class="ph ph-x"></i></button>
      </div>
      <nav class="drawer-nav">
        <button class="drawer-nav-item ${isPos ? "active" : ""}" data-route="#/panels"><i class="ph-bold ph-squares-four"></i><span>Workspaces</span></button>
        <!-- CRITICAL FIX: The Admin button now points to the proper #/admin route -->
        <button class="drawer-nav-item ${active === "admin" ? "active" : ""}" data-route="#/admin">
          <i class="ph-bold ph-shield-check"></i><span>Admin</span>
          <span id="admin-drawer-dot" style="width: 8px; height: 8px; border-radius: 50%; background: #e11d48; margin-left: auto; display: none;"></span>
        </button>
      </nav>
      <div class="drawer-foot" style="margin-top: auto; padding-bottom: 24px;">
         <button class="btn btn-quiet" id="${actionId}" style="width: 100%; border-color: var(--line); color: ${actionColor}; font-weight: 800;"><i class="ph-bold ${actionIcon}"></i> ${actionText}</button>
      </div>
    </aside>`;
  document.body.appendChild(root);

  const drawer = root.querySelector("[data-app-drawer]");
  const overlay = root.querySelector("[data-drawer-overlay]");
  const setOpen = open => { drawer.classList.toggle("open", open); overlay.classList.toggle("open", open); document.body.classList.toggle("drawer-open", open); };

  // Secure Contextual Button Logic
  root.querySelector(`#${actionId}`)?.addEventListener("click", async () => {
      setOpen(false); // Instantly close the drawer for a snappy feel
      
      if (isPos) {
          // POS MODE: Hard Sign-Out
          try {
             sessionStorage.removeItem("ff_staff_active");
             await signOut(); 
             window.location.reload(); 
          } catch (err) {
             console.error("Sign out failed:", err);
          }
      } else {
          // ADMIN MODE: Lock Workspace & Return to POS floor
          history.pushState({}, "", location.pathname);
          location.hash = "";
          window.dispatchEvent(new Event("rms:navigate"));
      }
  });

  root.addEventListener("click", async event => {
    const routeButton = event.target.closest("[data-route]");
    if (routeButton) {
      setOpen(false);
      const target = routeButton.dataset.route;
      
      // NOTE: Auto-clear removed! The red dot will stay until the staff actively clears the Inbox.
      
      if (target === "/") { history.pushState({}, "", location.pathname); location.hash = ""; }
      else location.hash = target;
      window.dispatchEvent(new Event("rms:navigate"));
      return;
    }
    if (event.target.closest("[data-close-drawer]") || event.target.closest("[data-drawer-overlay]")) { setOpen(false); return; }
  });

  window.__FOUR_FLAVOURS_NAV__ = { open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!drawer.classList.contains("open")) };
  window.__RMS_NAV__ = window.__FOUR_FLAVOURS_NAV__;
  
  // Sync dot visibility instantly when the drawer mounts
  setTimeout(updateGlobalNotificationBadge, 50);
  
  return () => { setOpen(false); root.remove(); delete window.__FOUR_FLAVOURS_NAV__; delete window.__RMS_NAV__; };
}

export function openAppModal({ title, subtitle = "", body, actions = [] }) {
  const root = document.createElement("div");
  root.className = "modal-backdrop";
  root.innerHTML = `
    <section class="app-modal" role="dialog" aria-modal="true">
      <header class="modal-head">
        <div class="modal-title-wrap">
          <!-- Dynamically inject active restaurant name here -->
          <span class="modal-kicker"><i class="ph ph-sparkle"></i>${escapeHtml(window.__ACTIVE_TENANT__?.name || "RMS Cloud")}</span>
          <h2>${escapeHtml(title)}</h2>
          ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}
        </div>
        <button class="icon-btn icon-btn-light" data-modal-close title="Close" aria-label="Close"><i class="ph ph-x"></i></button>
      </header>
      <div class="modal-body">${body}</div>${actions.length ? `<footer class="modal-actions">${actions.map((a,i)=>`<button class="btn ${a.className ?? "btn-quiet"}" style="${a.style || ''}" data-modal-action="${i}" ${a.disabled ? "disabled" : ""}>${a.icon ? `<i class="ph ${a.icon}" style="font-size: 22px; margin-right: 2px;"></i>` : ""}${escapeHtml(a.label)}</button>`).join("")}</footer>` : ""}
        </section>`;
  document.body.appendChild(root);
  document.body.classList.add("modal-open");
  const close = () => { root.remove(); document.body.classList.remove("modal-open"); document.removeEventListener("keydown", esc); };
  root.querySelector("[data-modal-close]")?.addEventListener("click", close);
  root.addEventListener("click", event => {
    if (event.target === root) close();
    const action = event.target.closest("[data-modal-action]");
    if (!action) return;
    const index = Number(action.dataset.modalAction);
    actions[index]?.onClick?.({ root, close, button: action });
  });
  const esc = event => { if (event.key === "Escape") close(); };
  document.addEventListener("keydown", esc);
  return { root, close };
}

// ============================================================================
// MASTER RECEIPT ENGINE (Single Source of Truth for POS, Customer & Admin)
// ============================================================================
export function openUniversalReceipt({
  order,
  items = [],
  settings = {},
  tables = [],
  tableString = "",
  modalTitle = "",
  modalSubtitle = "",
  isCustomerMode = false,
  allowPdf = true,
  extraActions = []
}) {
  const tenant = window.__ACTIVE_TENANT__ || {};
  const iconUrl = tenant.icon_url ? versionedAsset(tenant.icon_url) : "";
  const currency = settings.currency_symbol || "₹";

  // 1. Resolve Table / Order Type String automatically
  let resolvedTypeString = tableString;
  if (!resolvedTypeString) {
    const oType = order?.order_type || "dine_in";
    const tId = order?.table_id || order?.dining_sessions?.table_id;
    if (oType === "dine_in" && tId) {
      const allTables = tables.length ? tables : (window.__FF_TABLES__ || []);
      const tObj = allTables.find(x => x.id === tId);
      resolvedTypeString = tObj ? ("Dine-in · Table " + tObj.table_no) : "Dine-in";
    } else {
      resolvedTypeString = "Takeaway";
    }
  }

  // 2. Resolve Date
  const rawDate = order?.created_at ? new Date(order.created_at) : new Date();
  const dateStr = rawDate.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });

  // 3. Normalize Items (Handles both POS items and Admin order_items snapshots)
  const rawItems = (items && items.length > 0) ? items : (order?.order_items || []);
  const normalizedItems = rawItems.map(i => ({
    name: i.name || i.name_snapshot || i.product_name || "Item",
    price: Number(i.price ?? i.unit_price ?? 0),
    quantity: Number(i.quantity ?? 1)
  }));

  const rowsHtml = normalizedItems.map(item =>
    '<tr>' +
      '<td style="text-align: left;">' + escapeHtml(item.name) + '<br><small>' + currency + item.price.toFixed(2) + '</small></td>' +
      '<td style="text-align: center;">' + item.quantity + '</td>' +
      '<td style="text-align: right;">' + currency + (item.price * item.quantity).toFixed(2) + '</td>' +
    '</tr>'
  ).join("");

  const addressHtml = settings.restaurant_address
    ? '<p>' + escapeHtml(settings.restaurant_address).replace(/\n/g, "<br>") + '</p>'
    : "";

  // 4. Build Unified Thermal Receipt HTML (Parser-Safe)
  const receiptHTML =
    '<article class="thermal-receipt" id="thermal-receipt-content">' +
      '<header class="thermal-head">' +
        (iconUrl ? '<img class="thermal-logo" src="' + iconUrl + '" alt="Restaurant logo">' : '') +
        '<h1>' + escapeHtml(settings.restaurant_name || tenant.name || "Restaurant") + '</h1>' +
        addressHtml +
        (settings.gst_number ? '<p><strong>GSTIN:</strong> ' + escapeHtml(settings.gst_number) + '</p>' : '') +
      '</header>' +
      '<div class="thermal-meta">' +
        '<div><span>Order:</span> <strong>#' + escapeHtml(order?.order_number ?? "Tab") + '</strong></div>' +
        '<div><span>Date:</span> <strong>' + dateStr + '</strong></div>' +
        '<div><span>Type:</span> <strong>' + escapeHtml(resolvedTypeString) + '</strong></div>' +
      '</div>' +
      '<table class="thermal-items-table">' +
        '<thead>' +
          '<tr>' +
            '<th style="text-align: left;">Item</th>' +
            '<th style="text-align: center;">Qty</th>' +
            '<th style="text-align: right;">Total</th>' +
          '</tr>' +
        '</thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table>' +
      '<div class="thermal-totals-wrap">' +
        '<div class="thermal-line"><span>Subtotal</span><strong>' + currency + Number(order?.subtotal || 0).toFixed(2) + '</strong></div>' +
        '<div class="thermal-line"><span>CGST @ ' + Number(settings.cgst_rate || 0) + '%</span><strong>' + currency + Number(order?.cgst || 0).toFixed(2) + '</strong></div>' +
        '<div class="thermal-line"><span>SGST @ ' + Number(settings.sgst_rate || 0) + '%</span><strong>' + currency + Number(order?.sgst || 0).toFixed(2) + '</strong></div>' +
        '<div class="thermal-line"><span>Rounding</span><strong>' + currency + Number(order?.rounding || 0).toFixed(2) + '</strong></div>' +
        '<div class="thermal-line thermal-grand"><span>GRAND TOTAL</span><strong>' + currency + Number(order?.grand_total || 0).toFixed(2) + '</strong></div>' +
      '</div>' +
      (settings.upi_id ?
        '<div class="thermal-payment-block">' +
          '<div class="thermal-qr" id="thermal-upi"></div>' +
          '<div class="thermal-upi-note"><strong>Scan to pay</strong><br>Supported by all UPI apps</div>' +
        '</div>'
      : '') +
      '<footer class="thermal-foot">' +
        '<p>' + escapeHtml(settings.receipt_footer || "Thank you for dining with us!") + '</p>' +
        '<div class="thermal-software-tag">Powered by Table Forge System</div>' +
      '</footer>' +
    '</article>';

  // 5. Build Unified Modal Actions
  let actionsList = [];

  if (isCustomerMode) {
    actionsList = [
      {
        label: "Exit",
        icon: "ph-check",
        className: "btn-primary",
        onClick: ({ close }) => { close(); window.location.reload(); }
      }
    ];
  } else {
    if (allowPdf) {
      actionsList.push({
        label: "Save PDF",
        icon: "ph-bold ph-download-simple",
        className: "btn-quiet",
        style: "color: var(--forest-950); font-weight: 900;",
        onClick: async ({ root, button }) => {
          const element = root.querySelector("#thermal-receipt-content");
          if (!element) {
            showToast("Could not save PDF", "The receipt preview is unavailable.", "error");
            return;
          }
          button.disabled = true;
          const originalHTML = button.innerHTML;
          button.innerHTML = '<i class="ph ph-spinner-gap ph-spin"></i> Saving...';

          const oldShadow = element.style.boxShadow;
          const oldMargin = element.style.margin;

          try {
            if (!window.html2pdf) {
              await new Promise((resolve, reject) => {
                const script = document.createElement("script");
                script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";
                script.onload = resolve;
                script.onerror = () => reject(new Error("The PDF library could not be loaded."));
                document.head.appendChild(script);
              });
            }
            element.style.boxShadow = "none";
            element.style.margin = "0";
            const heightInMM = (element.getBoundingClientRect().height * 0.264583) + 1;

            await window.html2pdf()
              .set({
                margin: 0,
                filename: ((settings.restaurant_name || "Bill").replace(/\s+/g, "_")) + "_order_" + (order?.order_number || "Tab") + ".pdf",
                image: { type: "jpeg", quality: 1 },
                html2canvas: { scale: 6, useCORS: true },
                jsPDF: { unit: "mm", format: [80, heightInMM], orientation: "portrait" }
              })
              .from(element)
              .save();
          } catch (error) {
            console.error("PDF generation failed:", error);
            showToast("Could not save PDF", error.message || "Please try again.", "error");
          } finally {
            element.style.boxShadow = oldShadow;
            element.style.margin = oldMargin;
            button.disabled = false;
            button.innerHTML = originalHTML;
          }
        }
      });
    } else {
      actionsList.push({
        label: "Close",
        icon: "ph-x",
        className: "btn-quiet",
        onClick: ({ close }) => close()
      });
    }

    actionsList.push({
      label: "Print Bill",
      icon: "ph-bold ph-printer",
      className: "btn-primary",
      style: "background: var(--forest-950); border-color: var(--forest-950); font-weight: 900;",
      onClick: ({ root }) => {
        const receipt = root.querySelector("#thermal-receipt-content");
        const printHost = document.querySelector("#receipt-print-host");
        if (!receipt || !printHost) {
          showToast("Could not print", "The receipt preview is unavailable.", "error");
          return;
        }
        printHost.innerHTML = receipt.outerHTML;
        window.print();
      }
    });

    if (extraActions && extraActions.length) {
      actionsList.push(...extraActions);
    }
  }

  const finalTitle = modalTitle || (isCustomerMode ? "Your Digital Bill" : ("Order #" + (order?.order_number ?? "Tab") + " Bill"));
  const finalSubtitle = modalSubtitle || (isCustomerMode ? "Please settle this bill with restaurant staff in person." : "View, save, or print this bill.");

  const modal = openAppModal({
    title: finalTitle,
    subtitle: finalSubtitle,
    body: '<div class="receipt-preview-container">' + receiptHTML + '</div>',
    actions: actionsList
  });

  // 6. Universal UPI QR Code Generator with Center Brand Icon
  if (settings.upi_id) {
    const renderQR = () => {
      setTimeout(() => {
        const qrNode = modal.root.querySelector("#thermal-upi");
        if (qrNode) {
          qrNode.innerHTML = "";
          const rawUpi = String(settings.upi_id).replace(/[^a-zA-Z0-9.\-@]/g, "");
          const rawName = String(settings.restaurant_name || tenant.name || "Restaurant").replace(/[^a-zA-Z0-9\s]/g, "").trim();
          const rawNote = "Bill " + (order?.order_number || "Tab");
          const am = Number(order?.grand_total || 0).toFixed(2);
          const upiString = encodeURI("upi://pay?pa=" + rawUpi + "&pn=" + rawName + "&am=" + am + "&cu=INR&tn=" + rawNote);

          qrNode.style.position = "relative";
          qrNode.style.display = "inline-block";

          new globalThis.QRCode(qrNode, {
            text: upiString,
            width: 160,
            height: 160,
            correctLevel: globalThis.QRCode.CorrectLevel.H
          });

          if (iconUrl) {
            const logoImg = document.createElement("img");
            logoImg.src = iconUrl;
            logoImg.style.cssText = "position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 36px; height: 36px; min-width: 36px; min-height: 36px; max-width: 36px; max-height: 36px; border-radius: 8px; border: 3px solid #ffffff; background-color: #ffffff; object-fit: cover; box-shadow: 0 2px 8px rgba(0,0,0,0.15); z-index: 5;";
            qrNode.appendChild(logoImg);
          }
        }
      }, 50);
    };

    if (globalThis.QRCode) {
      renderQR();
    } else {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
      script.onload = renderQR;
      document.head.appendChild(script);
    }
  }

  return modal;
}
