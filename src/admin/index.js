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
      const { data: rest } = await supabase.from("restaurants").select("*").eq("owner_id", user.id).maybeSingle();
      if (rest) {
          window.__ACTIVE_TENANT__ = rest;
      }
  }

  const activeTenantId = window.__ACTIVE_TENANT__?.id;

  const [settings, products, tables, sessions, cuisines] = await Promise.all([
    supabase.from("app_settings").select("*").eq("restaurant_id", activeTenantId).maybeSingle(),
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
  const tenantName = activeTenant.name || "RMS Cloud";

  mount.innerHTML = `
    <section class="admin-page">
      <header class="app-topbar admin-topbar">
        <div class="topbar-side topbar-left" style="gap: 12px;">
          <button class="icon-btn icon-btn-dark" id="admin-menu" title="Menu" aria-label="Menu" style="position: relative;">
            <i class="ph ph-list"></i>
            <span class="hamburger-dot" style="position: absolute; top: 4px; right: 4px; width: 8px; height: 8px; border-radius: 50%; background: #e11d48; display: none; border: 2px solid var(--paper);"></span>
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

  // APP-LIKE PULL-TO-REFRESH GESTURE (ADMIN WORKSPACE)
  const adminContent = mount.querySelector(".admin-content");
  if (adminContent) {
    let touchStartY = 0;
    adminContent.addEventListener("touchstart", e => {
      if (adminContent.scrollTop <= 0) touchStartY = e.touches[0].clientY;
    }, { passive: true });

    adminContent.addEventListener("touchend", e => {
      if (adminContent.scrollTop <= 0 && touchStartY > 0) {
        const touchEndY = e.changedTouches[0].clientY;
        if (touchEndY - touchStartY > 120) { // If dragged down more than 120px
          const refreshBtn = mount.querySelector("#admin-refresh");
          if (refreshBtn) refreshBtn.click(); // Triggers the soft-refresh loader securely!
        }
      }
      touchStartY = 0;
    }, { passive: true });
  }

  mount.querySelector("#admin-section-nav").addEventListener("click", event => {
    const b = event.target.closest("[data-section]");
    if (!b) return;
    section = b.dataset.section;
    
    // Clear notification highlight when the admin views the Orders tab
    if (section === "orders") {
      b.style.color = "";
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
        const orders = rawOrders.filter(o => 
            o.order_type === 'takeaway' || 
            (o.dining_sessions && ['closed', 'bill_requested', 'bill_ready'].includes(o.dining_sessions.status))
        );

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
            
            return `
            <article class="admin-order-data-row" style="${isNew ? 'border-color: var(--gold-400); background: var(--gold-100); box-shadow: 0 4px 16px rgba(201,164,90,0.2);' : ''}">
              <div class="order-cell-id" style="display: flex; align-items: center; gap: 8px;">
                <span style="${isNew ? 'color: var(--gold-600);' : ''}">Order #${escapeHtml(o.order_number)}</span>
                ${isNew ? `<span style="background: var(--gold-500); color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 800; text-transform: uppercase;">New Bill</span>` : ''}
              </div>
              <div class="order-cell-date">${orderDate.toLocaleString('en-IN', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'})}</div>
              <div class="order-cell-type">${o.order_type === 'dine_in' ? `Dine-in · Table ${tables.find(t => t.id === o.table_id)?.table_no || 'Unknown'}` : 'Takeaway'} · ${o.order_items.length} ${o.order_items.length === 1 ? 'item' : 'items'}</div>
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
              
              // 1. Mark as Seen in Orders List
              const updatedSeen = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_orders") || "[]"));
              updatedSeen.add(orderId);
              localStorage.setItem("fourflavours.seen_orders", JSON.stringify([...updatedSeen]));
              
              // 2. Mark Session as Seen to clear Dashboard alerts
              if (targetOrder?.session_id) {
                  const updatedSessions = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_sessions") || "[]"));
                  updatedSessions.add(targetOrder.session_id);
                  localStorage.setItem("fourflavours.seen_sessions", JSON.stringify([...updatedSessions]));
              }
              
              // 3. CROSS-SYNC: Instantly wipe the Global Alert
              const tId = targetOrder?.table_id || targetOrder?.dining_sessions?.table_id;
              if (tId && window.clearTableAlert) {
                  window.clearTableAlert(tId);
              }
              
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
      title: `Delete Order #${order.order_number}?`,
      subtitle: "This will permanently remove the bill and its items from the database.",
      body: `<div class="danger-confirm"><div class="danger-confirm-icon"><i class="ph ph-trash"></i></div><h3>Delete this record?</h3><p>This action cannot be undone.</p></div>`,
      actions: [
        { label: "Cancel", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Delete", icon: "ph-trash", className: "btn-danger", onClick: async ({ close, button }) => {
          button.disabled = true;
          try {
            // Call our custom PostgreSQL function to bypass RLS and handle sequence resets
            const { error } = await supabase.rpc("delete_pos_order", { p_order_id: order.id });
            if (error) throw error;
            
            showToast("Order deleted", `Order #${order.order_number} has been completely removed.`);
            close();
            renderOrders();
          } catch(err) {
            button.disabled = false;
            showToast("Error", err.message, "error");
          }
        }}
      ]
    });
  }

  function showAdminReceiptPreview(order) {
    let tableString = "Takeaway";
    if (order.order_type === "dine_in" && order.table_id) {
      const t = tables.find(x => x.id === order.table_id);
      if (t) tableString = `Dine-in · Table ${t.table_no}`;
    }
    const date = new Date(order.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    const receiptHTML = `
      <article class="thermal-receipt" id="thermal-receipt-content">
        <header class="thermal-head">
          ${window.__ACTIVE_TENANT__?.icon_url ? `<img class="thermal-logo" src="${versionedAsset(window.__ACTIVE_TENANT__.icon_url)}" alt="Logo">` : ''}
          <h1>${escapeHtml(settings.restaurant_name)}</h1>
          ${settings.restaurant_address ? `<p>${escapeHtml(settings.restaurant_address).replace(/\n/g, '<br>')}</p>` : ''}
          ${settings.gst_number ? `<p><strong>GSTIN:</strong> ${escapeHtml(settings.gst_number)}</p>` : ''}
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
            ${order.order_items.map(i => `
              <tr>
                <td style="text-align: left;">${escapeHtml(i.name_snapshot)}<br><small>${money(i.unit_price, settings.currency_symbol)}</small></td>
                <td style="text-align: center;">${i.quantity}</td>
                <td style="text-align: right;">${money(Number(i.unit_price) * Number(i.quantity), settings.currency_symbol)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        <div class="thermal-totals-wrap">
          <div class="thermal-line"><span>Subtotal</span><strong>${money(order.subtotal, settings.currency_symbol)}</strong></div>
          <div class="thermal-line"><span>CGST (${order.subtotal > 0 ? parseFloat(((order.cgst / order.subtotal) * 100).toFixed(2)) : (settings.cgst_rate || 0)}%)</span><strong>${money(order.cgst, settings.currency_symbol)}</strong></div>
          <div class="thermal-line"><span>SGST (${order.subtotal > 0 ? parseFloat(((order.sgst / order.subtotal) * 100).toFixed(2)) : (settings.sgst_rate || 0)}%)</span><strong>${money(order.sgst, settings.currency_symbol)}</strong></div>
          <div class="thermal-line"><span>Rounding</span><strong>${money(order.rounding, settings.currency_symbol)}</strong></div>
          <div class="thermal-line thermal-grand"><span>GRAND TOTAL</span><strong>${money(order.grand_total, settings.currency_symbol)}</strong></div>
        </div>
        ${settings.upi_id ? `
          <div class="thermal-payment-block">
            <div class="thermal-qr" id="admin-thermal-upi"></div>
            <div class="thermal-upi-note"><strong>Scan to pay</strong><br>Supported by all UPI apps</div>
          </div>
        ` : ""}
        <footer class="thermal-foot">
          <p>${escapeHtml(settings.receipt_footer || 'Thank you for dining with us!')}</p>
          <div class="thermal-software-tag">Powered by RMS Cloud</div>
        </footer>
      </article>
    `;

    const actionsList = [
        { label: "PDF", icon: "ph-bold ph-download-simple", className: "btn-quiet", style: "color: var(--forest-950); font-weight: 900;", onClick: async ({ root, button }) => {
            const element = root.querySelector("#thermal-receipt-content");
            button.disabled = true;
            const originalText = button.innerHTML;
            button.innerHTML = `<i class="ph ph-spinner-gap"></i><span>Saving...</span>`;
            try {
              if (!window.html2pdf) {
                await new Promise((resolve) => {
                  const script = document.createElement("script");
                  script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";
                  script.onload = resolve;
                  document.head.appendChild(script);
                });
              }
              
              // Temporarily remove shadow and margin so they don't push the PDF onto a second page
              const oldShadow = element.style.boxShadow;
              const oldMargin = element.style.margin;
              element.style.boxShadow = "none";
              element.style.margin = "0";
              
              // Use getBoundingClientRect for exact sub-pixel accuracy after stripping the margin
              const exactHeight = element.getBoundingClientRect().height;
              const heightInMM = (exactHeight * 0.264583) + 1; // Just 1mm buffer for absolute safety
              
              const opt = {
                margin: 0,
                filename: `${(settings.restaurant_name || 'Bill').replace(/\s+/g, '_')}_#${order.order_number}.pdf`,
                image: { type: 'jpeg', quality: 1 },
                html2canvas: { scale: 4, useCORS: true }, 
                jsPDF: { unit: 'mm', format: [80, heightInMM], orientation: 'portrait' }
              };
              
              await html2pdf().set(opt).from(element).save();
              
              // Restore UI styles instantly after generation
              element.style.boxShadow = oldShadow;
              element.style.margin = oldMargin;
            } catch (err) {
              console.error("PDF Generation failed:", err);
            } finally {
              button.disabled = false;
              button.innerHTML = originalText;
            }
        }},
        { label: "Print", icon: "ph-bold ph-printer", className: "btn-primary", style: "background: var(--forest-950); border-color: var(--forest-950); font-weight: 900;", onClick: () => {
            const host = document.querySelector("#receipt-print-host");
            if (host) { host.innerHTML = modal.root.querySelector("#thermal-receipt-content").outerHTML; window.print(); }
        }}
    ];

    // THE CLOSING LOOPHOLE FIX: If the bill is actively requested, let Admin mark it paid securely right here!
    if (order.dining_sessions && ['bill_requested', 'bill_ready'].includes(order.dining_sessions.status)) {
        actionsList.push({
             label: "Paid", 
             icon: "ph-bold ph-check-circle", 
             className: "btn-primary", 
             style: "background: var(--success); border-color: var(--success); font-weight: 900;",
             onClick: async ({ close, button }) => {
                 button.disabled = true;
                 const og = button.innerHTML;
                 button.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i> Processing...`;
                 try {
                     const { error } = await supabase.rpc("complete_session_payment", { p_session_id: order.session_id, p_payment_method: "cash" });
                     if (error) throw error;
                     showToast("Table Closed", `Payment recorded successfully.`, "success");
                     close();
                     reload();
                 } catch(err) {
                     showToast("Error", err.message, "error");
                     button.disabled = false;
                     button.innerHTML = og;
                 }
             }
        });
    }

    const modal = openAppModal({
      title: `Order #${order.order_number} Receipt`,
      subtitle: order.dining_sessions && ['bill_requested', 'bill_ready'].includes(order.dining_sessions.status) ? "Review the customer's tab and close the table to accept payment." : "Reprint, download, or view historical bill details.",
      body: `<div class="receipt-preview-container">${receiptHTML}</div>`,
      actions: actionsList
    });

    if (settings.upi_id && globalThis.QRCode) {
      setTimeout(() => {
        const qr = modal.root.querySelector("#admin-thermal-upi");
        if (qr) {
          qr.innerHTML = "";
          
          const pa = encodeURIComponent(settings.upi_id.trim());
          const pn = encodeURIComponent(settings.restaurant_name.trim());
          const am = Number(order.grand_total).toFixed(2);
          const tn = encodeURIComponent(`Order #${order.order_number}`);
          const upiString = `upi://pay?pa=${pa}&pn=${pn}&am=${am}&cu=INR&tn=${tn}`;
          
          new QRCode(qr, { text: upiString, width: 160, height: 160, correctLevel: QRCode.CorrectLevel.M });
        }
      }, 50);
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
        <div><span class="eyebrow">Control centre</span><h1>Everything in its place.</h1><p>Menu, tables, tax, UPI and table sessions in one restrained workspace.</p></div>
        <div class="admin-hero-mark">
          ${iconUrl 
            ? `<img src="${iconUrl}" alt="${escapeHtml(tenantName)}" style="width: 100%; height: 100%; object-fit: cover;">`
            : `<div style="width: 100%; height: 100%; display: grid; place-items: center; background: var(--sage-100); color: var(--forest-700); font-size: 32px;"><i class="ph-bold ph-storefront"></i></div>`
          }
        </div>
      </section>
      <section class="metric-grid">${metricCard("ph-fork-knife", activeProducts, "Active dishes")}${metricCard("ph-armchair", activeTables, "Active tables")}${metricCard("ph-bell", sessions.length, "Open sessions")}${metricCard("ph-receipt", billRequests, "Bill requests")}</section>
      <section class="admin-grid-two">
        <article class="admin-panel"><div class="panel-head"><div><span class="eyebrow">Quick actions</span><h2>Run the floor</h2></div></div><div class="quick-action-grid"><button class="quick-action" data-go="tables"><i class="ph ph-armchair"></i><span><strong>Manage tables</strong><small>Add, edit, delete and print QR codes.</small></span><i class="ph ph-arrow-right"></i></button><button class="quick-action" data-go="menu"><i class="ph ph-fork-knife"></i><span><strong>Manage menu</strong><small>Names, descriptions, prices and visibility.</small></span><i class="ph ph-arrow-right"></i></button><button class="quick-action" data-go="settings"><i class="ph ph-gear"></i><span><strong>Tax & UPI</strong><small>Keep server-side billing settings current.</small></span><i class="ph ph-arrow-right"></i></button></div></article>
        <article class="admin-panel"><div class="panel-head"><div><span class="eyebrow">Dining sessions</span><h2>Open tables</h2></div><button class="btn btn-quiet btn-small" id="clear-admin-alerts" style="padding: 0 10px;">Clear Alerts</button></div><div class="session-mini-scroll" id="overview-session-list">
          ${sessions.length ? sessions.map(s => {
            // Check if the Admin has already opened this specific bill
            const seenSessions = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_sessions") || "[]"));
            const tableAlert = window.__tableAlerts ? window.__tableAlerts[s.table_id] : null;
            // Suppress the DB alert if it has already been seen!
            const isBillReq = (s.status === 'bill_requested' && !seenSessions.has(s.id)) || tableAlert?.type === 'bill_requested';
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
              if (window.clearTableAlert) window.clearTableAlert(table.id);
              openAdminTableManager(table, session);
              renderOverview();
          }
      }

      if (viewBill) {
          const tableId = viewBill.dataset.viewBillOrder;
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
          if (window.clearGlobalNotification) window.clearGlobalNotification();
          window.__tableAlerts = {};
          
          const seenSessions = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_sessions") || "[]"));
          if (sessions && sessions.length) {
              sessions.forEach(s => { seenSessions.add(s.id); });
              localStorage.setItem("fourflavours.seen_sessions", JSON.stringify([...seenSessions]));
          }

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
      const tableAlert = window.__tableAlerts ? window.__tableAlerts[t.id] : null;
      // Suppress the DB alert if it has already been seen!
      const isBillReq = (openSession?.status === "bill_requested" && !seenSessions.has(openSession.id)) || tableAlert?.type === "bill_requested";
      const isNewGreen = !isBillReq && tableAlert && ["new_order", "added_items", "new_session"].includes(tableAlert.type);

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
            if (window.clearTableAlert) window.clearTableAlert(t.id);
            openAdminTableManager(t, s);
            renderTables(); // instantly clear the UI highlight behind modal
        }
      }
      
      if (viewBill) {
          const tableId = viewBill.dataset.viewBillOrder;
          if (window.clearTableAlert) window.clearTableAlert(tableId);
          window.__autoOpenOrderTableId = tableId;
          section = "orders";
          updateNavUI();
          renderSection();
      }
    });
  }

  async function openAdminTableManager(table, session) {
    const modal = openAppModal({
      title: `Table ${table.table_no} Management`,
      subtitle: "Review the active table tab, add items, or close the table.",
      body: `<div id="admin-table-manager-host" style="display: flex; flex-direction: column; min-height: 50vh;"><div class="empty-state"><i class="ph ph-spinner-gap ph-spin"></i><strong>Loading table data...</strong></div></div>`,
      actions: [] // Strip default actions to merge them into a unified sticky block
    });

    const host = modal.root.querySelector("#admin-table-manager-host");
    
    async function renderManager() {
      try {
        // FETCH ALL ORDERS: Aggregate every round the customer ordered into one Master Tab
        const { data: ordersList, error } = await supabase.from("orders").select("*, order_items(*)").eq("session_id", session.id).eq("restaurant_id", window.__ACTIVE_TENANT__.id).neq("status", "cancelled").order("created_at", { ascending: true });
        if (error) throw error;

        if (!ordersList || ordersList.length === 0) {
          host.innerHTML = `
            <div style="display: flex; flex-direction: column; flex: 1;">
              <div class="empty-state"><i class="ph ph-warning-circle"></i><strong>No active order found</strong><span>The table session was opened, but no items were sent to the kitchen.</span></div>
              <div style="position: sticky; bottom: -17px; background: var(--paper); padding: 12px 0 0 0; margin-top: auto; border-top: 1px solid var(--line); display: flex; gap: 8px;">
                <button class="btn btn-primary" id="admin-add-items" style="flex: 1;"><i class="ph-bold ph-plus"></i> Add Items</button> 
                <button class="btn btn-danger" id="force-close-empty" style="flex: 1;"><i class="ph-bold ph-power"></i> Close Table</button>
              </div>
            </div>`;
          
          host.querySelector("#force-close-empty").addEventListener("click", async () => {
             await supabase.from("dining_sessions").update({ status: 'closed' }).eq("id", session.id).eq("restaurant_id", window.__ACTIVE_TENANT__.id);
             modal.close();
             reload();
          });
          
          host.querySelector("#admin-add-items").addEventListener("click", () => {
             modal.close();
             window.__FOUR_FLAVOURS_POS_STATE__?.setOrderType('dine_in');
             window.__FOUR_FLAVOURS_POS_STATE__?.setTable(table);
             document.querySelector('[data-nav="pos"]')?.click();
          });
          return;
        }

        let tempMap = new Map();
        let grandTotal = 0, subtotal = 0, cgst = 0, sgst = 0, rounding = 0;
        let latestOrder = ordersList[ordersList.length - 1]; // We append new items to the latest round

        ordersList.forEach(o => {
          grandTotal += Number(o.grand_total || 0);
          subtotal += Number(o.subtotal || 0);
          cgst += Number(o.cgst || 0);
          sgst += Number(o.sgst || 0);
          rounding += Number(o.rounding || 0);
          
          // SORTING FIX: Force the items to sort by ID so Admin additions ALWAYS appear at the bottom!
          const items = o.order_items || [];
          items.sort((a, b) => a.id - b.id);
          
          items.forEach(oi => {
            const pId = oi.product_id;
            const qty = Number(oi.quantity);
            if (tempMap.has(pId)) {
               tempMap.get(pId).quantity += qty;
            } else {
               tempMap.set(pId, { id: pId, name: oi.name_snapshot, price: oi.unit_price, quantity: qty });
            }
          });
        });

        const displayItems = Array.from(tempMap.values());
        const isBillReq = session.status === "bill_requested";

        host.innerHTML = `
          <div class="active-dining-dashboard" style="text-align: left; display: flex; flex-direction: column; flex: 1;">
            <div class="dining-status-banner" style="${isBillReq ? 'background: var(--gold-100); color: var(--gold-600); border: 1px solid var(--gold-400);' : ''}">
              <i class="ph-bold ph-${isBillReq ? 'bell-ringing qty-pulse' : 'receipt'}"></i>
              <div>
                <strong style="${isBillReq ? 'color: var(--gold-600);' : ''}">${isBillReq ? 'Customer Requested Bill' : 'Table Tab is open'}</strong>
                <span>Grand Total: ${money(grandTotal, settings.currency_symbol)}</span>
              </div>
            </div>
            <h3 class="dining-section-title">Customer's Order Items</h3>
            <div class="dining-items-list" style="max-height: 45vh; overflow-y: auto; margin-bottom: 0; padding-bottom: 12px;">
              ${displayItems.map(i => `
                <div class="dining-item-row" style="padding-right: 12px; align-items: center;">
                  <div class="dining-item-info">
                    <strong>${escapeHtml(i.name)} <span class="qty-badge">x${i.quantity}</span></strong>
                    <span>${money(i.price, settings.currency_symbol)}</span>
                  </div>
                  <button class="btn-primary btn-sm admin-repeat-btn" data-id="${i.id}" data-name="${escapeHtml(i.name)}" data-price="${i.price}" style="padding: 4px 12px; font-size: 12px; border-radius: 6px;">
                    <i class="ph-bold ph-arrow-counter-clockwise"></i> Repeat
                  </button>
                </div>
              `).join("")}
            </div>
            
            <!-- STICKY FOOTER (Merged Actions & Dead Space Eliminated) -->
            <div style="position: sticky; bottom: -17px; background: var(--paper); padding: 12px 0 0 0; margin-top: auto; border-top: 1px solid var(--line); display: flex; gap: 8px;">
              <button class="btn btn-quiet" id="admin-add-items" style="flex: 1; padding: 0 4px; font-size: 12px;"><i class="ph-bold ph-plus"></i> Add Items</button>
              <button class="btn btn-quiet" id="admin-view-bill" style="flex: 1; padding: 0 4px; font-size: 12px;"><i class="ph-bold ph-printer"></i> Bill</button>
              <button class="btn btn-primary" id="admin-close-table" style="flex: 1.5; padding: 0 4px; font-size: 12px;"><i class="ph-bold ph-check-circle"></i> Close Table</button>
            </div>
          </div>
        `;

        // REPEAT BUTTON LOGIC
        host.querySelectorAll(".admin-repeat-btn").forEach(btn => {
          btn.addEventListener("click", async () => {
            window.__STAFF_MUTED_UNTIL = Date.now() + 3000;
            btn.disabled = true;
            btn.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i>`;
            try {
              // Intelligent Merge Sync: Fetch existing items to prevent wiping the bill
              const { data: existingItems } = await supabase.from("order_items").select("*").eq("order_id", latestOrder.id).eq("restaurant_id", window.__ACTIVE_TENANT__.id);
              const mergedMap = new Map();
              
              if (existingItems) {
                  existingItems.forEach(item => {
                      mergedMap.set(item.product_id, {
                          id: item.product_id, product_id: item.product_id,
                          name: item.name_snapshot, name_snapshot: item.name_snapshot,
                          price: item.unit_price, unit_price: item.unit_price, quantity: item.quantity
                      });
                  });
              }
              
              const pId = btn.dataset.id;
              if (mergedMap.has(pId)) {
                  mergedMap.get(pId).quantity += 1;
              } else {
                  mergedMap.set(pId, { 
                      id: pId, product_id: pId, 
                      name: btn.dataset.name, name_snapshot: btn.dataset.name, 
                      price: btn.dataset.price, unit_price: btn.dataset.price, quantity: 1 
                  });
              }
              
              const { error } = await supabase.rpc('sync_pos_order', { 
                  p_order_id: latestOrder.id, 
                  p_items: Array.from(mergedMap.values()) 
              });
              if (error) throw error;
              
              showToast("Item Repeated", `${btn.dataset.name} added to Table ${table.table_no}`);
              renderManager(); // Refresh Admin drawer instantly
            } catch (err) {
              showToast("Error", err.message, "error");
              btn.disabled = false;
              btn.innerHTML = `<i class="ph-bold ph-arrow-counter-clockwise"></i> Repeat`;
            }
          });
        });

        // QUICK ADD ITEMS LOGIC (BATCH DRAFT MODE)
        host.querySelector("#admin-add-items").addEventListener("click", () => {
           const allActiveProducts = products.filter(p => p.is_active);
           let draftAdditions = new Map(); // Local cart for the modal
           let currentFilteredList = allActiveProducts; // Keeps track of search state
           
           function renderAdminItemList(list) {
              if (!list || !list.length) return `<div class="empty-state compact"><i class="ph ph-magnifying-glass"></i><strong>No dishes found</strong></div>`;
              return list.map(p => {
                 const qty = draftAdditions.get(p.id)?.quantity || 0;
                 return `
                 <div style="display:flex; justify-content:space-between; align-items:center; padding: 14px 0; border-bottom: 1px solid var(--cream-200);">
                    <div style="display:flex; flex-direction:column; gap:4px;">
                       <strong style="font-size: 14px; color: var(--forest-950);">${escapeHtml(p.name)}</strong>
                       <span style="font-size:12.5px; color:var(--muted);">${money(p.price, settings.currency_symbol)}</span>
                    </div>
                    ${qty > 0 ? `
                        <div style="display: flex; align-items: center; justify-content: space-between; width: 96px; height: 36px; background: #ffffff; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.04); flex-shrink: 0;">
                           <button data-draft-dec="${p.id}" style="width: 34px; height: 100%; background: var(--forest-900); color: #fff; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.2s;"><i class="ph-bold ph-minus"></i></button>
                           <span style="flex: 1; text-align: center; font-size: 14px; font-weight: 800; color: var(--forest-950);">${qty}</span>
                           <button data-draft-inc="${p.id}" data-name="${escapeHtml(p.name)}" data-price="${p.price}" style="width: 34px; height: 100%; background: var(--forest-900); color: #fff; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.2s;"><i class="ph-bold ph-plus"></i></button>
                        </div>
                    ` : `
                        <button class="btn btn-quiet btn-small" data-draft-inc="${p.id}" data-name="${escapeHtml(p.name)}" data-price="${p.price}" style="border-radius: 12px; font-weight: 800; border-color: var(--line); color: var(--forest-900); padding: 0 16px; height: 36px;"><i class="ph-bold ph-plus"></i> Add</button>
                    `}
                 </div>
              `}).join("");
           }

           function updateUI() {
               host.querySelector("#admin-item-grid").innerHTML = renderAdminItemList(currentFilteredList);
               const totalItems = Array.from(draftAdditions.values()).reduce((sum, i) => sum + i.quantity, 0);
               const footer = host.querySelector("#admin-draft-footer");
               if (totalItems > 0) {
                   footer.style.display = "flex";
                   host.querySelector("#draft-count").textContent = totalItems;
               } else {
                   footer.style.display = "none";
               }
           }

           host.innerHTML = `
             <div class="admin-add-item-list" style="text-align: left; display: flex; flex-direction: column; min-height: 50vh;">
                
                <!-- NEW INLINE SEARCH BAR & BACK BUTTON -->
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-shrink: 0; width: 100%;">
                   <button class="icon-btn icon-btn-light" id="back-to-manager" style="flex-shrink: 0; width: 44px; height: 44px; border-radius: 14px; box-shadow: 0 2px 6px rgba(0,0,0,0.04);">
                     <i class="ph-bold ph-arrow-left" style="font-size: 18px;"></i>
                   </button>
                   
                   <div class="search-input-wrap" style="flex: 1; margin: 0; height: 44px; border-radius: 14px; background: #ffffff; border: 1px solid var(--line); box-shadow: inset 0 2px 4px rgba(0,0,0,0.02), 0 2px 6px rgba(0,0,0,0.02); transition: all 0.2s ease;" 
                        onfocusin="this.style.borderColor='var(--forest-500)'; this.style.boxShadow='0 0 0 3px rgba(76,110,75,0.12)';" 
                        onfocusout="this.style.borderColor='var(--line)'; this.style.boxShadow='inset 0 2px 4px rgba(0,0,0,0.02), 0 2px 6px rgba(0,0,0,0.02)';">
                     <i class="ph-bold ph-magnifying-glass" style="font-size: 18px; color: var(--forest-600);"></i>
                     <input type="text" id="admin-item-search" placeholder="Search menu to add..." style="width: 100%; border: none; background: transparent; outline: none; font-size: 15px; font-weight: 700; color: var(--forest-950);">
                   </div>
                </div>

                <div id="admin-item-grid" style="flex: 1; max-height: 40vh; overflow-y: auto; padding-right: 8px; margin-bottom: 8px;">
                  ${renderAdminItemList(allActiveProducts)}
                </div>
                
                <!-- STICKY FOOTER FOR BATCH ADDING -->
                <div id="admin-draft-footer" style="position: sticky; bottom: -17px; background: var(--paper); padding: 12px 0 0 0; margin-top: auto; border-top: 1px solid var(--line); display: none;">
                  <button class="btn btn-primary" id="confirm-draft-btn" style="width: 100%; height: 48px; border-radius: 14px; font-size: 15px;">
                    <i class="ph-bold ph-cooking-pot"></i> Send <span id="draft-count" style="margin: 0 4px;">0</span> Items to Kitchen
                  </button>
                </div>
             </div>
           `;
           
           host.querySelector("#back-to-manager").addEventListener("click", renderManager);
           
           host.querySelector("#admin-item-search").addEventListener("input", (e) => {
              const q = e.target.value.toLowerCase();
              currentFilteredList = allActiveProducts.filter(p => p.name.toLowerCase().includes(q));
              updateUI();
           });

           // Event Delegation for Qty Adjustments
           host.querySelector("#admin-item-grid").addEventListener("click", e => {
              const inc = e.target.closest("[data-draft-inc]");
              const dec = e.target.closest("[data-draft-dec]");
              
              if (inc) {
                  const id = inc.dataset.draftInc;
                  if (draftAdditions.has(id)) {
                      draftAdditions.get(id).quantity++;
                  } else {
                      draftAdditions.set(id, {
                          id: id, name: inc.dataset.name, price: inc.dataset.price, quantity: 1
                      });
                  }
                  updateUI();
              }
              
              if (dec) {
                  const id = dec.dataset.draftDec;
                  if (draftAdditions.has(id)) {
                      const item = draftAdditions.get(id);
                      item.quantity--;
                      if (item.quantity <= 0) draftAdditions.delete(id);
                      updateUI();
                  }
              }
           });

           // Batch Submit to Kitchen
           host.querySelector("#confirm-draft-btn").addEventListener("click", async (e) => {
              const btn = e.currentTarget;
              window.__STAFF_MUTED_UNTIL = Date.now() + 3000;
              btn.disabled = true;
              btn.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i> Processing...`;
              
              try {
                 // Intelligent Merge Sync
                 const { data: existingItems } = await supabase.from("order_items").select("*").eq("order_id", latestOrder.id).eq("restaurant_id", window.__ACTIVE_TENANT__.id);
                 const mergedMap = new Map();
                 
                 if (existingItems) {
                     existingItems.forEach(item => {
                         mergedMap.set(item.product_id, {
                             id: item.product_id, product_id: item.product_id,
                             name: item.name_snapshot, name_snapshot: item.name_snapshot,
                             price: item.unit_price, unit_price: item.unit_price, quantity: item.quantity
                         });
                     });
                 }
                 
                 draftAdditions.forEach(draft => {
                     if (mergedMap.has(draft.id)) {
                         mergedMap.get(draft.id).quantity += draft.quantity;
                     } else {
                         mergedMap.set(draft.id, { 
                             id: draft.id, product_id: draft.id, 
                             name: draft.name, name_snapshot: draft.name, 
                             price: draft.price, unit_price: draft.price, quantity: draft.quantity 
                         });
                     }
                 });
                 
                 const { error } = await supabase.rpc('sync_pos_order', { 
                     p_order_id: latestOrder.id, 
                     p_items: Array.from(mergedMap.values()) 
                 });
                 if (error) throw error;
                 
                 const totalItems = Array.from(draftAdditions.values()).reduce((sum, i) => sum + i.quantity, 0);
                 showToast("Items Added", `${totalItems} new items sent to Table ${table.table_no}`);
                 renderManager(); // Return to active dashboard
              } catch (err) {
                 showToast("Error", err.message, "error");
                 btn.disabled = false;
                 btn.innerHTML = `<i class="ph-bold ph-cooking-pot"></i> Send <span id="draft-count" style="margin: 0 4px;">${Array.from(draftAdditions.values()).reduce((sum, i) => sum + i.quantity, 0)}</span> Items to Kitchen`;
              }
           });
        });

        // VIEW FULL BILL LOGIC
        host.querySelector("#admin-view-bill").addEventListener("click", () => {
           showAdminReceiptPreview({
             ...latestOrder, 
             order_items: displayItems.map(i => ({ name_snapshot: i.name, unit_price: i.price, quantity: i.quantity })),
             subtotal, cgst, sgst, rounding, grand_total: grandTotal
           });
        });

        // CLOSE TABLE LOGIC
        host.querySelector("#admin-close-table").addEventListener("click", () => {
           openAppModal({
              title: `Close Table ${table.table_no}?`,
              subtitle: "This marks the session as paid and frees the table for the next customer.",
              body: `<div class="danger-confirm"><div class="danger-confirm-icon" style="background: var(--success-soft); color: var(--success);"><i class="ph-bold ph-check-circle"></i></div><h3>Payment Received?</h3><p>Ensure the customer has paid ${money(grandTotal, settings.currency_symbol)} before closing.</p></div>`,
              actions: [
                { label: "Cancel", className: "btn-quiet", onClick: (ctx) => ctx.close() },
                { label: "Yes, Close Table", className: "btn-primary", onClick: async (ctx) => {
                    ctx.button.disabled = true;
                    try {
                      const { error } = await supabase.rpc("complete_session_payment", { p_session_id: session.id, p_payment_method: "cash" });
                      if (error) throw error;
                      showToast("Table Closed", `Table ${table.table_no} is now available.`);
                      ctx.close();
                      modal.close();
                      reload();
                    } catch(err) {
                      ctx.button.disabled = false;
                      showToast("Error", err.message, "error");
                    }
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
    supabase.from("restaurants").select("*").maybeSingle().then(({ data: restData }) => {
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
            <label class="field"><span>UPI ID</span><input class="field-input" name="upi_id" value="${escapeHtml(settings.upi_id || "")}" placeholder="restaurant@upi"></label>
            <label class="field"><span>GSTIN (GST Number)</span><input class="field-input" name="gst_number" value="${escapeHtml(settings.gst_number || "")}" placeholder="22AAAAA0000A1Z5"></label>
            <label class="field settings-wide"><span>Restaurant Address (Prints on Bill)</span><textarea class="field-input textarea-input" name="restaurant_address" placeholder="123 Food Street, City, State" rows="2">${escapeHtml(settings.restaurant_address || "")}</textarea></label>
            <label class="field"><span>CGST %</span><input class="field-input" name="cgst_rate" type="number" min="0" max="100" step="0.01" value="${Number(settings.cgst_rate)}" required></label>
            <label class="field"><span>SGST %</span><input class="field-input" name="sgst_rate" type="number" min="0" max="100" step="0.01" value="${Number(settings.sgst_rate)}" required></label>
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
          upi_id: String(fd.get("upi_id") || "").trim(),
          gst_number: String(fd.get("gst_number") || "").trim(),
          restaurant_address: String(fd.get("restaurant_address") || "").trim(),
          cgst_rate: Number(fd.get("cgst_rate")), 
          sgst_rate: Number(fd.get("sgst_rate")), 
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
          
          document.title = `${payload.restaurant_name} | RMS`;

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
        <div class="qr-preview-panel">
          <div class="qr-preview" id="table-qr"></div>
          <div class="qr-table-title">Table ${escapeHtml(table.table_no)}</div>
          <div class="qr-url">${escapeHtml(url)}</div>
          <div class="qr-safety-note">
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

    setTimeout(() => {
      if (globalThis.QRCode) {
        const container = modal.root.querySelector("#table-qr");
        container.innerHTML = ""; 
        new QRCode(container, { text: url, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.M });
      }
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

  // MAGIC BINDING: Automatically finds the list on the current screen and applies physics
  function triggerPhysics() {
      setTimeout(() => {
          const list = mount.querySelector(".admin-list-scroll, .admin-table-scroll");
          if (list && !list.dataset.physicsAttached) {
              attachTactilePhysics(list);
              list.dataset.physicsAttached = "true";
          }
      }, 150);
  }

  // Intercept the bottom nav clicks to attach physics to the newly rendered pages
  mount.querySelector("#admin-section-nav").addEventListener("click", triggerPhysics);

  renderSection();
  triggerPhysics(); // Fire immediately on first load
  
  return () => {
    mount.querySelector("#admin-section-nav")?.removeEventListener("click", triggerPhysics);
    navCleanup?.();
    window.removeEventListener("ff_admin_alert_received", adminAlertHandler);
    if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  };
}

function metricCard(icon, value, label) {
  return `<article class="metric-card"><div class="metric-icon"><i class="ph ${icon}"></i></div><strong>${Number(value || 0)}</strong><span>${escapeHtml(label)}</span></article>`;
}

// ==========================================================================
// UNIVERSAL iOS TACTILE CARD SEPARATION PHYSICS ENGINE
// ==========================================================================
export function attachTactilePhysics(scroller, grid = scroller) {
    if (!scroller || !grid) return;
    let touchStartY = 0;
    let isAtBottom = false;

    scroller.addEventListener("touchstart", e => {
        const maxScroll = scroller.scrollHeight - scroller.clientHeight;
        isAtBottom = scroller.scrollTop >= maxScroll - 5;
        if (isAtBottom) {
            touchStartY = e.touches[0].clientY;
            Array.from(grid.children).forEach(child => child.style.transition = 'none');
        }
    }, { passive: true });

    scroller.addEventListener("touchmove", e => {
        if (!isAtBottom) return;
        const deltaY = touchStartY - e.touches[0].clientY; 
        if (deltaY > 0) {
            const children = Array.from(grid.children);
            const total = children.length;
            children.forEach((child, index) => {
                const factor = Math.pow((index + 1) / total, 1.5); 
                const stretch = deltaY * factor * 0.45;
                child.style.transform = `translateY(-${stretch}px)`;
            });
        }
    }, { passive: true });

    scroller.addEventListener("touchend", () => {
        if (isAtBottom) {
            Array.from(grid.children).forEach(child => {
                child.style.transition = 'transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)';
                child.style.transform = 'translateY(0px)';
            });
            setTimeout(() => {
                Array.from(grid.children).forEach(child => {
                    child.style.transition = '';
                    child.style.transform = '';
                });
            }, 600);
            isAtBottom = false;
        }
    }, { passive: true });
}