import { supabase } from "../core/supabase.js";
import {
  DEFAULT_SETTINGS,
  versionedAsset,
  getCustomerTableUrl
} from "../core/config.js";
import { renderAdminLock } from "../components/lockScreen.js";
import {
  escapeHtml,
  money,
  mountNavigation,
  openAppModal,
  showToast
} from "../components/navigation.js";

const DISH_IMAGE_BUCKET = "dish-images";
const MAX_SOURCE_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_FINAL_IMAGE_BYTES = 2 * 1024 * 1024;
const TARGET_IMAGE_BYTES = 350 * 1024;
const IMAGE_CACHE_SECONDS = 31536000;

async function decodeDishImage(file) {
  if ("createImageBitmap" in window) {
    try {
      const bitmap = await createImageBitmap(
        file,
        {
          imageOrientation: "from-image"
        }
      );

      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close()
      };
    } catch {
      // Fall through to HTMLImageElement decoding.
    }
  }

  const objectUrl =
    URL.createObjectURL(file);

  const image =
    new Image();

  image.decoding =
    "async";

  image.src =
    objectUrl;

  try {
    await image.decode();
  } catch {
    await new Promise(
      (resolve, reject) => {
        image.onload = resolve;
        image.onerror = () =>
          reject(
            new Error(
              "The selected image could not be decoded."
            )
          );
      }
    );
  }

  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    cleanup: () =>
      URL.revokeObjectURL(objectUrl)
  };
}

function canvasToWebp(
  canvas,
  quality
) {
  return new Promise(
    (resolve, reject) => {
      canvas.toBlob(
        blob => {
          if (!blob) {
            reject(
              new Error(
                "The browser could not create the optimized image."
              )
            );
            return;
          }

          if (blob.type !== "image/webp") {
            reject(
              new Error(
                "This browser cannot export WebP images. Please use a current Chrome, Edge, Safari or Firefox browser."
              )
            );
            return;
          }

          resolve(blob);
        },
        "image/webp",
        quality
      );
    }
  );
}

function drawDishCrop(
  source,
  sourceWidth,
  sourceHeight,
  targetWidth,
  targetHeight
) {
  const targetRatio =
    targetWidth / targetHeight;

  const sourceRatio =
    sourceWidth / sourceHeight;

  let cropWidth;
  let cropHeight;
  let cropX;
  let cropY;

  if (sourceRatio > targetRatio) {
    cropHeight =
      sourceHeight;

    cropWidth =
      sourceHeight *
      targetRatio;

    cropX =
      (sourceWidth - cropWidth) / 2;

    cropY = 0;
  } else {
    cropWidth =
      sourceWidth;

    cropHeight =
      sourceWidth /
      targetRatio;

    cropX = 0;

    cropY =
      (sourceHeight - cropHeight) / 2;
  }

  const canvas =
    document.createElement("canvas");

  canvas.width =
    targetWidth;

  canvas.height =
    targetHeight;

  const context =
    canvas.getContext("2d", {
      alpha: false
    });

  if (!context) {
    throw new Error(
      "The browser could not create an image canvas."
    );
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  context.drawImage(
    source,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    targetWidth,
    targetHeight
  );

  return canvas;
}

async function optimizeDishImage(file) {
  if (!file) {
    return null;
  }

  if (
    !file.type.startsWith("image/")
  ) {
    throw new Error(
      "Please select an image file."
    );
  }

  if (
    file.size >
    MAX_SOURCE_IMAGE_BYTES
  ) {
    throw new Error(
      "Please select an image smaller than 12 MB."
    );
  }

  const decoded =
    await decodeDishImage(file);

  try {
    if (
      !decoded.width ||
      !decoded.height
    ) {
      throw new Error(
        "The selected image has invalid dimensions."
      );
    }

    if (
      decoded.width *
      decoded.height >
      50_000_000
    ) {
      throw new Error(
        "The selected image has too many pixels. Please choose a smaller image."
      );
    }

    /*
     * Four Flavours uses ONE canonical source ratio:
     *
     *                 1200 × 900
     *                   4 : 3
     *
     * This keeps every dish visually consistent across desktop,
     * tablet and mobile while avoiding giant originals in Storage.
     */
    const profiles = [
      {
        width: 1200,
        height: 900,
        quality: 0.86
      },
      {
        width: 1200,
        height: 900,
        quality: 0.82
      },
      {
        width: 1200,
        height: 900,
        quality: 0.78
      },
      {
        width: 1200,
        height: 900,
        quality: 0.74
      },
      {
        width: 960,
        height: 720,
        quality: 0.82
      },
      {
        width: 960,
        height: 720,
        quality: 0.76
      },
      {
        width: 768,
        height: 576,
        quality: 0.78
      },
      {
        width: 768,
        height: 576,
        quality: 0.72
      }
    ];

    let lastBlob =
      null;

    for (const profile of profiles) {
      const canvas =
        drawDishCrop(
          decoded.source,
          decoded.width,
          decoded.height,
          profile.width,
          profile.height
        );

      const blob =
        await canvasToWebp(
          canvas,
          profile.quality
        );

      lastBlob =
        blob;

      /*
       * Target ≈350 KB for fast QR/customer loading.
       * Hard limit remains 2 MB because that is the bucket limit.
       */
      if (
        blob.size <=
        TARGET_IMAGE_BYTES
      ) {
        return new File(
          [blob],
          `dish-${crypto.randomUUID()}.webp`,
          {
            type: "image/webp",
            lastModified: Date.now()
          }
        );
      }

      if (
        blob.size <=
        MAX_FINAL_IMAGE_BYTES
        &&
        profile ===
          profiles[profiles.length - 1]
      ) {
        return new File(
          [blob],
          `dish-${crypto.randomUUID()}.webp`,
          {
            type: "image/webp",
            lastModified: Date.now()
          }
        );
      }
    }

    if (
      lastBlob &&
      lastBlob.size <=
        MAX_FINAL_IMAGE_BYTES
    ) {
      return new File(
        [lastBlob],
        `dish-${crypto.randomUUID()}.webp`,
        {
          type: "image/webp",
          lastModified: Date.now()
        }
      );
    }

    throw new Error(
      "The optimized image is still too large. Please select a simpler or smaller photo."
    );

  } finally {
    decoded.cleanup();
  }
}

function drawCuisineCrop(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const targetRatio = targetWidth / targetHeight;
  const sourceRatio = sourceWidth / sourceHeight;
  let cropWidth, cropHeight, cropX, cropY;

  if (sourceRatio > targetRatio) {
    // Image is wider than needed. Center-crop horizontally.
    cropHeight = sourceHeight;
    cropWidth = sourceHeight * targetRatio;
    cropX = (sourceWidth - cropWidth) / 2;
    cropY = 0;
  } else {
    // Image is taller than needed. Top-align to preserve text at the top!
    cropWidth = sourceWidth;
    cropHeight = sourceWidth / targetRatio;
    cropX = 0;
    cropY = 0; // 0 anchors it to the absolute top edge
  }

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("The browser could not create an image canvas.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, cropX, cropY, cropWidth, cropHeight, 0, 0, targetWidth, targetHeight);
  return canvas;
}

async function optimizeCuisineImage(file) {
  if (!file) return null;
  if (!file.type.startsWith("image/")) throw new Error("Please select an image file.");
  if (file.size > MAX_SOURCE_IMAGE_BYTES) throw new Error("Please select an image smaller than 12 MB.");

  const decoded = await decodeDishImage(file);
  try {
    if (!decoded.width || !decoded.height) throw new Error("The selected image has invalid dimensions.");
    if (decoded.width * decoded.height > 50_000_000) throw new Error("The selected image has too many pixels.");

    // Target ratio 3:4 (Standard portrait cards)
    const profiles = [
      { width: 1200, height: 1600, quality: 0.86 },
      { width: 1200, height: 1600, quality: 0.82 },
      { width: 960, height: 1280, quality: 0.82 },
      { width: 768, height: 1024, quality: 0.78 }
    ];

    let lastBlob = null;
    for (const profile of profiles) {
      const canvas = drawCuisineCrop(decoded.source, decoded.width, decoded.height, profile.width, profile.height);
      const blob = await canvasToWebp(canvas, profile.quality);
      lastBlob = blob;
      if (blob.size <= TARGET_IMAGE_BYTES) return new File([blob], `cuisine-${crypto.randomUUID()}.webp`, { type: "image/webp", lastModified: Date.now() });
      if (blob.size <= MAX_FINAL_IMAGE_BYTES && profile === profiles[profiles.length - 1]) return new File([blob], `cuisine-${crypto.randomUUID()}.webp`, { type: "image/webp", lastModified: Date.now() });
    }

    if (lastBlob && lastBlob.size <= MAX_FINAL_IMAGE_BYTES) return new File([lastBlob], `cuisine-${crypto.randomUUID()}.webp`, { type: "image/webp", lastModified: Date.now() });
    throw new Error("The optimized image is still too large.");
  } finally {
    decoded.cleanup();
  }
}

function storagePathFromUrl(
  value
) {
  const raw =
    String(value ?? "")
      .trim();

  if (!raw) {
    return null;
  }

  const marker =
    `/storage/v1/object/public/${DISH_IMAGE_BUCKET}/`;

  const index =
    raw.indexOf(marker);

  if (index >= 0) {
    return decodeURIComponent(
      raw
        .slice(
          index + marker.length
        )
        .split("?")[0]
    );
  }

  if (
    raw.startsWith("products/") ||
    raw.startsWith("cuisines/")
  ) {
    return raw;
  }

  return null;
}

function getDishPublicUrl(
  path
) {
  const {
    data
  } =
    supabase.storage
      .from(DISH_IMAGE_BUCKET)
      .getPublicUrl(path);

  return data.publicUrl;
}

export async function render({ mount }) {
  let cleanup = null;
  await renderAdminLock({
    mount,
    onUnlocked: async () => {
      cleanup = await renderAdminWorkspace(mount);
    }
  });
  return () => cleanup?.();
}

async function fetchWorkspace() {
  // 1. STRICT IDENTITY VERIFICATION: Always ask Supabase for the true logged-in user.
  // This completely eliminates "Ghost State" where a previous login's data remains in memory across accounts.
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
      const { data: rest } = await supabase
        .from("restaurants")
        .select("id, name, slug, icon_url, logo_url, background_color, foreground_color")
        .eq("owner_id", user.id)
        .maybeSingle();
      if (rest) {
          window.__ACTIVE_TENANT__ = rest;
      }
  }

  const activeTenantId = window.__ACTIVE_TENANT__?.id;

  const [settings, products, tables, sessions, cuisines] = await Promise.all([
    supabase
      .from("app_settings")
      .select("restaurant_id, restaurant_name, restaurant_address, gst_number, cgst_rate, sgst_rate, currency_symbol, receipt_footer, upi_id, daily_pin")
      .eq("restaurant_id", activeTenantId)
      .maybeSingle(),
    supabase.from("products").select("*").eq("restaurant_id", activeTenantId).order("sort_order", { ascending: true }).order("name", { ascending: true }),
    supabase.from("tables").select("*").eq("restaurant_id", activeTenantId).order("table_no", { ascending: true }),
    supabase.from("dining_sessions").select("*").eq("restaurant_id", activeTenantId).neq("status", "closed").order("bill_requested_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }),
    supabase.from("cuisines").select("*").eq("restaurant_id", activeTenantId).order("sort_order", { ascending: true })
  ]);
  for (const result of [settings, products, tables, sessions, cuisines]) if (result?.error) throw result.error;
  
  // NATURAL SORT: Ensure all admin lists naturally sort as 1, 2, 3 instead of 1, 10, 11
  const sortedTables = (tables.data ?? []).sort((a, b) => 
    String(a.table_no).localeCompare(String(b.table_no), undefined, { numeric: true, sensitivity: 'base' })
  );

  return { settings: { ...DEFAULT_SETTINGS, ...(settings.data ?? {}) }, products: products.data ?? [], tables: sortedTables, sessions: sessions.data ?? [], cuisines: cuisines.data ?? [] };
}

async function renderAdminWorkspace(mount) {
  // 1. HARDWARE AUDIO ENGINE: Generates a perfect 880Hz POS 'Ding' without needing MP3 files
  const playDing = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'bell'; osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.6, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.6);
    } catch(e) { console.warn("Audio disabled by browser auto-play policy."); }
  };

  // 2. ENTERPRISE AUTO-LOCK: Securely logs out the admin if the tablet is untouched for 15 minutes
  let inactivityTimer;
  const resetLock = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(async () => {
          await supabase.auth.signOut();
          window.__ACTIVE_TENANT__ = null;
          window.location.reload();
      }, 15 * 60 * 1000); // 15 mins
  };
  ['touchstart', 'mousemove', 'keydown'].forEach(e => document.addEventListener(e, resetLock, { passive: true }));
  resetLock();

  // 3. NETWORK DROP RESILIENCE: Alerts staff immediately if the WiFi dies
  window.addEventListener('offline', () => showToast("Network Offline", "Live sync paused. Check your router.", "error"));
  window.addEventListener('online', () => showToast("Network Restored", "Live sync is back online.", "success"));

  let { settings, products, tables, sessions, cuisines } = await fetchWorkspace();
  window.__FF_TABLES__ = tables;
  let section = "overview";

  // 1. Fetch dynamic tenant branding safely
  const activeTenant = window.__ACTIVE_TENANT__ || {};
  const logoUrl = activeTenant.logo_url ? versionedAsset(activeTenant.logo_url) : null;
  const iconUrl = activeTenant.icon_url ? versionedAsset(activeTenant.icon_url) : null;
  const tenantName = activeTenant.name || "Table Forge";

  mount.innerHTML = `
    <section class="admin-page">
      <header class="app-topbar admin-topbar">
        <div class="topbar-side topbar-left" style="gap: 12px;">
          <button class="icon-btn icon-btn-dark" id="admin-menu" title="Menu" aria-label="Menu" style="position: relative;">
            <i class="ph ph-list"></i>
            <span class="hamburger-dot" style="display: none;"></span>
          </button>
          ${logoUrl 
            ? `<img src="${logoUrl}" alt="${escapeHtml(tenantName)}" style="height: 40px; max-width: 180px; object-fit: contain; object-position: left center;" />`
            : `<strong style="font-size: 1.15rem; color: var(--forest-950); margin-left: 4px;">${escapeHtml(tenantName)}</strong>`
          }
        </div>
        <div class="brand-center main-logo-only">
          <!-- Center logo safely removed to match POS layout -->
        </div>
        <div class="topbar-side topbar-right">
          <button class="icon-btn icon-btn-dark" id="admin-refresh" title="Refresh" aria-label="Refresh"><i class="ph-bold ph-arrows-clockwise"></i></button>
          <button class="icon-btn" id="admin-logout" title="Sign Out" aria-label="Sign Out" style="background: #fee2e2; color: #e11d48; border: 1px solid #fecdd3; border-radius: 12px; margin-left: 8px;"><i class="ph-bold ph-sign-out"></i></button>
        </div>
      </header>

      <nav class="admin-section-nav" id="admin-section-nav" aria-label="Management sections">
        <button data-section="overview" class="active"><i class="ph ph-fill ph-squares-four"></i><span>Overview</span></button>
        <button data-section="orders"><i class="ph ph-bold ph-receipt"></i><span>Orders</span></button>
        <button data-section="cuisines"><i class="ph ph-bold ph-image"></i><span>Cuisines</span></button>
        <button data-section="menu"><i class="ph ph-bold ph-fork-knife"></i><span>Menu</span></button>
        <button data-section="tables"><i class="ph ph-bold ph-armchair"></i><span>Tables</span></button>
        <button data-section="settings"><i class="ph ph-bold ph-gear"></i><span>Settings</span></button>
      </nav>
      <main class="admin-content"><section id="admin-area"></section></main>
    </section>`;

  const navCleanup = mountNavigation({ active: "admin" });
  const area = mount.querySelector("#admin-area");

  // 🧠 THE ULTIMATE ALERT EVALUATOR: Calculates the true state of the restaurant and syncs ALL dots!
  function evaluateGlobalAlerts() {
      const seenSessions = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_sessions") || "[]"));
      
      // Ghost Purge: Automatically delete local alerts for tables that are no longer active
      const activeTableIds = new Set((sessions || []).map(s => s.table_id));
      if (window.__tableAlerts) {
          Object.keys(window.__tableAlerts).forEach(tId => {
              if (!activeTableIds.has(tId)) {
                  delete window.__tableAlerts[tId];
              }
          });
      }

      const hasUnreadBills = (sessions || []).some(s => s.status === 'bill_requested' && !seenSessions.has(s.id));
      const hasLocalAlerts = Object.keys(window.__tableAlerts || {}).length > 0;
      
      const isAlertActive = hasUnreadBills || hasLocalAlerts;

      // Force-update all dots across the entire UI (Topbar + Drawer)
      document.querySelectorAll(".hamburger-dot, .admin-drawer-dot, [data-drawer-alert-dot], .drawer-nav-dot").forEach(dot => {
          dot.style.display = isAlertActive ? "block" : "none";
      });
      
      // Synchronize with external navigation components if available
      if (window.setGlobalNotification) {
          if (isAlertActive) window.setGlobalNotification(true);
          else window.clearGlobalNotification();
      }
  }

  // Dynamically swaps hollow icons to filled icons for the active tab
  function updateNavUI() {
    mount.querySelectorAll("[data-section]").forEach(el => {
      const isActive = el.dataset.section === section;
      el.classList.toggle("active", isActive);
      const icon = el.querySelector("i");
      if (icon) {
        if (isActive) icon.className = icon.className.replace("ph-bold", "ph-fill");
        else icon.className = icon.className.replace("ph-fill", "ph-bold");
      }
    });
    
    evaluateGlobalAlerts();
  }

  mount.querySelector("#admin-menu").addEventListener("click", () => window.__FOUR_FLAVOURS_NAV__?.open());

  // ==========================================
  // GLOBAL SIGN OUT LOGIC
  // ==========================================
  mount.querySelector("#admin-logout")?.addEventListener("click", async () => {
    const btn = mount.querySelector("#admin-logout");
    btn.innerHTML = `<i class="ph-bold ph-spinner-gap ph-spin"></i>`;
    
    // 1. Securely destroy the Supabase authentication session
    await supabase.auth.signOut();
    
    // 2. Wipe the local browser memory
    window.__ACTIVE_TENANT__ = null;
    
    // 3. Kick the user back to the main SaaS landing page
    history.pushState({}, "", location.pathname);
    location.hash = "";
    window.dispatchEvent(new Event("rms:navigate"));
  });
  
  mount.querySelector("#admin-refresh").addEventListener("click", async (e) => { 
    const btn = e.currentTarget;
    const icon = btn.querySelector("i");
    
    const blocker = document.createElement("div");
    blocker.className = "full-page-blocker";
    document.body.appendChild(blocker);
    
    btn.disabled = true;
    icon.classList.add("icon-spin");
    
    try {
      await reload(); 
      showToast("Workspace refreshed"); 
    } catch (err) {
      showToast("Refresh failed", err.message, "error");
    } finally {
      icon.classList.remove("icon-spin");
      btn.disabled = false;
      blocker.remove();
    }
  });

  mount.querySelector("#admin-section-nav").addEventListener("click", event => {
    const b = event.target.closest("[data-section]");
    if (!b) return;
    section = b.dataset.section;
    
    // PREMIUM UX: Automatically clear "New Activity" ghost alerts when the admin checks the dashboard!
    if (section === "orders" || section === "overview" || section === "tables") {
      b.style.color = "";
      b.classList.remove("qty-pulse");
      window.__tableAlerts = {}; // Wipe local temporary alerts
      if (window.clearGlobalNotification) window.clearGlobalNotification();
    }
    
    updateNavUI();
    renderSection();
    
    // NATIVE APP BEHAVIOR: Instantly snap the page back to the absolute top
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    
    // Failsafe: Reset the internal flex container if it caught any scroll momentum
    const adminContent = mount.querySelector(".admin-content");
    if (adminContent) adminContent.scrollTop = 0;
  });

  async function reload() {
    ({ settings, products, tables, sessions, cuisines } = await fetchWorkspace());
    window.__FF_TABLES__ = tables;
    evaluateGlobalAlerts();
    renderSection();
  }

  function renderSection() {
    if (section === "overview") renderOverview();
    if (section === "orders") renderOrders();
    if (section === "cuisines") renderCuisines();
    if (section === "menu") renderMenu();
    if (section === "tables") renderTables();
    if (section === "settings") renderSettings();
  }

  async function renderOrders() {
    // Default to 'today' as it is the most relevant for an active POS dashboard
    const currentFilter = area.dataset.orderFilter || 'today';
    const customDate = area.dataset.customDate || '';

    area.innerHTML = `
      <section class="section-title-row">
        <div>
          <span class="eyebrow">Order History</span>
          <h1>All past bills.</h1>
          <p>View, reprint, or delete historical receipts.</p>
        </div>
        <button class="btn btn-primary" id="export-excel-btn" style="background: #16a34a; border-color: #15803d; color: white; box-shadow: 0 4px 12px rgba(22, 163, 74, 0.25);">
          <i class="ph-bold ph-download-simple"></i> Excel
        </button>
      </section>
      
      <!-- ANALYTICS DATE FILTERS -->
      <div class="pos-toolbar-row" id="order-date-filters" style="justify-content: flex-start; margin: 0 0 16px 0; overflow-x: auto; padding-bottom: 4px; gap: 8px;">
         <button class="pos-toolbar-pill ${currentFilter === 'today' ? 'active' : ''}" data-range="today"><span>Today</span></button>
         <button class="pos-toolbar-pill ${currentFilter === 'all' ? 'active' : ''}" data-range="all"><span>All</span></button>
         
         <!-- Native OS Calendar Picker (PC Fix with showPicker API) -->
         <div style="position: relative; display: inline-flex;">
           <button class="pos-toolbar-pill ${currentFilter === 'custom' ? 'active' : ''}" style="padding-right: 14px;" onclick="try { document.getElementById('custom-date-picker').showPicker(); } catch(e) {}">
             <i class="ph-bold ph-calendar-blank"></i>
             <span>${currentFilter === 'custom' && customDate ? new Date(customDate).toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'}) : 'Date'}</span>
           </button>
           <input type="date" id="custom-date-picker" value="${customDate}" style="position: absolute; left: 0; bottom: 0; width: 0; height: 0; opacity: 0; pointer-events: none;">
         </div>
      </div>

      <section class="admin-panel">
        <div class="admin-list-scroll" id="orders-list">
          <div class="empty-state"><i class="ph ph-spinner-gap ph-spin"></i><strong>Loading orders...</strong></div>
        </div>
      </section>`;
    
    // Attach Filter Listeners
    area.querySelectorAll("#order-date-filters button[data-range]").forEach(btn => {
        btn.addEventListener("click", () => {
            area.dataset.orderFilter = btn.dataset.range;
            renderOrders(); // Re-render with new filter
        });
    });

    const datePicker = area.querySelector("#custom-date-picker");
    if (datePicker) {
        datePicker.addEventListener("change", (e) => {
            if (e.target.value) {
                area.dataset.orderFilter = 'custom';
                area.dataset.customDate = e.target.value;
                renderOrders();
            }
        });
    }

    const list = area.querySelector("#orders-list");
    const exportBtn = area.querySelector("#export-excel-btn");

    try {
        // 1. Build Query with Strict Time Range Logic
        let query = supabase.from("orders")
          .select("*, order_items(*), dining_sessions(status)")
          .eq("restaurant_id", window.__ACTIVE_TENANT__.id);

        if (currentFilter === 'today') {
            const start = new Date(); start.setHours(0,0,0,0);
            query = query.gte("created_at", start.toISOString());
        } else if (currentFilter === 'custom' && customDate) {
            const start = new Date(customDate); start.setHours(0,0,0,0);
            const end = new Date(customDate); end.setHours(23,59,59,999);
            query = query.gte("created_at", start.toISOString()).lte("created_at", end.toISOString());
        }

        // Adjust limits: Allow massive pulls for custom dates, keep 'all' fast to prevent crashing
        if (currentFilter === 'all') query = query.limit(150);
        else query = query.limit(2000); 

        const { data: rawOrders, error } = await query.order("created_at", { ascending: false });
        if (error) throw error;

        // 2. Filter out open sessions that haven't requested bills yet
        const validOrders = rawOrders.filter(o => 
            o.order_type === 'takeaway' || 
            (o.dining_sessions && ['closed', 'bill_requested', 'bill_ready'].includes(o.dining_sessions.status))
        );

        // 3. CONSOLIDATE ROUNDS INTO A SINGLE MASTER BILL
        const groupedOrdersMap = new Map();
        
        validOrders.forEach(o => {
            const key = o.session_id || o.id; 
            if (!groupedOrdersMap.has(key)) {
                groupedOrdersMap.set(key, {
                    ...o,
                    original_order_ids: [o.id],
                    all_order_numbers: [Number(o.order_number)], // Track all numbers for the range
                    subtotal: Number(o.subtotal || 0),
                    cgst: Number(o.cgst || 0),
                    sgst: Number(o.sgst || 0),
                    rounding: Number(o.rounding || 0),
                    grand_total: Number(o.grand_total || 0),
                    order_items: [...(o.order_items || [])]
                });
            } else {
                const master = groupedOrdersMap.get(key);
                master.original_order_ids.push(o.id);
                if (o.order_number) master.all_order_numbers.push(Number(o.order_number));
                
                master.subtotal += Number(o.subtotal || 0);
                master.cgst += Number(o.cgst || 0);
                master.sgst += Number(o.sgst || 0);
                master.rounding += Number(o.rounding || 0);
                master.grand_total += Number(o.grand_total || 0);
                master.order_items.push(...(o.order_items || []));
                
                // Keep the timestamp anchored to their FIRST round (when they sat down)
                if (new Date(o.created_at) < new Date(master.created_at)) {
                    master.created_at = o.created_at;
                }
            }
        });

        // Filter out any orders that have been completely emptied (0 items)
        const orders = Array.from(groupedOrdersMap.values()).filter(o => o.order_items && o.order_items.length > 0);

        // ==========================================
        // EXPORT TO EXCEL LOGIC (WYSIWYG: Only exports what is filtered!)
        // ==========================================
        if (exportBtn) {
            if (!orders || orders.length === 0) {
                exportBtn.style.display = "none";
            } else {
                exportBtn.style.display = "flex";
                exportBtn.addEventListener("click", async () => {
                    const ogHtml = exportBtn.innerHTML;
                    exportBtn.disabled = true;
                    exportBtn.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i> Exporting...`;

                    try {
                        const excelData = orders.map(o => {
                            let tableStr = "Takeaway";
                            if (o.dining_sessions?.table_id && typeof tables !== 'undefined') {
                                const t = tables.find(x => x.id === o.dining_sessions.table_id);
                                if (t) tableStr = `Table ${t.table_no}`;
                            }
                            const itemsStr = (o.order_items || []).map(i => `${i.quantity}x ${i.name_snapshot || i.product_name || i.name}`).join(", ");
                            return {
                                "Order #": o.order_number,
                                "Date": new Date(o.created_at).toLocaleDateString('en-IN'),
                                "Time": new Date(o.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
                                "Order Type": tableStr,
                                "Items": itemsStr,
                                "Subtotal (₹)": Number(o.subtotal || 0),
                                "CGST (₹)": Number(o.cgst || 0),
                                "SGST (₹)": Number(o.sgst || 0),
                                "Rounding (₹)": Number(o.rounding || 0),
                                "Grand Total (₹)": Number(o.grand_total || 0),
                                "Status": String(o.status || "Completed").toUpperCase()
                            };
                        });

                        if (!window.XLSX) {
                            await new Promise((resolve, reject) => {
                                const script = document.createElement("script");
                                script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
                                script.onload = resolve; script.onerror = reject;
                                document.head.appendChild(script);
                            });
                        }

                        const wb = window.XLSX.utils.book_new();
                        const ws = window.XLSX.utils.json_to_sheet(excelData);
                        ws['!cols'] = [{ wch: 10 }, { wch: 15 }, { wch: 12 }, { wch: 18 }, { wch: 55 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 15 }, { wch: 15 }];
                        
                        let safeSheetName = (window.__ACTIVE_TENANT__?.name || "Orders").substring(0, 31).replace(/[\\\/\?\*\[\]\:]/g, ''); 
                        window.XLSX.utils.book_append_sheet(wb, ws, safeSheetName);
                        
                        let rangeStr = currentFilter === 'all' ? 'All_Time' : currentFilter.toUpperCase();
                        window.XLSX.writeFile(wb, `${safeSheetName.replace(/\s+/g, '_')}_Orders_${rangeStr}.xlsx`);
                        
                        showToast("Export Successful", "Excel file downloaded securely.", "success");
                    } catch (err) {
                        showToast("Export Failed", err.message, "error");
                    } finally {
                        exportBtn.disabled = false;
                        exportBtn.innerHTML = ogHtml;
                    }
                });
            }
        }

        if (!orders || orders.length === 0) {
            list.innerHTML = `<div class="empty-state"><i class="ph ph-receipt"></i><strong>No bills found</strong><span>There are no completed orders in this date range.</span></div>`;
            return;
        }

        const seenOrders = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_orders") || "[]"));
        const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60000);

        // 3. Render list with Gold/Green Highlight states
        list.innerHTML = orders.map(o => {
            const orderDate = new Date(o.created_at);
        
            const isUnpaidTable = o.dining_sessions && ['bill_requested', 'bill_ready'].includes(o.dining_sessions.status);
            // FIX: If the bill is marked as seen, the gold tag is removed instantly, regardless of payment status.
            const isNew = !seenOrders.has(o.id) && (isUnpaidTable || orderDate > twelveHoursAgo);
            
            // Use the original (first) order number to represent the entire unified Tab
            let displayId = escapeHtml(o.order_number);
            if (o.all_order_numbers && o.all_order_numbers.length > 0) {
                displayId = Math.min(...o.all_order_numbers);
            }

            const roundIndicator = o.original_order_ids && o.original_order_ids.length > 1 ? `<span style="font-size: 11px; color: var(--muted); font-weight: 700; margin-left: 4px;">(${o.original_order_ids.length} Rounds)</span>` : '';
            return `
            <article class="admin-order-data-row" style="${isNew ? 'border-color: var(--gold-400); background: var(--gold-100); box-shadow: 0 4px 16px rgba(201,164,90,0.2);' : ''}">
              <div class="order-cell-id" style="display: flex; align-items: center; gap: 8px;">
                <span style="${isNew ? 'color: var(--gold-600);' : ''}">Ord #${displayId}</span>${isNew ? `<span style="background: var(--gold-500); color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 800; text-transform: uppercase;">New Bill</span>` : ''}
              </div>
              <div class="order-cell-date">${orderDate.toLocaleString('en-IN', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'})}</div>
              <div class="order-cell-type">${o.order_type === 'dine_in' ? `Dine-in · Table ${tables.find(t => t.id === o.table_id)?.table_no || 'Unknown'}` : 'Takeaway'} ${roundIndicator} · ${o.order_items.length}${o.order_items.length === 1 ? 'item' : 'items'}</div>
              <div class="order-cell-price">${money(o.grand_total, settings.currency_symbol)}</div>
              <div class="order-cell-actions">
                <button class="icon-btn icon-btn-light" data-view-order="${o.id}" title="View Receipt" style="${isNew ? 'background: #fff; border-color: var(--gold-400); color: var(--forest-900);' : ''}"><i class="ph-bold ph-printer"></i></button>
                <button class="icon-btn icon-btn-danger" data-delete-order="${o.id}" title="Delete Order"><i class="ph-bold ph-trash"></i></button>
              </div>
            </article>
          `}).join("");

        list.addEventListener("click", e => {
            const view = e.target.closest("[data-view-order]");
            const del = e.target.closest("[data-delete-order]");
            
            if (view) {
              const orderId = view.dataset.viewOrder;
              const targetOrder = orders.find(x => x.id === orderId);
              
              const updatedSeen = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_orders") || "[]"));
              updatedSeen.add(orderId);
              localStorage.setItem("fourflavours.seen_orders", JSON.stringify([...updatedSeen]));
              
              if (targetOrder?.session_id) {
                  const updatedSessions = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_sessions") || "[]"));
                  updatedSessions.add(targetOrder.session_id);
                  localStorage.setItem("fourflavours.seen_sessions", JSON.stringify([...updatedSessions]));
              }
              
              // Clear global alert state
              const tId = targetOrder?.table_id || targetOrder?.dining_sessions?.table_id;
              if (tId && window.__tableAlerts) delete window.__tableAlerts[tId];
              if (tId && window.clearTableAlert) window.clearTableAlert(tId);
              
              showAdminReceiptPreview(targetOrder);
              renderOrders(); 
            }
            if (del) deleteOrder(orders.find(x => x.id === del.dataset.deleteOrder));
        });

        if (window.__autoOpenOrderTableId) {
            const targetTableId = window.__autoOpenOrderTableId;
            window.__autoOpenOrderTableId = null;
            const latestOrder = orders.find(o => o.table_id === targetTableId || o.dining_sessions?.table_id === targetTableId);
            
            if (latestOrder) {
                // Mark order as seen
                const updatedSeen = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_orders") || "[]"));
                updatedSeen.add(latestOrder.id);
                localStorage.setItem("fourflavours.seen_orders", JSON.stringify([...updatedSeen]));
                
                // Mark session as seen
                if (latestOrder.session_id) {
                    const updatedSessions = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_sessions") || "[]"));
                    updatedSessions.add(latestOrder.session_id);
                    localStorage.setItem("fourflavours.seen_sessions", JSON.stringify([...updatedSessions]));
                }
                
                showAdminReceiptPreview(latestOrder);
                
                // Redraw the list quietly in the background so the Gold highlight vanishes instantly
                setTimeout(() => renderOrders(), 50); 
            }
            else showToast("Order Not Found", "No items were added to this table's session.", "error");
        }

    } catch (err) {
        list.innerHTML = `<div class="empty-state"><i class="ph ph-warning-circle"></i><strong>Error loading orders</strong><span>${escapeHtml(err.message)}</span></div>`;
    }
  }

  function deleteOrder(order) {
    openAppModal({
      title: `Delete Ord #${order.order_number}?`,
      subtitle: "This will permanently remove the bill and its items from the database.",
      body: `<div class="danger-confirm"><div class="danger-confirm-icon"><i class="ph ph-trash"></i></div><h3>Delete this record?</h3><p>This action cannot be undone.</p></div>`,
      actions: [
        { label: "Cancel", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Delete", icon: "ph-trash", className: "btn-danger", onClick: async ({ close, button }) => {
          button.disabled = true;
          button.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i> Processing...`;
          try {
            // Safely iterate through all rounds that make up this Master Bill and delete them
            const idsToDelete = order.original_order_ids || [order.id];
            for (const id of idsToDelete) {
                const { error } = await supabase.rpc("delete_pos_order", { p_order_id: id });
                if (error) throw error;
            }
            
            showToast("Record deleted", `Ord #${order.order_number} has been completely removed.`);
            close();
            renderOrders();
          } catch(err) {
            button.disabled = false;
            showToast("Error", err.message, "error");
            button.innerHTML = `<i class="ph-trash"></i> Delete`;
          }
        }}
      ]
    });
  }

  function showAdminReceiptPreview(order) {
    let tableString = "Takeaway";

    if (order.order_type === "dine_in" && order.table_id) {
      const table = tables.find(item => item.id === order.table_id);
      if (table) tableString = `Dine-in · Table ${table.table_no}`;
    }

    const date = new Date(order.created_at).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });

    const receiptHTML = `
      <article class="thermal-receipt" id="thermal-receipt-content">
        <header class="thermal-head">
          ${window.__ACTIVE_TENANT__?.icon_url
            ? `<img class="thermal-logo" src="${versionedAsset(window.__ACTIVE_TENANT__.icon_url)}" alt="Restaurant logo">`
            : ""}
          <h1>${escapeHtml(settings.restaurant_name)}</h1>
          ${settings.restaurant_address ? `<p>${escapeHtml(settings.restaurant_address).replace(/\n/g, "<br>")}</p>` : ""}
          ${settings.gst_number ? `<p><strong>GSTIN:</strong> ${escapeHtml(settings.gst_number)}</p>` : ""}
        </header>

        <div class="thermal-meta">
          <div><span>Order:</span> <strong>#${escapeHtml(order.order_number)}</strong></div>
          <div><span>Date:</span> <strong>${date}</strong></div>
          <div><span>Type:</span> <strong>${escapeHtml(tableString)}</strong></div>
        </div>

        <table class="thermal-items-table">
          <thead>
            <tr>
              <th style="text-align: left;">Item</th>
              <th style="text-align: center;">Qty</th>
              <th style="text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${(order.order_items || []).map(item => `
              <tr>
                <td style="text-align: left;">${escapeHtml(item.name_snapshot)}<br><small>${money(item.unit_price, settings.currency_symbol)}</small></td>
                <td style="text-align: center;">${item.quantity}</td>
                <td style="text-align: right;">${money(Number(item.unit_price) * Number(item.quantity), settings.currency_symbol)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>

        <div class="thermal-totals-wrap">
          <div class="thermal-line"><span>Subtotal</span><strong>${money(order.subtotal, settings.currency_symbol)}</strong></div>
          <div class="thermal-line"><span>CGST</span><strong>${money(order.cgst, settings.currency_symbol)}</strong></div>
          <div class="thermal-line"><span>SGST</span><strong>${money(order.sgst, settings.currency_symbol)}</strong></div>
          <div class="thermal-line"><span>Rounding</span><strong>${money(order.rounding, settings.currency_symbol)}</strong></div>
          <div class="thermal-line thermal-grand"><span>GRAND TOTAL</span><strong>${money(order.grand_total, settings.currency_symbol)}</strong></div>
        </div>

        ${settings.upi_id ? `
          <div class="thermal-payment-block">
            <div class="thermal-qr" id="thermal-upi"></div>
            <div class="thermal-upi-note"><strong>Scan to pay</strong><br>Supported by all UPI apps</div>
          </div>
        ` : ""}

        <footer class="thermal-foot">
          <p>${escapeHtml(settings.receipt_footer || "Thank you for dining with us!")}</p>
          <div class="thermal-software-tag">Powered by Table Forge System</div>
        </footer>
      </article>
    `;

    const isActiveBill = Boolean(
      order.dining_sessions &&
      ["bill_requested", "bill_ready"].includes(order.dining_sessions.status)
    );

    const actionsList = [
      {
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
          button.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i> Saving...`;

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
                filename: `${(settings.restaurant_name || "Bill").replace(/\s+/g, "_")}_order_${order.order_number}.pdf`,
                image: { type: "jpeg", quality: 1 },
                html2canvas: { scale: 6, useCORS: true }, // Ultra-HD Scale 6 configuration
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
      },
      {
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
      }
    ];

    if (isActiveBill) {
      actionsList.push({
        label: "Paid",
        icon: "ph-bold ph-check-circle",
        className: "btn-primary",
        style: "background: var(--success); border-color: var(--success); font-weight: 900;",
        onClick: async ({ close, button }) => {
          const originalHTML = button.innerHTML;
          button.disabled = true;
          button.innerHTML = `<i class="ph-bold ph-spinner-gap ph-spin"></i> Paid...`;

          try {
            const { error } = await supabase.rpc("complete_session_payment", {
              p_session_id: order.session_id,
              p_payment_method: "cash"
            });

            if (error) throw error;

            showToast("Payment recorded", "Cash payment was recorded and the table was closed.", "success");
            close();
            await reload();
          } catch (error) {
            showToast("Could not record payment", error.message || "Please try again.", "error");
            button.disabled = false;
            button.innerHTML = originalHTML;
          }
        }
      });
    }

    const modal = openAppModal({
      title: `Order #${order.order_number} Bill`,
      subtitle: isActiveBill
        ? "Print the bill, collect cash in person, then confirm receipt to close the table."
        : "View, save, or reprint this bill.",
      body: `<div class="receipt-preview-container">${receiptHTML}</div>`,
      actions: actionsList
    });

    // 🔗 DYNAMIC UPI QR INJECTION: Safely loads the library and renders the perfect UPI string
    if (settings.upi_id) {
        const renderQR = () => {
            setTimeout(() => {
                const qrNode = modal.root.querySelector("#thermal-upi");
                if (qrNode) {
                    qrNode.innerHTML = "";
                    
                    // 1. SANITIZATION: Forcefully strip zero-width spaces and invalid hidden characters
                    const rawUpi = settings.upi_id.replace(/[^a-zA-Z0-9.\-@]/g, '');
                    
                    // 2. NAME CLEANUP: Strip weird symbols from the restaurant name
                    const rawName = (settings.restaurant_name || "Restaurant").replace(/[^a-zA-Z0-9\s]/g, '').trim();
                    
                    // 3. THE '#' FIX: Completely remove the '#' symbol to prevent URI fragment corruption in banking apps
                    const rawNote = `Bill ${order.order_number}`;
                    
                    const am = Number(order.grand_total).toFixed(2);
                    
                    // Encode spaces to %20 cleanly without breaking the core structure
                    const upiString = encodeURI(`upi://pay?pa=${rawUpi}&pn=${rawName}&am=${am}&cu=INR&tn=${rawNote}`);
                    
                    // Ensure the node has relative positioning to hold the center logo
                    qrNode.style.position = "relative";
                    qrNode.style.display = "inline-block";
                    
                    new QRCode(qrNode, { 
                        text: upiString, 
                        width: 160, 
                        height: 160, 
                        // CRITICAL: Must use Level H (30% redundancy) to allow a logo in the center without breaking scans!
                        correctLevel: QRCode.CorrectLevel.H 
                    });

                    // 💎 PREMIUM UPGRADE: Inject the Restaurant Icon perfectly into the center
                    const iconUrl = window.__ACTIVE_TENANT__?.icon_url;
                    if (iconUrl) {
                        const logoImg = document.createElement("img");
                        logoImg.src = versionedAsset(iconUrl);
                        logoImg.style.position = "absolute";
                        logoImg.style.top = "50%";
                        logoImg.style.left = "50%";
                        logoImg.style.transform = "translate(-50%, -50%)";
                        
                        // CRITICAL FIX: The logo must be exactly 20-25% of the total QR size to allow scanning
                        logoImg.style.width = "36px"; 
                        logoImg.style.height = "36px";
                        logoImg.style.minWidth = "36px";
                        logoImg.style.minHeight = "36px";
                        logoImg.style.maxWidth = "36px";
                        logoImg.style.maxHeight = "36px";
                        
                        logoImg.style.borderRadius = "8px";
                        logoImg.style.border = "3px solid #ffffff";
                        logoImg.style.backgroundColor = "#ffffff";
                        logoImg.style.objectFit = "cover";
                        logoImg.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
                        logoImg.style.zIndex = "5"; // Ensure it sits strictly on top of the canvas
                        
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
  }

  
  function renderCuisines() {
    area.innerHTML = `
      <section class="section-title-row">
        <div>
          <span class="eyebrow">Menu Categories</span>
          <h1>Manage categories.</h1>
          <p>Add categories and upload background images.</p>
        </div>
        <button class="btn btn-primary" id="add-cuisine"><i class="ph-bold ph-plus"></i> Add</button>
      </section>
      <section class="admin-panel"><div class="admin-list-scroll" id="cuisine-list"></div></section>`;
    
    const list = area.querySelector("#cuisine-list");
    list.innerHTML = cuisines.length ? cuisines.map(cuisine => `
      <article class="admin-product-row" style="align-items: center;">
        <div class="admin-product-image">${cuisine.image_url ? `<img src="${versionedAsset(cuisine.image_url)}" alt="">` : `<div class="product-placeholder"><i class="ph ph-image"></i></div>`}</div>
        <div class="admin-product-main">
          <div class="admin-product-title"><div><strong style="font-size: 15px;">${escapeHtml(cuisine.name)}</strong></div></div>
          <div style="margin-top: 4px; color: var(--muted); font-size: 12px; font-weight: 600;">Display Order: ${cuisine.sort_order || 0}</div>
        </div>
        <div class="admin-product-actions" style="display: flex; gap: 8px;">
          <button class="icon-btn icon-btn-light" data-edit-cuisine="${cuisine.id}" title="Edit Category" style="border-radius: 10px;"><i class="ph-bold ph-pencil-simple"></i></button>
          <button class="icon-btn icon-btn-danger" data-delete-cuisine="${cuisine.id}" title="Delete Category" style="border-radius: 10px;"><i class="ph-bold ph-trash"></i></button>
        </div>
      </article>`).join("") : `<div class="empty-state"><strong>No categories configured.</strong></div>`;
    
    area.querySelector("#add-cuisine").addEventListener("click", () => openCuisineEditor());
    list.addEventListener("click", e => { 
        const edit = e.target.closest("[data-edit-cuisine]"); 
        const del = e.target.closest("[data-delete-cuisine]");
        if (edit) { const c = cuisines.find(x => x.id === edit.dataset.editCuisine); if (c) openCuisineEditor(c); } 
        if (del) { const c = cuisines.find(x => x.id === del.dataset.deleteCuisine); if (c) openCuisineDelete(c); }
    });
  }

  function openCuisineEditor(cuisine = null) {
    const editing = Boolean(cuisine);
    const currentImageUrl = cuisine?.image_url ? versionedAsset(cuisine.image_url) : "";
    const currentImageHtml = currentImageUrl ? `<div class="image-upload-preview" id="cuisine-preview"><img src="${currentImageUrl}" alt="" /><div class="image-preview-copy"><strong>Current background</strong><span>Upload another to replace.</span></div></div>` : `<div class="image-upload-preview empty" id="cuisine-preview"><i class="ph ph-image"></i><div class="image-preview-copy"><strong>No image yet</strong><span>Add a background photo.</span></div></div>`;
    
    const modal = openAppModal({
      title: editing ? `Edit ${escapeHtml(cuisine.name)}` : "Add new category",
      subtitle: "Category photos are automatically cropped to 3:4 and optimized.",
      body: `
        <form id="cuisine-form" class="stack-form">
          <div class="form-grid-two">
            <label class="field"><span>Category Name</span><input class="field-input" name="name" value="${escapeHtml(cuisine?.name ?? "")}" placeholder="e.g. Italian, Desserts" required /></label>
            <label class="field"><span>Display Order</span><input class="field-input" name="sort_order" type="number" value="${cuisine?.sort_order ?? 1}" required /></label>
          </div>
          <div class="field" style="margin-top: 8px;">
            <span>Background Image</span>
            <label class="image-upload-zone">
              <input id="cuisine-image" type="file" accept="image/*" />
              <span class="image-upload-icon"><i class="ph ph-cloud-arrow-up"></i></span>
              <span class="image-upload-copy"><strong>Choose photo</strong><small>JPG, PNG, WebP · optimized automatically</small></span>
            </label>
            ${currentImageHtml}
            ${editing && cuisine?.image_url ? `<label class="switch-field image-remove-switch" style="margin-top: 8px;"><input type="checkbox" name="remove_image" id="remove-image" /><span class="switch-ui"></span><span><strong>Remove image</strong><small>The category will still exist without a photo.</small></span></label>` : ""}
            <div class="image-upload-status" id="cuisine-upload-status"></div>
          </div>
        </form>`,
      actions: [
        { label: "Cancel", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: editing ? "Save changes" : "Create category", icon: "ph-floppy-disk", className: "btn-primary", onClick: async ({ root, close, button }) => {
          const form = root.querySelector("#cuisine-form");
          if (!form.reportValidity()) return;
          
          const fd = new FormData(form);
          const name = String(fd.get("name") || "").trim();
          const sortOrder = Number(fd.get("sort_order") || 1);
          const fileInput = root.querySelector("#cuisine-image");
          const selectedFile = fileInput?.files?.[0];
          const removeImage = root.querySelector("#remove-image")?.checked;
          
          button.disabled = true;
          const statusNode = root.querySelector("#cuisine-upload-status");
          
          try {
            let finalImageUrl = cuisine?.image_url ?? null;
            let newStoragePath = null;
            let optimizedFile = null;
            const oldPath = storagePathFromUrl(cuisine?.image_url);
            const cuisineId = editing ? cuisine.id : crypto.randomUUID();

            if (removeImage && !selectedFile) finalImageUrl = null;

            if (selectedFile) {
              statusNode.innerHTML = `<i class="ph ph-spinner-gap"></i><span>Optimizing...</span>`;
              optimizedFile = await optimizeCuisineImage(selectedFile);
              // 🔒 STORAGE ISOLATION: Nests the image in a folder dedicated strictly to this restaurant
              newStoragePath = `${window.__ACTIVE_TENANT__.id}/cuisines/${cuisineId}/${crypto.randomUUID()}.webp`;
              finalImageUrl = getDishPublicUrl(newStoragePath);
            }
            
            // 1. SAVE DATABASE ROW FIRST (Establishes ownership so the Bucket allows the upload)
            statusNode.innerHTML = `<i class="ph ph-floppy-disk"></i><span>Saving category...</span>`;
            const payload = {
                id: cuisineId,
                restaurant_id: window.__ACTIVE_TENANT__.id,
                name: name,
                sort_order: sortOrder,
                image_url: finalImageUrl
            };
            
            if (editing) {
                const { error: dbError } = await supabase.from("cuisines").update(payload).eq("id", cuisineId);
                if (dbError) throw dbError;
            } else {
                const { error: dbError } = await supabase.from("cuisines").insert(payload);
                if (dbError) throw dbError;
            }

            // 2. UPLOAD IMAGE TO STORAGE SECOND (Now authorized by RLS)
            if (selectedFile && optimizedFile) {
              statusNode.innerHTML = `<i class="ph ph-cloud-arrow-up"></i><span>Uploading...</span>`;
              const { error: uploadError } = await supabase.storage.from(DISH_IMAGE_BUCKET).upload(newStoragePath, optimizedFile, { contentType: "image/webp", upsert: false });
              if (uploadError) throw uploadError;
            }
            
            if (editing && oldPath && (newStoragePath || removeImage)) {
              await supabase.storage.from(DISH_IMAGE_BUCKET).remove([oldPath]);
            }
            
            showToast(editing ? "Category updated" : "Category created", name);
            close();
            await reload();
          } catch (error) { 
              button.disabled = false; 
              statusNode.innerHTML = `<i class="ph ph-warning-circle"></i><span>${escapeHtml(error.message)}</span>`; 
          }
        }}
      ]
    });
    
    modal.root.querySelector("#cuisine-image")?.addEventListener("change", e => {
      const file = e.target.files?.[0];
      if (!file) return;
      const previewUrl = URL.createObjectURL(file);
      const preview = modal.root.querySelector("#cuisine-preview");
      preview.classList.remove("empty");
      preview.innerHTML = `<img src="${previewUrl}" alt=""><div class="image-preview-copy"><strong>New image selected</strong><span>${escapeHtml(file.name)}</span></div>`;
      if (modal.root.querySelector("#remove-image")) modal.root.querySelector("#remove-image").checked = false;
    });
  }

  function openCuisineDelete(cuisine) {
    openAppModal({
      title: `Delete ${escapeHtml(cuisine.name)}?`,
      subtitle: "This will permanently remove the category from the menu layout.",
      body: `<div class="danger-confirm"><div class="danger-confirm-icon"><i class="ph-bold ph-trash"></i></div><h3>Remove this category?</h3><p>This action removes the category image and tile. Dishes belonging to this category will remain in the database but may be grouped under "Others".</p></div>`,
      actions: [
        { label: "Cancel", icon: "ph-arrow-left", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Delete category", icon: "ph-trash", className: "btn-danger", onClick: async ({ close, button }) => {
          button.disabled = true;
          try { 
            const { error } = await supabase.from("cuisines").delete().eq("id", cuisine.id).eq("restaurant_id", window.__ACTIVE_TENANT__.id); 
            if (error) throw error; 
            const storagePath = storagePathFromUrl(cuisine.image_url);
            if (storagePath) await supabase.storage.from(DISH_IMAGE_BUCKET).remove([storagePath]);
            showToast("Category deleted", `${cuisine.name} was removed.`); 
            close(); 
            await reload(); 
          } catch (error) { button.disabled = false; showToast("Could not delete", error.message, "error"); }
        }}
      ]
    });
  }

  function renderOverview() {
    const activeProducts = products.filter(p => p.is_active).length;
    const activeTables = tables.filter(t => t.is_active).length;
    const billRequests = sessions.filter(s => s.status === "bill_requested").length;
    
    // Erase the old standalone inbox, using native table rows instead
    area.innerHTML = `
      <section class="admin-hero" style="padding-top: 0;">
        <div><span class="eyebrow">Control centre</span><h1>Everything in its place.</h1><p>Menu, tables, billing and live table sessions in one workspace.</p></div>
        <div class="admin-hero-mark">
          ${iconUrl 
            ? `<img src="${iconUrl}" alt="${escapeHtml(tenantName)}" style="width: 100%; height: 100%; object-fit: cover;">`
            : `<div style="width: 100%; height: 100%; display: grid; place-items: center; background: var(--sage-100); color: var(--forest-700); font-size: 32px;"><i class="ph-bold ph-storefront"></i></div>`
          }
        </div>
      </section>
      <section class="metric-grid">${metricCard("ph-fork-knife", activeProducts, "Active dishes")}${metricCard("ph-armchair", activeTables, "Active tables")}${metricCard("ph-bell", sessions.length, "Open sessions")}${metricCard("ph-receipt", billRequests, "Bill requests")}</section>
      <section class="admin-grid-two">
        <article class="admin-panel"><div class="panel-head"><div><span class="eyebrow">Quick actions</span><h2>Run the floor</h2></div></div><div class="quick-action-grid"><button class="quick-action" data-go="tables"><i class="ph ph-armchair"></i><span><strong>Manage tables</strong><small>Add, edit, delete and print QR codes.</small></span><i class="ph ph-arrow-right"></i></button><button class="quick-action" data-go="menu"><i class="ph ph-fork-knife"></i><span><strong>Manage menu</strong><small>Names, descriptions, prices and visibility.</small></span><i class="ph ph-arrow-right"></i></button><button class="quick-action" data-go="settings"><i class="ph ph-gear"></i><span><strong>Billing & Branding</strong><small>Manage restaurant details, tax and receipts.</small></span><i class="ph ph-arrow-right"></i></button></div></article>
        <article class="admin-panel"><div class="panel-head"><div><span class="eyebrow">Dining sessions</span><h2>Open tables</h2></div><button class="btn btn-quiet btn-small" id="clear-admin-alerts" style="padding: 0 10px;">Clear Alerts</button></div><div class="session-mini-scroll" id="overview-session-list">
          ${sessions.length ? sessions.map(s => {
            // Check if the Admin has already opened this specific bill
            const seenSessions = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_sessions") || "[]"));
            const tableAlert = window.__tableAlerts ? window.__tableAlerts[s.table_id] : null;
            const isSeen = seenSessions.has(s.id);
            // Suppress the alert completely if it has been seen
            const isBillReq = (s.status === 'bill_requested' && !isSeen) || (tableAlert?.type === 'bill_requested' && !isSeen);
            const isNewGreen = !isBillReq && tableAlert && ['new_order', 'added_items', 'new_session'].includes(tableAlert.type);
            const tableNo = escapeHtml(tables.find(t => t.id === s.table_id)?.table_no ?? "—");
            
            let rowStyle = "background: var(--paper); border-color: var(--line);";
            let iconBg = "var(--sage-100)"; let iconColor = "var(--forest-700)";
            let titleColor = "inherit"; let statusColor = "var(--muted)"; let statusWeight = "normal";
            let statusText = s.status === "bill_ready" ? "Bill ready" : "Dining session open";
            let iconClass = "ph-armchair";
            let badgeHtml = "";
            let actionBtnHtml = `<button class="btn btn-primary btn-small" data-manage-session="${s.id}">Manage</button>`;
            
            if (isBillReq) {
                rowStyle = "background: var(--gold-100); border-color: var(--gold-400); box-shadow: 0 4px 16px rgba(201,164,90,0.25);";
                iconBg = "var(--gold-400)"; iconColor = "#fff";
                titleColor = "var(--gold-600)"; statusColor = "var(--gold-600)"; statusWeight = "800";
                statusText = tableAlert?.message || "Customer requested final bill!";
                iconClass = "ph-receipt qty-pulse";
                badgeHtml = `<span style="background: var(--gold-500); color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 800; text-transform: uppercase;">Needs Bill</span>`;
                actionBtnHtml = `<button class="btn btn-primary btn-small qty-pulse" style="background: var(--gold-500); color: var(--forest-950); border-color: var(--gold-500);" data-view-bill-order="${s.table_id}">View Bill in Orders</button>`;
            } else if (isNewGreen) {
                rowStyle = "background: var(--success-soft); border-color: #a3d9b0; box-shadow: 0 4px 16px rgba(44,108,69,0.15);";
                iconBg = "var(--success)"; iconColor = "#fff";
                titleColor = "var(--forest-950)"; statusColor = "var(--success)"; statusWeight = "800";
                statusText = tableAlert.message || "New activity";
                iconClass = "ph-bell-ringing qty-pulse";
                badgeHtml = `<span style="background: var(--success); color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 800; text-transform: uppercase;">NEW</span>`;
                actionBtnHtml = `<button class="btn btn-primary btn-small" style="background: var(--success); border-color: var(--success);" data-manage-session="${s.id}">Manage</button>`;
            }

            return `
            <div class="admin-mini-row" style="padding: 16px 12px; border: 1px solid transparent; ${rowStyle} border-radius: 14px; margin-bottom: 8px;">
              <div class="mini-row-icon" style="background: ${iconBg}; color:${iconColor};"><i class="ph-bold ${iconClass}"></i></div>
              <div style="flex: 1; margin-left: 14px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <strong style="font-size: 15px; color: ${titleColor};">Table ${tableNo}</strong>${badgeHtml}
                </div>
                <span style="font-size: 12px; color: ${statusColor}; font-weight: ${statusWeight}; margin-top: 4px; display: block;">${statusText}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 14px;">
                ${actionBtnHtml}
              </div>
            </div>`;
          }).join("") : `<div class="empty-state compact"><i class="ph ph-circle-wavy-check"></i><strong>No open table sessions</strong><span>The floor is currently clear.</span></div>`}
        </div></article>
      </section>`;
    
    area.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => { section = b.dataset.go; updateNavUI(); renderSection(); }));
    
    area.querySelector("#overview-session-list")?.addEventListener("click", e => {
      const row = e.target.closest("[data-manage-session]");
      const viewBill = e.target.closest("[data-view-bill-order]");

      if (row) {
          const session = sessions.find(x => x.id === row.dataset.manageSession);
          const table = tables.find(x => x.id === session?.table_id);
          if (table && session) {
              if (window.__tableAlerts) delete window.__tableAlerts[table.id];
              if (window.clearTableAlert) window.clearTableAlert(table.id);
              openAdminTableManager(table, session);
              renderOverview();
          }
      }

      if (viewBill) {
          const tableId = viewBill.dataset.viewBillOrder;
          if (window.__tableAlerts) delete window.__tableAlerts[tableId];
          if (window.clearTableAlert) window.clearTableAlert(tableId);
          window.__autoOpenOrderTableId = tableId;
          section = "orders";
          updateNavUI();
          renderSection();
      }
    });
    
    area.querySelector("#clear-admin-alerts")?.addEventListener("click", async () => {
      const btn = area.querySelector("#clear-admin-alerts");
      if (btn) btn.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i> Clearing...`;

      try {
          // Deep wipe of all alert states
          window.__tableAlerts = {};
          
          const seenSessions = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_sessions") || "[]"));
          if (sessions && sessions.length) {
              sessions.forEach(s => { seenSessions.add(s.id); });
              localStorage.setItem("fourflavours.seen_sessions", JSON.stringify([...seenSessions]));
          }

          // Force the global function to re-evaluate and hide the dots immediately across the entire DOM
          evaluateGlobalAlerts();
          
          await reload();
          showToast("Alerts Cleared", "All notifications and highlights have been reset.", "success");
      } catch (err) {
          showToast("Error", err.message, "error");
          if (btn) btn.innerHTML = `Clear Alerts`;
      }
    });
  }

  function renderMenu() {
    area.innerHTML = `
      <section class="section-title-row">
        <div>
          <span class="eyebrow">Menu management</span>
          <h1>Every dish, managed.</h1>
          <p>Organize your entire restaurant menu.</p>
        </div>
        <div class="header-action-group">
          <button class="btn btn-quiet" id="generate-menu-pdf"><i class="ph-bold ph-file-pdf"></i> PDF</button>
          <button class="btn btn-primary" id="add-product"><i class="ph-bold ph-plus"></i> Add</button>
        </div>
      </section>
      <section class="admin-panel"><div class="panel-toolbar"><div class="search-wrap light"><i class="ph ph-magnifying-glass"></i><input class="search-input" id="product-search" type="search" placeholder="Search dishes or categories"></div><span class="soft-badge">${products.length} dishes</span></div><div class="admin-list-scroll" id="product-list"></div></section>`;
    
    const search = area.querySelector("#product-search");
    const list = area.querySelector("#product-list");

    area.querySelector("#generate-menu-pdf").addEventListener("click", () => openMenuPDFPreview());
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      const visible = products.filter(p => !q || `${p.name} ${p.category} ${p.description ?? ""}`.toLowerCase().includes(q));
      
      list.innerHTML = visible.length ? visible.map(product => `
        <article class="admin-product-row" style="align-items: center;">
          <div class="admin-product-image">${product.image_url ? `<img src="${versionedAsset(product.image_url)}" alt="" loading="lazy">` : `<div class="product-placeholder"><i class="ph ph-fork-knife"></i></div>`}</div>
          <div class="admin-product-main">
            <div class="admin-product-title"><div><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml(product.category)}</span></div><strong style="font-size: 16px;">${money(product.price)}</strong></div>
            <p>${escapeHtml(product.description ?? "")}</p>
            <div style="margin-top: 8px;"><span class="active-badge ${product.is_active ? "active" : ""}"><span></span>${product.is_active ? "Live" : "Hidden"}</span></div>
          </div>
          
          <div class="admin-product-actions" style="display: flex; flex-direction: column; gap: 8px; align-items: center; padding-left: 16px; border-left: 1px solid var(--line); margin-left: 12px;">
            <button data-edit-product="${product.id}" title="Edit dish" style="width: 36px; height: 36px; padding: 0; border-radius: 10px; background: #f8fafc; border: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: center; color: var(--forest-800); font-size: 18px; cursor: pointer; transition: transform 0.1s ease; box-shadow: 0 1px 2px rgba(0,0,0,0.03);" onmousedown="this.style.transform='scale(0.92)'" onmouseup="this.style.transform='scale(1)'" onmouseleave="this.style.transform='scale(1)'">
              <i class="ph-bold ph-pencil-simple"></i>
            </button>
            <button data-delete-product="${product.id}" title="Delete dish" style="width: 36px; height: 36px; padding: 0; border-radius: 10px; background: #fff1f2; border: 1px solid #ffe4e6; display: flex; align-items: center; justify-content: center; color: #e11d48; font-size: 18px; cursor: pointer; transition: transform 0.1s ease; box-shadow: 0 1px 2px rgba(225,29,72,0.03);" onmousedown="this.style.transform='scale(0.92)'" onmouseup="this.style.transform='scale(1)'" onmouseleave="this.style.transform='scale(1)'">
              <i class="ph-bold ph-trash"></i>
            </button>
          </div>
          
        </article>`).join("") : `<div class="empty-state"><i class="ph ph-magnifying-glass"></i><strong>No dishes found</strong><span>Try another search.</span></div>`;
    };
    
    search.addEventListener("input", paint); paint();
    area.querySelector("#add-product").addEventListener("click", () => openProductEditor());
    
    function openMenuPDFPreview() {
      const activeProducts = products.filter(p => p.is_active).sort((a,b) => a.sort_order - b.sort_order);
      
      const targetCuisines = ["Indian", "Chinese", "Continental", "Mexican"];
      const menuTree = {};
      const cuisineItemCounts = {};
      
      targetCuisines.forEach(c => { 
          menuTree[c] = {}; 
          cuisineItemCounts[c] = 0; 
      });

      // Group active dishes and accurately count the total items in each cuisine
      activeProducts.forEach(p => {
         const parts = String(p.category || "").split(" - ");
         const cName = parts[0]?.trim();
         const subName = parts[1]?.trim() || "Others";
         const targetCuisine = targetCuisines.includes(cName) ? cName : "Continental";
         
         if (!menuTree[targetCuisine][subName]) menuTree[targetCuisine][subName] = [];
         menuTree[targetCuisine][subName].push(p);
         cuisineItemCounts[targetCuisine]++;
      });
      
      function getSubcatIcon(name) {
         const n = name.toLowerCase();
         if (n.includes('starter') || n.includes('appetizer')) return 'ph-fire';
         if (n.includes('bread') || n.includes('roti') || n.includes('naan')) return 'ph-bread';
         if (n.includes('rice') || n.includes('biryani')) return 'ph-bowl-steam';
         if (n.includes('soup')) return 'ph-bowl-food';
         if (n.includes('main')) return 'ph-cooking-pot';
         if (n.includes('noodle')) return 'ph-waves';
         if (n.includes('pasta')) return 'ph-spiral';
         if (n.includes('pizza')) return 'ph-pizza';
         if (n.includes('dessert') || n.includes('sweet')) return 'ph-ice-cream';
         if (n.includes('beverage') || n.includes('drink')) return 'ph-brandy';
         if (n.includes('wrap') || n.includes('roll')) return 'ph-hamburger';
         if (n.includes('bowl')) return 'ph-orange-slice';
         return 'ph-star';
      }

      const columnsHtml = targetCuisines.map(cuisineName => {
         const flexWeight = Math.max(12, cuisineItemCounts[cuisineName]);
         
         // THE PACKING ALGORITHM: Sort subcategories by Item Count (Descending)
         // This guarantees the largest lists fill the primary columns on the left first, eliminating massive empty spaces!
         const subCats = Object.keys(menuTree[cuisineName]).sort((a, b) => {
             return menuTree[cuisineName][b].length - menuTree[cuisineName][a].length;
         });

         if (subCats.length === 0) return `<div class="a0-cuisine-col" style="flex: ${flexWeight};"><h2 class="a0-cuisine-title">${escapeHtml(cuisineName)}</h2><div style="text-align: center; color: var(--muted); font-size: 24px;">Coming Soon</div></div>`;
         
         const subCatsHtml = subCats.map(subCat => {
            const itemsHtml = menuTree[cuisineName][subCat].map(p => `
               <div class="a0-item">
                  ${p.image_url ? `<img src="${versionedAsset(p.image_url)}" class="a0-item-thumb">` : `<div class="a0-item-placeholder"><i class="ph-bold ph-fork-knife"></i></div>`}
                  <div class="a0-item-details">
                     <div class="a0-item-header">
                        <span class="a0-item-name">${escapeHtml(p.name)}</span>
                        <span class="a0-item-leader"></span>
                        <span class="a0-item-price">${money(p.price, settings.currency_symbol)}</span>
                     </div>
                     ${p.description ? `<div class="a0-item-desc">${escapeHtml(p.description)}</div>` : ''}
                  </div>
               </div>
            `).join("");
            
            return `<div class="a0-subcat-wrap"><h3 class="a0-subcat-title"><i class="ph-fill ${getSubcatIcon(subCat)}"></i> ${escapeHtml(subCat)}</h3>${itemsHtml}</div>`;
         }).join("");
         
         return `<div class="a0-cuisine-col" style="flex: ${flexWeight};"><h2 class="a0-cuisine-title">${escapeHtml(cuisineName)}</h2><div class="a0-masonry-wrapper">${subCatsHtml}</div></div>`;
      }).join("");

      const canvasHtml = `
         <div class="a0-canvas" id="a0-print-target">
            <header class="a0-header">
               ${window.__ACTIVE_TENANT__?.logo_url 
                 ? `<div class="a0-logo-box"><img src="${versionedAsset(window.__ACTIVE_TENANT__.logo_url)}" class="a0-logo" alt="Logo"></div>`
                 : `<div class="a0-logo-box" style="padding: 24px 60px;"><h1 style="font-size: 72px; color: var(--forest-950); margin: 0; letter-spacing: -0.02em;">${escapeHtml(window.__ACTIVE_TENANT__?.name || "Menu")}</h1></div>`
               }
            </header>
            <div class="a0-grid">
               ${columnsHtml}
            </div>
         </div>
         <div class="a0-viewer-hints"><i class="ph-bold ph-hand-pointing"></i> Drag to pan · Scroll/Pinch to zoom</div>
      `;

      const modal = openAppModal({
         title: "A0 Menu Board",
         subtitle: "Drag to pan. Scroll to zoom. The layout is pixel-perfect.",
         body: `<div class="a0-preview-viewport" id="a0-preview-viewport">${canvasHtml}</div>`,
         actions: [
            { label: "Close", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
            { label: "Download High-Res PDF", icon: "ph-download-simple", className: "btn-primary", onClick: async ({ root, button }) => {
               const element = root.querySelector("#a0-print-target");
               
               button.disabled = true;
               const originalText = button.innerHTML;
               button.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i><span>Generating PDF...</span>`;
               
               try {
                  if (!window.html2pdf) {
                     await new Promise((resolve) => {
                        const script = document.createElement("script");
                        script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";
                        script.onload = resolve;
                        document.head.appendChild(script);
                     });
                  }

                  // 1. Create a pristine container at the absolute root of the document
                  const printContainer = document.createElement("div");
                  printContainer.style.position = "absolute";
                  printContainer.style.top = "0";
                  printContainer.style.left = "0";
                  printContainer.style.width = "4400px";
                  printContainer.style.zIndex = "-9999"; 
                  printContainer.style.background = "#0c1a11";

                  // 2. Clone the element and strip the pan/zoom transform physics
                  const clone = element.cloneNode(true);
                  clone.style.transform = "none";
                  clone.style.margin = "0";
                  // CRITICAL FIX: Ensure document flow is respected so height doesn't collapse to 0
                  clone.style.position = "relative"; 

                  printContainer.appendChild(clone);
                  document.body.appendChild(printContainer);

                  // 3. Give the browser 400ms to completely paint the new DOM and images
                  await new Promise(r => setTimeout(r, 400));

                  const renderWidthPx = clone.scrollWidth;
                  const renderHeightPx = clone.scrollHeight;
                  
                  // Convert pixels to exact millimeters
                  const widthMm = renderWidthPx * 0.264583;
                  const heightMm = renderHeightPx * 0.264583;

                  // 4. THE LIMIT FIX: 
                  // By dropping scale to 1.5, we get a 6600px canvas, safely under the 8192px browser limit.
                  // This allows html2pdf to process and directly download the file without the print dialog!
                  const opt = {
                     margin: 0,
                     filename: `${(window.__ACTIVE_TENANT__?.name || 'Menu').replace(/\s+/g, '_')}_Premium_Menu.pdf`,
                     image: { type: 'jpeg', quality: 1 },
                     html2canvas: { 
                         scale: 1.5, 
                         useCORS: true, 
                         logging: false, 
                         backgroundColor: '#0c1a11',
                         width: renderWidthPx,
                         height: renderHeightPx,
                         windowWidth: renderWidthPx,
                         windowHeight: renderHeightPx
                     },
                     jsPDF: { unit: 'mm', format: [widthMm, heightMm], orientation: widthMm > heightMm ? 'landscape' : 'portrait' }
                  };
                  
                  await html2pdf().set(opt).from(clone).save();
                  
                  // 5. Cleanup the temporary clone instantly after download triggers
                  document.body.removeChild(printContainer);
               } catch (err) {
                  console.error("PDF Generation failed:", err);
                  showToast("Generation Error", "Failed to compile PDF.", "error");
               } finally {
                  button.disabled = false;
                  button.innerHTML = originalText;
               }
            }}
         ]
      });

      // PHYSICS ENGINE: Complete Pan & Zoom Architecture
      const viewport = modal.root.querySelector("#a0-preview-viewport");
      const canvas = modal.root.querySelector("#a0-print-target");
      if (!viewport || !canvas) return;
      
      let scale = 0, translateX = 0, translateY = 0, isDragging = false, startX, startY;
      
      function fitToScreen() {
         const vW = viewport.clientWidth;
         const vH = viewport.clientHeight;
         const cW = canvas.scrollWidth;
         const cH = canvas.scrollHeight;
         
         const scaleX = vW / cW;
         const scaleY = vH / cH;
         scale = Math.min(scaleX, scaleY) * 0.95; // 95% perfect fit to view everything
         
         translateX = (vW - (cW * scale)) / 2;
         translateY = (vH - (cH * scale)) / 2;
         updateTransform();
      }
      
      function updateTransform() {
         canvas.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
      }
      
      setTimeout(fitToScreen, 50);
      window.addEventListener("resize", fitToScreen);

      // Desktop Scroll Zoom
      viewport.addEventListener("wheel", e => {
         e.preventDefault();
         const delta = e.deltaY * -0.002;
         let newScale = Math.max(0.05, Math.min(scale * Math.exp(delta), 2));
         
         const rect = viewport.getBoundingClientRect();
         const pointerX = e.clientX - rect.left;
         const pointerY = e.clientY - rect.top;
         
         // Zoom into pointer
         translateX = pointerX - (pointerX - translateX) * (newScale / scale);
         translateY = pointerY - (pointerY - translateY) * (newScale / scale);
         scale = newScale;
         updateTransform();
      }, { passive: false });

      // Unified Mouse/Touch Pan Dragging
      viewport.addEventListener("pointerdown", e => {
         isDragging = true;
         startX = e.clientX - translateX;
         startY = e.clientY - translateY;
         viewport.setPointerCapture(e.pointerId);
      });
      viewport.addEventListener("pointermove", e => {
         if (!isDragging) return;
         translateX = e.clientX - startX;
         translateY = e.clientY - startY;
         updateTransform();
      });
      viewport.addEventListener("pointerup", () => { isDragging = false; });

      // Mobile Pinch to Zoom
      let initialDistance = null;
      let initialScale = null;
      
      viewport.addEventListener("touchstart", e => {
         if (e.touches.length === 2) {
             isDragging = false; 
             initialDistance = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
             initialScale = scale;
         }
      }, { passive: false });
      
      viewport.addEventListener("touchmove", e => {
         if (e.touches.length === 2 && initialDistance) {
             e.preventDefault();
             const currentDistance = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
             let newScale = Math.max(0.05, Math.min(initialScale * (currentDistance / initialDistance), 2));
             
             const rect = viewport.getBoundingClientRect();
             const pointerX = rect.width / 2;
             const pointerY = rect.height / 2;
             
             translateX = pointerX - (pointerX - translateX) * (newScale / scale);
             translateY = pointerY - (pointerY - translateY) * (newScale / scale);
             scale = newScale;
             updateTransform();
         }
      }, { passive: false });
      
      viewport.addEventListener("touchend", e => { if (e.touches.length < 2) { initialDistance = null; initialScale = null; } });
      
      const originalClose = modal.close;
      modal.close = () => { window.removeEventListener("resize", fitToScreen); originalClose(); };
    }

    list.addEventListener("click", e => { 
      const editBtn = e.target.closest("[data-edit-product]"); 
      const delBtn = e.target.closest("[data-delete-product]");
      if (editBtn) { const p = products.find(x => x.id === editBtn.dataset.editProduct); if (p) openProductEditor(p); } 
      if (delBtn) { const p = products.find(x => x.id === delBtn.dataset.deleteProduct); if (p) openProductDelete(p); }
    });
  }

  function renderTables() {
    area.innerHTML = `
      <section class="section-title-row">
        <div>
          <span class="eyebrow">Floor layout</span>
          <h1>Live Tables.</h1>
          <p>Monitor tables and generate QR codes.</p>
        </div>
        <button class="btn btn-primary" id="add-table"><i class="ph-bold ph-plus"></i> Add</button>
      </section>
      <section class="admin-panel"><div class="panel-toolbar"><span class="soft-badge">${tables.length} tables</span><span class="panel-help"><i class="ph ph-qr-code"></i> Production QR Available</span></div><div class="admin-table-scroll" id="table-list"></div></section>`;
    
    const list = area.querySelector("#table-list");
    const activeSessions = sessions.filter(s => s.status !== "closed");

    list.innerHTML = tables.length ? tables.map(t => {
      const openSession = activeSessions.find(s => s.table_id === t.id);
      const seenSessions = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_sessions") || "[]"));
      
      // 1. Ghost Session Fix: Ignore all memory alerts if the database confirms there is no open session!
      const tableAlert = openSession && window.__tableAlerts ? window.__tableAlerts[t.id] : null;
      const isSeen = openSession && seenSessions.has(openSession.id);
      
      // 2. Clear Bill Request: Suppress the bill request highlight once it has been viewed!
      const isBillReq = openSession && ((openSession.status === "bill_requested" && !isSeen) || (tableAlert?.type === "bill_requested" && !isSeen));
      const isNewGreen = openSession && !isBillReq && tableAlert && ["new_order", "added_items", "new_session"].includes(tableAlert.type);

      let cardStyle = "";
      if (isBillReq) cardStyle = "background: var(--gold-100); border-color: var(--gold-400); box-shadow: 0 4px 16px rgba(201,164,90,0.25);";
      else if (isNewGreen) cardStyle = "background: var(--success-soft); border-color: #a3d9b0; box-shadow: 0 4px 16px rgba(44,108,69,0.15);";
      else if (openSession) cardStyle = "background: var(--danger-soft); border-color: #f1c7c4;";
      
      return `
        <article class="table-admin-card ${t.is_active ? "" : "inactive"}" style="${cardStyle}">
          <div class="table-badge">
            <i class="ph-bold ${isBillReq ? 'ph-receipt qty-pulse' : isNewGreen ? 'ph-bell-ringing qty-pulse' : 'ph-armchair'}" style="${isBillReq ? 'color: var(--gold-600);' : isNewGreen ? 'color: var(--success);' : openSession ? 'color: var(--danger);' : ''}"></i>
            <strong>${escapeHtml(t.table_no)}</strong>
            ${isNewGreen ? `<span style="background: var(--success); color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 800; text-transform: uppercase; margin-left: 8px;">NEW</span>` : ''}
            ${isBillReq ? `<span style="background: var(--gold-500); color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 800; text-transform: uppercase; margin-left: 8px;">BILL</span>` : ''}
          </div>
          <div class="table-card-main">
            <div>
              <span class="eyebrow">Capacity: ${Number(t.capacity)}</span>
              ${isBillReq ? `<strong style="color: var(--gold-600);">${tableAlert?.message || 'Needs Bill'}</strong>` :
                isNewGreen ? `<strong style="color: var(--success);">${tableAlert.message}</strong>` :
                openSession ? `<strong style="color: var(--danger);">Occupied</strong>` : `<strong>Empty</strong>`}
            </div>
            ${openSession || isBillReq || isNewGreen
              ? `<span class="table-state active" style="${isNewGreen ? 'color: var(--success);' : isBillReq ? 'color: var(--gold-600);' : 'color: var(--danger);'}"><span><div style="background:currentColor;width:6px;height:6px;border-radius:50%;"></div></span>Session Active</span>`
              : `<span class="table-state ${t.is_active ? "active" : "inactive"}"><span></span>${t.is_active ? "Ready" : "Hidden"}</span>`
            }
          </div>
          <div class="table-card-actions">
            ${isBillReq
              ? `<button class="btn btn-primary btn-small qty-pulse" style="background: var(--gold-500); color: var(--forest-950); border-color: var(--gold-500);" data-view-bill-order="${t.id}">View Bill in Orders</button>`
              : isNewGreen
              ? `<button class="btn btn-primary btn-small" style="background: var(--success); border-color: var(--success);" data-manage-table="${t.id}">Manage</button>`
              : openSession
              ? `<button class="btn btn-primary btn-small" data-manage-table="${t.id}"><i class="ph-bold ph-list-magnifying-glass"></i> Manage</button>`
              : `
                ${t.is_active ? `<button class="icon-btn icon-btn-light" data-qr="${t.id}" title="Table QR"><i class="ph-bold ph-qr-code"></i></button>` : ""}
                <button class="icon-btn icon-btn-light" data-edit-table="${t.id}" title="Edit table"><i class="ph-bold ph-pencil-simple"></i></button>
                <button class="icon-btn icon-btn-danger" data-delete-table="${t.id}" title="Delete table"><i class="ph-bold ph-trash"></i></button>
              `
            }
          </div>
        </article>
      `
    }).join("") : `<div class="empty-state"><i class="ph-bold ph-armchair"></i><strong>No tables yet</strong><span>Create the first table to generate a QR.</span></div>`;

    area.querySelector("#add-table").addEventListener("click", () => openTableEditor());
    
    list.addEventListener("click", e => {
      const edit = e.target.closest("[data-edit-table]");
      const del = e.target.closest("[data-delete-table]");
      const qr = e.target.closest("[data-qr]");
      const manageTbl = e.target.closest("[data-manage-table]");
      const viewBill = e.target.closest("[data-view-bill-order]");
      
      if (edit) { const t = tables.find(x => x.id === edit.dataset.editTable); if (t) openTableEditor(t); }
      if (del) { const t = tables.find(x => x.id === del.dataset.deleteTable); if (t) openTableDelete(t); }
      if (qr) { const t = tables.find(x => x.id === qr.dataset.qr); if (t) openTableQR(t); }
      
      if (manageTbl) { 
        const t = tables.find(x => x.id === manageTbl.dataset.manageTable);
        const s = activeSessions.find(x => x.table_id === t.id);
        if (t && s) {
            if (window.__tableAlerts) delete window.__tableAlerts[t.id];
            if (window.clearTableAlert) window.clearTableAlert(t.id);
            openAdminTableManager(t, s);
            renderTables(); // instantly clear the UI highlight behind modal
        }
      }
      
      if (viewBill) {
          const tableId = viewBill.dataset.viewBillOrder;
          if (window.__tableAlerts) delete window.__tableAlerts[tableId];
          if (window.clearTableAlert) window.clearTableAlert(tableId);
          window.__autoOpenOrderTableId = tableId;
          section = "orders";
          updateNavUI();
          renderSection();
      }
    });
  }

  async function openAdminTableManager(table, session) {
    // 🧠 GHOST DOT FIX: Instantly mark this session as seen and wipe local alerts
    if (window.__tableAlerts) delete window.__tableAlerts[table.id];
    if (window.clearTableAlert) window.clearTableAlert(table.id);
    
    if (session && session.id) {
        const seenSessions = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_sessions") || "[]"));
        seenSessions.add(session.id);
        localStorage.setItem("fourflavours.seen_sessions", JSON.stringify([...seenSessions]));
    }
    
    // Force the UI to evaluate the new clean memory state and hide the dot
    evaluateGlobalAlerts();

    const modal = openAppModal({
      title: `Table ${table.table_no} Management`,
      subtitle: "Review the active table tab, add items, or close the table.",
      body: `<div id="admin-table-manager-host" style="display: flex; flex-direction: column; min-height: 50vh;"><div class="empty-state"><i class="ph ph-spinner-gap ph-spin"></i><strong>Loading table data...</strong></div></div>`,
      actions: [] // Strip default actions to merge them into a unified sticky block
    });

    const host = modal.root.querySelector("#admin-table-manager-host");
    
    async function renderManager() {
      try {
        const { data: ordersList, error } = await supabase.from("orders").select("*, order_items(*)").eq("session_id", session.id).eq("restaurant_id", window.__ACTIVE_TENANT__.id).neq("status", "cancelled").order("round_number", { ascending: true });
        if (error) throw error;

        if (!ordersList || ordersList.length === 0) {
          host.innerHTML = `
            <div style="display: flex; flex-direction: column; flex: 1;">
              <div class="empty-state"><i class="ph ph-warning-circle"></i><strong>No active order found</strong></div>
              <div style="position: sticky; bottom: -17px; background: var(--paper); padding: 12px 0 0 0; margin-top: auto; border-top: 1px solid var(--line); display: flex; gap: 8px;">
                <button class="btn btn-primary" id="admin-add-items" style="flex: 1;"><i class="ph-bold ph-plus"></i> Add Round</button> 
                <button class="btn btn-danger" id="force-close-empty" style="flex: 1;"><i class="ph-bold ph-power"></i> Close Table</button>
              </div>
            </div>`;
          
          host.querySelector("#force-close-empty").addEventListener("click", async () => {
            const button = host.querySelector("#force-close-empty");
            const originalHTML = button.innerHTML;
            button.disabled = true;
            button.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i> Closing...`;

            try {
              const tenantId = window.__ACTIVE_TENANT__?.id;
              if (!tenantId) {
                throw new Error("The active restaurant could not be verified.");
              }

              const { error } = await supabase.rpc("close_empty_dining_session", {
                p_session_id: session.id
              });

              if (error) throw error;

              modal.close();
              await reload();
            } catch (error) {
              button.disabled = false;
              button.innerHTML = originalHTML;
              showToast("Could not close table", error?.message || "Please try again.", "error");
            }
          });
          
          host.querySelector("#admin-add-items").addEventListener("click", () => {
            const tenantId = window.__ACTIVE_TENANT__?.id;
            const posNav = document.querySelector('[data-nav="pos"]');

            if (!tenantId || !table?.id) {
              showToast("Cannot add round", "The active restaurant or table could not be verified.", "error");
              return;
            }

            if (!posNav) {
              showToast("POS unavailable", "The POS navigation could not be found. Please refresh and try again.", "error");
              return;
            }

            // Pass the selected table to the POS route. Do not update the old
            // POS state here; its action-bar listener belongs to a view that
            // is no longer mounted and would throw on missing DOM elements.
            window.__RMS_PENDING_POS_TABLE__ = {
              restaurantId: tenantId,
              tableId: table.id,
              orderType: "dine_in"
            };

            modal.close();
            posNav.click();
          });
          return;
        }

        let displayRounds = [];
        let grandTotal = 0, subtotal = 0, cgst = 0, sgst = 0, rounding = 0;
        let latestOrder = ordersList[ordersList.length - 1]; 

        ordersList.forEach((o, index) => {
          grandTotal += Number(o.grand_total || 0); subtotal += Number(o.subtotal || 0);
          cgst += Number(o.cgst || 0); sgst += Number(o.sgst || 0); rounding += Number(o.rounding || 0);
          
          let roundItems = [];
          (o.order_items || []).sort((a, b) => {
              const dateDiff = new Date(a.created_at) - new Date(b.created_at);
              return dateDiff !== 0 ? dateDiff : (a.id > b.id ? 1 : -1);
          }).forEach(oi => {
              roundItems.push({ id: oi.id, name: oi.name_snapshot, price: oi.unit_price, quantity: oi.quantity, status: oi.serving_status || 'pending' });
          });
          displayRounds.push({ id: o.id, round_number: o.round_number || (index+1), items: roundItems, total: o.grand_total });
        });

        const isBillReq = session.status === "bill_requested";

        function cycleStatus(current) {
            const sequence = ["pending", "preparing", "ready", "served"];
            const index = sequence.indexOf(current);

            // Never cycle a completed item back to pending.
            if (index < 0 || index >= sequence.length - 1) return current;
            return sequence[index + 1];
        }

        function getNextStatusLabel(status) {
            const labels = {
                pending: "START PREPARING",
                preparing: "MARK READY",
                ready: "MARK SERVED",
                served: "SERVED"
            };

            return labels[status] || "PENDING";
        }

        function getStatusColor(status) {
            if (status === "served") {
                return "color: var(--success); background: transparent; border-color: transparent; box-shadow: none; padding-right: 2px;";
            }
            if (status === "ready") {
                return "color: #166534; background: #dcfce7; border-color: #86efac; box-shadow: 0 2px 6px rgba(22,163,74,0.12);";
            }
            if (status === "preparing") {
                return "color: var(--gold-700); background: var(--gold-100); border-color: var(--gold-400); box-shadow: 0 2px 6px rgba(201,164,90,0.2);";
            }

            return "color: var(--forest-900); background: #ffffff; border-color: var(--forest-900); box-shadow: 0 2px 6px rgba(25,50,28,0.08);";
        }

        const hasUnservedItems = displayRounds.some(round =>
            round.items.some(item => item.status !== "served")
        );

        // 🧠 SCROLL LOCK FIX: Capture the exact scroll position before destroying the old HTML list
        const scrollNode = host.querySelector(".dining-items-list");
        const currentScroll = scrollNode ? scrollNode.scrollTop : 0;

        host.innerHTML = `
          <div class="active-dining-dashboard" style="text-align: left; display: flex; flex-direction: column; flex: 1; min-height: 0;">
            <div class="dining-status-banner" style="flex-shrink: 0; ${isBillReq ? 'background: var(--gold-100); color: var(--gold-600); border: 1px solid var(--gold-400);' : ''}">
              <i class="ph-bold ph-${isBillReq ? 'bell-ringing qty-pulse' : 'receipt'}"></i>
              <div>
                <strong style="${isBillReq ? 'color: var(--gold-600);' : ''}">${isBillReq ? 'Customer Requested Bill' : 'Table Tab is open'}</strong>
                <span>Grand Total: ${money(grandTotal, settings.currency_symbol)}</span>
              </div>
            </div>

            <div class="dining-items-list" style="flex: 1; overflow-y: auto; min-height: 0; margin-top: 12px; padding-bottom: 24px; padding-right: 6px;">
              ${displayRounds.map(round => `
                <div style="flex-shrink: 0; margin-bottom: 16px; background: var(--paper); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column;">
                  <div style="background: var(--cream-50); padding: 10px 14px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center;">
                    <strong style="font-size: 13px; color: var(--forest-900);">Round ${round.round_number}</strong>
                    <span style="font-size: 13px; font-weight: 800;">${money(round.total, settings.currency_symbol)}</span>
                  </div>

                  <div style="display: flex; flex-direction: column; background: var(--paper);">
                    ${round.items.map(item => `
                      <div style="padding: 12px 14px; border-bottom: 1px solid var(--cream-200); display: flex; justify-content: space-between; align-items: center;">
                        <div style="display: flex; flex-direction: column; gap: 6px;">
                          <strong style="font-size: 14px;">
                            ${escapeHtml(item.name)}
                            <span class="qty-badge" style="background: var(--sage-200); color: var(--forest-900); padding: 2px 6px; border-radius: 6px; font-size: 11px;">x${item.quantity}</span>
                          </strong>
                          <span style="font-size: 13px; color: var(--muted);">${money(item.price, settings.currency_symbol)}</span>
                        </div>

                        <div style="display: flex; gap: 6px; align-items: center;">
                          ${item.status === "pending" ? `
                            <button class="admin-delete-item-btn icon-btn" data-delete-id="${item.id}" title="Remove pending item"
                              style="width: 30px; height: 30px; border-radius: 8px; border: none; background: #fee2e2; color: #ef4444;">
                              <i class="ph-bold ph-trash" style="font-size: 15px;"></i>
                            </button>
                          ` : ""}

                          <button class="status-cycle-btn"
                            data-item-id="${item.id}"
                            data-current-status="${item.status}"
                            title="${getNextStatusLabel(item.status)}"
                            style="padding: 6px 12px; font-size: 11px; font-weight: 900; text-transform: uppercase; border-radius: 20px; border: 1px solid transparent; transition: all 0.15s ease; display: inline-flex; align-items: center; gap: 4px; ${getStatusColor(item.status)}${item.status === "served" ? "cursor: default; opacity: 0.95;" : "cursor: pointer;"}"
                            ${item.status === "served" ? "disabled" : ""}>
                            ${item.status === "served" ? '<i class="ph-bold ph-check" style="font-size: 14px;"></i> SERVED' : `${getNextStatusLabel(item.status)} <i class="ph-bold ph-caret-right" style="font-size: 12px;"></i>`}
                          </button>
                        </div>
                      </div>
                    `).join("")}
                  </div>
                </div>
              `).join("")}
              <div style="height: 24px; flex-shrink: 0; width: 100%;"></div>
            </div>

            <div style="position: sticky; bottom: -17px; background: var(--paper); padding: 12px 0 0 0; margin-top: auto; border-top: 1px solid var(--line); display: flex; gap: 8px;">
              <button class="btn btn-quiet" id="admin-add-items" style="flex: 1; padding: 0 4px; font-size: 12px;">
                <i class="ph-bold ph-plus"></i> Add Round
              </button>
              <button class="btn btn-quiet" id="admin-view-bill" style="flex: 1; padding: 0 4px; font-size: 12px;" ${hasUnservedItems ? "disabled" : ""}>
                <i class="ph-bold ph-printer"></i> Bill
              </button>
              <button class="btn btn-primary" id="admin-close-table" style="flex: 1.5; padding: 0 4px; font-size: 12px;" ${hasUnservedItems ? "disabled" : ""}>
                ${hasUnservedItems ? '<i class="ph-bold ph-clock"></i> Items Pending' : '<i class="ph-bold ph-check-circle"></i> Close Table'}
              </button>
            </div>
          </div>
        `;

        // 🧠 SCROLL LOCK FIX: Instantly restore the scroll position on the newly generated HTML list
        const newScrollNode = host.querySelector(".dining-items-list");
        if (newScrollNode) newScrollNode.scrollTop = currentScroll;

        // Delete only pending items. The database RPC must verify tenant ownership and recalculate the round totals.
        host.querySelectorAll(".admin-delete-item-btn").forEach(button => {
            button.addEventListener("click", async () => {
                const itemId = button.dataset.deleteId;
                const originalHTML = button.innerHTML;
                button.disabled = true;
                button.innerHTML = '<i class="ph-bold ph-spinner-gap ph-spin"></i>';

                try {
                    const { error } = await supabase.rpc("remove_order_item", {
                        p_item_id: itemId
                    });
                    if (error) throw error;

                    renderManager();
                } catch (error) {
                    button.disabled = false;
                    button.innerHTML = originalHTML;
                    showToast("Could not remove item", error.message, "error");
                }
            });
        });

        // The database validates both tenant ownership and the legal status transition.
        host.querySelectorAll(".status-cycle-btn").forEach(button => {
            button.addEventListener("click", async () => {
                const itemId = button.dataset.itemId;
                const nextStatus = cycleStatus(button.dataset.currentStatus);

                if (nextStatus === button.dataset.currentStatus) return;

                const originalHTML = button.innerHTML;
                button.disabled = true;
                button.innerHTML = '<i class="ph-bold ph-spinner-gap ph-spin"></i>';

                try {
                    const { error } = await supabase.rpc("set_order_item_status", {
                        p_item_id: itemId,
                        p_status: nextStatus
                    });
                    if (error) throw error;

                    renderManager();
                } catch (error) {
                    button.disabled = false;
                    button.innerHTML = originalHTML;
                    showToast("Could not update item status", error.message, "error");
                }
            });
        });

        // Connects straight to the existing POS Cart mechanism without forcing a route change
        host.querySelector("#admin-add-items").addEventListener("click", async () => {
            
            // PERFORMANCE FIX: Use the instantly available, globally cached products array instead of a slow database call!
            const activeProducts = products.filter(p => p.is_active).sort((a, b) => a.name.localeCompare(b.name));
            
            if (!activeProducts || activeProducts.length === 0) { 
                showToast("Error", "No active dishes found in the menu.", "error"); 
                renderManager(); 
                return; 
            }

            const cuisinesList = ["All", ...new Set(activeProducts.map(p => (p.category || "Uncategorized").split(" - ")[0].trim()))];
            
            let localCart = new Map();
            let searchQuery = "";
            let selectedCuisine = "All";
            let selectedSub = "All";

            function getAvailableSubs() {
                if (selectedCuisine === "All") return ["All"];
                const subs = new Set();
                activeProducts.forEach(p => {
                    const parts = (p.category || "Uncategorized").split(" - ");
                    if (parts[0].trim() === selectedCuisine) subs.add(parts[1]?.trim() || "Others");
                });
                return ["All", ...Array.from(subs)];
            }

            // The DOM Updater: Animates quantities & updates cart without destroying HTML nodes
            function updateAdminCatalogQuantities() {
                const cartTotal = Array.from(localCart.values()).reduce((sum, item) => sum + (item.product.price * item.qty), 0);
                const cartCount = Array.from(localCart.values()).reduce((sum, item) => sum + item.qty, 0);

                host.querySelectorAll("[data-catalog-control]").forEach(control => {
                    const id = control.dataset.catalogControl;
                    const qty = localCart.get(id)?.qty || 0;
                    const valSpan = control.querySelector(".premium-qty-value");
                    const incBtn = control.querySelector(".inc-btn");
                    
                    // Highlight the parent row when active
                    const row = control.closest('.catalog-row');
                    if (row) {
                        row.style.background = qty > 0 ? "var(--cream-50)" : "#fff";
                    }

                    if (qty <= 0) {
                        control.classList.remove("is-active");
                        if (valSpan) valSpan.textContent = "0";
                        if (incBtn) { incBtn.classList.remove("catalog-inc"); incBtn.classList.add("catalog-add"); }
                    } else {
                        control.classList.add("is-active");
                        if (valSpan) valSpan.textContent = qty;
                        if (incBtn) { incBtn.classList.remove("catalog-add"); incBtn.classList.add("catalog-inc"); }
                    }
                });

                const footerWrap = host.querySelector("#catalog-footer-wrap");
                if (footerWrap) {
                    if (cartCount > 0) {
                        footerWrap.style.display = "block";
                        footerWrap.innerHTML = `
                            <button class="btn btn-primary" id="confirm-new-round" style="width: 100%; display: flex; justify-content: space-between; align-items: center; padding: 0 16px; height: 50px; border-radius: 12px; font-size: 15px; box-shadow: 0 8px 24px rgba(25, 50, 28, 0.25);">
                                <span style="display: flex; align-items: center; gap: 10px;"><div style="background: rgba(255,255,255,0.25); width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; border-radius: 6px; font-size: 13px; font-weight: 900;">${cartCount}</div> Confirm Round</span>
                                <span>${money(cartTotal, settings.currency_symbol)} <i class="ph-bold ph-arrow-right" style="margin-left: 6px; font-size: 16px;"></i></span>
                            </button>
                        `;
                        
                        const confirmBtn = footerWrap.querySelector("#confirm-new-round");
                        confirmBtn.addEventListener("click", async () => {
                            confirmBtn.disabled = true;
                            confirmBtn.innerHTML = `<i class="ph-bold ph-spinner-gap ph-spin" style="font-size: 20px;"></i> <span>Sending to kitchen...</span>`;
                            const itemsToSubmit = Array.from(localCart.values()).map(x => ({ id: x.product.id, quantity: x.qty }));
                            try {
                                const { error } = await supabase.rpc("create_pos_order", { 
                                    p_restaurant_id: window.__ACTIVE_TENANT__.id,
                                    p_order_type: 'dine_in', p_table_id: table.id, p_items: itemsToSubmit, p_note: "Admin Added Round" 
                                });
                                if (error) throw error;
                                showToast("Round Added", "Items sent to kitchen successfully.", "success");
                                renderManager(); 
                            } catch(err) {
                                showToast("Error", err.message, "error");
                                confirmBtn.disabled = false;
                                confirmBtn.innerHTML = `Try Again`;
                            }
                        });
                    } else {
                        footerWrap.style.display = "none";
                        footerWrap.innerHTML = "";
                    }
                }
            }

            function renderCatalog() {
                const visible = activeProducts.filter(p => {
                    const parts = (p.category || "Uncategorized").split(" - ");
                    const pCuisine = parts[0].trim();
                    const pSub = parts[1]?.trim() || "Others";
                    const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) || (p.category || "").toLowerCase().includes(searchQuery.toLowerCase());
                    const matchesCuisine = selectedCuisine === "All" || pCuisine === selectedCuisine;
                    const matchesSub = selectedSub === "All" || pSub === selectedSub;
                    return matchesSearch && matchesCuisine && matchesSub;
                });
                
                host.innerHTML = `
                    <div style="display: flex; flex-direction: column; flex: 1; min-height: 0; background: var(--paper);">
                        
                        <!-- SINGLE LINE PERFECT ALIGNMENT HEADER -->
                        <div style="position: sticky; top: -16px; margin: -15px -17px 0 -17px; padding: 8px 16px 8px 16px; border-bottom: 1px solid var(--line); display: flex; gap: 8px; align-items: center; background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); z-index: 110; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch;">
                            <button id="back-to-tab" style="width: 38px; height: 38px; border-radius: 10px; flex-shrink: 0; background: var(--cream-100); border: 1px solid var(--line); display: flex; align-items: center; justify-content: center; cursor: pointer;" onpointerdown="this.style.transform='scale(0.9)'" onpointerup="this.style.transform='scale(1)'" onpointerleave="this.style.transform='scale(1)'">
                                <i class="ph-bold ph-caret-left" style="font-size: 20px; color: var(--forest-950); margin-left: -2px;"></i>
                            </button>
                            <div style="flex: 1; position: relative; min-width: 150px;">
                                <i class="ph-bold ph-magnifying-glass" style="position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--muted); font-size: 16px;"></i>
                                <input type="text" id="add-round-search" placeholder="Search dishes..." value="${escapeHtml(searchQuery)}" style="width: 100%; height: 38px; border-radius: 10px; border: 1px solid var(--line); padding: 0 12px 0 36px; font-size: 14px; font-weight: 700; color: var(--forest-950); background: var(--cream-50); outline: none; transition: border-color 0.2s;">
                            </div>
                            <div style="position: relative; width: 130px; flex-shrink: 0;">
                                <select id="filter-cuisine" style="width: 100%; height: 38px; padding: 0 28px 0 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--cream-50); font-size: 13px; font-weight: 800; color: var(--forest-950); appearance: none; outline: none; cursor: pointer;">
                                    ${cuisinesList.map(c => `<option value="${escapeHtml(c)}" ${c === selectedCuisine ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
                                </select>
                                <i class="ph-bold ph-caret-down" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 13px; color: var(--forest-900); pointer-events: none;"></i>
                            </div>
                            <div style="position: relative; width: 130px; flex-shrink: 0;">
                                <select id="filter-sub" style="width: 100%; height: 38px; padding: 0 28px 0 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--cream-50); font-size: 13px; font-weight: 800; color: var(--forest-950); appearance: none; outline: none; cursor: pointer; opacity: ${selectedCuisine === 'All' ? '0.5' : '1'}; pointer-events:${selectedCuisine === 'All' ? 'none' : 'auto'};">
                                    ${getAvailableSubs().map(s => `<option value="${escapeHtml(s)}" ${s === selectedSub ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
                                </select>
                                <i class="ph-bold ph-caret-down" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 13px; color: var(--forest-900); pointer-events: none;"></i>
                            </div>
                        </div>

                        <!-- COMPACT LIST VIEW -->
                        <div id="catalog-list-container" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; align-content: flex-start; padding-bottom: 24px;">
                            ${visible.map(p => {
                                const isVeg = p.is_veg !== false;
                                const markColor = isVeg ? "#16a34a" : "#dc2626";

                                return `
                                <div class="catalog-row" style="display: flex; padding: 12px 16px; border-bottom: 1px solid var(--cream-200); background: #fff; align-items: center; gap: 14px; transition: background 0.3s ease;">
                                    <!-- 4:3 Small Thumbnail -->
                                    <div style="width: 64px; height: 48px; flex-shrink: 0; border-radius: 6px; overflow: hidden; background: var(--cream-200); position: relative;">
                                        ${p.image_url ? `<img src="${versionedAsset(p.image_url)}" style="width: 100%; height: 100%; object-fit: cover;" alt="">` : `<i class="ph-bold ph-image" style="position: absolute; top:50%; left:50%; transform: translate(-50%, -50%); color: var(--muted); font-size: 20px;"></i>`}
                                        <span style="position: absolute; top: 4px; right: 4px; width: 12px; height: 12px; background: #fff; border: 1px solid ${markColor}; border-radius: 2px; display: flex; align-items: center; justify-content: center; box-shadow: 0 1px 2px rgba(0,0,0,0.1);"><span style="width: 6px; height: 6px; background: ${markColor}; border-radius: 1px;"></span></span>
                                    </div>
                                    
                                    <div style="flex: 1; min-width: 0;">
                                        <h4 style="margin: 0 0 2px 0; font-size: 14px; font-weight: 800; color: var(--forest-950); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(p.name)}</h4>
                                        <div style="font-size: 13px; font-weight: 800; color: var(--forest-700);">${money(p.price, settings.currency_symbol)}</div>
                                    </div>
                                    
                                    <div style="flex-shrink: 0; display: flex; align-items: center;">
                                        <!-- EXACT POS STYLE BUTTON -->
                                        <div class="premium-qty-wrapper" style="margin: 0; box-shadow: 0 2px 8px rgba(0,0,0,0.06);" data-catalog-control="${p.id}">
                                            <button class="premium-qty-btn dec-btn catalog-dec" data-id="${p.id}"><i class="ph-bold ph-minus"></i></button>
                                            <span class="premium-qty-value">0</span>
                                            <button class="premium-qty-btn inc-btn catalog-add" data-id="${p.id}"><i class="ph-bold ph-plus"></i></button>
                                        </div>
                                    </div>
                                </div>
                                `;
                            }).join("") || `<div class="empty-state"><i class="ph-bold ph-magnifying-glass"></i><strong>No dishes found</strong><span>Try a different filter.</span></div>`}
                        </div>

                        <!-- ABSOLUTE STICKY FOOTER WRAPPER -->
                        <div id="catalog-footer-wrap" style="position: sticky; bottom: -17px; background: var(--paper); padding: 12px 0 12px 0; margin-top: auto; border-top: 1px solid var(--line); z-index: 100; display: none;"></div>
                    </div>
                `;

                // Instantly inject quantities & activate footer without destroying DOM transitions
                updateAdminCatalogQuantities();

                // Bind Search Input
                const searchInput = host.querySelector("#add-round-search");
                if (searchInput) {
                    searchInput.addEventListener("input", (e) => {
                        searchQuery = e.target.value;
                        renderCatalog();
                        const restoredInput = host.querySelector("#add-round-search");
                        if (restoredInput) { restoredInput.focus(); restoredInput.setSelectionRange(restoredInput.value.length, restoredInput.value.length); }
                    });
                }

                // Bind Dropdowns
                host.querySelector("#filter-cuisine")?.addEventListener("change", (e) => {
                    selectedCuisine = e.target.value;
                    selectedSub = "All"; 
                    renderCatalog();
                });
                
                host.querySelector("#filter-sub")?.addEventListener("change", (e) => {
                    selectedSub = e.target.value;
                    renderCatalog();
                });

                // Bind Back (Instant Pointerdown removes 300ms mobile lag)
                host.querySelector("#back-to-tab")?.addEventListener("pointerdown", () => renderManager());

                // EVENT DELEGATION: Animates the POS pill buttons without refreshing HTML
                const listContainer = host.querySelector("#catalog-list-container");
                if (listContainer) {
                    listContainer.addEventListener("click", (e) => {
                        const addBtn = e.target.closest(".catalog-add");
                        const incBtn = e.target.closest(".catalog-inc");
                        const decBtn = e.target.closest(".catalog-dec");

                        if (addBtn || incBtn) {
                            const btn = addBtn || incBtn;
                            const id = btn.dataset.id;
                            const p = products.find(x => x.id === id);
                            const current = localCart.get(id) || { product: p, qty: 0 };
                            current.qty += 1;
                            localCart.set(id, current);
                            
                            updateAdminCatalogQuantities();
                            
                            const control = btn.closest("[data-catalog-control]");
                            if (control) {
                                control.classList.remove("qty-pulse");
                                void control.offsetWidth;
                                control.classList.add("qty-pulse");
                            }
                        }

                        if (decBtn) {
                            const id = decBtn.dataset.id;
                            const current = localCart.get(id);
                            if (current) {
                                current.qty -= 1;
                                if (current.qty <= 0) localCart.delete(id);
                                else localCart.set(id, current);
                                
                                updateAdminCatalogQuantities();
                                
                                if (current.qty > 0) {
                                    const control = decBtn.closest("[data-catalog-control]");
                                    if (control) {
                                        control.classList.remove("qty-pulse");
                                        void control.offsetWidth;
                                        control.classList.add("qty-pulse");
                                    }
                                }
                            }
                        }
                    });
                }
            }

            renderCatalog();
        });

        host.querySelector("#admin-view-bill").addEventListener("click", () => {
           let flatItems = []; displayRounds.forEach(r => r.items.forEach(i => flatItems.push({ name_snapshot: i.name, unit_price: i.price, quantity: i.quantity })));
           showAdminReceiptPreview({ ...latestOrder, session_id: session.id, order_items: flatItems, subtotal, cgst, sgst, rounding, grand_total: grandTotal });
        });

        host.querySelector("#admin-close-table").addEventListener("click", () => {
           openAppModal({
              title: `Close Table ${table.table_no}?`,
              subtitle: "This marks the session as paid and frees the table.",
              body: `<div class="danger-confirm"><div class="danger-confirm-icon" style="background: var(--success-soft); color: var(--success);"><i class="ph-bold ph-check-circle"></i></div><h3>Payment Received?</h3><p>Customer total is <strong>${money(grandTotal, settings.currency_symbol)}</strong>.</p></div>`,
              actions: [
                { label: "Cancel", className: "btn-quiet", onClick: (ctx) => ctx.close() },
                { label: "Yes, Close Table", className: "btn-primary", onClick: async (ctx) => {
                    ctx.button.disabled = true;
                    try {
                      const { error } = await supabase.rpc("complete_session_payment", { p_session_id: session.id, p_payment_method: "cash" });
                      if (error) throw error;
                      showToast("Table Closed", `Table ${table.table_no} is now available.`);
                      ctx.close(); modal.close(); reload();
                    } catch(err) { ctx.button.disabled = false; showToast("Error", err.message, "error"); }
                }}
              ]
           });
        });

      } catch (err) {
        host.innerHTML = `<div class="empty-state"><i class="ph ph-warning-circle"></i><strong>Error loading table</strong><span>${escapeHtml(err.message)}</span></div>`;
      }
    }
    
    renderManager();
  }

  function renderSettings() {
    // Fetch current restaurant-level branding configuration securely
    supabase
      .from("restaurants")
      .select("id, name, icon_url, logo_url, background_color, foreground_color")
      .eq("id", window.__ACTIVE_TENANT__?.id)
      .maybeSingle()
      .then(({ data: restData }) => {
      if (!restData) return;

      area.innerHTML = `
        <section class="section-title-row">
          <div>
            <span class="eyebrow">Restaurant settings</span>
            <h1>Keep the bill precise.</h1>
            <p>Database-verified tax, totals, and branding.</p>
          </div>
          <button class="btn btn-quiet" id="admin-lock-workspace"><i class="ph-bold ph-lock-key"></i> Lock Workspace</button>
        </section>
        
        <!-- Branding Section -->
        <section class="admin-panel settings-panel" style="margin-bottom: 16px;">
          <div class="panel-head" style="margin-bottom: 16px;">
            <div><span class="eyebrow">Branding</span><h2>Visual Identity</h2></div>
          </div>
          <form id="branding-form" class="settings-form-grid">
            <label class="field settings-wide">
              <span>Square Icon (Receipts & Mobile)</span>
              <div style="display: flex; gap: 12px; align-items: center; margin-top: 6px;">
                <div id="icon-preview-box" style="width: 64px; height: 64px; border-radius: 12px; border: 1px solid var(--line); overflow: hidden; background: var(--sage-100); display: flex; align-items: center; justify-content: center;">
                  ${restData.icon_url ? `<img src="${versionedAsset(restData.icon_url)}" style="width: 100%; height: 100%; object-fit: cover;">` : `<i class="ph ph-image" style="font-size: 24px; color: var(--muted);"></i>`}
                </div>
                <input class="field-input" type="file" id="icon_upload" accept="image/png, image/jpeg, image/svg+xml" style="flex: 1; padding: 8px;">
              </div>
            </label>
            
            <label class="field settings-wide">
              <span>Landscape Logo (Top Header)</span>
              <div style="display: flex; gap: 12px; align-items: center; margin-top: 6px;">
                <div id="logo-preview-box" style="width: 120px; height: 48px; border-radius: 8px; border: 1px solid var(--line); overflow: hidden; background: var(--sage-100); display: flex; align-items: center; justify-content: center;">
                  ${restData.logo_url ? `<img src="${versionedAsset(restData.logo_url)}" style="width: 100%; height: 100%; object-fit: contain;">` : `<i class="ph ph-image" style="font-size: 24px; color: var(--muted);"></i>`}
                </div>
                <input class="field-input" type="file" id="logo_upload" accept="image/png, image/jpeg, image/svg+xml" style="flex: 1; padding: 8px;">
              </div>
            </label>

            <div class="settings-wide" style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 12px;">
              <label class="field" style="margin: 0;">
                <span>Background Color</span>
                <input class="field-input" name="background_color" type="color" value="${escapeHtml(restData.background_color || '#fcfbf7')}" style="height: 48px; width: 100%; padding: 4px; cursor: pointer; border-radius: 12px; background: var(--paper);">
              </label>
              
              <label class="field" style="margin: 0;">
                <span>Foreground Color</span>
                <input class="field-input" name="foreground_color" type="color" value="${escapeHtml(restData.foreground_color || '#122216')}" style="height: 48px; width: 100%; padding: 4px; cursor: pointer; border-radius: 12px; background: var(--paper);">
              </label>
            </div>
            
            <div class="settings-wide" style="margin-top: 16px;">
              <button class="btn btn-primary" type="submit" id="save-branding-btn" style="width: 100%; height: 48px; border-radius: 12px; font-size: 15px;">
                <i class="ph-bold ph-check-circle"></i> Done
              </button>
            </div>
          </form>
        </section>

        <!-- Security Section -->
        <section class="admin-panel settings-panel" style="margin-bottom: 16px;">
          <div class="panel-head" style="margin-bottom: 16px;">
            <div><span class="eyebrow">Security</span><h2>Access Control</h2></div>
          </div>
          <form id="security-form" class="settings-form-grid">
            <label class="field"><span>Current 6-Digit PIN</span><input class="field-input" type="password" name="current_pin" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="••••••" required></label>
            <label class="field"><span>New 6-Digit PIN</span><input class="field-input" type="password" name="new_pin" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="••••••" required></label>
            <div class="settings-wide" style="margin-top: 8px;">
              <button class="btn btn-primary" type="submit" id="save-security-btn" style="background: var(--forest-900); border-color: var(--forest-900);"><i class="ph ph-lock-key"></i>Change Admin PIN</button>
            </div>
          </form>
        </section>

        <!-- Billing Section -->
        <section class="admin-panel settings-panel">
          <form id="settings-form" class="settings-form-grid">
            <label class="field"><span>Restaurant name</span><input class="field-input" name="restaurant_name" value="${escapeHtml(settings.restaurant_name)}" required></label>
            <label class="field"><span>GSTIN (GST Number)</span><input class="field-input" name="gst_number" value="${escapeHtml(settings.gst_number || "")}" placeholder="22AAAAA0000A1Z5"></label>
            <label class="field settings-wide"><span>Restaurant Address (Prints on Bill)</span><textarea class="field-input textarea-input" name="restaurant_address" placeholder="123 Food Street, City, State" rows="2">${escapeHtml(settings.restaurant_address || "")}</textarea></label>
            <label class="field"><span>CGST %</span><input class="field-input" name="cgst_rate" type="number" min="0" max="100" step="0.01" value="${Number(settings.cgst_rate)}" required></label>
            <label class="field"><span>SGST %</span><input class="field-input" name="sgst_rate" type="number" min="0" max="100" step="0.01" value="${Number(settings.sgst_rate)}" required></label>
            <label class="field settings-wide"><span>UPI ID (For Bill QR Code)</span><input class="field-input" name="upi_id" value="${escapeHtml(settings.upi_id || "")}" placeholder="yourname@bank"></label>
            <label class="field settings-wide"><span>Receipt footer</span><input class="field-input" name="receipt_footer" value="${escapeHtml(settings.receipt_footer || "")}"></label>
            <div class="settings-wide settings-preview"><div class="settings-preview-icon"><i class="ph ph-shield-check"></i></div><div><strong>Secure calculation</strong><span>Prices, tax rates and the final total are recalculated by PostgreSQL when the order is created.</span></div></div>
            <div class="settings-wide">
              <button class="btn btn-primary" type="submit" id="save-billing-btn" style="height: 48px; border-radius: 12px; font-size: 15px; transition: all 0.2s ease;">
                <i class="ph ph-floppy-disk"></i>Save billing settings
              </button>
            </div>
          </form>
        </section>
        
        `;

      // 1. Add Instant Image Previews for the Uploaders
      area.querySelector("#icon_upload")?.addEventListener("change", e => {
        const file = e.target.files?.[0];
        if (file) {
          const url = URL.createObjectURL(file);
          area.querySelector("#icon-preview-box").innerHTML = `<img src="${url}" style="width: 100%; height: 100%; object-fit: cover;">`;
        }
      });

      area.querySelector("#logo_upload")?.addEventListener("change", e => {
        const file = e.target.files?.[0];
        if (file) {
          const url = URL.createObjectURL(file);
          area.querySelector("#logo-preview-box").innerHTML = `<img src="${url}" style="width: 100%; height: 100%; object-fit: contain;">`;
        }
      });

      area.querySelector("#admin-lock-workspace").addEventListener("click", async () => {
        const btn = area.querySelector("#admin-lock-workspace");
        btn.innerHTML = `<i class="ph-bold ph-spinner-gap ph-spin"></i> Locking...`;
        
        // Securely destroy the session so the next person must sign in
        await supabase.auth.signOut();
        window.__ACTIVE_TENANT__ = null;
        
        history.pushState({}, "", location.pathname);
        location.hash = "";
        window.dispatchEvent(new Event("rms:navigate"));
      });

      area.querySelector("#branding-form").addEventListener("submit", async e => {
        e.preventDefault();
        const btn = area.querySelector("#save-branding-btn");
        btn.disabled = true;
        const ogText = btn.innerHTML;
        btn.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i> Saving...`;

        try {
          const fd = new FormData(e.currentTarget);
          const bgCol = fd.get("background_color");
          const fgCol = fd.get("foreground_color");
          
          let iconUrl = restData.icon_url;
          let logoUrl = restData.logo_url;

          const iconFile = area.querySelector("#icon_upload").files[0];
          const logoFile = area.querySelector("#logo_upload").files[0];

          if (iconFile) {
            const path = `${restData.id}/icon_${crypto.randomUUID()}.${iconFile.name.split('.').pop()}`;
            const { error } = await supabase.storage.from('restaurant-assets').upload(path, iconFile);
            if (error) throw error;
            iconUrl = supabase.storage.from('restaurant-assets').getPublicUrl(path).data.publicUrl;
          }

          if (logoFile) {
            const path = `${restData.id}/logo_${crypto.randomUUID()}.${logoFile.name.split('.').pop()}`;
            const { error } = await supabase.storage.from('restaurant-assets').upload(path, logoFile);
            if (error) throw error;
            logoUrl = supabase.storage.from('restaurant-assets').getPublicUrl(path).data.publicUrl;
          }

          const { error } = await supabase.from("restaurants").update({
            background_color: bgCol,
            foreground_color: fgCol,
            icon_url: iconUrl,
            logo_url: logoUrl
          }).eq("id", restData.id);

          if (error) throw error;
          
          // Instantly apply the colors to the live document so they don't have to refresh!
          if (bgCol) {
            document.documentElement.style.setProperty("--cream-100", bgCol);
            document.documentElement.style.setProperty("--cream-50", bgCol);
          }
          if (fgCol) {
            document.documentElement.style.setProperty("--forest-950", fgCol);
            document.documentElement.style.setProperty("--forest-900", fgCol);
            document.documentElement.style.setProperty("--forest-800", fgCol);
            document.documentElement.style.setProperty("--forest-700", fgCol);
            document.documentElement.style.setProperty("--ink", fgCol);
          }
          
          // Update the global state
          if (window.__ACTIVE_TENANT__) {
            window.__ACTIVE_TENANT__.background_color = bgCol;
            window.__ACTIVE_TENANT__.foreground_color = fgCol;
            if (iconUrl) window.__ACTIVE_TENANT__.icon_url = iconUrl;
            if (logoUrl) window.__ACTIVE_TENANT__.logo_url = logoUrl;
          }
          
          // Magically update the top header so the user doesn't even need to refresh
          const topLogo = document.querySelector(".app-topbar .topbar-left img");
          if (topLogo && logoUrl) topLogo.src = logoUrl;
          
          btn.innerHTML = `<i class="ph-bold ph-check"></i> Applied`;
          showToast("Branding Updated", "Your new colors and logos are live!");
          
          setTimeout(() => { btn.innerHTML = ogText; }, 2500);
        } catch (error) {
          showToast("Error", error.message, "error");
          btn.innerHTML = ogText;
        } finally {
          btn.disabled = false;
        }
      });

      area.querySelector("#security-form").addEventListener("submit", async e => {
        e.preventDefault();
        
        // 1. Capture the form element synchronously before we pause to talk to the database!
        const form = e.target; 
        
        const btn = area.querySelector("#save-security-btn");
        btn.disabled = true;
        const ogText = btn.innerHTML;
        btn.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i> Updating...`;

        try {
          const fd = new FormData(form);
          const currentPin = fd.get("current_pin");
          const newPin = fd.get("new_pin");

          // 2. The security check happens securely inside PostgreSQL here
          const { error } = await supabase.rpc("change_admin_pin", { 
            p_restaurant_id: window.__ACTIVE_TENANT__.id,
            p_current_pin: currentPin, 
            p_new_pin: newPin 
          });

          if (error) throw error;
          
          btn.innerHTML = `<i class="ph ph-check"></i> PIN Changed!`;
          showToast("Security Updated", "Your Admin PIN has been successfully changed.");
          
          // 3. Safely empty the text boxes using our captured reference
          form.reset();
          
          setTimeout(() => { btn.innerHTML = ogText; }, 3000);
        } catch (error) {
          showToast("Update Failed", error.message, "error");
          btn.innerHTML = ogText;
        } finally {
          btn.disabled = false;
        }
      });

      area.querySelector("#settings-form").addEventListener("submit", async e => {
        e.preventDefault(); 
        
        const form = e.currentTarget;
        const btn = form.querySelector("#save-billing-btn");
        const ogText = btn.innerHTML;
        
        // Instantly disable button and show loading spinner
        btn.disabled = true;
        btn.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i> Saving...`;

        const fd = new FormData(form);
        const payload = {
          restaurant_id: window.__ACTIVE_TENANT__.id,
          restaurant_name: String(fd.get("restaurant_name") || "").trim(),
          gst_number: String(fd.get("gst_number") || "").trim(),
          restaurant_address: String(fd.get("restaurant_address") || "").trim(),
          cgst_rate: Number(fd.get("cgst_rate")),
          sgst_rate: Number(fd.get("sgst_rate")),
          upi_id: String(fd.get("upi_id") || "").trim(),
          daily_pin: String(fd.get("daily_pin") || "").trim(),
          receipt_footer: String(fd.get("receipt_footer") || "").trim()
        };
        
        try { 
          // 1. Save Billing Settings
          const { error } = await supabase.from("app_settings").upsert(payload, { onConflict: 'restaurant_id' }); 
          if (error) throw error; 
          
          // 2. Sync Master Tenant Identity
          const { error: restError } = await supabase.from("restaurants").update({ name: payload.restaurant_name }).eq("id", window.__ACTIVE_TENANT__.id);
          if (restError) throw restError;

          // 3. Update Memory State
          Object.assign(settings, payload); 
          if (window.__ACTIVE_TENANT__) {
            window.__ACTIVE_TENANT__.name = payload.restaurant_name;
          }
          
          // 4. Live DOM Update (Magically changes the text on screen instantly)
          const topbarName = document.querySelector(".app-topbar .topbar-left strong");
          if (topbarName) topbarName.textContent = payload.restaurant_name;
          
          const drawerName = document.querySelector(".app-drawer .drawer-head strong");
          if (drawerName) drawerName.textContent = payload.restaurant_name;
          
          document.title = `${payload.restaurant_name} | Table Forge`;

          showToast("Settings saved", "Configuration updated."); 
          
          // Show success checkmark
          btn.innerHTML = `<i class="ph-bold ph-check"></i> Saved`;
          
          // Revert back to normal after 2.5 seconds
          setTimeout(() => { 
            btn.innerHTML = ogText; 
            btn.disabled = false; 
          }, 2500);

        } catch (error) { 
          showToast("Could not save settings", error.message, "error"); 
          btn.innerHTML = ogText;
          btn.disabled = false;
        }
      });

      }); 
  }

  function openTableEditor(table = null) {
    const editing = Boolean(table);
    openAppModal({
      title: editing ? "Edit table" : "Add table",
      subtitle: editing ? "Update the table without leaving the workspace." : "Create a table and generate its QR automatically.",
      body: `<form id="table-form" class="stack-form"><label class="field"><span>Table number</span><input class="field-input" name="table_no" value="${escapeHtml(table?.table_no ?? "")}" placeholder="1, A1, VIP-1" required></label><label class="field"><span>Capacity</span><input class="field-input" name="capacity" type="number" min="1" max="100" value="${Number(table?.capacity ?? 4)}" required></label><label class="switch-field"><input type="checkbox" name="is_active" ${table?.is_active ?? true ? "checked" : ""}><span class="switch-ui"></span><span><strong>Table is active</strong><small>Inactive tables cannot accept QR orders.</small></span></label><div class="modal-form-note"><i class="ph ph-qr-code"></i><span>The QR remains tied to the table ID, so changing the displayed number does not change the QR destination.</span></div></form>`,
      actions: [
        { label: "Cancel", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: editing ? "Save changes" : "Create table", icon: "ph-floppy-disk", className: "btn-primary", onClick: async ({ root, close, button }) => {
          const form = root.querySelector("#table-form"); if (!form.reportValidity()) return; button.disabled = true; const fd = new FormData(form); 
          const payload = { 
            restaurant_id: window.__ACTIVE_TENANT__.id, // CRITICAL FIX: Tenant Isolation Identity attached
            table_no: String(fd.get("table_no") || "").trim(), 
            capacity: Number(fd.get("capacity")), 
            is_active: fd.get("is_active") === "on" 
          };
          try { const query = editing ? supabase.from("tables").update(payload).eq("id", table.id) : supabase.from("tables").insert(payload); const { error } = await query; if (error) throw error; showToast(editing ? "Table updated" : "Table created", `Table ${payload.table_no} is ready.`); close(); await reload(); } catch (error) { button.disabled = false; showToast("Could not save table", error.message, "error"); }
        }}
      ]
    });
  }

  function openTableDelete(table) {
    openAppModal({
      title: `Delete table ${escapeHtml(table.table_no)}?`,
      subtitle: "This action uses the standard confirmation screen.",
      body: `<div class="danger-confirm"><div class="danger-confirm-icon"><i class="ph ph-trash"></i></div><h3>Remove this table from management?</h3><p>The QR will stop accepting new orders. Historical orders remain in the database, but their table reference may become empty.</p><div class="modal-form-note warning"><i class="ph ph-warning-circle"></i><span>If this table currently has an open dining session, finish that session first.</span></div></div>`,
      actions: [
        { label: "Keep table", icon: "ph-arrow-left", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Delete table", icon: "ph-trash", className: "btn-danger", onClick: async ({ close, button }) => {
          button.disabled = true;
          try { const { data: openSessions, error: sessionError } = await supabase.from("dining_sessions").select("id").eq("table_id", table.id).eq("restaurant_id", window.__ACTIVE_TENANT__.id).neq("status", "closed").limit(1); if (sessionError) throw sessionError; if (openSessions?.length) throw new Error("This table has an open dining session. Close that session before deleting the table."); const { error } = await supabase.from("tables").delete().eq("id", table.id).eq("restaurant_id", window.__ACTIVE_TENANT__.id); if (error) throw error; showToast("Table deleted", `Table ${table.table_no} was removed.`); close(); await reload(); } catch (error) { button.disabled = false; showToast("Could not delete table", error.message, "error"); }
        }}
      ]
    });
  }

  function openTableQR(table) {
    const baseUrl = getCustomerTableUrl(table.id);
    const url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "scan=true";
    
    const modal = openAppModal({
      title: `Table ${escapeHtml(table.table_no)} QR`,
      subtitle: "This QR always opens the live menu for this specific table.",
      body: `
        <div class="qr-preview-panel" style="position: relative;">
          <div class="qr-preview" id="table-qr" style="position: relative; display: inline-block;"></div>
          <div class="qr-table-title">Table ${escapeHtml(table.table_no)}</div>
          <div class="qr-url">${escapeHtml(url)}</div>

          <!-- Elegant Inline PIN Display -->
          <div style="margin: 20px auto 0; display: inline-flex; align-items: center; justify-content: center; gap: 12px; background: var(--cream-50); padding: 8px 16px 8px 20px; border-radius: 30px; border: 1px solid var(--line);">
            <div style="display: flex; flex-direction: column; align-items: flex-start; justify-content: center;">
                <span style="font-size: 10px; font-weight: 800; color: var(--forest-600); text-transform: uppercase; letter-spacing: 0.05em; line-height: 1; margin-bottom: 2px;">Today's PIN</span>
                <span id="display-table-pin" style="font-size: 18px; font-weight: 900; color: var(--forest-950); letter-spacing: 0.1em; line-height: 1;"><i class="ph ph-spinner-gap ph-spin" style="font-size: 14px;"></i></span>
            </div>
            <button id="regenerate-pin-btn" class="icon-btn icon-btn-quiet" title="Regenerate PIN" style="width: 32px; height: 32px; border-radius: 50%; background: #ffffff; border: 1px solid var(--line); box-shadow: 0 2px 4px rgba(0,0,0,0.02);">
                <i class="ph-bold ph-arrows-clockwise" style="font-size: 16px;"></i>
            </button>
          </div>

          <div class="qr-safety-note" style="margin-top: 16px;">
            <i class="ph ph-shield-check"></i>
            <span>Production QR · Opens only the customer menu for this table.</span>
          </div>
        </div>
      `,
      actions: [
        { label: "Close", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Download", icon: "ph-download-simple", className: "btn-quiet", onClick: () => { 
            showToast("Generating...", "Preparing high-res QR code.");
            const tempDiv = document.createElement("div");
            new QRCode(tempDiv, { text: url, width: 1024, height: 1024, correctLevel: QRCode.CorrectLevel.M });
            setTimeout(() => {
              const qrCanvas = tempDiv.querySelector("canvas");
              if (qrCanvas) {
                const padding = 120;
                const targetSize = qrCanvas.width + (padding * 2);
                const exportCanvas = document.createElement("canvas");
                exportCanvas.width = targetSize; exportCanvas.height = targetSize;
                const ctx = exportCanvas.getContext("2d");
                ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, targetSize, targetSize);
                ctx.drawImage(qrCanvas, padding, padding);
                const link = document.createElement("a"); link.download = `Table-${table.table_no}-QR.jpg`; link.href = exportCanvas.toDataURL("image/jpeg", 1.0); link.click();
                showToast("Downloaded", `Table ${table.table_no} high-res JPG saved.`);
              } else { showToast("Error", "Could not generate QR Code.", "error"); }
            }, 100);
          } 
        },
        { label: "Print QR", icon: "ph-printer", className: "btn-primary", onClick: ({ button }) => { 
            button.disabled = true; 
            const host = document.querySelector("#qr-print-host"); 
            const qr = modal.root.querySelector("#table-qr"); 
            const iconHtml = window.__ACTIVE_TENANT__?.icon_url ? `<img src="${versionedAsset(window.__ACTIVE_TENANT__.icon_url)}" alt="">` : '';
            host.innerHTML = `<section class="qr-print-sheet">${iconHtml}<h1>Table ${escapeHtml(table.table_no)}</h1><div class="qr-print-code">${qr.innerHTML}</div><p>Scan to view the menu & order</p></section>`; 
            document.body.classList.add("print-qr"); 
            window.print(); 
            setTimeout(() => { document.body.classList.remove("print-qr"); host.innerHTML = ""; button.disabled = false; }, 800); 
          } 
        }
      ]
    });

    setTimeout(async () => {
      // 1. Fetch the Live PIN from the Database
      try {
          const { data, error } = await supabase.rpc("get_table_daily_pin", { p_table_id: table.id });
          if (!error && data) {
             modal.root.querySelector("#display-table-pin").textContent = data;
          } else {
             modal.root.querySelector("#display-table-pin").textContent = "----";
          }
      } catch(e) {
          modal.root.querySelector("#display-table-pin").textContent = "ERR";
      }

      // 2. Render the QR with the Premium Branding Center Logo
      if (globalThis.QRCode) {
        const container = modal.root.querySelector("#table-qr");
        container.innerHTML = ""; 
        
        new QRCode(container, { 
            text: url, 
            width: 256, 
            height: 256, 
            correctLevel: QRCode.CorrectLevel.H // MUST be High for center logo to scan properly
        });

        const iconUrl = window.__ACTIVE_TENANT__?.icon_url;
        if (iconUrl) {
            const logoImg = document.createElement("img");
            logoImg.src = versionedAsset(iconUrl);
            
            // CRITICAL FIX: Use cssText with !important to completely block external stylesheets from stretching the image!
            logoImg.style.cssText = "position: absolute !important; top: 50% !important; left: 50% !important; transform: translate(-50%, -50%) !important; width: 48px !important; height: 48px !important; min-width: 48px !important; min-height: 48px !important; max-width: 48px !important; max-height: 48px !important; border-radius: 10px !important; border: 4px solid #ffffff !important; background-color: #ffffff !important; object-fit: cover !important; z-index: 20 !important; box-shadow: 0 4px 12px rgba(0,0,0,0.15) !important;";
            
            container.appendChild(logoImg);
        }
      }

      // 3. Handle Manual Regeneration (Increments the Salt)
      modal.root.querySelector("#regenerate-pin-btn").addEventListener("click", async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          const pinDisplay = modal.root.querySelector("#display-table-pin");
          pinDisplay.innerHTML = `<i class="ph ph-spinner-gap ph-spin" style="font-size: 20px;"></i>`;
          
          try {
              // Increment the salt in the database
              const newSalt = Math.floor(Math.random() * 100000);
              await supabase.from("tables").update({ pin_salt: newSalt }).eq("id", table.id);
              
              // Refetch the new mathematically generated PIN
              const { data, error } = await supabase.rpc("get_table_daily_pin", { p_table_id: table.id });
              if (!error && data) {
                 pinDisplay.textContent = data;
                 showToast("PIN Updated", "The table PIN was manually regenerated.");
              }
          } catch (err) {
              pinDisplay.textContent = "ERR";
          } finally {
              btn.disabled = false;
          }
      });

    }, 50);
  }

  function openProductDelete(product) {
    openAppModal({
      title: `Delete ${escapeHtml(product.name)}?`,
      subtitle: "This will permanently remove the dish from your active menu.",
      body: `<div class="danger-confirm"><div class="danger-confirm-icon"><i class="ph-bold ph-trash"></i></div><h3>Remove from menu?</h3><p>This action cannot be undone. Historical orders will still retain the item name on their receipts.</p></div>`,
      actions: [
        { label: "Cancel", icon: "ph-arrow-left", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Delete dish", icon: "ph-trash", className: "btn-danger", onClick: async ({ close, button }) => {
          button.disabled = true;
          try { 
            const { error } = await supabase.from("products").delete().eq("id", product.id).eq("restaurant_id", window.__ACTIVE_TENANT__.id); 
            if (error) throw error; 
            const storagePath = storagePathFromUrl(product.image_url);
            if (storagePath) await supabase.storage.from(DISH_IMAGE_BUCKET).remove([storagePath]);
            showToast("Dish deleted", `${product.name} was removed.`); 
            close(); 
            await reload(); 
          } catch (error) { button.disabled = false; showToast("Could not delete dish", error.message, "error"); }
        }}
      ]
    });
  }

  function openProductEditor(product = null) {
    const editing = Boolean(product);
    const currentImageUrl = product?.image_url ? versionedAsset(product.image_url) : "";
    const currentImageHtml = currentImageUrl ? `<div class="image-upload-preview" id="image-preview"><img src="${currentImageUrl}" alt="" /><div class="image-preview-copy"><strong>Current dish image</strong><span>Upload another image below to replace it.</span></div></div>` : `<div class="image-upload-preview empty" id="image-preview"><i class="ph ph-image"></i><div class="image-preview-copy"><strong>No dish image yet</strong><span>Add a clear food photograph for the customer menu.</span></div></div>`;

    const modal = openAppModal({
      title: editing ? "Edit dish" : "Add dish",
      subtitle: "Dish photos are automatically cropped to 4:3, optimized and stored as WebP.",
      body: `
        <form id="product-form" class="stack-form">
          <label class="field"><span>Dish name</span><input class="field-input" name="name" value="${escapeHtml(product?.name ?? "")}" required /></label>
          
          <!-- Native HTML Combobox Datalists (Tenant Isolated) -->
          <datalist id="cuisine-datalist">
            ${cuisines.map(c => `<option value="${escapeHtml(c.name)}">`).join("")}
          </datalist>
          <datalist id="subcat-datalist">
            ${[...new Set(products.map(p => { const parts = String(p.category || "").split(" - "); return parts.length > 1 ? parts.slice(1).join(" - ").trim() : null; }).filter(Boolean))].map(sub => `<option value="${escapeHtml(sub)}">`).join("")}
          </datalist>

          <div style="display: grid; grid-template-columns: 1.2fr 1.2fr 100px; gap: 10px;">
            <label class="field">
              <span>Category</span>
              <input class="field-input" list="cuisine-datalist" name="main_category" value="${escapeHtml(String(product?.category ?? "").split(" - ")[0]?.trim() ?? "")}" placeholder="e.g. Indian" required autocomplete="off" />
            </label>
            <label class="field">
              <span>Sub Category</span>
              <input class="field-input" list="subcat-datalist" name="sub_category" value="${escapeHtml(String(product?.category ?? "").split(" - ").slice(1).join(" - ")?.trim() ?? "")}" placeholder="e.g. Starter" required autocomplete="off" />
            </label>
            <label class="field">
              <span>Price (₹)</span>
              <input class="field-input" name="price" type="number" min="0" step="0.01" value="${Number(product?.price ?? 0)}" required />
            </label>
          </div>
          
          <label class="field"><span>Description</span><textarea class="field-input textarea-input" name="description" maxlength="240" placeholder="A short, appetising description for customers">${escapeHtml(product?.description ?? "")}</textarea></label>
          <div class="field">
            <span>Dish image</span>
            <label class="image-upload-zone" data-image-zone>
              <input id="product-image" name="product_image" type="file" accept="image/*" />
              <span class="image-upload-icon"><i class="ph ph-cloud-arrow-up"></i></span>
              <span class="image-upload-copy"><strong>Choose dish photo</strong><small>JPG, PNG, WebP, etc. · automatically converted to optimized 4:3 WebP</small></span>
              <span class="image-upload-arrow"><i class="ph ph-arrow-up-right"></i></span>
            </label>
            ${currentImageHtml}
            ${editing && product?.image_url ? `<label class="switch-field image-remove-switch"><input type="checkbox" name="remove_image" id="remove-image" /><span class="switch-ui"></span><span><strong>Remove current image</strong><small>The dish will remain available without a photo.</small></span></label>` : ""}
            <div class="image-upload-status" id="image-upload-status"><i class="ph ph-sparkle"></i><span>Best result: clear dish photo with the food near the centre.</span></div>
          </div>
          <div class="inline-switch-grid">
            <label class="switch-field"><input type="checkbox" name="is_active" ${product?.is_active ?? true ? "checked" : ""} /><span class="switch-ui"></span><span><strong>Visible</strong><small>Show this dish on the customer menu.</small></span></label>
            <label class="switch-field"><input type="checkbox" name="tax_exempt" ${product?.tax_exempt ? "checked" : ""} /><span class="switch-ui"></span><span><strong>Tax exempt</strong><small>Exclude it from GST calculations.</small></span></label>
            <label class="switch-field settings-wide"><input type="checkbox" name="is_veg" ${product?.is_veg ?? true ? "checked" : ""} /><span class="switch-ui"></span><span><strong>Vegetarian</strong><small>Toggle off for non-vegetarian dishes. Displays dietary symbol on menus.</small></span></label>
          </div>
        </form>
      `,
      actions: [
        { label: "Cancel", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: editing ? "Save changes" : "Create dish", icon: "ph-floppy-disk", className: "btn-primary", onClick: async ({ root, close, button }) => {
            const form = root.querySelector("#product-form");
            if (!form.reportValidity()) return;
            button.disabled = true;
            const statusNode = root.querySelector("#image-upload-status");
            const fileInput = root.querySelector("#product-image");
            const removeImage = root.querySelector("#remove-image");
            const selectedFile = fileInput?.files?.[0] ?? null;
            const shouldRemoveImage = Boolean(removeImage?.checked);
            if (selectedFile && shouldRemoveImage) removeImage.checked = false;
            const finalRemoveImage = Boolean(removeImage?.checked);
            const fd = new FormData(form);
            const productId = editing ? product.id : crypto.randomUUID();
            let newStoragePath = null;
            let previousStoragePath = storagePathFromUrl(product?.image_url);
            let finalImageUrl = product?.image_url ?? null;

            try {
              let optimizedFile = null;
              if (selectedFile) {
                statusNode.innerHTML = `<i class="ph ph-spinner-gap"></i><span>Optimizing image…</span>`;
                optimizedFile = await optimizeDishImage(selectedFile);
                // 🔒 STORAGE ISOLATION: Nests the image in a folder dedicated strictly to this restaurant
                newStoragePath = `${window.__ACTIVE_TENANT__.id}/products/${productId}/${crypto.randomUUID()}.webp`;
                finalImageUrl = getDishPublicUrl(newStoragePath);
              }

              if (finalRemoveImage && !selectedFile) { finalImageUrl = null; }

              const mainCat = String(fd.get("main_category") || "").trim();
              const subCat = String(fd.get("sub_category") || "").trim();
              
              // THE FIX: Ensure there is a space BEFORE and AFTER the hyphen so parsing works perfectly!
              const finalCategory = subCat ? `${mainCat} - ${subCat}` : mainCat;

              const payload = {
                id: productId,
                restaurant_id: window.__ACTIVE_TENANT__.id,
                name: String(fd.get("name") || "").trim(),
                category: finalCategory,
                price: Number(fd.get("price")),
                description: String(fd.get("description") || "").trim(),
                image_url: finalImageUrl,
                is_active: fd.get("is_active") === "on",
                tax_exempt: fd.get("tax_exempt") === "on",
                is_veg: fd.get("is_veg") === "on"
              };

              // 1. SAVE DATABASE ROW FIRST (Establishes ownership so the Bucket allows the upload)
              statusNode.innerHTML = `<i class="ph ph-floppy-disk"></i><span>Saving dish details…</span>`;
              const query = editing ? supabase.from("products").update(payload).eq("id", product.id) : supabase.from("products").insert(payload);
              const { error } = await query;
              if (error) throw error;

              // 2. UPLOAD IMAGE TO STORAGE SECOND (Now authorized by RLS)
              if (selectedFile && optimizedFile) {
                statusNode.innerHTML = `<i class="ph ph-cloud-arrow-up"></i><span>Uploading photo…</span>`;
                const { error: uploadError } = await supabase.storage.from(DISH_IMAGE_BUCKET).upload(newStoragePath, optimizedFile, { cacheControl: String(IMAGE_CACHE_SECONDS), contentType: "image/webp", upsert: false });
                if (uploadError) throw uploadError;
              }

              if (editing && previousStoragePath && (newStoragePath || finalRemoveImage)) {
                const { error: cleanupError } = await supabase.storage.from(DISH_IMAGE_BUCKET).remove([previousStoragePath]);
                if (cleanupError) console.warn("Old dish image cleanup failed:", cleanupError);
              }

              showToast(editing ? "Dish updated" : "Dish created", payload.name);
              close();
              await reload();
            } catch (error) {
              if (newStoragePath) {
                try { await supabase.storage.from(DISH_IMAGE_BUCKET).remove([newStoragePath]); } 
                catch (cleanupError) { console.warn("Failed to remove orphaned upload:", cleanupError); }
              }
              statusNode.innerHTML = `<i class="ph ph-warning-circle"></i><span>${escapeHtml(error.message)}</span>`;
              button.disabled = false;
              showToast("Could not save dish", error.message, "error");
            }
        }}
      ]
    });

    const fileInput = modal.root.querySelector("#product-image");
    const preview = modal.root.querySelector("#image-preview");
    const status = modal.root.querySelector("#image-upload-status");
    const removeImage = modal.root.querySelector("#remove-image");
    let previewUrl = null;

    fileInput?.addEventListener("change", event => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (file.size > MAX_SOURCE_IMAGE_BYTES) { fileInput.value = ""; showToast("Image too large", "Please choose an image smaller than 12 MB.", "error"); return; }
      if (!file.type.startsWith("image/")) { fileInput.value = ""; showToast("Invalid image", "Please select an image file.", "error"); return; }
      if (removeImage) removeImage.checked = false;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(file);
      preview.classList.remove("empty");
      preview.innerHTML = `<img src="${previewUrl}" alt="" /><div class="image-preview-copy"><strong>New image selected</strong><span>${escapeHtml(file.name)} · ${(file.size / 1024 / 1024).toFixed(2)} MB source</span></div>`;
      status.innerHTML = `<i class="ph ph-check-circle"></i><span>Ready. It will be cropped to 4:3 and converted to optimized WebP when saved.</span>`;
    });
  }

  // Listen for the custom inbox event triggered by navigation.js
  const adminAlertHandler = async () => {
    setTimeout(async () => {
       if (section === "overview") await reload();
    }, 400);
  };
  window.addEventListener("ff_admin_alert_received", adminAlertHandler);

  // --- LIVE MONITORING WEBSOCKET (STRICT TENANT ISOLATION) ---
  const tenantFilter = `restaurant_id=eq.${window.__ACTIVE_TENANT__.id}`;
  
  const realtimeChannel = supabase.channel(`admin-live-updates-${window.__ACTIVE_TENANT__.id}-${crypto.randomUUID()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: tenantFilter }, async payload => {
      if (payload.eventType === 'INSERT' && payload.new?.note === "Customer Self-Order") {
          const tableNo = window.__FF_TABLES__?.find(t => t.id === payload.new.table_id)?.table_no || "Unknown";
          if (window.setTableAlert) window.setTableAlert(payload.new.table_id, "new_order", "New Order Received");
          showToast("New Order", `Table ${tableNo} placed an order!`, "success");
          try { playDing(); } catch(e){} // AUDIO ALERT
      }
      
      if (section === "orders") renderOrders();
      else if (section === "overview" || section === "tables") await reload(); 
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'dining_sessions', filter: tenantFilter }, async payload => {
      const tableNo = window.__FF_TABLES__?.find(t => t.id === (payload.new?.table_id || payload.old?.table_id))?.table_no || "Unknown";

      if (payload.eventType === 'INSERT' && payload.new?.status === 'open') {
         if (window.setTableAlert) window.setTableAlert(payload.new.table_id, "new_session", "Table Opened");
         showToast("Table Opened", `Table ${tableNo} was just seated.`);
      }
      
      if (payload.eventType === 'UPDATE' && payload.new?.status === "bill_requested" && payload.old?.status !== "bill_requested") {
         if (window.setTableAlert) window.setTableAlert(payload.new.table_id, "bill_requested", "Bill Requested");
         showToast("Bill Requested", `Table ${tableNo} finalized their meal!`, "success");
         try { playDing(); playDing(); } catch(e){} // DOUBLE AUDIO ALERT FOR BILLS
         
         // If a bill is re-requested, we MUST remove it from seen_sessions so it flashes again!
         const updatedSessions = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_sessions") || "[]"));
         updatedSessions.delete(payload.new.id);
         localStorage.setItem("fourflavours.seen_sessions", JSON.stringify([...updatedSessions]));
         
         const ordersNavBtn = mount.querySelector('[data-section="orders"]');
         if (ordersNavBtn) {
           ordersNavBtn.style.color = "var(--gold-600)";
           ordersNavBtn.classList.remove("qty-pulse"); void ordersNavBtn.offsetWidth; ordersNavBtn.classList.add("qty-pulse");
         }
      } else if (payload.eventType === 'UPDATE' && payload.new?.status === "closed" && payload.old?.status !== "closed") {
         showToast("Table Closed", `Table ${tableNo} was finalized and is now free.`, "success");
      }
      
      // CRITICAL FIX: Force the UI to dynamically redraw the live floor the millisecond the status changes!
      if (section === "overview" || section === "tables" || section === "orders") {
          setTimeout(async () => await reload(), 150);
      }
    })
    .subscribe();

  renderSection();
  
  return () => {
    navCleanup?.();
    window.removeEventListener("ff_admin_alert_received", adminAlertHandler);
    if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  };
}

function metricCard(icon, value, label) {
  return `<article class="metric-card"><div class="metric-icon"><i class="ph ${icon}"></i></div><strong>${Number(value || 0)}</strong><span>${escapeHtml(label)}</span></article>`;
}