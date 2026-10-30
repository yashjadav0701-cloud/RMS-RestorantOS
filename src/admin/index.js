import { supabase } from "../core/supabase.js";
import { requestPanelSignOut } from "../core/panelSession.js";
import { createPresetRange, renderDateRangePicker, bindDateRangePicker, DATE_RANGE_STYLES, indiaDateStartISOString, indiaDateAfterISOString, dateRangeLabel } from "../components/dateRangePicker.js";
import {
  DEFAULT_SETTINGS,
  versionedAsset,
  getCustomerTableUrl
} from "../core/config.js";
import {
  escapeHtml,
  money,
  mountNavigation,
  openAppModal,
  showToast,
  openUniversalReceipt
} from "../components/navigation.js";

const DISH_IMAGE_BUCKET = "dish-images";
const MAX_SOURCE_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_FINAL_IMAGE_BYTES = 2 * 1024 * 1024;
const TARGET_IMAGE_BYTES = 350 * 1024;
const IMAGE_CACHE_SECONDS = 31536000;

// Temporary frontend inventory drafts, isolated by active restaurant.
// These are NOT persistent database records.
let inventoryDraftTenantId = null;
let ingredientDrafts = [];
let productRecipeDrafts = new Map();
let inventoryMovementDrafts = [];
let inventoryModeDraft = "disabled";

// Ingredient categories are tenant-scoped values loaded from the database by
// get_inventory_dashboard(). There is intentionally no hard-coded category list:
// every category already assigned to an ingredient becomes a suggestion.
function normalizeIngredientCategory(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-IN")
    .replace(/(^|[\s-])([a-z])/g, (_, separator, letter) =>
      separator + letter.toLocaleUpperCase("en-IN")
    );
}

function getDatabaseIngredientCategories(currentValue = "") {
  const categories = new Map();
  for (const ingredient of ingredientDrafts) {
    const rawCategory = String(ingredient?.category ?? "").trim();
    if (!rawCategory) continue;
    const category = normalizeIngredientCategory(rawCategory);
    if (category) categories.set(category.toLocaleLowerCase("en-IN"), category);
  }

  // Keep a legacy/current category available even if it was renamed elsewhere
  // while this modal was open; saving still normalizes it to Title Case.
  const current = normalizeIngredientCategory(currentValue);
  if (current) categories.set(current.toLocaleLowerCase("en-IN"), current);

  return [...categories.values()].sort((a, b) =>
    a.localeCompare(b, "en-IN", { sensitivity: "base" })
  );
}

function renderDatabaseIngredientCategoryOptions(listId, currentValue = "") {
  return getDatabaseIngredientCategories(currentValue)
    .map(category => `<button type="button" class="inventory-category-option" role="option" data-category-option="${escapeHtml(category)}">${escapeHtml(category)}</button>`)
    .join("");
}

function bindInventoryCategoryCombobox(root) {
  root?.querySelectorAll("[data-category-combobox]").forEach(combobox => {
    const input = combobox.querySelector("[data-category-input]");
    const toggle = combobox.querySelector("[data-category-toggle]");
    const menu = combobox.querySelector("[data-category-options]");
    if (!input || !toggle || !menu || combobox.dataset.categoryBound === "true") return;
    combobox.dataset.categoryBound = "true";

    let activeIndex = -1;
    const close = () => {
      menu.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      activeIndex = -1;
    };

    const choose = value => {
      input.value = normalizeIngredientCategory(value);
      close();
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const render = (showAll = false) => {
      const query = input.value.trim().toLocaleLowerCase("en-IN");
      const categories = getDatabaseIngredientCategories(input.value)
        .filter(category => showAll || !query ||
          category.toLocaleLowerCase("en-IN").includes(query));
      menu.innerHTML = categories.length
        ? categories.map((category, index) =>
            `<button type="button" role="option" aria-selected="false" id="${combobox.id || "ingredient-category"}-option-${index}" class="inventory-category-option" data-category-option="${escapeHtml(category)}">${escapeHtml(category)}</button>`
          ).join("")
        : `<div class="inventory-category-empty">No matching category. Press Enter to use “${escapeHtml(normalizeIngredientCategory(input.value))}”.</div>`;
      menu.hidden = false;
      input.setAttribute("aria-expanded", "true");
      activeIndex = -1;
    };

    input.addEventListener("focus", () => render(true));
    input.addEventListener("input", () => render(false));
    toggle.addEventListener("click", () => {
      if (menu.hidden) {
        input.focus();
        render(true);
      } else close();
    });

    menu.addEventListener("mousedown", event => {
      const option = event.target.closest("[data-category-option]");
      if (option) {
        event.preventDefault();
        choose(option.dataset.categoryOption);
      }
    });

    input.addEventListener("keydown", event => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (menu.hidden) render(true);
        const options = [...menu.querySelectorAll("[data-category-option]")];
        if (options.length) {
          activeIndex = (activeIndex + 1) % options.length;
          options.forEach((option, index) => {
            option.setAttribute("aria-selected", String(index === activeIndex));
          });
          options[activeIndex]?.scrollIntoView({ block: "nearest" });
        }
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const options = [...menu.querySelectorAll("[data-category-option]")];
        if (options.length) {
          activeIndex = (activeIndex - 1 + options.length) % options.length;
          options.forEach((option, index) => {
            option.setAttribute("aria-selected", String(index === activeIndex));
          });
          options[activeIndex]?.scrollIntoView({ block: "nearest" });
        }
      } else if (event.key === "Enter" && !menu.hidden) {
        const active = menu.querySelector('[aria-selected="true"][data-category-option]');
        if (active) {
          event.preventDefault();
          choose(active.dataset.categoryOption);
        } else {
          close();
          input.value = normalizeIngredientCategory(input.value);
        }
      } else if (event.key === "Escape") {
        close();
      }
    });

    input.addEventListener("blur", () => {
      input.value = normalizeIngredientCategory(input.value);
      window.setTimeout(close, 120);
    });
  });
}

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

export async function render({ mount, route }) {
  // PIN verification is handled once by the router's panelPinScreen. Re-prompting
  // here used the legacy rms_verify_pin_v2 flow and could reject otherwise valid
  // access, especially after the master migration retired the legacy PIN setter.
  // Only mount Admin when the server-issued, short-lived Admin grant is present.
  const access = window.__RMS_PANEL_ACCESS__;
  const hasValidAdminGrant =
    access?.panelId === "admin" &&
    typeof access.token === "string" &&
    access.token.length >= 20 &&
    Number.isFinite(access.expiresAt) &&
    access.expiresAt > Date.now();

  if (route?.panelId === "manager") {
    return renderAdminWorkspace(mount, { managerMode: true });
  }

  if (!hasValidAdminGrant) {
    // Fail closed if a grant expires between the router check and this render.
    history.replaceState({}, "", `${location.pathname}${location.search}#/panel/admin`);
    window.dispatchEvent(new Event("rms:navigate"));
    return () => {};
  }

  const cleanup = await renderAdminWorkspace(mount);
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

  const panelAccess = window.__RMS_PANEL_ACCESS__;
  const settingsRpc = panelAccess?.panelId === "admin" ? "get_admin_settings" : "get_operational_settings";
  const [settings, products, tables, sessions, cuisines] = await Promise.all([
    supabase.rpc(settingsRpc, { p_panel_token: panelAccess?.token || null }),
    supabase.from("products").select("*").eq("restaurant_id", activeTenantId).order("sort_order", { ascending: true }).order("name", { ascending: true }),
    supabase.from("tables").select("id, table_no, capacity, is_active, created_at, updated_at, restaurant_id").eq("restaurant_id", activeTenantId).order("table_no", { ascending: true }),
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

async function renderAdminWorkspace(
  mount,
  { managerMode = false } = {}
) {
  const currentTenantId = window.__ACTIVE_TENANT__?.id ?? null;

  if (inventoryDraftTenantId !== currentTenantId) {
    inventoryDraftTenantId = currentTenantId;
    ingredientDrafts = [];
    productRecipeDrafts = new Map();
    inventoryMovementDrafts = [];
    inventoryModeDraft = "disabled";
  }
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
      inactivityTimer = setTimeout(() => {
          // Lock the PIN-protected workspace without signing out the shared
          // restaurant account. Staff can choose their panel and re-enter its PIN.
          requestPanelSignOut({ confirmExit: false });
      }, 15 * 60 * 1000); // 15 mins
  };
  ['touchstart', 'mousemove', 'keydown'].forEach(e => document.addEventListener(e, resetLock, { passive: true }));
  resetLock();

  // 3. NETWORK DROP RESILIENCE: Alerts staff immediately if the WiFi dies
  window.addEventListener('offline', () => showToast("Network Offline", "Live sync paused. Check your router.", "error"));
  window.addEventListener('online', () => showToast("Network Restored", "Live sync is back online.", "success"));

  let { settings, products, tables, sessions, cuisines } = await fetchWorkspace();

  async function reloadInventoryDrafts() {
    if (managerMode) return;
    const access = window.__RMS_PANEL_ACCESS__;
    if (access?.panelId !== "admin" || !access?.token || access.expiresAt <= Date.now()) return;
    const [dashboardResult, setupResult] = await Promise.all([
      supabase.rpc("get_inventory_dashboard", { p_panel_token: access.token }),
      supabase.rpc("get_inventory_setup_status", { p_panel_token: access.token })
    ]);
    if (dashboardResult.error) throw dashboardResult.error;
    const result = Array.isArray(dashboardResult.data) ? dashboardResult.data[0] : dashboardResult.data;
    const setup = Array.isArray(setupResult.data) ? setupResult.data[0] : setupResult.data;
    inventoryModeDraft = setupResult.error ? "disabled" : (setup?.inventoryMode || "disabled");
    ingredientDrafts = (result?.ingredients || []).map(item => ({
      id: item.id,
      name: item.name,
      category: item.category || "other",
      baseUnit: item.baseUnit,
      reorderLevel: Number(item.reorderLevel || 0),
      costPerUnit: item.costPerUnit == null ? null : Number(item.costPerUnit),
      currentStock: Number(item.currentStock || 0)
    }));
    inventoryMovementDrafts = (result?.movements || []).map(item => ({
      id: item.id,
      ingredientId: item.ingredientId,
      movementType: item.movementType,
      label: item.label,
      quantityDelta: Number(item.quantityDelta || 0),
      unit: item.unit,
      reason: item.reason,
      createdAt: Number(item.createdAt || 0)
    }));
    productRecipeDrafts = new Map();
    for (const recipe of result?.recipes || []) {
      const rows = productRecipeDrafts.get(recipe.product_id) || [];
      rows.push({
        ingredient_id: recipe.ingredient_id,
        quantity_per_serving: String(recipe.quantity_per_serving),
        is_estimate: recipe.is_estimate !== false,
        source_note: recipe.source_note || ""
      });
      productRecipeDrafts.set(recipe.product_id, rows);
    }
  }

  if (!managerMode) {
    try { await reloadInventoryDrafts(); }
    catch (error) { console.error("Inventory data could not be loaded:", error); }
  }

  window.__FF_TABLES__ = tables;
  let section = "overview";
  let sectionTransitionPending = false;
  let sectionTransitionTimer = null;
  const lazyAdminSections = new Set(["top-products", "ingredient-usage", "activity-audit"]);
  let orderDateRange = createPresetRange("today");
  let revenueDateRange = createPresetRange("7");
  let productAnalyticsDateRange = createPresetRange("7");

  // 1. Fetch dynamic tenant branding safely
  const activeTenant = window.__ACTIVE_TENANT__ || {};
  const logoUrl = activeTenant.logo_url ? versionedAsset(activeTenant.logo_url) : null;
  const iconUrl = activeTenant.icon_url ? versionedAsset(activeTenant.icon_url) : null;
  const tenantName = activeTenant.name || "Table Forge";

  mount.innerHTML = `
    <section class="admin-page">
      <header class="app-topbar admin-topbar">
        <div class="topbar-side topbar-left" style="gap: 12px;">
          ${managerMode ? `
            <button class="icon-btn icon-btn-dark" id="manager-workspaces" title="Return to workspaces" aria-label="Return to workspaces">
              <i class="ph-bold ph-arrow-left"></i>
            </button>
          ` : `
            <button class="icon-btn icon-btn-dark" id="admin-menu" title="Menu" aria-label="Menu" style="position: relative;">
              <i class="ph ph-list"></i>
              <span class="hamburger-dot" style="display: none;"></span>
            </button>
          `}
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
          <button class="btn btn-quiet" id="admin-logout" title="Sign out of Admin workspace" aria-label="Sign out of Admin workspace" style="display:inline-flex;align-items:center;gap:7px;background:#fff;color:var(--forest-900);border:1px solid var(--line);border-radius:12px;margin-left:8px;min-height:38px;padding:0 12px;font-size:12px;font-weight:850;white-space:nowrap;"><i class="ph-bold ph-sign-out"></i><span>Sign out</span></button>
        </div>
      </header>

      <nav class="admin-section-nav" id="admin-section-nav" aria-label="Management sections">
        <button data-section="overview" class="active"><i class="ph ph-fill ph-squares-four"></i><span>${managerMode ? "Operations" : "Overview"}</span></button>
        <button data-section="orders"><i class="ph ph-bold ph-receipt"></i><span>Orders</span></button>

        ${managerMode ? "" : `
          <button data-section="revenue"><i class="ph ph-bold ph-chart-line-up"></i><span>Revenue</span></button>
          <button data-section="products"><i class="ph ph-bold ph-chart-bar"></i><span>Products</span></button>
          <button data-section="top-products"><i class="ph ph-bold ph-trophy"></i><span>Top Products</span></button>
          <button data-section="ingredient-usage"><i class="ph ph-bold ph-chart-pie-slice"></i><span>Ingredient Usage</span></button>
          <button data-section="activity-audit"><i class="ph ph-bold ph-shield-check"></i><span>Activity & Audit</span></button>
          <button data-section="cuisines"><i class="ph ph-bold ph-image"></i><span>Cuisines</span></button>
          <button data-section="menu"><i class="ph ph-bold ph-fork-knife"></i><span>Menu</span></button>
          <button data-section="inventory"><i class="ph ph-bold ph-package"></i><span>Inventory</span></button>
        `}

        <button data-section="tables"><i class="ph ph-bold ph-armchair"></i><span>Tables</span></button>

        ${managerMode ? "" : `
          <button data-section="settings"><i class="ph ph-bold ph-gear"></i><span>Settings</span></button>
        `}
      </nav>
      <main class="admin-content">
        <div class="admin-section-loader" id="admin-section-loader" role="status" aria-live="polite" hidden>
          <span><i class="ph-bold ph-spinner-gap ph-spin" aria-hidden="true"></i>Loading section…</span>
        </div>
        <section id="admin-area"></section>
      </main>
    </section>`;

  const navCleanup = managerMode
    ? null
    : mountNavigation({ active: "admin" });
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
    const nav = mount.querySelector("#admin-section-nav");

    nav?.querySelectorAll("[data-section]").forEach(el => {
      const isActive = el.dataset.section === section;
      el.classList.toggle("active", isActive);

      const icon = el.querySelector("i");

      if (icon) {
        if (isActive) {
          icon.className = icon.className.replace("ph-bold", "ph-fill");
        } else {
          icon.className = icon.className.replace("ph-fill", "ph-bold");
        }
      }
    });

    // Keep the selected pill visible without scrolling the whole page.
    const activeButton = nav?.querySelector("button.active");

    if (nav && activeButton) {
      const navRect = nav.getBoundingClientRect();
      const buttonRect = activeButton.getBoundingClientRect();

      const buttonLeft =
        buttonRect.left - navRect.left + nav.scrollLeft;

      const targetLeft =
        buttonLeft - (nav.clientWidth - activeButton.offsetWidth) / 2;

      nav.scrollTo({
        left: Math.max(0, targetLeft),
        behavior: "auto"
      });
    }

    evaluateGlobalAlerts();
  }

  function finishAdminSectionTransition(targetSection) {
    if (!sectionTransitionPending || section !== targetSection) return;
    if (sectionTransitionTimer !== null) {
      clearTimeout(sectionTransitionTimer);
      sectionTransitionTimer = null;
    }

    const nav = mount.querySelector("#admin-section-nav");
    const loader = mount.querySelector("#admin-section-loader");
    area.inert = false;
    area.classList.remove("admin-area-exit", "admin-tab-content");
    requestAnimationFrame(() => {
      if (section !== targetSection) return;
      area.classList.add("admin-tab-content");
      if (loader) loader.hidden = true;
      nav?.removeAttribute("aria-busy");
      nav?.querySelectorAll("[data-section]").forEach(button => { button.disabled = false; });
      sectionTransitionPending = false;
    });
  }

  function transitionToSection(nextSection, sourceButton = null) {
    if (!nextSection || nextSection === section || sectionTransitionPending) return;
    const nav = mount.querySelector("#admin-section-nav");
    const validTarget = nav?.querySelector(`[data-section="${nextSection}"]`);
    if (!validTarget) return;
    if (managerMode && !["overview", "orders", "tables"].includes(nextSection)) return;

    sectionTransitionPending = true;
    const loader = mount.querySelector("#admin-section-loader");
    if (loader) loader.hidden = false;
    nav?.setAttribute("aria-busy", "true");
    nav?.querySelectorAll("[data-section]").forEach(button => { button.disabled = true; });
    area.inert = true;
    area.classList.remove("admin-tab-content");
    area.classList.add("admin-area-exit");

    // The selected tab responds immediately; allow a short exit frame before
    // rendering its new section. Rapid taps are ignored while one switch is active.
    section = nextSection;
    if (["orders", "overview", "tables"].includes(nextSection)) {
      if (sourceButton) {
        sourceButton.style.color = "";
        sourceButton.classList.remove("qty-pulse");
      }
      window.__tableAlerts = {};
      if (window.clearGlobalNotification) window.clearGlobalNotification();
    }
    updateNavUI();

    sectionTransitionTimer = window.setTimeout(() => {
      sectionTransitionTimer = null;
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      const adminContent = mount.querySelector(".admin-content");
      if (adminContent) adminContent.scrollTop = 0;
      try {
        renderSection();
      } catch (error) {
        console.error(`Admin section failed to render (${nextSection}):`, error);
        area.innerHTML = `<section class="section-title-row"><div><h1>Could not open this section</h1><p>Please retry. ${escapeHtml(error?.message || "Unexpected rendering error.")}</p></div></section>`;
        finishAdminSectionTransition(nextSection);
        return;
      }

      if (lazyAdminSections.has(nextSection) && !managerMode) return;
      requestAnimationFrame(() => requestAnimationFrame(() => finishAdminSectionTransition(nextSection)));
    }, 70);
  }

  if (managerMode) {
    mount.querySelector("#manager-workspaces")?.addEventListener("click", () => {
      window.__RMS_PANEL_ACCESS__ = null;

      history.pushState(
        {},
        "",
        `${location.pathname}${location.search}#/panels`
      );

      window.dispatchEvent(new Event("rms:navigate"));
    });
  } else {
    mount.querySelector("#admin-menu")?.addEventListener(
      "click",
      () => window.__FOUR_FLAVOURS_NAV__?.open()
    );
  }

  // Panel sign-out clears the six-digit PIN grant but keeps the shared restaurant
  // account session alive. Account sign-out remains on the workspace chooser.
  mount.querySelector("#admin-logout")?.addEventListener("click", () => {
    requestPanelSignOut({ confirmExit: true });
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
    const button = event.target.closest("[data-section]");
    if (!button || button.disabled) return;
    transitionToSection(button.dataset.section, button);
  });

  async function reload() {
    ({ settings, products, tables, sessions, cuisines } = await fetchWorkspace());
    if (!managerMode) await reloadInventoryDrafts();
    window.__FF_TABLES__ = tables;
    evaluateGlobalAlerts();
    renderSection();
  }

  function renderSection() {
    const managerAllowedSections = new Set([
      "overview",
      "orders",
      "tables"
    ]);

    if (managerMode && !managerAllowedSections.has(section)) {
      section = "overview";
    }

    if (section === "overview") renderOverview();
    if (section === "orders") renderOrders();
    if (!managerMode && section === "revenue") renderRevenueDashboard();
    if (!managerMode && section === "products") renderProductDashboard();

    if (!managerMode && section === "top-products") {
      import("./topProducts.js")
        .then(({ renderTopProductsDashboard }) => {
          if (!managerMode && section === "top-products") {
            renderTopProductsDashboard(area);
            finishAdminSectionTransition("top-products");
          }
        })
        .catch(error => {
          console.error("Top Products dashboard failed to load:", error);
          area.innerHTML = `
            <section class="section-title-row">
              <div>
                <h1>Top Products</h1>
                <p>The dashboard could not be loaded. Please try again.</p>
              </div>
            </section>
          `;
          finishAdminSectionTransition("top-products");
        });
    }

    if (!managerMode && section === "ingredient-usage") {
      import("./ingredientUsage.js")
        .then(({ renderIngredientUsageDashboard }) => {
          if (!managerMode && section === "ingredient-usage") {
            renderIngredientUsageDashboard(area);
            finishAdminSectionTransition("ingredient-usage");
          }
        })
        .catch(error => {
          console.error("Ingredient Usage dashboard failed to load:", error);
          area.innerHTML = `
            <section class="section-title-row">
              <div>
                <h1>Ingredient Usage</h1>
                <p>The dashboard could not be loaded. Please try again.</p>
              </div>
            </section>
          `;
          finishAdminSectionTransition("ingredient-usage");
        });
    }

    if (!managerMode && section === "activity-audit") {
      import("./auditDashboard.js")
        .then(({ renderAuditDashboard }) => {
          if (!managerMode && section === "activity-audit") {
            renderAuditDashboard(area);
            finishAdminSectionTransition("activity-audit");
          }
        })
        .catch(error => {
          console.error("Activity & Audit dashboard failed to load:", error);
          area.innerHTML = `
            <section class="section-title-row">
              <div>
                <h1>Activity & Audit</h1>
                <p>The dashboard could not be loaded. Please try again.</p>
              </div>
            </section>
          `;
          finishAdminSectionTransition("activity-audit");
        });
    }

    if (!managerMode && section === "cuisines") renderCuisines();
    if (!managerMode && section === "menu") renderMenu();
    if (!managerMode && section === "inventory") renderInventory();
    if (section === "tables") renderTables();
    if (!managerMode && section === "settings") renderSettings();
  }

  function renderProductDashboard() {
    const currentRange = productAnalyticsDateRange;
    const periodArgs = () => currentRange.preset === "all" ? { p_period_start: null, p_period_end: null } : {
      p_period_start: indiaDateStartISOString(currentRange.startDate),
      p_period_end: indiaDateAfterISOString(currentRange.endDate)
    };
    const esc = value => escapeHtml(String(value ?? ""));
    const count = value => Number(value || 0).toLocaleString("en-IN");
    area.innerHTML = `
      <style>
        ${DATE_RANGE_STYLES}
        .product-analytics{display:grid;gap:18px}.product-analytics-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
        .product-analytics-card{min-width:0;padding:16px;border:1px solid var(--line);border-radius:15px;background:var(--paper)}.product-analytics-icon{display:grid;place-items:center;width:36px;height:36px;margin-bottom:13px;border-radius:11px;background:var(--sage-100);color:var(--forest-900);font-size:19px}.product-analytics-value{display:block;margin-bottom:5px;font-size:23px;font-weight:850;color:var(--forest-950);overflow-wrap:anywhere}.product-analytics-label{display:block;color:var(--muted);font-size:12px;line-height:1.5}
        .product-analytics-grid-two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.product-analytics-panel{min-width:0;padding:19px;border:1px solid var(--line);border-radius:16px;background:var(--paper)}.product-analytics-panel h2{margin:0 0 6px;font-size:16px}.product-analytics-panel>p{margin:0;color:var(--muted);font-size:12px;line-height:1.6}.product-analytics-note{padding:13px 15px;border:1px solid var(--line);border-radius:12px;background:var(--cream-100);color:var(--muted);font-size:12px;line-height:1.6}
        .tf-analytics-list{display:grid;gap:12px;margin-top:15px}.tf-analytics-row{display:grid;grid-template-columns:minmax(95px,1fr) minmax(70px,2fr) auto;align-items:center;gap:10px;font-size:12px}.tf-analytics-name{min-width:0;overflow-wrap:anywhere;color:var(--forest-950);font-weight:700}.tf-analytics-track{height:8px;overflow:hidden;border-radius:99px;background:var(--sage-100)}.tf-analytics-fill{height:100%;border-radius:99px;background:var(--forest-700)}.tf-analytics-value{font-variant-numeric:tabular-nums;color:var(--muted);white-space:nowrap}.tf-analytics-empty{padding:22px 14px;margin-top:14px;border:1px dashed var(--line);border-radius:12px;text-align:center;color:var(--muted);font-size:12px;line-height:1.6}
        @media(max-width:900px){.product-analytics-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){.product-analytics-grid-two{grid-template-columns:1fr}.product-analytics-card{padding:13px}.product-analytics-value{font-size:21px}.product-analytics-panel{padding:15px}.tf-analytics-row{grid-template-columns:minmax(78px,1fr) minmax(45px,1fr) auto;gap:7px;font-size:11px}}
      </style>
      <section class="section-title-row"><div><span class="eyebrow">Business intelligence</span><h1>Product Analytics</h1><p>Understand what sells, cancellation patterns and category performance.</p></div></section>
      <section class="product-analytics">
        <div><label style="display:block;margin-bottom:7px;color:var(--muted);font-size:11px;font-weight:800">REPORTING PERIOD</label>${renderDateRangePicker("product-analytics", currentRange)}</div>
        <div class="product-analytics-note" data-product-analytics-status role="status">Loading saved paid order-item data for ${esc(dateRangeLabel(currentRange))}…</div>
        <div class="product-analytics-grid">
          <article class="product-analytics-card"><div class="product-analytics-icon"><i class="ph-bold ph-bowl-food"></i></div><strong class="product-analytics-value" data-product-metric="units">—</strong><span class="product-analytics-label">Units sold (paid orders)</span></article>
          <article class="product-analytics-card"><div class="product-analytics-icon"><i class="ph-bold ph-currency-inr"></i></div><strong class="product-analytics-value" data-product-metric="revenue">—</strong><span class="product-analytics-label">Paid product sales value</span></article>
          <article class="product-analytics-card"><div class="product-analytics-icon"><i class="ph-bold ph-x-circle"></i></div><strong class="product-analytics-value" data-product-metric="cancelled">—</strong><span class="product-analytics-label">Cancelled item quantities</span></article>
          <article class="product-analytics-card"><div class="product-analytics-icon"><i class="ph-bold ph-chart-line-up"></i></div><strong class="product-analytics-value" data-product-metric="category">—</strong><span class="product-analytics-label">Top category by paid sales</span></article>
        </div>
        <div class="product-analytics-grid-two">
          <article class="product-analytics-panel"><h2>Sales by product</h2><p>Top dishes ranked by paid net sales value.</p><div class="tf-analytics-list" data-product-chart="products"><div class="tf-analytics-empty">Loading product sales…</div></div></article>
          <article class="product-analytics-panel"><h2>Category performance</h2><p>Menu categories compared by paid product sales value.</p><div class="tf-analytics-list" data-product-chart="categories"><div class="tf-analytics-empty">Loading category performance…</div></div></article>
          <article class="product-analytics-panel"><h2>Cancellation analysis</h2><p>Cancellation quantities are counted from stored item statuses.</p><div class="tf-analytics-list" data-product-chart="cancellations"><div class="tf-analytics-empty">Loading cancellation data…</div></div></article>
          <article class="product-analytics-panel"><h2>Product profitability</h2><p>Revenue is not the same as profit.</p><div class="tf-analytics-empty">Profitability is intentionally not estimated. Populate and validate each recipe, unit conversion and ingredient cost before using a gross-margin report.</div></article>
        </div>
      </section>`;
    bindDateRangePicker(area, "product-analytics", currentRange, nextRange => { productAnalyticsDateRange = nextRange; renderProductDashboard(); });
    void loadProductAnalytics();

    async function loadProductAnalytics() {
      const status = area.querySelector("[data-product-analytics-status]");
      const access = window.__RMS_PANEL_ACCESS__;
      if (!supabase || access?.panelId !== "admin" || !access.token) {
        if (status) status.textContent = "A valid Admin session is required to view reporting data.";
        return;
      }
      try {
        const { data, error } = await supabase.rpc("get_admin_reporting_data", { p_panel_token: access.token, ...periodArgs() });
        if (error) throw error;
        if (section !== "products" || !area.querySelector("[data-product-analytics-status]")) return;
        const products = Array.isArray(data?.top_products) ? data.top_products : [];
        const categories = Array.isArray(data?.top_categories) ? data.top_categories : [];
        const totalUnits = products.reduce((sum, row) => sum + Number(row.quantity_sold || 0), 0);
        const totalRevenue = products.reduce((sum, row) => sum + Number(row.revenue || 0), 0);
        area.querySelector('[data-product-metric="units"]').textContent = count(totalUnits);
        area.querySelector('[data-product-metric="revenue"]').textContent = money(totalRevenue);
        area.querySelector('[data-product-metric="cancelled"]').textContent = count(data?.cancelled_units);
        area.querySelector('[data-product-metric="category"]').textContent = categories[0]?.category || "No paid sales";
        if (status) status.textContent = `${products.length} product groups and ${categories.length} categories · ${dateRangeLabel(currentRange)}. Only paid, non-cancelled items are used in sales totals.`;
        const renderBars = (rows, labelKey, valueKey, formatter) => {
          if (!rows.length) return '<div class="tf-analytics-empty">No data available for this period.</div>';
          const values = rows.map(row => Number(row[valueKey] || 0));
          const max = Math.max(1, ...values);
          return rows.slice(0, 10).map(row => {
            const value = Number(row[valueKey] || 0);
            return `<div class="tf-analytics-row"><span class="tf-analytics-name" title="${esc(row[labelKey])}">${esc(row[labelKey])}</span><span class="tf-analytics-track"><span class="tf-analytics-fill" style="display:block;width:${Math.max(value > 0 ? 2 : 0, value / max * 100)}%"></span></span><span class="tf-analytics-value">${esc(formatter(value))}</span></div>`;
          }).join("");
        };
        area.querySelector('[data-product-chart="products"]').innerHTML = renderBars(products, "name", "revenue", money);
        area.querySelector('[data-product-chart="categories"]').innerHTML = renderBars(categories, "category", "revenue", money);
        const cancelled = Number(data?.cancelled_units || 0);
        area.querySelector('[data-product-chart="cancellations"]').innerHTML = cancelled ? `<div class="tf-analytics-row"><span class="tf-analytics-name">Cancelled units</span><span class="tf-analytics-track"><span class="tf-analytics-fill" style="display:block;width:100%"></span></span><span class="tf-analytics-value">${count(cancelled)}</span></div><div class="tf-analytics-note">This total is quantity-based; individual cancellation reasons are shown only when recorded in the audit log.</div>` : '<div class="tf-analytics-empty">No cancelled item quantities recorded for this period.</div>';
      } catch (error) {
        console.error("Product Analytics failed:", error);
        if (status) status.textContent = `Product analytics could not load: ${String(error?.message || "Unknown database error")}. Apply the included SQL migration, then refresh.`;
      }
    }
  }

  function renderRevenueDashboard() {
    const currentRange = revenueDateRange;
    const periodArgs = () => currentRange.preset === "all" ? { p_period_start: null, p_period_end: null } : {
      p_period_start: indiaDateStartISOString(currentRange.startDate),
      p_period_end: indiaDateAfterISOString(currentRange.endDate)
    };
    const esc = value => escapeHtml(String(value ?? ""));
    const count = value => Number(value || 0).toLocaleString("en-IN");
    area.innerHTML = `
      <style>
        ${DATE_RANGE_STYLES}
        .revenue-dashboard{display:grid;gap:18px}.revenue-summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.revenue-summary-card{min-width:0;padding:17px;border:1px solid var(--line);border-radius:15px;background:var(--paper)}.revenue-summary-icon{display:grid;place-items:center;width:37px;height:37px;margin-bottom:14px;border-radius:11px;background:var(--sage-100);color:var(--forest-900);font-size:19px}.revenue-summary-value{display:block;margin-bottom:5px;color:var(--forest-950);font-size:24px;font-weight:850;overflow-wrap:anywhere}.revenue-summary-label{display:block;color:var(--muted);font-size:12px;line-height:1.5}
        .revenue-panel-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.revenue-panel{min-width:0;padding:19px;border:1px solid var(--line);border-radius:16px;background:var(--paper)}.revenue-panel h2{margin:0 0 5px;font-size:16px}.revenue-panel-description{margin:0;color:var(--muted);font-size:12px;line-height:1.6}.revenue-data-note{padding:13px 15px;border:1px solid var(--line);border-radius:12px;background:var(--cream-100);color:var(--muted);font-size:12px;line-height:1.6}.revenue-chart{display:grid;gap:12px;margin-top:16px}.revenue-bar-row{display:grid;grid-template-columns:minmax(66px,1fr) minmax(50px,2fr) auto;align-items:center;gap:10px;font-size:12px}.revenue-bar-label{color:var(--forest-950);font-weight:700;overflow-wrap:anywhere}.revenue-bar-track{height:9px;overflow:hidden;border-radius:99px;background:var(--sage-100)}.revenue-bar-fill{height:100%;border-radius:99px;background:var(--forest-700)}.revenue-bar-value{color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}.revenue-empty-chart{padding:24px 14px;margin-top:15px;border:1px dashed var(--line);border-radius:12px;text-align:center;color:var(--muted);font-size:12px;line-height:1.6}.revenue-reconcile{display:grid;gap:0;margin-top:14px}.revenue-reconcile-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);font-size:12px}.revenue-reconcile-row span{color:var(--muted)}.revenue-reconcile-row strong{color:var(--forest-950);text-align:right}
        @media(max-width:900px){.revenue-summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){.revenue-panel-grid{grid-template-columns:1fr}.revenue-summary-card{padding:13px}.revenue-summary-value{font-size:21px}.revenue-panel{padding:15px}.revenue-bar-row{grid-template-columns:minmax(65px,1fr) minmax(35px,1fr) auto;gap:7px;font-size:11px}}
      </style>
      <section class="section-title-row"><div><span class="eyebrow">Business intelligence</span><h1>Revenue</h1><p>Separate collected payments from issued bills and unpaid balances.</p></div></section>
      <section class="revenue-dashboard">
        <div><label style="display:block;margin-bottom:7px;color:var(--muted);font-size:11px;font-weight:800">REPORTING PERIOD</label>${renderDateRangePicker("revenue-report", currentRange)}</div>
        <div class="revenue-data-note" data-revenue-status role="status">Loading saved billing records for ${esc(dateRangeLabel(currentRange))}…</div>
        <div class="revenue-summary-grid">
          <article class="revenue-summary-card"><div class="revenue-summary-icon"><i class="ph-bold ph-wallet"></i></div><strong class="revenue-summary-value" data-revenue-metric="paid_revenue">—</strong><span class="revenue-summary-label">Paid revenue</span></article>
          <article class="revenue-summary-card"><div class="revenue-summary-icon"><i class="ph-bold ph-receipt"></i></div><strong class="revenue-summary-value" data-revenue-metric="bills_issued">—</strong><span class="revenue-summary-label">Bills issued</span></article>
          <article class="revenue-summary-card"><div class="revenue-summary-icon"><i class="ph-bold ph-hourglass-medium"></i></div><strong class="revenue-summary-value" data-revenue-metric="outstanding_amount">—</strong><span class="revenue-summary-label">Outstanding amount</span></article>
          <article class="revenue-summary-card"><div class="revenue-summary-icon"><i class="ph-bold ph-arrow-counter-clockwise"></i></div><strong class="revenue-summary-value" data-revenue-metric="refunded_amount">—</strong><span class="revenue-summary-label">Recorded refunded amount</span></article>
        </div>
        <div class="revenue-panel-grid">
          <article class="revenue-panel"><h2>Revenue over time</h2><p class="revenue-panel-description">Paid bill totals grouped in India Standard Time.</p><div class="revenue-chart" data-revenue-chart="trend"><div class="revenue-empty-chart">Loading revenue trend…</div></div></article>
          <article class="revenue-panel"><h2>Payment breakdown</h2><p class="revenue-panel-description">Collected revenue grouped by the recorded payment method.</p><div class="revenue-chart" data-revenue-chart="payments"><div class="revenue-empty-chart">Loading payment methods…</div></div></article>
          <article class="revenue-panel"><h2>Sales by hour</h2><p class="revenue-panel-description">Paid bill totals grouped by hour (IST).</p><div class="revenue-chart" data-revenue-chart="hours"><div class="revenue-empty-chart">Loading hourly sales…</div></div></article>
          <article class="revenue-panel"><h2>Billing reconciliation</h2><p class="revenue-panel-description">Bills issued, paid and outstanding are separate lifecycle states.</p><div class="revenue-reconcile" data-revenue-chart="reconcile"><div class="revenue-empty-chart">Loading reconciliation…</div></div></article>
        </div>
      </section>`;
    bindDateRangePicker(area, "revenue-report", currentRange, nextRange => { revenueDateRange = nextRange; renderRevenueDashboard(); });
    void loadRevenueReport();

    async function loadRevenueReport() {
      const status = area.querySelector("[data-revenue-status]");
      const access = window.__RMS_PANEL_ACCESS__;
      if (!supabase || access?.panelId !== "admin" || !access.token) {
        if (status) status.textContent = "A valid Admin session is required to view revenue reporting.";
        return;
      }
      try {
        const { data, error } = await supabase.rpc("get_admin_reporting_data", { p_panel_token: access.token, ...periodArgs() });
        if (error) throw error;
        if (section !== "revenue" || !area.querySelector("[data-revenue-status]")) return;
        const metrics = data?.metrics || {};
        for (const key of ["paid_revenue", "outstanding_amount", "refunded_amount"]) {
          const node = area.querySelector(`[data-revenue-metric="${key}"]`);
          if (node) node.textContent = money(metrics[key] || 0);
        }
        area.querySelector('[data-revenue-metric="bills_issued"]').textContent = count(metrics.bills_issued);
        if (status) status.textContent = `Reporting ${dateRangeLabel(currentRange)}. Revenue includes only paid bills; outstanding amounts remain unpaid and are not included in revenue.`;
        const renderBars = (rows, labelFn, valueKey, formatter) => {
          if (!rows.length) return '<div class="revenue-empty-chart">No recorded data for this period.</div>';
          const max = Math.max(1, ...rows.map(row => Number(row[valueKey] || 0)));
          return rows.slice(-24).map(row => {
            const value = Number(row[valueKey] || 0);
            return `<div class="revenue-bar-row"><span class="revenue-bar-label">${esc(labelFn(row))}</span><span class="revenue-bar-track"><span class="revenue-bar-fill" style="display:block;width:${Math.max(value > 0 ? 2 : 0, value / max * 100)}%"></span></span><span class="revenue-bar-value">${esc(formatter(value))}</span></div>`;
          }).join("");
        };
        const trend = Array.isArray(data?.trend) ? data.trend : [];
        const payments = Array.isArray(data?.payment_breakdown) ? data.payment_breakdown : [];
        const hours = Array.isArray(data?.sales_by_hour) ? data.sales_by_hour : [];
        area.querySelector('[data-revenue-chart="trend"]').innerHTML = renderBars(trend, row => row.label, "revenue", money);
        const paymentLabels = { upi_qr: "UPI QR", cash: "Cash", card: "Card", bank_transfer: "Bank transfer", Unrecorded: "Not recorded" };
        area.querySelector('[data-revenue-chart="payments"]').innerHTML = renderBars(payments, row => paymentLabels[row.method] || row.method || "Unknown", "amount", money);
        area.querySelector('[data-revenue-chart="hours"]').innerHTML = renderBars(hours, row => `${String(row.hour).padStart(2,"0")}:00`, "amount", money);
        area.querySelector('[data-revenue-chart="reconcile"]').innerHTML = `
          <div class="revenue-reconcile-row"><span>Issued bills</span><strong>${count(metrics.bills_issued)}</strong></div>
          <div class="revenue-reconcile-row"><span>Paid bills</span><strong>${count(metrics.paid_bills)}</strong></div>
          <div class="revenue-reconcile-row"><span>Outstanding bills</span><strong>${count(metrics.outstanding_bills)}</strong></div>
          <div class="revenue-reconcile-row"><span>Outstanding balance</span><strong>${esc(money(metrics.outstanding_amount || 0))}</strong></div>
          <div class="revenue-reconcile-row"><span>Refunded bills recorded</span><strong>${count(metrics.refunded_bills)}</strong></div>
          <div class="revenue-reconcile-row"><span>Refunded amount recorded</span><strong>${esc(money(metrics.refunded_amount || 0))}</strong></div>`;
      } catch (error) {
        console.error("Revenue report failed:", error);
        if (status) status.textContent = `Revenue report could not load: ${String(error?.message || "Unknown database error")}. Apply the included SQL migration, then refresh.`;
        for (const node of area.querySelectorAll("[data-revenue-chart]")) node.innerHTML = '<div class="revenue-empty-chart">Report unavailable. Check the SQL migration and database error details.</div>';
      }
    }
  }

  function renderInventory() {
    const views = {
      ingredients: {
        title: "Ingredients",
        description: "Manage ingredient records, measurement units, purchase costs and reorder levels.",
        icon: "ph-package"
      },
      history: {
        title: "History",
        description: "Read-only timeline of stock received, opening balances, consumption, wastage and corrections.",
        icon: "ph-clock-counter-clockwise"
      },
      recipes: {
        title: "Recipes",
        description: "Connect each menu dish to its ingredients and quantities required per serving.",
        icon: "ph-cooking-pot"
      },
      movements: {
        title: "Stock movements",
        description: "Track received stock, recipe consumption, waste and authorized adjustments.",
        icon: "ph-arrows-left-right"
      },
      forecast: {
        title: "Stock forecast",
        description: "Estimate remaining stock, expected days of supply and ingredients needing reorder.",
        icon: "ph-chart-line-up"
      }
    };

    let activeView = "ingredients";

    // Stock is always stored in canonical base units (g, ml or pcs).
    // Display and receiving inputs may use larger units without changing recipe math.
    function formatInventoryQuantity(value, baseUnit) {
      const amount = Number(value);
      if (!Number.isFinite(amount)) return "—";
      const abs = Math.abs(amount);
      const number = n => n.toLocaleString("en-IN", { maximumFractionDigits: 3 });
      if (baseUnit === "g") {
        return `${number(amount / 1000)} kg`;
      }
      if (baseUnit === "ml") {
        return `${number(amount / 1000)} L`;
      }
      if (baseUnit === "pcs" && abs >= 12 && Math.abs(abs / 12 - Math.round(abs / 12)) < 0.000001) {
        return `${number(amount / 12)} dozen`;
      }
      return `${number(amount)} ${baseUnit === "pcs" ? "pcs" : baseUnit}`;
    }

    function getInventoryDisplayUnit(baseUnit) {
      if (baseUnit === "g" || baseUnit === "kg") return "kg";
      if (baseUnit === "ml" || baseUnit === "L" || baseUnit === "l") return "L";
      return "pcs";
    }

    function formatInventoryDate(timestamp) {
      const date = new Date(Number(timestamp));
      if (!Number.isFinite(date.getTime())) return "—";
      return date.toLocaleString("en-IN", {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit"
      });
    }

    function getLastIngredientAddition(ingredientId) {
      return inventoryMovementDrafts
        .filter(item => item.ingredientId === ingredientId &&
          ["opening_stock", "received", "adjustment_in"].includes(item.movementType) &&
          Number(item.quantityDelta) > 0)
        .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    }

    function getInventoryEntryUnits(baseUnit) {
      const units = {
        g: [
          { value: "g", label: "Grams (g)", factor: 1 },
          { value: "kg", label: "Kilograms (kg)", factor: 1000 }
        ],
        ml: [
          { value: "ml", label: "Millilitres (ml)", factor: 1 },
          { value: "l", label: "Litres (L)", factor: 1000 }
        ],
        pcs: [
          { value: "pcs", label: "Pieces (pcs)", factor: 1 },
          { value: "dozen", label: "Dozen (12 pcs)", factor: 12 }
        ]
      };
      return units[baseUnit] || [];
    }

    area.innerHTML = `
      <style>
        .inventory-page {
          display: grid;
          gap: 18px;
        }

        .inventory-summary {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 12px;
        }

        .inventory-summary-card {
          padding: 17px;
          min-width: 0;
          border: 1px solid var(--line);
          border-radius: 15px;
          background: var(--paper);
        }

        .inventory-summary-card i {
          display: grid;
          place-items: center;
          width: 36px;
          height: 36px;
          margin-bottom: 14px;
          border-radius: 11px;
          background: var(--sage-100);
          color: var(--forest-900);
          font-size: 19px;
        }

        .inventory-summary-card strong {
          display: block;
          margin-bottom: 5px;
          font-size: 24px;
          line-height: 1.2;
          color: var(--forest-950);
        }

        .inventory-summary-card span {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.4;
        }

        .inventory-view-tabs {
          display: flex;
          gap: 8px;
          overflow-x: auto;
          padding-bottom: 3px;
        }

        .inventory-view-tab {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          flex-shrink: 0;
          min-height: 40px;
          padding: 0 13px;
          border: 1px solid var(--line);
          border-radius: 11px;
          background: var(--paper);
          color: var(--forest-800);
          font: inherit;
          font-size: 12px;
          font-weight: 800;
          cursor: pointer;
        }

        .inventory-view-tab.active {
          background: var(--forest-900);
          border-color: var(--forest-900);
          color: #fff;
          box-shadow: 0 5px 14px rgba(20, 42, 28, .12);
        }

        .inventory-ingredient-form {
          margin-top: 22px;
          padding: 22px;
          border: 1px solid var(--line);
          border-radius: 18px;
          background: linear-gradient(145deg, var(--paper) 0%, var(--cream-100) 100%);
          box-shadow: 0 10px 28px rgba(30, 48, 34, .06);
        }

        .inventory-ingredient-form .field { min-width: 0; gap: 8px; }
        .inventory-ingredient-form .field > span {
          color: var(--forest-900);
          font-size: 12px;
          font-weight: 850;
          letter-spacing: .01em;
        }
        .inventory-ingredient-form .field-input {
          width: 100%;
          min-width: 0;
          min-height: 44px;
          padding: 10px 13px;
          border: 1px solid #d8ded1;
          border-radius: 12px;
          outline: none;
          background: #fff;
          color: var(--forest-950);
          font: inherit;
          font-size: 14px;
          box-shadow: 0 1px 2px rgba(24, 39, 27, .04);
          transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
        }
        .inventory-ingredient-form .field-input:hover { border-color: #aebca9; }
        .inventory-ingredient-form .field-input:focus {
          border-color: var(--forest-700);
          box-shadow: 0 0 0 3px rgba(54, 91, 56, .12);
        }
        .inventory-ingredient-form .field-input::placeholder { color: #929b8e; }
        .inventory-ingredient-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 14px;
        }
        .inventory-last-added {
          max-width: 300px;
          margin-top: 5px;
          color: var(--muted);
          font-size: 11px;
          line-height: 1.45;
          overflow-wrap: anywhere;
        }
        .inventory-history-note {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          margin: 16px 0 18px;
          padding: 13px 15px;
          border: 1px solid #dfe7da;
          border-radius: 13px;
          background: #f5f8f1;
          color: var(--forest-800);
          font-size: 12px;
          line-height: 1.55;
        }
        .inventory-add-choice-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }
        .inventory-add-choice-card {
          padding: 17px;
          border: 1px solid var(--line);
          border-radius: 15px;
          background: linear-gradient(145deg, #fff, var(--cream-100));
        }
        .inventory-add-choice-card > i {
          display: grid;
          place-items: center;
          width: 42px;
          height: 42px;
          margin-bottom: 12px;
          border-radius: 13px;
          background: var(--sage-100);
          color: var(--forest-900);
          font-size: 21px;
        }
        .inventory-add-choice-card strong { display: block; color: var(--forest-950); font-size: 14px; }
        .inventory-add-choice-card p { margin: 7px 0 0; color: var(--muted); font-size: 12px; line-height: 1.55; }

        .inventory-view-panel {
          min-height: 220px;
          padding: 24px;
          border: 1px solid var(--line);
          border-radius: 17px;
          background: var(--paper);
        }

        .inventory-view-panel-icon {
          display: grid;
          place-items: center;
          width: 46px;
          height: 46px;
          margin-bottom: 15px;
          border-radius: 14px;
          background: var(--sage-100);
          color: var(--forest-900);
          font-size: 24px;
        }

        .inventory-view-panel h2 {
          margin: 0 0 7px;
          font-size: 19px;
        }

        .inventory-view-panel p {
          max-width: 540px;
          margin: 0;
          color: var(--muted);
          font-size: 13px;
          line-height: 1.6;
        }

        .inventory-data-status {
          margin-top: 20px;
          padding: 12px 14px;
          border-radius: 11px;
          background: var(--cream-100);
          color: var(--muted);
          font-size: 12px;
          line-height: 1.6;
        }

        @media (max-width: 700px) {
          .inventory-summary {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 9px;
          }

          .inventory-summary-card {
            padding: 13px;
          }

          .inventory-summary-card strong {
            font-size: 21px;
          }

          .inventory-view-panel {
            padding: 18px;
          }

          .inventory-ingredient-form { padding: 17px; }
          .inventory-ingredient-grid,
          .inventory-add-choice-grid { grid-template-columns: minmax(0, 1fr); }
        }
      </style>

      <div class="section-title-row">
        <div>
          <span class="eyebrow">Admin · Stock control</span>
          <h1>Inventory</h1>
          <p>Ingredients, recipes and stock movement in one place.</p>
        </div>
      </div>

      <section class="inventory-page">
        <div class="inventory-summary">
          <article class="inventory-summary-card">
            <i class="ph-bold ph-package"></i>
            <strong data-inventory-metric="ingredients">—</strong>
            <span>Ingredients</span>
          </article>

          <article class="inventory-summary-card">
            <i class="ph-bold ph-cooking-pot"></i>
            <strong data-inventory-metric="recipes">—</strong>
            <span>Recipes configured</span>
          </article>

          <article class="inventory-summary-card">
            <i class="ph-bold ph-warning-circle"></i>
            <strong data-inventory-metric="low-stock">—</strong>
            <span>Low-stock items</span>
          </article>

          <article class="inventory-summary-card">
            <i class="ph-bold ph-calendar-check"></i>
            <strong data-inventory-metric="stock-days">—</strong>
            <span>Average estimated stock days</span>
          </article>
        </div>

        <div class="inventory-view-tabs" role="tablist" aria-label="Inventory sections">
          ${Object.entries(views).map(([key, view], index) => `
            <button
              type="button"
              class="inventory-view-tab ${index === 0 ? "active" : ""}"
              data-inventory-view="${key}"
              role="tab"
              aria-selected="${index === 0 ? "true" : "false"}"
            >
              <i class="ph-bold ${view.icon}"></i>
              ${view.title}
            </button>
          `).join("")}
        </div>

        <section
          class="inventory-view-panel"
          id="inventory-view-panel"
          role="tabpanel"
          aria-live="polite"
        ></section>
      </section>
    `;

    const panel = area.querySelector("#inventory-view-panel");
    const tabs = [...area.querySelectorAll("[data-inventory-view]")];

    function updateInventorySummary() {
      const setMetric = (key, value) => {
        const node = area.querySelector(`[data-inventory-metric="${key}"]`);
        if (node) node.textContent = String(value);
      };
      const activeIngredients = ingredientDrafts.filter(item => item.isActive !== false);
      const activeProducts = products.filter(item => item.is_active);
      const recipeCount = activeProducts.filter(item => (productRecipeDrafts.get(item.id) || []).length > 0).length;
      const balances = new Map(activeIngredients.map(item => [item.id, Number(item.currentStock || 0)]));
      const lowStockCount = activeIngredients.filter(item => Number(item.currentStock || 0) <= Number(item.reorderLevel || 0)).length;
      const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const estimatedDays = activeIngredients.map(ingredient => {
        const movements = inventoryMovementDrafts.filter(item => item.ingredientId === ingredient.id);
        const hasOpening = movements.some(item => item.movementType === "opening_stock");
        const usedLast7 = movements.filter(item => item.movementType === "sale" && item.createdAt >= since && item.quantityDelta < 0).reduce((sum, item) => sum + Math.abs(item.quantityDelta), 0);
        return hasOpening && usedLast7 > 0 ? Math.max(0, balances.get(ingredient.id) || 0) / (usedLast7 / 7) : null;
      }).filter(value => value !== null && Number.isFinite(value));
      setMetric("ingredients", activeIngredients.length.toLocaleString("en-IN"));
      setMetric("recipes", `${recipeCount}/${activeProducts.length}`);
      setMetric("low-stock", lowStockCount.toLocaleString("en-IN"));
      setMetric("stock-days", estimatedDays.length ? (estimatedDays.reduce((sum, value) => sum + value, 0) / estimatedDays.length).toLocaleString("en-IN", { maximumFractionDigits: 1 }) : "—");
    }

    function renderInventoryView() {
      const view = views[activeView];

      function renderMovementView() {
        const movements = inventoryMovementDrafts
          .slice()
          .sort((a, b) => b.createdAt - a.createdAt);

        const getBalance = ingredientId =>
          inventoryMovementDrafts
            .filter(item => item.ingredientId === ingredientId)
            .reduce((total, item) => total + item.quantityDelta, 0);

        const totalIngredients = ingredientDrafts.length;
        const lowStockCount = ingredientDrafts.filter(ingredient => {
          const balance = getBalance(ingredient.id);
          return balance <= Number(ingredient.reorderLevel);
        }).length;

        panel.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
            <div>
              <div class="inventory-view-panel-icon">
                <i class="ph-bold ph-arrows-left-right"></i>
              </div>

              <h2>Stock movements</h2>
              <p>
                Record stock received, wastage, and verified stock corrections.
              </p>
            </div>

            <button
              type="button"
              class="btn btn-primary"
              data-open-stock-movement
            >
              <i class="ph-bold ph-plus"></i>
              Record movement
            </button>
          </div>

          <div
            class="inventory-data-status"
            style="margin-top:18px;"
          >
            Stock movements are saved to the restaurant database as separate records.
            Existing history is read-only; corrections are recorded as new movements.
          </div>

          <div
            style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px;"
          >
            <div class="inventory-summary-card">
              <strong>${totalIngredients}</strong>
              <span>Ingredients</span>
            </div>

            <div class="inventory-summary-card">
              <strong>${lowStockCount}</strong>
              <span>At or below draft reorder level</span>
            </div>
          </div>

          <form
            data-stock-movement-form
            hidden
            style="margin-top:18px;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--cream-100);"
          >
            <h3 style="margin:0 0 15px;font-size:16px;">
              Record stock movement
            </h3>

            <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;">
              <label class="field">
                <span>Ingredient *</span>
                <select name="ingredientId" required>
                  <option value="">Choose ingredient</option>
                  ${ingredientDrafts.map(ingredient => `
                    <option value="${escapeHtml(ingredient.id)}">
                      ${escapeHtml(ingredient.name)}
                    </option>
                  `).join("")}
                </select>
              </label>

              <label class="field">
                <span>Movement type *</span>
                <select name="movementType" required>
                  <option value="opening_stock">Opening stock</option>
                  <option value="received">Stock received</option>
                  <option value="waste">Wastage</option>
                  <option value="adjustment_in">Correction — increase</option>
                  <option value="adjustment_out">Correction — decrease</option>
                </select>
              </label>

              <label class="field">
                <span>Quantity *</span>
                <input
                  name="quantity"
                  type="number"
                  min="0"
                  step="any"
                  required
                  inputmode="decimal"
                  placeholder="Enter quantity"
                />
              </label>

              <label class="field">
                <span>Unit</span>
                <input
                  name="unit"
                  type="text"
                  value=""
                  readonly
                />
              </label>

              <label class="field" style="grid-column:1/-1;">
                <span>Reason / reference *</span>
                <input
                  name="reason"
                  type="text"
                  maxlength="240"
                  required
                  placeholder="e.g. Purchase receipt, spillage, stock count correction"
                />
              </label>
            </div>

            <p
              data-stock-movement-error
              role="alert"
              style="margin:12px 0 0;color:var(--danger);font-size:12px;"
            ></p>

            <div style="display:flex;justify-content:flex-end;gap:9px;flex-wrap:wrap;margin-top:16px;">
              <button
                type="button"
                class="btn btn-quiet"
                data-cancel-stock-movement
              >
                Cancel
              </button>

              <button type="submit" class="btn btn-primary">
                Record movement
              </button>
            </div>
          </form>

          <div style="margin-top:22px;">
            <h3 style="margin:0 0 10px;font-size:15px;">
              Movement history
            </h3>

            ${movements.length ? `
              <div style="overflow-x:auto;">
                <table class="data-table" style="width:100%;min-width:630px;">
                  <thead>
                    <tr>
                      <th>Ingredient</th>
                      <th>Movement</th>
                      <th>Quantity change</th>
                      <th>Reason</th>
                      <th>Recorded balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${movements.map(movement => {
                      const ingredient = ingredientDrafts.find(
                        item => item.id === movement.ingredientId
                      );

                      return `
                        <tr>
                          <td>
                            <strong>${escapeHtml(ingredient?.name || "Unknown ingredient")}</strong>
                          </td>

                          <td>${escapeHtml(movement.label)}</td>

                          <td style="font-weight:800;color:${movement.quantityDelta < 0 ? "var(--danger)" : "var(--forest-800)"};">
                            ${movement.quantityDelta > 0 ? "+" : ""}${formatInventoryQuantity(movement.quantityDelta, movement.unit)}
                          </td>

                          <td>${escapeHtml(movement.reason)}</td>

                          <td>
                            <strong style="color:${getBalance(movement.ingredientId) < 0 ? "var(--danger)" : "inherit"};">${formatInventoryQuantity(getBalance(movement.ingredientId), movement.unit)}</strong>
                            ${getBalance(movement.ingredientId) < 0 ? `<div style="margin-top:3px;color:var(--danger);font-size:10px;font-weight:850;">SHORTAGE</div>` : ""}
                          </td>
                        </tr>
                      `;
                    }).join("")}
                  </tbody>
                </table>
              </div>
            ` : `
              <div class="product-recipe-empty">
                <i class="ph-bold ph-arrows-left-right" style="font-size:25px;"></i>
                <p style="margin:8px 0 0;">
                  No stock movements yet. Record opening stock first, then log receipts, wastage or corrections.
                </p>
              </div>
            `}
          </div>
        `;

        const form = panel.querySelector("[data-stock-movement-form]");
        const ingredientSelect = form?.elements.ingredientId;
        const unitInput = form?.elements.unit;
        const errorNode = form?.querySelector("[data-stock-movement-error]");

        function updateSelectedUnit() {
          const ingredient = ingredientDrafts.find(
            item => item.id === ingredientSelect?.value
          );

          if (unitInput) {
            unitInput.value = ingredient?.baseUnit || "";
          }
        }

        ingredientSelect?.addEventListener("change", updateSelectedUnit);

        panel.querySelector("[data-open-stock-movement]")
          ?.addEventListener("click", () => {
            if (!ingredientDrafts.length) {
              showToast(
                "No ingredients available",
                "Create an ingredient in Inventory first.",
                "error"
              );
              return;
            }

            form.hidden = false;
            ingredientSelect?.focus();
          });

        panel.querySelector("[data-cancel-stock-movement]")
          ?.addEventListener("click", () => {
            form.reset();
            updateSelectedUnit();
            form.hidden = true;
          });

        form?.addEventListener("submit", async event => {
          event.preventDefault();

          const ingredientId = form.elements.ingredientId.value;
          const ingredient = ingredientDrafts.find(
            item => item.id === ingredientId
          );

          const movementType = form.elements.movementType.value;
          const quantity = Number(form.elements.quantity.value);
          const reason = form.elements.reason.value.trim();

          if (!ingredient) {
            errorNode.textContent = "Select a valid ingredient.";
            return;
          }

          if (!Number.isFinite(quantity) || quantity <= 0) {
            errorNode.textContent = "Enter a quantity greater than zero.";
            return;
          }

          if (!reason) {
            errorNode.textContent = "Enter a reason or reference.";
            return;
          }

          const priorMovements = inventoryMovementDrafts.filter(
            item => item.ingredientId === ingredientId
          );

          const hasOpeningStock = priorMovements.some(
            item => item.movementType === "opening_stock"
          );

          if (movementType === "opening_stock" && priorMovements.length > 0) {
            errorNode.textContent =
              "Opening stock must be recorded before other movements and only once per ingredient.";
            return;
          }

          if (movementType !== "opening_stock" && !hasOpeningStock) {
            errorNode.textContent =
              "Record the opening stock for this ingredient before recording other movements.";
            return;
          }

          const quantityDelta = [
            "waste",
            "adjustment_out"
          ].includes(movementType) ? -quantity : quantity;

          const labelMap = {
            opening_stock: "Opening stock",
            received: "Stock received",
            waste: "Wastage",
            adjustment_in: "Correction (+)",
            adjustment_out: "Correction (−)"
          };

          const nextBalance =
            getBalance(ingredientId) + quantityDelta;

          if (nextBalance < 0 && inventoryModeDraft !== "automatic") {
            errorNode.textContent = inventoryModeDraft === "strict"
              ? "Strict inventory does not allow a negative balance. Record a verified receipt or reduce the adjustment."
              : "This movement would create negative stock while automatic deductions are off. Record the missing stock or reduce the quantity.";
            return;
          }

          const submitButton = form.querySelector('button[type="submit"]');
          if (submitButton) submitButton.disabled = true;
          try {
            const { error: movementError } = await supabase.rpc("admin_record_inventory_movement", {
              p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null,
              p_ingredient_id: ingredientId,
              p_movement_type: movementType,
              p_quantity: quantity,
              p_reason: reason
            });
            if (movementError) throw movementError;
            await reloadInventoryDrafts();
            showToast(
              "Stock movement recorded",
              `${ingredient.name}: ${quantityDelta > 0 ? "+" : ""}${quantityDelta} ${ingredient.baseUnit}`,
              "success"
            );
            renderInventoryView();
          } catch (movementError) {
            errorNode.textContent = movementError.message || "The stock movement could not be saved.";
          } finally {
            if (submitButton) submitButton.disabled = false;
          }
        });
      }

      if (activeView === "movements") {
        renderMovementView();
      } else if (activeView === "forecast") {
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

        const forecastRows = ingredientDrafts.map(ingredient => {
          const movements = inventoryMovementDrafts.filter(
            item => item.ingredientId === ingredient.id
          );

          const hasOpeningStock = movements.some(
            item => item.movementType === "opening_stock"
          );

          const currentBalance = movements.reduce(
            (total, item) => total + item.quantityDelta,
            0
          );

          // Only recipe consumption counts as ingredient demand.
          // Wastage and stock adjustments are not demand.
          const consumptionLast7Days = movements
            .filter(item =>
              item.movementType === "sale" &&
              item.createdAt >= sevenDaysAgo &&
              item.quantityDelta < 0
            )
            .reduce(
              (total, item) => total + Math.abs(item.quantityDelta),
              0
            );

          const averageDailyUsage = consumptionLast7Days / 7;

          const daysRemaining =
            hasOpeningStock && averageDailyUsage > 0
              ? Math.max(0, currentBalance) / averageDailyUsage
              : null;

          let stockStatus;

          if (currentBalance < 0) {
            stockStatus = "Shortage";
          } else if (!hasOpeningStock) {
            stockStatus = "Opening stock needed";
          } else if (currentBalance <= Number(ingredient.reorderLevel)) {
            stockStatus = "Reorder";
          } else if (averageDailyUsage <= 0) {
            stockStatus = "Usage history needed";
          } else {
            stockStatus = "Forecast available";
          }

          return {
            ingredient,
            hasOpeningStock,
            currentBalance,
            averageDailyUsage,
            daysRemaining,
            stockStatus
          };
        });

        const openingStockCount = forecastRows.filter(
          row => row.hasOpeningStock
        ).length;

        const availableForecastCount = forecastRows.filter(
          row => row.daysRemaining !== null &&
            Number.isFinite(row.daysRemaining)
        ).length;

        panel.innerHTML = `
          <div>
            <div class="inventory-view-panel-icon">
              <i class="ph-bold ph-chart-line-up"></i>
            </div>

            <h2>Stock forecast</h2>

            <p>
              Review saved stock balances and estimate how long ingredients
              may last using recipe-consumption history.
            </p>
          </div>

          <div class="inventory-data-status">
These estimates use saved stock movements and recipe-consumption records for the last seven days. Forecasts require a recorded opening balance and at least one saved recipe-consumption movement.
          </div>

          <div
            style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:18px;"
          >
            <div class="inventory-summary-card">
              <strong>${forecastRows.length}</strong>
              <span>Ingredients</span>
            </div>

            <div class="inventory-summary-card">
              <strong>${openingStockCount}</strong>
              <span>With opening stock</span>
            </div>

            <div class="inventory-summary-card">
              <strong>${availableForecastCount}</strong>
              <span>Usable forecasts</span>
            </div>
          </div>

          <div style="overflow-x:auto;margin-top:20px;">
            <table class="data-table" style="width:100%;min-width:720px;">
              <thead>
                <tr>
                  <th>Ingredient</th>
                  <th>Recorded balance</th>
                  <th>Average usage / day</th>
                  <th>Estimated days remaining</th>
                  <th>Status</th>
                </tr>
              </thead>

              <tbody>
                ${forecastRows.length
                  ? forecastRows.map(row => `
                      <tr>
                        <td>
                          <strong>
                            ${escapeHtml(row.ingredient.name)}
                          </strong>
                        </td>

                        <td>
                          ${row.hasOpeningStock
                            ? escapeHtml(formatInventoryQuantity(row.currentBalance, row.ingredient.baseUnit))
                            : "Not established"}
                        </td>

                        <td>
                          ${row.hasOpeningStock &&
                            row.averageDailyUsage > 0
                            ? escapeHtml(formatInventoryQuantity(row.averageDailyUsage, row.ingredient.baseUnit))
                            : "Unavailable"}
                        </td>

                        <td>
                          ${row.daysRemaining !== null &&
                            Number.isFinite(row.daysRemaining)
                            ? `${row.daysRemaining.toLocaleString(undefined, { maximumFractionDigits: 1 })} days`
                            : "Insufficient data"}
                        </td>

                        <td>
                          <span
                            style="font-size:11px;font-weight:800;color:${
                              row.stockStatus === "Reorder"
                                ? "var(--danger)"
                                : row.stockStatus === "Forecast available"
                                  ? "var(--forest-800)"
                                  : "var(--muted)"
                            };"
                          >
                            ${escapeHtml(row.stockStatus)}
                          </span>
                        </td>
                      </tr>
                    `).join("")
                  : `
                      <tr>
                        <td colspan="5">
                          <div style="padding:24px;text-align:center;color:var(--muted);">
                            Record opening stock to establish saved balances, then track recipe consumption over time.
                          </div>
                        </td>
                      </tr>
                    `
                }
              </tbody>
            </table>
          </div>
        `;
      } else if (activeView === "recipes") {
        const activeProducts = products.filter(item => item.is_active);
        const configuredProducts = activeProducts.filter(item => (productRecipeDrafts.get(item.id) || []).length > 0);
        const missingRecipeProducts = activeProducts.filter(item => (productRecipeDrafts.get(item.id) || []).length === 0);
        panel.innerHTML = `
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;">
            <div>
              <div class="inventory-view-panel-icon"><i class="ph-bold ph-cooking-pot"></i></div>
              <h2>Recipe coverage</h2>
              <p>Review which active menu dishes have saved ingredient recipes. Recipes are edited inside each dish in the Menu section.</p>
            </div>
            <button class="btn btn-primary" type="button" data-open-menu-to-edit-recipes><i class="ph-bold ph-fork-knife"></i> Manage recipes in Menu</button>
          </div>
          <div class="inventory-data-status">${configuredProducts.length} of ${activeProducts.length} active dishes have at least one saved ingredient recipe. This count is based on persisted recipe data, not a draft estimate.</div>
          <div style="overflow-x:auto;margin-top:18px;">
            <table class="data-table" style="width:100%;min-width:560px;">
              <thead><tr><th>Dish</th><th>Recipe ingredients</th><th>Coverage</th></tr></thead>
              <tbody>
                ${activeProducts.length ? activeProducts.map(item => {
                  const recipe = productRecipeDrafts.get(item.id) || [];
                  const verified = recipe.length > 0 &&
                    recipe.every(row => row.is_estimate === false);
                  const stateLabel = !recipe.length ? "Missing recipe" : verified ? "Verified" : "Estimated";
                  const stateColor = !recipe.length ? "var(--danger)" : verified ? "var(--forest-800)" : "var(--muted)";
                  return `<tr><td><strong>${escapeHtml(item.name)}</strong><div style="color:var(--muted);font-size:11px;margin-top:3px;">${escapeHtml(item.category || "Uncategorized")}</div></td><td>${recipe.length ? recipe.map(row => `${escapeHtml(ingredientDrafts.find(ingredient => ingredient.id === row.ingredient_id)?.name || "Unknown ingredient")} · ${escapeHtml(row.quantity_per_serving)} per serving`).join("<br>") : "No recipe saved"}</td><td><span style="font-size:11px;font-weight:850;color:${stateColor};">${escapeHtml(stateLabel)}</span></td></tr>`;
                }).join("") : `<tr><td colspan="3"><div style="padding:20px;text-align:center;color:var(--muted);">No active menu dishes are available for recipe coverage.</div></td></tr>`}
              </tbody>
            </table>
          </div>
          ${missingRecipeProducts.length ? `<p style="margin-top:14px;color:var(--muted);font-size:12px;">${missingRecipeProducts.length} dishes do not yet have a recipe. They are not included in ingredient-consumption reporting until recipes are saved.</p>` : ""}
        `;
        panel.querySelector("[data-open-menu-to-edit-recipes]")?.addEventListener("click", () => transitionToSection("menu"));
      } else if (activeView === "history") {
        const historyRows = inventoryMovementDrafts
          .slice()
          .sort((a, b) => b.createdAt - a.createdAt);

        panel.innerHTML = `
          <div class="inventory-view-panel-icon"><i class="ph-bold ph-clock-counter-clockwise"></i></div>
          <h2>Inventory history</h2>
          <p>A permanent, read-only record of every stock addition, consumption, wastage and correction.</p>
          <div class="inventory-history-note">
            <i class="ph-bold ph-lock-key" style="font-size:18px;flex:0 0 auto;"></i>
            <div><strong>History is read-only.</strong> Entries cannot be edited from this screen. To correct a balance, record a new adjustment so the audit trail remains complete.</div>
          </div>
          <div style="overflow-x:auto;margin-top:10px;">
            <table class="data-table" style="width:100%;min-width:760px;">
              <thead><tr><th>Date & time</th><th>Ingredient</th><th>Activity</th><th>Quantity change</th><th>Reason / reference</th></tr></thead>
              <tbody>
                ${historyRows.length ? historyRows.map(movement => {
                  const ingredient = ingredientDrafts.find(item => item.id === movement.ingredientId);
                  return `<tr>
                    <td style="white-space:nowrap;">${escapeHtml(formatInventoryDate(movement.createdAt))}</td>
                    <td><strong>${escapeHtml(ingredient?.name || "Unknown ingredient")}</strong></td>
                    <td>${escapeHtml(movement.label || movement.movementType)}</td>
                    <td style="font-weight:850;color:${movement.quantityDelta < 0 ? "var(--danger)" : "var(--forest-800)"};white-space:nowrap;">${movement.quantityDelta > 0 ? "+" : ""}${escapeHtml(formatInventoryQuantity(movement.quantityDelta, movement.unit))}</td>
                    <td>${escapeHtml(movement.reason || "—")}</td>
                  </tr>`;
                }).join("") : `<tr><td colspan="5"><div style="padding:28px 8px;text-align:center;color:var(--muted);">No stock history has been recorded yet. Add an opening balance or receive stock to start the history.</div></td></tr>`}
              </tbody>
            </table>
          </div>
        `;
      } else if (activeView !== "ingredients") {
        panel.innerHTML = `
          <div class="inventory-view-panel-icon">
            <i class="ph-bold ${view.icon}"></i>
          </div>

          <h2>${escapeHtml(view.title)}</h2>
          <p>${escapeHtml(view.description)}</p>

          <div class="inventory-data-status">
This inventory view is unavailable. Use Ingredient Usage for the server-backed consumption report and Recipes to review saved recipe coverage.
          </div>
        `;
      } else {
        const ingredientRows = ingredientDrafts.length
          ? ingredientDrafts.map(item => {
              const lastAdded = getLastIngredientAddition(item.id);
              return `
              <tr>
                <td>
                  <strong>${escapeHtml(item.name)}</strong>
                  <div style="margin-top:3px;color:var(--muted);font-size:11px;">
                    ${escapeHtml(item.category || "Uncategorized")}
                  </div>
                  <div class="inventory-last-added">
                    ${lastAdded
                      ? `Last added ${escapeHtml(formatInventoryQuantity(lastAdded.quantityDelta, item.baseUnit))} · ${escapeHtml(formatInventoryDate(lastAdded.createdAt))}`
                      : "No stock additions recorded yet"}
                  </div>
                </td>

                <td>${item.baseUnit === "g" ? "kg" : item.baseUnit === "ml" ? "L" : "pcs"}</td>
                <td>
                  <strong style="color:${Number(item.currentStock || 0) < 0 ? "var(--danger)" : "inherit"};">${escapeHtml(formatInventoryQuantity(item.currentStock || 0, item.baseUnit))}</strong>
                  ${Number(item.currentStock || 0) < 0 ? `<div style="margin-top:3px;color:var(--danger);font-size:10px;font-weight:850;">SHORTAGE</div>` : Number(item.currentStock || 0) === 0 ? `<div style="margin-top:3px;color:var(--muted);font-size:10px;font-weight:750;">OUT OF STOCK</div>` : ""}
                </td>
                <td>${item.costPerUnit === null ? "Not entered" : `₹${(Number(item.costPerUnit) * (item.baseUnit === "g" || item.baseUnit === "ml" ? 1000 : 1)).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / ${item.baseUnit === "g" ? "kg" : item.baseUnit === "ml" ? "L" : "pcs"}`}</td>

                <td>
                  <button
                    type="button"
                    class="icon-btn icon-btn-light"
                    data-edit-ingredient="${escapeHtml(item.id)}"
                    aria-label="Edit ${escapeHtml(item.name)}"
                    title="Edit ingredient"
                  >
                    <i class="ph-bold ph-pencil-simple"></i>
                  </button>
                  <button
                    type="button"
                    class="icon-btn icon-btn-light"
                    data-delete-ingredient="${escapeHtml(item.id)}"
                    data-ingredient-name="${escapeHtml(item.name)}"
                    aria-label="Delete ${escapeHtml(item.name)}"
                    title="Delete ingredient"
                    style="color:var(--danger);margin-left:6px;"
                  >
                    <i class="ph-bold ph-trash"></i>
                  </button>
                </td>
              </tr>
            `;
            }).join("")
          : `
              <tr>
                <td colspan="6">
                  <div style="padding:28px 8px;text-align:center;">
                    <i
                      class="ph-bold ph-package"
                      style="font-size:30px;color:var(--forest-700);"
                    ></i>

                    <h3 style="margin:10px 0 5px;font-size:15px;">
                      No ingredients yet
                    </h3>

                    <p style="margin:0;color:var(--muted);font-size:12px;">
                      Add ingredients to prepare the catalogue.
                    </p>
                  </div>
                </td>
              </tr>
            `;

        panel.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
            <div>
              <div class="inventory-view-panel-icon">
                <i class="ph-bold ph-package"></i>
              </div>

              <h2>Ingredients</h2>

              <p>
                Define ingredients, purchasing units and costs. Edit ingredient details in the themed dialog; stock is tracked separately.
              </p>
            </div>

            <button
              type="button"
              class="btn btn-primary"
              data-add-ingredient
            >
              <i class="ph-bold ph-plus"></i>
              Add ingredient
            </button>
          </div>

          <div class="inventory-data-status" style="margin-top:18px;">
            Ingredient details are saved to this restaurant's inventory. Stock quantities are tracked separately in the read-only movement history.
          </div>

          <div style="overflow-x:auto;margin-top:18px;">
            <table class="data-table" style="width:100%;min-width:780px;">
              <thead>
                <tr>
                  <th>Ingredient</th>
                  <th>Base unit</th>
                  <th>Current stock</th>
                  <th>Cost / unit</th>
                  <th>Actions</th>
                </tr>
              </thead>

              <tbody>
                ${ingredientRows}
              </tbody>
            </table>
          </div>
        `;

        panel.querySelector("[data-add-ingredient]")
          ?.addEventListener("click", () => {
            openAppModal({
              title: "Add ingredient",
              subtitle: "Choose whether to create a new ingredient or record stock for one already in your catalogue.",
              body: `
                <div class="inventory-add-choice-grid">
                  <article class="inventory-add-choice-card">
                    <i class="ph-bold ph-package"></i>
                    <strong>Add new ingredient</strong>
                    <p>Create the ingredient, choose kg, litres or pieces, set its purchase price, and record opening stock.</p>
                  </article>
                  <article class="inventory-add-choice-card">
                    <i class="ph-bold ph-tray-arrow-down"></i>
                    <strong>Add to existing ingredient</strong>
                    <p>Choose an existing ingredient and record the amount received. The quantity, date and reason are added to read-only history.</p>
                  </article>
                </div>
              `,
              actions: [
                {
                  label: "Cancel",
                  icon: "ph-x",
                  className: "btn-quiet",
                  onClick: ({ close }) => close()
                },
                {
                  label: "Add to existing",
                  icon: "ph-tray-arrow-down",
                  className: "btn-primary",
                  onClick: ({ close }) => {
                    close();
                    if (!ingredientDrafts.length) {
                      showToast("No ingredients yet", "Create a new ingredient first.", "error");
                      return;
                    }

                    const unitOptions = baseUnit => getInventoryEntryUnits(baseUnit)
                      .map(unit => `<option value="${unit.value}" data-factor="${unit.factor}">${unit.label}</option>`)
                      .join("");
                    const firstIngredient = ingredientDrafts[0];
                    const modal = openAppModal({
                      title: "Add stock to ingredient",
                      subtitle: "Record the receipt as a new permanent inventory event. Previous history cannot be edited.",
                      body: `
                        <form class="inventory-ingredient-form" data-stock-add-form style="margin:0;">
                          <div class="inventory-ingredient-grid">
                            <label class="field" style="grid-column:1/-1;">
                              <span>Ingredient *</span>
                              <select class="field-input" name="ingredientId" required>
                                ${ingredientDrafts.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(getInventoryDisplayUnit(item.baseUnit))}</option>`).join("")}
                              </select>
                            </label>
                            <label class="field" style="grid-column:1/-1;">
                              <span>Quantity to add *</span>
                              <input class="field-input" name="quantity" type="number" min="0.001" step="any" inputmode="decimal" required placeholder="e.g. 2.5" />
                              <small data-stock-unit-help style="color:var(--muted);font-size:11px;line-height:1.5;">Enter quantity in kg.</small>
                            </label>
                          </div>
                          <p data-stock-add-error role="alert" style="margin:12px 0 0;color:var(--danger);font-size:12px;"></p>
                          <p style="margin:10px 0 0;color:var(--muted);font-size:11px;line-height:1.5;">Enter only kg, litres or pieces. Stock history is recorded permanently and cannot be edited.</p>
                        </form>
                      `,
                      actions: [
                        { label: "Cancel", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
                        {
                          label: "Record stock",
                          icon: "ph-check-circle",
                          className: "btn-primary",
                          onClick: async ({ root, close, button }) => {
                            const form = root.querySelector("[data-stock-add-form]");
                            const errorNode = root.querySelector("[data-stock-add-error]");
                            if (!form?.reportValidity()) return;

                            const ingredient = ingredientDrafts.find(item => item.id === form.elements.ingredientId.value);
                            const quantity = Number(form.elements.quantity.value);
                            if (!ingredient || !Number.isFinite(quantity) || quantity <= 0) {
                              errorNode.textContent = "Choose an ingredient and enter a valid positive quantity.";
                              return;
                            }

                            // Staff enter only kg, litres or pieces. Inventory and recipe
                            // math continue to use the database's canonical g/ml/pcs units.
                            const factor = ingredient.baseUnit === "g" || ingredient.baseUnit === "ml" ? 1000 : 1;
                            const baseQuantity = Math.round(quantity * factor * 1000) / 1000;
                            const reason = "Stock received";
                            if (!Number.isFinite(baseQuantity) || baseQuantity <= 0) {
                              errorNode.textContent = "The converted quantity is invalid.";
                              return;
                            }

                            const hasOpening = inventoryMovementDrafts.some(item => item.ingredientId === ingredient.id && item.movementType === "opening_stock");
                            button.disabled = true;
                            button.innerHTML = '<i class="ph ph-spinner-gap ph-spin"></i> Recording...';
                            try {
                              const { data, error: movementError } = await supabase.rpc("admin_record_inventory_movement", {
                                p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null,
                                p_ingredient_id: ingredient.id,
                                p_movement_type: hasOpening ? "received" : "opening_stock",
                                p_quantity: baseQuantity,
                                p_reason: reason
                              });
                              if (movementError) throw movementError;
                              const result = Array.isArray(data) ? data[0] : data;
                              if (result?.ok !== true) throw new Error("The stock movement was not confirmed by the server.");
                              await reloadInventoryDrafts();
                              close();
                              showToast("Stock recorded", `${ingredient.name}: +${formatInventoryQuantity(baseQuantity, ingredient.baseUnit)} · ${formatInventoryDate(Date.now())}`, "success");
                              renderInventoryView();
                            } catch (stockError) {
                              button.disabled = false;
                              button.innerHTML = '<i class="ph ph-check-circle" style="font-size:22px;margin-right:2px;"></i>Record stock';
                              errorNode.textContent = stockError.message || "The stock receipt could not be saved.";
                            }
                          }
                        }
                      ]
                    });

                    const form = modal.root.querySelector("[data-stock-add-form]");
                    const ingredientSelect = form?.elements.ingredientId;
                    const quantityHelp = form?.querySelector("[data-stock-unit-help]");
                    const updateQuantityUnit = () => {
                      const chosen = ingredientDrafts.find(item => item.id === ingredientSelect?.value);
                      if (!chosen || !quantityHelp) return;
                      quantityHelp.textContent = chosen.baseUnit === "g"
                        ? "Enter the quantity in kilograms (kg)."
                        : chosen.baseUnit === "ml"
                          ? "Enter the quantity in litres (L)."
                          : "Enter the quantity in pieces (pcs).";
                    };
                    ingredientSelect?.addEventListener("change", updateQuantityUnit);
                    updateQuantityUnit();
                    form?.elements.quantity?.focus();
                  }
                },
                {
                  label: "Add new ingredient",
                  icon: "ph-plus-circle",
                  className: "btn-quiet",
                  onClick: ({ close }) => {
                    close();
                    const createModal = openAppModal({
                      title: "Create ingredient",
                      subtitle: "Set the ingredient's purchase unit, price and opening quantity.",
                      body: `
                        <form class="inventory-ingredient-form" data-modal-ingredient-form style="margin:0;">
                          <div class="inventory-ingredient-grid">
                            <label class="field">
                              <span>Ingredient name *</span>
                              <input class="field-input" name="name" type="text" maxlength="100" required placeholder="e.g. Paneer" autocomplete="off" />
                            </label>
                            <label class="field">
                              <span>Category</span>
                              <div class="inventory-category-combobox" data-category-combobox id="inventory-create-category-combobox">
                                <div class="inventory-category-input-wrap">
                                  <input class="field-input" name="category" type="text"
                                    data-category-input role="combobox" aria-autocomplete="list"
                                    aria-expanded="false" aria-controls="inventory-create-category-options"
                                    maxlength="60" autocomplete="off"
                                    placeholder="Type or select a category"
                                    aria-label="Ingredient category" />
                                  <button class="inventory-category-toggle" type="button"
                                    data-category-toggle aria-label="Show categories">
                                    <i class="ph ph-caret-down"></i>
                                  </button>
                                </div>
                                <div class="inventory-category-options" id="inventory-create-category-options"
                                  data-category-options role="listbox" hidden>
                                  ${renderDatabaseIngredientCategoryOptions("inventory-create-category-options")}
                                </div>
                              </div>
                              <small style="color:var(--muted);font-size:11px;line-height:1.5;">
                                Suggestions come from this restaurant's saved ingredient categories. You can also type a new category.
                              </small>
                            </label>
                            <label class="field">
                              <span>Purchase unit *</span>
                              <select class="field-input" name="purchaseUnit" required>
                                <option value="kg">Kilograms (kg)</option>
                                <option value="L">Litres (L)</option>
                                <option value="pcs">Pieces (pcs)</option>
                              </select>
                            </label>
                            <label class="field">
                              <span>Opening quantity *</span>
                              <input class="field-input" name="openingQuantity" type="number" min="0.001" step="any" inputmode="decimal" required placeholder="e.g. 2.5" />
                              <small data-opening-unit-help style="color:var(--muted);font-size:11px;">Enter quantity in kg.</small>
                            </label>
                            <label class="field" style="grid-column:1/-1;">
                              <span data-modal-price-label>Price per kg (₹) *</span>
                              <div style="position:relative;">
                                <span style="position:absolute;left:15px;top:50%;transform:translateY(-50%);color:var(--muted);font-weight:700;pointer-events:none;">₹</span>
                                <input class="field-input" name="purchasePrice" type="number" min="0" step="0.01" inputmode="decimal" style="padding-left:34px;" required placeholder="e.g. 250.00" />
                              </div>
                              <small data-modal-price-help style="color:var(--muted);font-size:11px;line-height:1.5;">Total purchase price for 1 kg, in Indian rupees.</small>
                            </label>
                          </div>
                          <p data-modal-ingredient-error role="alert" style="margin:12px 0 0;color:var(--danger);font-size:12px;"></p>
                        </form>
                      `,
                      actions: [
                        { label: "Cancel", icon: "ph-x", className: "btn-quiet", onClick: ({ close: closeCreate }) => closeCreate() },
                        {
                          label: "Create & record stock",
                          icon: "ph-check-circle",
                          className: "btn-primary",
                          onClick: async ({ root, close: closeCreate, button }) => {
                            const form = root.querySelector("[data-modal-ingredient-form]");
                            const errorNode = root.querySelector("[data-modal-ingredient-error]");
                            if (!form?.reportValidity()) return;
                            const name = form.elements.name.value.trim();
                            const category = normalizeIngredientCategory(form.elements.category.value);
                            form.elements.category.value = category;
                            const purchaseUnit = form.elements.purchaseUnit.value;
                            const openingQuantity = Number(form.elements.openingQuantity.value);
                            const purchasePrice = Number(form.elements.purchasePrice.value);
                            const baseUnit = purchaseUnit === "kg" ? "g" : purchaseUnit === "L" ? "ml" : "pcs";
                            const factor = purchaseUnit === "kg" || purchaseUnit === "L" ? 1000 : 1;
                            const costPerUnit = purchasePrice / factor;
                            if (!name || !Number.isFinite(openingQuantity) || openingQuantity <= 0 || !Number.isFinite(purchasePrice) || purchasePrice < 0) {
                              errorNode.textContent = "Enter a name, positive opening quantity and a valid non-negative price.";
                              return;
                            }
                            if (ingredientDrafts.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
                              errorNode.textContent = "An ingredient with this name already exists. Use Add to existing ingredient instead.";
                              return;
                            }
                            button.disabled = true;
                            button.innerHTML = '<i class="ph ph-spinner-gap ph-spin"></i> Saving...';
                            try {
                              const { data: saveData, error: saveError } = await supabase.rpc("admin_save_ingredient", {
                                p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null,
                                p_ingredient_id: null,
                                p_payload: { name, category, baseUnit, reorderLevel: 0, costPerUnit }
                              });
                              if (saveError) throw saveError;
                              const saved = Array.isArray(saveData) ? saveData[0] : saveData;
                              const ingredient = saved?.ingredient || saved?.record || null;
                              const ingredientId = ingredient?.id || saved?.ingredient_id || saved?.id;
                              if (saved?.ok !== true || !ingredientId) throw new Error("Ingredient creation was not confirmed by the server; opening stock was not recorded.");
                              const internalQuantity = Math.round(openingQuantity * factor * 1000) / 1000;
                              const { data: movementData, error: movementError } = await supabase.rpc("admin_record_inventory_movement", {
                                p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null,
                                p_ingredient_id: ingredientId,
                                p_movement_type: "opening_stock",
                                p_quantity: internalQuantity,
                                p_reason: "Opening stock · initial inventory"
                              });
                              if (movementError) throw movementError;
                              const movementResult = Array.isArray(movementData) ? movementData[0] : movementData;
                              if (movementResult?.ok !== true) throw new Error("Ingredient was created, but opening stock was not confirmed. Reopen Add to existing and record the quantity.");
                              await reloadInventoryDrafts();
                              closeCreate();
                              showToast("Ingredient created", `${name}: ${openingQuantity.toLocaleString("en-IN")} ${purchaseUnit} · ₹${purchasePrice.toLocaleString("en-IN", {minimumFractionDigits:2, maximumFractionDigits:2})} per ${purchaseUnit}`, "success");
                              renderInventoryView();
                            } catch (saveError) {
                              errorNode.textContent = saveError.message || "The ingredient and opening stock could not be saved.";
                              button.disabled = false;
                              button.innerHTML = '<i class="ph-bold ph-check-circle"></i> Create & record stock';
                            }
                          }
                        }
                      ]
                    });
                    const form = createModal.root?.querySelector("[data-modal-ingredient-form]");
                    bindInventoryCategoryCombobox(createModal.root);
                    const createCategoryInput = form?.elements.category;
                    createCategoryInput?.addEventListener("blur", () => {
                      createCategoryInput.value = normalizeIngredientCategory(createCategoryInput.value);
                    });
                    createCategoryInput?.addEventListener("change", () => {
                      createCategoryInput.value = normalizeIngredientCategory(createCategoryInput.value);
                    });
                    const updateUnitLabels = () => {
                      if (!form) return;
                      const unit = form.elements.purchaseUnit.value;
                      const configs = {
                        kg: { price: "Price per kg (₹) *", priceHelp: "Total purchase price for 1 kg, in Indian rupees.", qty: "Enter quantity in kg.", placeholder: "e.g. 250.00" },
                        L: { price: "Price per litre (₹) *", priceHelp: "Total purchase price for 1 litre, in Indian rupees.", qty: "Enter quantity in litres.", placeholder: "e.g. 120.00" },
                        pcs: { price: "Price per piece (₹) *", priceHelp: "Purchase price for one piece, in Indian rupees.", qty: "Enter quantity in pieces.", placeholder: "e.g. 12.00" }
                      };
                      const config = configs[unit];
                      form.querySelector("[data-modal-price-label]").textContent = config.price;
                      form.querySelector("[data-modal-price-help]").textContent = config.priceHelp;
                      form.querySelector("[data-opening-unit-help]").textContent = config.qty;
                      form.elements.purchasePrice.placeholder = config.placeholder;
                    };
                    form?.elements.purchaseUnit.addEventListener("change", updateUnitLabels);
                    updateUnitLabels();
                    requestAnimationFrame(() => form?.elements.name?.focus());
                  }
                }
              ]
            });
          });

        panel.querySelectorAll("[data-edit-ingredient]")
          .forEach(button => {
            button.addEventListener("click", () => {
              const ingredient = ingredientDrafts.find(
                item => item.id === button.dataset.editIngredient
              );
              if (!ingredient) return;

              const purchaseUnit = getInventoryDisplayUnit(ingredient.baseUnit);
              const unitFactor = ingredient.baseUnit === "g" || ingredient.baseUnit === "ml"
                ? 1000
                : 1;
              const displayedPrice = ingredient.costPerUnit == null
                ? ""
                : (Number(ingredient.costPerUnit) * unitFactor).toFixed(2);

              const editModal = openAppModal({
                title: "Edit ingredient",
                subtitle: "Update the ingredient details and purchasing price. Existing stock history and recipe units will be preserved.",
                body: `
                  <form class="inventory-ingredient-form" data-edit-ingredient-form style="margin:0;">
                    <div class="inventory-ingredient-grid">
                      <label class="field ingredient-name-field">
                        <span>Ingredient name *</span>
                        <input
                          class="field-input ingredient-name-input"
                          name="name"
                          type="text"
                          required
                          maxlength="120"
                          autocomplete="off"
                          value="${escapeHtml(ingredient.name)}"
                          placeholder="e.g. Almonds"
                        />
                      </label>

                      <label class="field">
                        <span>Category</span>
                        <div class="inventory-category-combobox" data-category-combobox id="inventory-edit-category-combobox">
                          <div class="inventory-category-input-wrap">
                            <input class="field-input" name="category" type="text"
                              data-category-input role="combobox" aria-autocomplete="list"
                              aria-expanded="false" aria-controls="inventory-edit-category-options"
                              maxlength="60" autocomplete="off"
                              value="${escapeHtml(normalizeIngredientCategory(ingredient.category || ""))}"
                              placeholder="Type or select a category" aria-label="Ingredient category" />
                            <button class="inventory-category-toggle" type="button"
                              data-category-toggle aria-label="Show categories">
                              <i class="ph ph-caret-down"></i>
                            </button>
                          </div>
                          <div class="inventory-category-options" id="inventory-edit-category-options"
                            data-category-options role="listbox" hidden>
                            ${renderDatabaseIngredientCategoryOptions("inventory-edit-category-options", ingredient.category || "")}
                          </div>
                        </div>
                        <small style="color:var(--muted);font-size:11px;line-height:1.5;">
                          Suggestions come from this restaurant's saved ingredient categories. You can also type a new category.
                        </small>
                      </label>

                      <label class="field">
                        <span>Base measurement unit</span>
                        <select class="field-input" name="purchaseUnit" disabled aria-describedby="edit-ingredient-unit-help" style="opacity:1;color:var(--forest-950);background:#f5f7f2;cursor:not-allowed;-webkit-text-fill-color:var(--forest-950);">
                          <option value="kg" ${purchaseUnit === "kg" ? "selected" : ""}>Kilograms (kg)</option>
                          <option value="L" ${purchaseUnit === "L" ? "selected" : ""}>Litres (L)</option>
                          <option value="pcs" ${purchaseUnit === "pcs" ? "selected" : ""}>Pieces (pcs)</option>
                        </select>
                        <small id="edit-ingredient-unit-help" style="color:var(--muted);font-size:11px;line-height:1.5;">The unit is locked to protect saved recipes and historical stock movements.</small>
                      </label>

                      <label class="field">
                        <span data-edit-price-label>Price per ${escapeHtml(purchaseUnit)} (₹, optional)</span>
                        <div style="position:relative;">
                          <span style="position:absolute;left:15px;top:50%;transform:translateY(-50%);color:var(--muted);font-weight:700;pointer-events:none;">₹</span>
                          <input class="field-input" name="purchasePrice" type="number" min="0" step="0.01" inputmode="decimal" style="padding-left:34px;" value="${escapeHtml(displayedPrice)}" placeholder="e.g. 250.00" />
                        </div>
                        <small data-edit-price-help style="color:var(--muted);font-size:11px;line-height:1.5;">${purchaseUnit === "kg" ? "Price for 1 kilogram." : purchaseUnit === "L" ? "Price for 1 litre." : "Price for one piece."} Values are saved in the database's existing internal unit.</small>
                      </label>
                    </div>
                    <p data-edit-ingredient-error role="alert" style="margin:12px 0 0;color:var(--danger);font-size:12px;"></p>
                  </form>
                `,
                actions: [
                  {
                    label: "Cancel",
                    icon: "ph-x",
                    className: "btn-quiet",
                    onClick: ({ close }) => close()
                  },
                  {
                    label: "Save changes",
                    icon: "ph-check-circle",
                    className: "btn-primary",
                    onClick: async ({ root, close, button: saveButton }) => {
                      const form = root.querySelector("[data-edit-ingredient-form]");
                      const errorNode = root.querySelector("[data-edit-ingredient-error]");
                      if (!form?.reportValidity()) return;

                      const name = form.elements.name.value.trim();
                      const category = normalizeIngredientCategory(form.elements.category.value);
                      form.elements.category.value = category;
                      const priceText = form.elements.purchasePrice.value.trim();
                      const purchasePrice = priceText === "" ? null : Number(priceText);

                      if (!name || (purchasePrice !== null && (!Number.isFinite(purchasePrice) || purchasePrice < 0))) {
                        errorNode.textContent = "Enter a valid ingredient name and a non-negative price.";
                        return;
                      }

                      if (ingredientDrafts.some(item =>
                        item.id !== ingredient.id &&
                        item.name.toLocaleLowerCase() === name.toLocaleLowerCase()
                      )) {
                        errorNode.textContent = "An ingredient with this name already exists in the inventory.";
                        form.elements.name.focus();
                        return;
                      }

                      // UI price is per kg/L/pcs. Keep DB storage canonical (g/ml/pcs).
                      const costPerUnit = purchasePrice === null
                        ? null
                        : purchasePrice / unitFactor;

                      saveButton.disabled = true;
                      saveButton.innerHTML = '<i class="ph ph-spinner-gap ph-spin" style="font-size:22px;margin-right:2px;"></i>Saving...';

                      try {
                        const { data: saveData, error: saveError } = await supabase.rpc("admin_save_ingredient", {
                          p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null,
                          p_ingredient_id: ingredient.id,
                          p_payload: {
                            name,
                            category,
                            baseUnit: ingredient.baseUnit,
                            reorderLevel: Number(ingredient.reorderLevel ?? 0),
                            costPerUnit
                          }
                        });
                        if (saveError) throw saveError;
                        const saveResult = Array.isArray(saveData) ? saveData[0] : saveData;
                        if (saveResult?.ok !== true) {
                          throw new Error("The server did not confirm that the ingredient was saved.");
                        }

                        await reloadInventoryDrafts();
                        close();
                        showToast("Ingredient updated", `${name} was saved successfully.`, "success");
                        renderInventoryView();
                      } catch (saveError) {
                        errorNode.textContent = saveError.message || "The ingredient could not be saved.";
                        saveButton.disabled = false;
                        saveButton.innerHTML = '<i class="ph ph-check-circle" style="font-size:22px;margin-right:2px;"></i>Save changes';
                      }
                    }
                  }
                ]
              });

              bindInventoryCategoryCombobox(editModal.root);
              const editCategoryInput = editModal.root.querySelector(
                '[data-edit-ingredient-form] [name="category"]'
              );
              editCategoryInput?.addEventListener("blur", () => {
                editCategoryInput.value = normalizeIngredientCategory(editCategoryInput.value);
              });
              editCategoryInput?.addEventListener("change", () => {
                editCategoryInput.value = normalizeIngredientCategory(editCategoryInput.value);
              });

              requestAnimationFrame(() => {
                editModal.root.querySelector('[data-edit-ingredient-form] [name="name"]')?.focus();
              });
            });
          });

        panel.querySelectorAll("[data-delete-ingredient]")
          .forEach(button => {
            button.addEventListener("click", async () => {
              const ingredientId = button.dataset.deleteIngredient;
              const ingredientName = button.dataset.ingredientName || "this ingredient";

              
              openAppModal({
                title: "Delete ingredient?",
                subtitle: `You are about to delete ${ingredientName}.`,
                body: `
                  <div class="danger-confirm">
                    <div class="danger-confirm-icon">
                      <i class="ph ph-trash"></i>
                    </div>
                    <h3>Delete ${escapeHtml(ingredientName)}?</h3>
                    <p>
                      This action cannot be undone. Ingredients used in recipes
                      or stock history cannot be permanently deleted.
                    </p>
                  </div>
                `,
                actions: [
                  {
                    label: "Cancel",
                    icon: "ph-x",
                    className: "btn-quiet",
                    onClick: ({ close }) => close()
                  },
                  {
                    label: "Delete ingredient",
                    icon: "ph-trash",
                    className: "btn-danger",
                    onClick: async ({ close, button: modalButton }) => {
                      modalButton.disabled = true;
                      modalButton.innerHTML =
                        '<i class="ph ph-spinner-gap ph-spin"></i> Deleting...';

                      try {
                        const { data, error } = await supabase.rpc(
                          "admin_delete_ingredient",
                          {
                            p_panel_token:
                              window.__RMS_PANEL_ACCESS__?.token || null,
                            p_ingredient_id: ingredientId
                          }
                        );

                        if (error) throw error;

                        if (data?.ok !== true) {
                          throw new Error("The ingredient could not be deleted.");
                        }

                        await reloadInventoryDrafts();

                        close();

                        showToast(
                          "Ingredient deleted",
                          `${ingredientName} was removed from inventory.`,
                          "success"
                        );

                        renderInventoryView();
                      } catch (deleteError) {
                        modalButton.disabled = false;
                        modalButton.innerHTML =
                          '<i class="ph ph-trash"></i> Delete ingredient';

                        showToast(
                          "Cannot delete ingredient",
                          deleteError.message || "Please try again.",
                          "error"
                        );
                      }
                    }
                  }
                ]
              });

            });
          });

      }

      tabs.forEach(tab => {
        const selected = tab.dataset.inventoryView === activeView;
        tab.classList.toggle("active", selected);
        tab.setAttribute("aria-selected", String(selected));
      });
      updateInventorySummary();
    }

    tabs.forEach(tab => {
      tab.addEventListener("click", () => {
        activeView = tab.dataset.inventoryView;
        renderInventoryView();
      });
    });

    renderInventoryView();
  }

  async function renderOrders() {
    // All report dates use the same shared range model and local calendar semantics.
    const currentRange = orderDateRange;

    area.innerHTML = `
      <style>${DATE_RANGE_STYLES}</style>
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
      
      <!-- Shared date and date-range filter -->
      ${renderDateRangePicker("orders", currentRange)}

      <section class="admin-panel">
        <div class="admin-list-scroll" id="orders-list">
          <div class="empty-state"><i class="ph ph-spinner-gap ph-spin"></i><strong>Loading orders...</strong></div>
        </div>
      </section>`;
    
    bindDateRangePicker(area, "orders", currentRange, nextRange => {
      orderDateRange = nextRange;
      renderOrders();
    });

    const list = area.querySelector("#orders-list");
    const exportBtn = area.querySelector("#export-excel-btn");

    try {
        // 1. Build Query with Strict Time Range Logic
        let query = supabase.from("orders")
          .select("*, order_items(*), dining_sessions(status, payment_method, payment_status, table_id, closed_at, bill_subtotal, bill_cgst, bill_sgst, bill_rounding, bill_grand_total, bill_cgst_rate, bill_sgst_rate, bill_discount_type, bill_discount_value, bill_discount_amount, bill_discount_reason)")
          .eq("restaurant_id", window.__ACTIVE_TENANT__.id);

        if (currentRange.startDate && currentRange.endDate) {
            query = query.gte("created_at", indiaDateStartISOString(currentRange.startDate))
              .lt("created_at", indiaDateAfterISOString(currentRange.endDate));
        }

        // Avoid unbounded client pulls. The range is exact; the current UI keeps
        // a conservative result cap until pagination is implemented.
        query = query.limit(currentRange.preset === "all" ? 1000 : 2000); 

        const { data: rawOrders, error } = await query.order("created_at", { ascending: false });
        if (error) throw error;

        // 2. Filter out open sessions that haven't requested bills yet
        const validOrders = rawOrders.filter(o =>
            String(o.status || "").toLowerCase() !== "cancelled" &&
            (
              o.order_type === "takeaway" ||
              (o.dining_sessions && ["closed", "bill_requested", "bill_ready"].includes(o.dining_sessions.status))
            )
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
                    order_items: (o.order_items || [])
                      .filter(item => String(item.serving_status || "").toLowerCase() !== "cancelled")
                      .map(item => ({
                        ...item,
                        receipt_round_number: Number(o.round_number || 0),
                        receipt_order_created_at: o.created_at
                      }))
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
                master.order_items.push(...(o.order_items || [])
                  .filter(item => String(item.serving_status || "").toLowerCase() !== "cancelled")
                  .map(item => ({
                    ...item,
                    receipt_round_number: Number(o.round_number || 0),
                    receipt_order_created_at: o.created_at
                  })));
                
                // Keep the timestamp anchored to their FIRST round (when they sat down)
                if (new Date(o.created_at) < new Date(master.created_at)) {
                    master.created_at = o.created_at;
                }
            }
        });

        // Keep Admin receipt data aligned with the canonical Cashier bill:
        // omit cancelled items/orders and use the earliest order number for a session.
        const orders = Array.from(groupedOrdersMap.values())
          .filter(o => String(o.status || "").toLowerCase() !== "cancelled" && o.order_items && o.order_items.length > 0)
          .map(o => {
            const orderNumbers = (o.all_order_numbers || []).filter(n => Number.isFinite(n) && n > 0);
            const normalized = {
              ...o,
              order_number: orderNumbers.length ? Math.min(...orderNumbers) : o.order_number
            };

            // Dining sessions are the canonical source for consolidated bill totals.
            // This also ensures an Admin-applied discount matches Cashier reprints.
            if (o.session_id && o.dining_sessions) {
              const session = o.dining_sessions;
              normalized.subtotal = Number(session.bill_subtotal ?? o.subtotal ?? 0);
              normalized.cgst = Number(session.bill_cgst ?? o.cgst ?? 0);
              normalized.sgst = Number(session.bill_sgst ?? o.sgst ?? 0);
              normalized.rounding = Number(session.bill_rounding ?? o.rounding ?? 0);
              normalized.grand_total = Number(session.bill_grand_total ?? o.grand_total ?? 0);
              normalized.bill_discount_type = session.bill_discount_type || null;
              normalized.bill_discount_value = Number(session.bill_discount_value || 0);
              normalized.bill_discount_amount = Number(session.bill_discount_amount || 0);
              normalized.bill_discount_reason = session.bill_discount_reason || "";
              normalized.payment_status = session.payment_status || o.payment_status;
            }
            return normalized;
          });

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
                        
                        const rangeStr = currentRange.preset === "all"
                          ? "All_Time"
                          : `${currentRange.startDate}_to_${currentRange.endDate}`;
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
                ${managerMode ? "" : `
                  <button class="icon-btn icon-btn-danger" data-delete-order="${o.id}" title="Delete Order"><i class="ph-bold ph-trash"></i></button>
                `}
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
    if (managerMode) {
      showToast(
        "Admin access required",
        "Historical order deletion is reserved for Admin.",
        "error"
      );
      return;
    }

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
                const { error } = await supabase.rpc("delete_pos_order", {
                  p_order_id: id,
                  p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null
                });
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
    const isBillReady = Boolean(
      order.dining_sessions && order.dining_sessions.status === "bill_ready"
    );

    const extraActions = [];
    const panelAccess = window.__RMS_PANEL_ACCESS__;
    const isAdminPanel = !managerMode && panelAccess?.panelId === "admin" &&
      Boolean(panelAccess?.token) && Number.isFinite(panelAccess?.expiresAt) &&
      panelAccess.expiresAt > Date.now();
    const sessionStatus = String(order.dining_sessions?.status || "").toLowerCase();
    const sessionPaymentStatus = String(order.dining_sessions?.payment_status || order.payment_status || "pending").toLowerCase();
    const isSessionBill = Boolean(order.session_id);
    const isEditableTakeawayBill = order.order_type === "takeaway" &&
      ["bill_ready", "issued"].includes(String(order.billing_status || "").toLowerCase()) &&
      !["closed"].includes(String(order.billing_status || "").toLowerCase()) &&
      !["completed", "cancelled"].includes(String(order.status || "").toLowerCase()) &&
      String(order.payment_status || "pending").toLowerCase() !== "paid";
    const isEditableSessionBill = isSessionBill && sessionStatus === "bill_ready" &&
      sessionPaymentStatus !== "paid" && !order.dining_sessions?.closed_at;
    const canApplyBillDiscount = isAdminPanel && (isEditableSessionBill || isEditableTakeawayBill);
    const currentDiscountType = String(
      order.bill_discount_type || order.discount_type || order.dining_sessions?.bill_discount_type || ""
    ).toLowerCase();
    const currentDiscountValue = Number(
      order.bill_discount_value ?? order.discount_value ?? order.dining_sessions?.bill_discount_value ?? 0
    );
    const currentDiscountAmount = Number(
      order.bill_discount_amount ?? order.discount_amount ?? order.dining_sessions?.bill_discount_amount ?? 0
    );
    const currentDiscountReason = String(
      order.bill_discount_reason ?? order.discount_reason ?? order.dining_sessions?.bill_discount_reason ?? ""
    );

    if (canApplyBillDiscount) {
      extraActions.push({
        label: currentDiscountAmount > 0 ? "Edit Discount" : "Discount",
        icon: "ph-bold ph-percent",
        className: "btn-quiet",
        style: "font-weight:850;",
        onClick: ({ close: closeReceipt }) => {
          const subtotal = Math.max(0, Number(order.subtotal || 0));
          const currentType = currentDiscountType === "amount" || currentDiscountType === "percent"
            ? currentDiscountType
            : "percent";
          const { root: discountRoot, close: closeDiscount } = openAppModal({
            title: currentDiscountAmount > 0 ? "Edit bill discount" : "Apply bill discount",
            subtitle: "Available only while this bill is unpaid and open.",
            body: `
              <div class="tf-admin-discount-form">
                <div class="tf-admin-discount-summary">
                  <span>Bill subtotal</span>
                  <strong>${escapeHtml(settings.currency_symbol || "₹")}${subtotal.toFixed(2)}</strong>
                </div>
                ${currentDiscountAmount > 0 ? `<div class="tf-admin-discount-summary"><span>Current discount</span><strong>−${escapeHtml(settings.currency_symbol || "₹")}${currentDiscountAmount.toFixed(2)}</strong></div>` : ""}
                <label class="field"><span>Discount type *</span>
                  <select data-admin-discount-type>
                    <option value="percent" ${currentType === "percent" ? "selected" : ""}>Percentage (%)</option>
                    <option value="amount" ${currentType === "amount" ? "selected" : ""}>Fixed amount (₹)</option>
                  </select>
                </label>
                <label class="field"><span data-admin-discount-value-label>Discount percentage *</span>
                  <input data-admin-discount-value type="number" min="0" max="${currentType === "percent" ? "100" : subtotal.toFixed(2)}" step="0.01" inputmode="decimal" value="${currentDiscountAmount > 0 ? escapeHtml(String(currentDiscountValue)) : ""}" placeholder="${currentType === "percent" ? "e.g. 10" : "e.g. 100"}" required />
                </label>
                <label class="field"><span>Reason * (required for non-zero discounts)</span>
                  <input data-admin-discount-reason type="text" maxlength="300" value="${escapeHtml(currentDiscountReason)}" placeholder="e.g. Customer loyalty or service recovery" autocomplete="off" />
                </label>
                <p class="tf-admin-discount-error" data-admin-discount-error role="alert" hidden></p>
                <div class="tf-admin-discount-preview" data-admin-discount-preview role="status">Enter a discount to see the estimated reduction.</div>
                <p class="tf-admin-discount-note">Discount is applied before GST. The server recalculates tax and rounding. Enter 0 to remove an existing discount. Paid or closed bills cannot be changed.</p>
              </div>
            `,
            actions: [
              { label: "Cancel", className: "btn-quiet", onClick: ({ close }) => close() },
              {
                label: currentDiscountAmount > 0 ? "Save discount" : "Apply discount",
                icon: "ph-check",
                className: "btn-primary",
                onClick: async ({ root, close, button }) => {
                  const type = root.querySelector("[data-admin-discount-type]")?.value;
                  const rawValue = root.querySelector("[data-admin-discount-value]")?.value;
                  const reason = String(root.querySelector("[data-admin-discount-reason]")?.value || "").trim();
                  const value = rawValue === "" ? NaN : Number(rawValue);
                  const errorNode = root.querySelector("[data-admin-discount-error]");
                  const setDiscountValidationError = (message) => {
                    if (errorNode) {
                      errorNode.textContent = message;
                      errorNode.hidden = !message;
                    } else if (message) {
                      showToast("Invalid discount", message, "error");
                    }
                  };
                  if (!Number.isFinite(value) || value < 0 || (type === "percent" && value > 100) || (type === "amount" && value > subtotal)) {
                    setDiscountValidationError("Enter a valid discount. Percentage must be 0–100%; rupee discount cannot exceed the subtotal.");
                    return;
                  }
                  if (value > 0 && !reason) {
                    setDiscountValidationError("Enter a reason before applying a non-zero discount.");
                    root.querySelector("[data-admin-discount-reason]")?.focus();
                    return;
                  }
                  setDiscountValidationError("");
                  const access = window.__RMS_PANEL_ACCESS__;
                  if (!access?.token || access.panelId !== "admin" || !Number.isFinite(access.expiresAt) || access.expiresAt <= Date.now()) {
                    showToast("Admin access expired", "Verify the Admin PIN again before changing a bill.", "error");
                    return;
                  }
                  button.disabled = true;
                  const originalHTML = button.innerHTML;
                  button.innerHTML = '<i class="ph ph-spinner-gap ph-spin"></i> Saving…';
                  try {
                    const { data, error } = await supabase.rpc("apply_admin_bill_discount", {
                      p_session_id: isSessionBill ? order.session_id : null,
                      p_order_id: isSessionBill ? null : order.id,
                      p_discount_type: type,
                      p_discount_value: value,
                      p_reason: reason,
                      p_panel_token: access.token
                    });
                    if (error) throw error;
                    const result = Array.isArray(data) ? data[0] : data;
                    if (!result || result.ok !== true) throw new Error("The server did not confirm the discount update.");

                    order.subtotal = Number(result.subtotal ?? order.subtotal ?? 0);
                    order.cgst = Number(result.cgst ?? order.cgst ?? 0);
                    order.sgst = Number(result.sgst ?? order.sgst ?? 0);
                    order.rounding = Number(result.rounding ?? order.rounding ?? 0);
                    order.grand_total = Number(result.grand_total ?? order.grand_total ?? 0);
                    if (isSessionBill) {
                      order.bill_discount_type = result.discount_type || null;
                      order.bill_discount_value = Number(result.discount_value || 0);
                      order.bill_discount_amount = Number(result.discount_amount || 0);
                      order.bill_discount_reason = result.discount_reason || "";
                      order.dining_sessions = {
                        ...order.dining_sessions,
                        status: result.status || order.dining_sessions?.status,
                        payment_status: result.payment_status || order.dining_sessions?.payment_status,
                        bill_subtotal: order.subtotal,
                        bill_cgst: order.cgst,
                        bill_sgst: order.sgst,
                        bill_rounding: order.rounding,
                        bill_grand_total: order.grand_total,
                        bill_discount_type: order.bill_discount_type,
                        bill_discount_value: order.bill_discount_value,
                        bill_discount_amount: order.bill_discount_amount,
                        bill_discount_reason: order.bill_discount_reason
                      };
                    } else {
                      order.discount_type = result.discount_type || null;
                      order.discount_value = Number(result.discount_value || 0);
                      order.discount_amount = Number(result.discount_amount || 0);
                      order.discount_reason = result.discount_reason || "";
                    }
                    closeDiscount();
                    closeReceipt();
                    showToast(
                      Number(result.discount_amount || 0) > 0 ? "Discount saved" : "Discount removed",
                      `Updated bill total: ${escapeHtml(settings.currency_symbol || "₹")}${Number(result.grand_total || 0).toFixed(2)}.`,
                      "success"
                    );
                    await reload();
                    showAdminReceiptPreview(order);
                  } catch (error) {
                    showToast("Discount not saved", error.message || "The bill was not changed.", "error");
                    button.disabled = false;
                    button.innerHTML = originalHTML;
                  }
                }
              }
            ]
          });

          const typeControl = discountRoot.querySelector("[data-admin-discount-type]");
          const valueControl = discountRoot.querySelector("[data-admin-discount-value]");
          const valueLabel = discountRoot.querySelector("[data-admin-discount-value-label]");
          const preview = discountRoot.querySelector("[data-admin-discount-preview]");
          const reasonControl = discountRoot.querySelector("[data-admin-discount-reason]");
          const errorNode = discountRoot.querySelector("[data-admin-discount-error]");
          const updateDiscountPreview = () => {
            const type = typeControl?.value || "percent";
            const raw = valueControl?.value;
            const value = raw === "" ? NaN : Number(raw);
            if (valueLabel) valueLabel.textContent = type === "percent" ? "Discount percentage *" : "Discount amount (₹) *";
            if (valueControl) valueControl.max = type === "percent" ? "100" : String(subtotal);
            if (!Number.isFinite(value) || value < 0 || (type === "percent" && value > 100) || (type === "amount" && value > subtotal)) {
              if (preview) preview.textContent = "Enter a valid discount. Fixed discount cannot exceed the bill subtotal.";
              return;
            }
            const amount = Math.min(subtotal, Math.round((type === "percent" ? subtotal * value / 100 : value) * 100) / 100);
            if (preview) preview.textContent = amount > 0
              ? `Estimated discount: ${settings.currency_symbol || "₹"}${amount.toFixed(2)}. GST and final rounding are recalculated when saved.`
              : "No discount will be applied. This removes any current discount.";
          };
          const clearDiscountValidationError = () => {
            if (!errorNode) return;
            errorNode.textContent = "";
            errorNode.hidden = true;
          };
          typeControl?.addEventListener("change", () => {
            updateDiscountPreview();
            clearDiscountValidationError();
          });
          valueControl?.addEventListener("input", () => {
            updateDiscountPreview();
            clearDiscountValidationError();
          });
          reasonControl?.addEventListener("input", clearDiscountValidationError);
          updateDiscountPreview();
        }
      });
    }

    if (isBillReady) {
      extraActions.push({
        label: "Paid",
        className: "btn-primary paid-action-button",
        style: "background: var(--success); border-color: var(--success); color: #fff; font-weight: 900;",
        onClick: ({ close }) => {
          openAppModal({
            title: "Confirm payment",
            subtitle: "Choose the method the customer actually used.",
            body: `<label class="field"><span>Payment method *</span><select data-admin-receipt-payment-method required><option value="upi_qr">UPI QR</option>
<option value="cash">Cash</option>
<option value="card">Card</option>
<option value="bank_transfer">Bank transfer</option></select></label>`,
            actions: [
              { label: "Back", className: "btn-quiet", onClick: ({ close: closeMethodModal }) => closeMethodModal() },
              {
                label: "Confirm payment",
                className: "btn-primary",
                onClick: async ({ root, close: closeMethodModal, button }) => {
                  const method = root.querySelector("[data-admin-receipt-payment-method]")?.value;
                  const access = window.__RMS_PANEL_ACCESS__;
                  if (!["upi_qr", "cash", "card", "bank_transfer"].includes(method)) {
                    showToast("Choose a method", "Select a valid payment method.", "error");
                    return;
                  }
                  if (!access?.token || !["admin", "manager"].includes(access.panelId) || !Number.isFinite(access.expiresAt) || access.expiresAt <= Date.now()) {
                    showToast("Access expired", "Verify the Admin PIN again.", "error");
                    return;
                  }
                  button.disabled = true;
                  try {
                    const { error } = await supabase.rpc("complete_session_payment", {
                      p_session_id: order.session_id,
                      p_payment_method: method,
                      p_panel_token: access.token
                    });
                    if (error) throw error;
                    closeMethodModal();
                    close();
                    const methodLabel = {
                      upi_qr: "UPI QR",
                      cash: "Cash",
                      card: "Card",
                      bank_transfer: "Bank transfer"
                    }[method] || method;
                    showToast("Payment confirmed", `Payment recorded as ${methodLabel}.`, "success");
                    await reload();
                  } catch (error) {
                    showToast("Could not record payment", error.message || "Please try again.", "error");
                    button.disabled = false;
                  }
                }
              }
            ]
          });
        }
      });
    }

    openUniversalReceipt({
      order,
      settings,
      tables,
      paymentMethod: order.dining_sessions?.payment_method || order.payment_method || null,
      items: (order.order_items || [])
        .filter(item => String(item.serving_status || "").toLowerCase() !== "cancelled")
        .sort((a, b) =>
          Number(a.receipt_round_number || 0) - Number(b.receipt_round_number || 0) ||
          (Date.parse(a.receipt_order_created_at || "") || 0) - (Date.parse(b.receipt_order_created_at || "") || 0) ||
          (Date.parse(a.created_at || "") || 0) - (Date.parse(b.created_at || "") || 0)
        ),
      modalTitle: "Order #" + order.order_number + " Bill",
      modalSubtitle: isBillReady
        ? "Print the bill with its payment QR, then confirm payment after staff verifies receipt."
        : "View, save, or reprint this bill.",
      extraActions
    });
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
                const { error: dbError } = await supabase.rpc("admin_mutate_resource", {
                  p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null,
                  p_resource: "cuisines",
                  p_action: "update",
                  p_record_id: cuisineId,
                  p_payload: payload
                });
                if (dbError) throw dbError;
            } else {
                const { error: dbError } = await supabase.rpc("admin_mutate_resource", {
                  p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null,
                  p_resource: "cuisines",
                  p_action: "insert",
                  p_record_id: cuisineId,
                  p_payload: payload
                });
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
            const { error } = await supabase.rpc("admin_mutate_resource", {
              p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null,
              p_resource: "cuisines",
              p_action: "delete",
              p_record_id: cuisine.id,
              p_payload: {}
            }); 
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
    
    area.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => transitionToSection(b.dataset.go)));
    
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
          transitionToSection("orders");
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
      
      const targetCuisines = ["Indian", "Chinese", "Continental", "Mexican", "Global"];
      const menuTree = {};
      const cuisineItemCounts = {};
      
      targetCuisines.forEach(c => { 
          menuTree[c] = {}; 
          cuisineItemCounts[c] = 0; 
      });

      // Cuisine and menu section are stored separately after taxonomy normalization.
      // The prefix fallback keeps legacy rows correctly grouped until migration.
      activeProducts.forEach(p => {
         const parts = String(p.category || "").split(" - ");
         const cName = String(p.cuisine || (parts.length > 1 ? parts[0] : "")).trim();
         const subName = (parts.length > 1 ? parts.slice(1).join(" - ") : parts[0]).trim() || "Other";
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
          <span class="eyebrow">${managerMode ? "Operations" : "Floor layout"}</span>
          <h1>${managerMode ? "Live Tables." : "Live Tables."}</h1>
          <p>${managerMode ? "Monitor occupancy and manage active dining sessions." : "Monitor tables and generate QR codes."}</p>
        </div>
        ${managerMode ? "" : `
          <button class="btn btn-primary" id="add-table"><i class="ph-bold ph-plus"></i> Add</button>
        `}
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
              : managerMode
                ? `<span class="table-state ${t.is_active ? "active" : "inactive"}">${t.is_active ? "Ready" : "Hidden"}</span>`
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

    area.querySelector("#add-table")?.addEventListener(
      "click",
      () => openTableEditor()
    );
    
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
          transitionToSection("orders");
      }
    });
  }

  async function openAdminTableManager(table, session) {
    // Clear temporary green activity alert for this table
    if (window.__tableAlerts) delete window.__tableAlerts[table.id];
    if (window.clearTableAlert) window.clearTableAlert(table.id);
    
    // CRITICAL: Only mark seen_sessions if the bill was ALREADY requested when opening the manager.
    // Otherwise, serving items on an 'open' table would suppress a future Golden Bill Notification!
    if (session && session.id && session.status === "bill_requested") {
        const seenSessions = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_sessions") || "[]"));
        seenSessions.add(session.id);
        localStorage.setItem("fourflavours.seen_sessions", JSON.stringify([...seenSessions]));
    }
    
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
                p_session_id: session.id,
                p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null
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
          (o.order_items || [])
            .filter(oi => String(oi.serving_status || 'pending').toLowerCase() !== 'cancelled')
            .slice()
            .sort((a, b) => {
              const dateDiff = new Date(a.created_at) - new Date(b.created_at);
              return dateDiff !== 0 ? dateDiff : (a.id > b.id ? 1 : -1);
            })
            .forEach(oi => {
              roundItems.push({
                id: oi.id,
                name: oi.name_snapshot,
                price: oi.unit_price,
                quantity: oi.quantity,
                status: String(oi.serving_status || 'pending').toLowerCase(),
                kotReadyPreviousStatus: oi.kot_ready_previous_status || null,
                kotReadyAt: oi.kot_ready_at || null,
                inventoryConsumedAt: oi.inventory_consumed_at || null,
                inventoryUsageCalculatedAt: oi.inventory_usage_calculated_at || null,
                inventoryRecipeSnapshot: Array.isArray(oi.inventory_recipe_snapshot) ? oi.inventory_recipe_snapshot : [],
                inventoryActualUsageSnapshot: Array.isArray(oi.inventory_actual_usage_snapshot) ? oi.inventory_actual_usage_snapshot : []
              });
            });
          displayRounds.push({ id: o.id, round_number: o.round_number || (index+1), items: roundItems, total: o.grand_total });
        });

        const isBillReq = session.status === "bill_requested";

        // Admin table operations use the same Ready/Undo Ready workflow as KOT.
        // A KOT-ready item is stored as served plus a reversible marker; it is not
        // advanced through a separate Admin-only status cycle.
        function isKotReady(item) {
            return item.status === "served" && Boolean(item.kotReadyPreviousStatus);
        }

        function getNextStatusLabel(item) {
            if (isKotReady(item)) return "UNDO READY";
            if (["pending", "preparing", "ready"].includes(item.status)) return "MARK READY";
            if (item.status === "served") return "SERVED";
            return "UNAVAILABLE";
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

        // Once the bill is prepared, Admin may inspect/reprint it but must not
        // mutate KOT state behind a generated bill. Keep UI and RPC eligibility aligned.
        const canChangeKOTStatus = ["open", "bill_requested"].includes(String(session.status || "").toLowerCase());
        const tableReadyItems = canChangeKOTStatus
          ? displayRounds.flatMap(round => round.items).filter(item =>
              ["pending", "preparing", "ready"].includes(item.status) || isKotReady(item)
            )
          : [];
        const tableAlreadyReady = tableReadyItems.length > 0 && tableReadyItems.every(isKotReady);
        const canReadyTable = canChangeKOTStatus && tableReadyItems.some(item =>
          !isKotReady(item) && ["pending", "preparing", "ready"].includes(item.status)
        );
        const hasUnservedItems = displayRounds.some(round =>
            round.items.some(item => !["served", "cancelled"].includes(item.status))
        );

        // 🧠 SCROLL LOCK FIX: Capture the exact scroll position before destroying the old HTML list
        const scrollNode = host.querySelector(".dining-items-list");
        const currentScroll = scrollNode ? scrollNode.scrollTop : 0;

        host.innerHTML = `
          <div class="active-dining-dashboard" style="text-align: left; display: flex; flex-direction: column; flex: 1; min-height: 0;">
            <div class="dining-status-banner" style="flex-shrink: 0; display:flex; align-items:center; gap:10px; ${isBillReq ? 'background: var(--gold-100); color: var(--gold-600); border: 1px solid var(--gold-400);' : ''}">
              <i class="ph-bold ph-${isBillReq ? 'bell-ringing qty-pulse' : 'receipt'}"></i>
              <div style="flex:1; min-width:0;">
                <strong style="${isBillReq ? 'color: var(--gold-600);' : ''}">${isBillReq ? 'Customer Requested Bill' : 'Table Tab is open'}</strong>
                <span>Grand Total: ${money(grandTotal, settings.currency_symbol)}</span>
              </div>
              ${canReadyTable || tableAlreadyReady ? `
                <button class="btn ${tableAlreadyReady ? 'btn-quiet' : 'btn-primary'}" id="admin-table-ready" type="button" style="flex:0 0 auto; min-height:36px; padding:0 10px; font-size:11px; white-space:nowrap;">
                  <i class="ph-bold ph-${tableAlreadyReady ? 'arrow-counter-clockwise' : 'check-circle'}"></i>
                  ${tableAlreadyReady ? 'Undo Ready' : 'Ready table'}
                </button>
              ` : ""}
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
                          <button
                            class="admin-delete-item-btn icon-btn"
                            data-delete-id="${item.id}"
                            ${item.status === "served" ? "hidden disabled" : ""}
                            title="Remove this dish from the active bill"
                            aria-label="Remove ${escapeHtml(item.name)} from the active bill"
                            style="width:30px;height:30px;border-radius:8px;border:none;background:#fee2e2;color:#ef4444;"
                          >
                            <i class="ph-bold ph-trash" style="font-size:15px;"></i>
                          </button>

                          <button class="status-cycle-btn"
                            data-item-id="${item.id}"
                            data-ready-action="${canChangeKOTStatus ? (isKotReady(item) ? 'undo_ready' : (["pending", "preparing", "ready"].includes(item.status) ? 'ready' : '')) : ''}"
                            title="${canChangeKOTStatus ? getNextStatusLabel(item) : 'Bill already prepared'}"
                            aria-label="${canChangeKOTStatus ? getNextStatusLabel(item) : 'Bill already prepared'} for ${escapeHtml(item.name)}"
                            style="padding: 6px 12px; font-size: 11px; font-weight: 900; text-transform: uppercase; border-radius: 20px; border: 1px solid transparent; transition: all 0.15s ease; display: inline-flex; align-items: center; gap: 4px; ${getStatusColor(isKotReady(item) ? 'ready' : item.status)}${!canChangeKOTStatus || (item.status === "served" && !isKotReady(item)) ? "cursor: default; opacity: 0.75;" : "cursor: pointer;"}"
                            ${!canChangeKOTStatus || (item.status === "served" && !isKotReady(item)) ? "disabled" : ""}>
                            ${!canChangeKOTStatus ? 'BILL PREPARED' : isKotReady(item) ? '<i class="ph-bold ph-arrow-counter-clockwise" style="font-size: 14px;"></i> UNDO READY' : item.status === "served" ? '<i class="ph-bold ph-check" style="font-size: 14px;"></i> SERVED' : 'READY <i class="ph-bold ph-check-circle" style="font-size: 12px;"></i>'}
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

        // Cancellation preserves the order line and stock ledger. If the item already
        // consumed ingredients, Admin must reconcile actual quantities before cancelling.
        host.querySelectorAll(".admin-delete-item-btn").forEach(button => {
            button.addEventListener("click", () => {
                const itemId = button.dataset.deleteId;
                const item = displayRounds.flatMap(round => round.items).find(row => row.id === itemId);
                if (!item) {
                    showToast("Could not cancel item", "The order item is no longer available. Refresh the table and try again.", "error");
                    return;
                }

                const snapshot = Array.isArray(item.inventoryRecipeSnapshot) ? item.inventoryRecipeSnapshot : [];
                const hasConsumptionMarker = Boolean(item.inventoryConsumedAt);
                const hasUsageCalculationMarker = Boolean(item.inventoryUsageCalculatedAt);
                const hasSnapshot = snapshot.length > 0;
                const needsReconciliation = hasUsageCalculationMarker && hasSnapshot;
                const snapshotMissing = (hasConsumptionMarker && !hasSnapshot)
                  || (hasUsageCalculationMarker && !hasSnapshot)
                  || (hasSnapshot && !hasUsageCalculationMarker);
                const modal = openAppModal({
                    title: snapshotMissing ? "Stock reconciliation required" : `Cancel ${item.name}?`,
                    subtitle: "This action is recorded in the restaurant audit history.",
                    body: snapshotMissing
                      ? `<p style="margin:0;color:var(--muted);line-height:1.65;">The item's stock-consumption timestamp and saved recipe snapshot do not agree. Keep it unchanged and investigate the stock ledger before cancelling; the system will not guess which ingredients should be returned.</p>`
                      : `<div style="display:grid;gap:13px;">
                          <p style="margin:0;color:var(--muted);line-height:1.6;">${needsReconciliation
                            ? hasConsumptionMarker
                              ? "Stock was deducted when preparation started. Enter the actual quantity used for each ingredient. Unused quantities will be returned to stock; additional usage will be recorded as an adjustment-out."
                              : "Recipe usage was calculated when preparation started, but stock was not deducted. Enter the actual quantity used for the audit record; the system will preserve this usage without changing stock balances."
                            : "No preparation recipe snapshot is attached to this item. It will be marked cancelled without deleting its order history or changing stock."}</p>
                          ${needsReconciliation ? `<div style="display:grid;gap:9px;max-height:260px;overflow:auto;padding-right:4px;">
                            ${snapshot.map(row => {
                              const ingredientId = String(row.ingredient_id || "");
                              const name = escapeHtml(row.name || "Ingredient");
                              const unit = escapeHtml(row.unit || "");
                              const issued = Number(row.quantity || 0);
                              return `<label style="display:grid;grid-template-columns:minmax(0,1fr) minmax(110px,145px);gap:10px;align-items:center;font-size:12px;font-weight:750;">
                                <span>${name}<small style="display:block;color:var(--muted);font-weight:500;">Issued: ${issued.toLocaleString("en-IN", { maximumFractionDigits: 3 })} ${unit}</small></span>
                                <span><input type="number" min="0" step="0.001" required inputmode="decimal" data-actual-usage-ingredient="${escapeHtml(ingredientId)}" value="" placeholder="${Number.isFinite(issued) ? issued : 0}" style="width:100%;min-height:40px;padding:8px;border:1px solid var(--line);border-radius:9px;background:var(--paper);color:var(--ink);font:inherit;"><small style="display:block;color:var(--muted);font-weight:500;">Actual used (${unit})</small></span>
                              </label>`;
                            }).join("")}
                          </div>` : ""}
                          <label style="display:grid;gap:6px;font-size:12px;font-weight:800;">Cancellation reason
                            <textarea data-cancel-reason maxlength="250" rows="2" required placeholder="Enter the reason for cancellation" style="width:100%;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--paper);color:var(--ink);font:inherit;resize:vertical;"></textarea>
                          </label>
                        </div>`,
                    actions: snapshotMissing ? [
                      { label: "Close", className: "btn-quiet", onClick: ({ close }) => close() }
                    ] : [
                      { label: "Keep item", className: "btn-quiet", onClick: ({ close }) => close() },
                      {
                        label: needsReconciliation ? "Reconcile & cancel" : "Cancel dish",
                        className: "btn-danger",
                        onClick: async ({ root, close, button: confirmButton }) => {
                          const reason = root.querySelector("[data-cancel-reason]")?.value?.trim() || "";
                          if (!reason) {
                            showToast("Reason required", "Enter why this dish is being cancelled.", "error");
                            root.querySelector("[data-cancel-reason]")?.focus();
                            return;
                          }
                          const actualUsage = needsReconciliation
                            ? [...root.querySelectorAll("[data-actual-usage-ingredient]")].map(input => ({
                                ingredient_id: input.dataset.actualUsageIngredient,
                                actual_quantity: input.value.trim()
                              }))
                            : [];
                          if (needsReconciliation && actualUsage.some(row => row.actual_quantity === "" || !Number.isFinite(Number(row.actual_quantity)) || Number(row.actual_quantity) < 0)) {
                            showToast("Invalid ingredient quantity", "Enter a valid non-negative actual quantity for every listed ingredient.", "error");
                            return;
                          }

                          confirmButton.disabled = true;
                          const oldLabel = confirmButton.textContent;
                          confirmButton.textContent = "Saving…";
                          try {
                            const { data, error } = await supabase.rpc("admin_cancel_order_item", {
                              p_item_id: itemId,
                              p_actual_usage: actualUsage,
                              p_reason: reason,
                              p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null
                            });
                            if (error) throw error;
                            if (!data?.ok) throw new Error("The database did not confirm the cancellation.");
                            close();
                            showToast(
                              data.inventory_reconciled
                                ? data.stock_deduction_was_recorded ? "Dish cancelled and stock reconciled" : "Dish cancelled and actual use recorded"
                                : "Dish cancelled",
                              data.inventory_reconciled
                                ? data.stock_deduction_was_recorded
                                  ? `${Number(data.adjustment_count || 0)} stock correction(s) were added to the permanent ledger.`
                                  : "Actual ingredient use was saved for reporting; stock balances were not changed."
                                : "The order line was retained in history; no stock movement was changed.",
                              "success"
                            );
                            await renderManager();
                          } catch (error) {
                            confirmButton.disabled = false;
                            confirmButton.textContent = oldLabel;
                            showToast("Could not cancel item", error?.message || "Please refresh and try again.", "error");
                          }
                        }
                      }
                    ]
                });
            });
        });

        // Use the exact same Ready/Undo Ready server transition as the KOT screen.
        host.querySelectorAll(".status-cycle-btn[data-ready-action]").forEach(button => {
            button.addEventListener("click", async () => {
                const itemId = button.dataset.itemId;
                const action = button.dataset.readyAction;
                if (!itemId || !["ready", "undo_ready"].includes(action)) return;

                const originalHTML = button.innerHTML;
                button.disabled = true;
                button.innerHTML = '<i class="ph-bold ph-spinner-gap ph-spin"></i>';

                try {
                    const { error } = await supabase.rpc("set_kot_item_status", {
                        p_item_id: itemId,
                        p_new_status: action,
                        p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null
                    });
                    if (error) throw error;
                    renderManager();
                } catch (error) {
                    button.disabled = false;
                    button.innerHTML = originalHTML;
                    showToast("Could not update item status", error.message || "Please refresh and try again.", "error");
                }
            });
        });

        const adminTableReadyButton = host.querySelector("#admin-table-ready");
        if (adminTableReadyButton) {
          adminTableReadyButton.addEventListener("click", async () => {
            const action = tableAlreadyReady ? "undo_ready" : "ready";
            const itemIds = tableReadyItems.map(item => item.id);
            if (!itemIds.length) return;
            const originalHTML = adminTableReadyButton.innerHTML;
            adminTableReadyButton.disabled = true;
            adminTableReadyButton.innerHTML = '<i class="ph-bold ph-spinner-gap ph-spin"></i> Updating';
            try {
              const { error } = await supabase.rpc("set_kot_table_ready", {
                p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null,
                p_item_ids: itemIds,
                p_action: action
              });
              if (error) throw error;
              renderManager();
            } catch (error) {
              adminTableReadyButton.disabled = false;
              adminTableReadyButton.innerHTML = originalHTML;
              showToast("Could not update table readiness", error.message || "Please refresh and try again.", "error");
            }
          });
        }

        // Connects straight to the existing POS Cart mechanism without forcing a route change
        host.querySelector("#admin-add-items").addEventListener("click", async () => {
            
            // PERFORMANCE FIX: Use the instantly available, globally cached products array instead of a slow database call!
            const activeProducts = products.filter(p => p.is_active).sort((a, b) => a.name.localeCompare(b.name));
            
            if (!activeProducts || activeProducts.length === 0) { 
                showToast("Error", "No active dishes found in the menu.", "error"); 
                renderManager(); 
                return; 
            }

            const cuisinesList = ["All", ...new Set(activeProducts
              .map(p => String(p.cuisine || String(p.category || "").split(" - ")[0]).trim())
              .filter(c => c && c !== "Global" && c !== "Other"))];
            
            let localCart = new Map();
            let catalogControlMap = new Map();
            let catalogSubmitInFlight = false;
            const catalogControlAnimations = new WeakMap();
            let searchQuery = "";
            let selectedCuisine = "All";
            let selectedSub = "All";

            function getCatalogCuisine(product) {
                const legacyParts = String(product.category || "").split(" - ");
                return String(product.cuisine || (legacyParts.length > 1 ? legacyParts[0] : "Other")).trim();
            }

            function getCatalogSection(product) {
                const legacyParts = String(product.category || "").split(" - ");
                return String(legacyParts.length > 1 ? legacyParts.slice(1).join(" - ") : legacyParts[0] || "Other").trim();
            }

            function getAvailableSubs() {
                const subs = new Set();
                activeProducts.forEach(p => {
                    const cuisine = getCatalogCuisine(p);
                    if (selectedCuisine !== "All" && cuisine !== selectedCuisine && cuisine !== "Global") return;
                    subs.add(getCatalogSection(p));
                });
                return ["All", ...Array.from(subs).filter(Boolean).sort((a, b) => a.localeCompare(b))];
            }

            // Keep quantity updates local to the changed row. Full synchronization is
            // only needed after the catalog HTML has been rebuilt by a filter/search.
            function updateAdminCatalogQuantities(changedProductId = null) {
                let cartTotal = 0;
                let cartCount = 0;
                for (const item of localCart.values()) {
                    cartTotal += item.product.price * item.qty;
                    cartCount += item.qty;
                }

                const controls = changedProductId
                    ? [catalogControlMap.get(changedProductId)].filter(Boolean)
                    : catalogControlMap.values();

                for (const control of controls) {
                    const id = control.dataset.catalogControl;
                    const qty = localCart.get(id)?.qty || 0;
                    const value = control.querySelector(".premium-qty-value");
                    const incBtn = control.querySelector(".inc-btn");
                    const row = control.closest(".catalog-row");

                    control.classList.toggle("is-active", qty > 0);
                    if (value && value.textContent !== String(qty)) value.textContent = String(qty);
                    if (row) row.style.background = qty > 0 ? "var(--cream-50)" : "#fff";
                    if (incBtn) {
                        incBtn.classList.toggle("catalog-inc", qty > 0);
                        incBtn.classList.toggle("catalog-add", qty <= 0);
                    }
                }

                const footerWrap = host.querySelector("#catalog-footer-wrap");
                if (!footerWrap) return;
                if (cartCount <= 0) {
                    footerWrap.style.display = "none";
                    footerWrap.innerHTML = "";
                    return;
                }

                footerWrap.style.display = "block";
                let confirmBtn = footerWrap.querySelector("#confirm-new-round");
                const buttonContent = `
                    <span style="display:flex;align-items:center;gap:10px;"><span data-round-count style="background:rgba(255,255,255,.25);width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:6px;font-size:13px;font-weight:900;">${cartCount}</span> Confirm Round</span>
                    <span><span data-round-total>${money(cartTotal, settings.currency_symbol)}</span> <i class="ph-bold ph-arrow-right" style="margin-left:6px;font-size:16px;"></i></span>
                `;

                if (!confirmBtn) {
                    footerWrap.innerHTML = `<button class="btn btn-primary" id="confirm-new-round" style="width:100%;display:flex;justify-content:space-between;align-items:center;padding:0 16px;height:50px;border-radius:12px;font-size:15px;box-shadow:0 5px 14px rgba(25,50,28,.16);">${buttonContent}</button>`;
                    confirmBtn = footerWrap.querySelector("#confirm-new-round");
                    confirmBtn.addEventListener("click", async () => {
                        if (catalogSubmitInFlight || !localCart.size) return;
                        catalogSubmitInFlight = true;
                        confirmBtn.disabled = true;
                        confirmBtn.innerHTML = '<i class="ph-bold ph-spinner-gap ph-spin" style="font-size:20px;"></i><span>Sending to kitchen…</span>';
                        const itemsToSubmit = Array.from(localCart.values()).map(item => ({ id: item.product.id, quantity: item.qty }));
                        try {
                            const { error } = await supabase.rpc("create_pos_order", {
                                p_restaurant_id: window.__ACTIVE_TENANT__.id,
                                p_order_type: "dine_in",
                                p_table_id: table.id,
                                p_items: itemsToSubmit,
                                p_note: "Admin Added Round",
                                p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null
                            });
                            if (error) throw error;
                            showToast("Round Added", "Items sent to kitchen successfully.", "success");
                            renderManager();
                        } catch (error) {
                            catalogSubmitInFlight = false;
                            showToast("Error", error.message, "error");
                            confirmBtn.disabled = false;
                            confirmBtn.textContent = "Try Again";
                        }
                    });
                } else if (!confirmBtn.disabled) {
                    // Update only the two changing labels; preserve the button and
                    // its child tree during rapid quantity taps.
                    const countLabel = confirmBtn.querySelector("[data-round-count]");
                    const totalLabel = confirmBtn.querySelector("[data-round-total]");
                    if (countLabel && totalLabel) {
                        countLabel.textContent = String(cartCount);
                        totalLabel.textContent = money(cartTotal, settings.currency_symbol);
                    } else {
                        // Recover the stable markup if a failed submit temporarily
                        // replaced the button contents with a retry label.
                        confirmBtn.innerHTML = buttonContent;
                    }
                }
            }

            function renderCatalog() {
                const visible = activeProducts.filter(p => {
                    const pCuisine = getCatalogCuisine(p);
                    const pSub = getCatalogSection(p);
                    const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) || (p.category || "").toLowerCase().includes(searchQuery.toLowerCase());
                    const matchesCuisine = selectedCuisine === "All" || pCuisine === selectedCuisine || pCuisine === "Global";
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

                // Index the rebuilt catalog once; rapid quantity taps then touch only
                // the selected control instead of every product row.
                catalogControlMap = new Map(
                    Array.from(host.querySelectorAll("[data-catalog-control]"), control => [control.dataset.catalogControl, control])
                );
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
                        if (catalogSubmitInFlight) return;
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
                            
                            updateAdminCatalogQuantities(id);

                            const control = catalogControlMap.get(id);
                            if (control && !window.matchMedia("(prefers-reduced-motion: reduce)").matches && typeof control.animate === "function") {
                                const running = catalogControlAnimations.get(control);
                                if (!running || running.playState !== "running") {
                                    catalogControlAnimations.set(control, control.animate(
                                        [{ transform: "scale(1)" }, { transform: "scale(1.012)" }, { transform: "scale(1)" }],
                                        { duration: 90, easing: "cubic-bezier(.2,.7,.2,1)" }
                                    ));
                                }
                            } else if (control && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
                                control.classList.remove("qty-pulse");
                                requestAnimationFrame(() => control.classList.add("qty-pulse"));
                            }
                        }

                        if (decBtn) {
                            const id = decBtn.dataset.id;
                            const current = localCart.get(id);
                            if (current) {
                                current.qty -= 1;
                                if (current.qty <= 0) localCart.delete(id);
                                else localCart.set(id, current);
                                
                                updateAdminCatalogQuantities(id);

                                if (current.qty > 0) {
                                    const control = catalogControlMap.get(id);
                                    if (control && !window.matchMedia("(prefers-reduced-motion: reduce)").matches && typeof control.animate === "function") {
                                        const running = catalogControlAnimations.get(control);
                                        if (!running || running.playState !== "running") {
                                            catalogControlAnimations.set(control, control.animate(
                                                [{ transform: "scale(1)" }, { transform: "scale(1.012)" }, { transform: "scale(1)" }],
                                                { duration: 90, easing: "cubic-bezier(.2,.7,.2,1)" }
                                            ));
                                        }
                                    } else if (control && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
                                        control.classList.remove("qty-pulse");
                                        requestAnimationFrame(() => control.classList.add("qty-pulse"));
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
           showAdminReceiptPreview({
             ...latestOrder,
             session_id: session.id,
             dining_sessions: { status: session.status, table_id: table.id },
             order_items: flatItems,
             subtotal,
             cgst,
             sgst,
             rounding,
             grand_total: grandTotal
           });
        });

        host.querySelector("#admin-close-table").addEventListener("click", () => {
           if (session.status !== "bill_ready") {
             showToast("Bill not ready", "The customer must request the physical bill and Cashier/Admin must generate it before payment can be confirmed.", "error");
             return;
           }
           openAppModal({
              title: `Close Table ${table.table_no}?`,
              subtitle: "The bill must be generated before staff can confirm payment.",
              body: `<div class="danger-confirm"><div class="danger-confirm-icon" style="background: var(--success-soft); color: var(--success);"><i class="ph-bold ph-check-circle"></i></div><h3>Confirm payment?</h3><p>Customer total is <strong>${money(grandTotal, settings.currency_symbol)}</strong>.</p><label class="field" style="display:block;text-align:left;margin-top:14px;"><span>Payment method *</span><select data-admin-close-payment-method required><option value="upi_qr">UPI QR</option>
<option value="cash">Cash</option>
<option value="card">Card</option>
<option value="bank_transfer">Bank transfer</option></select></label><p style="font-size:12px;color:var(--muted);">Only continue after the customer has paid.</p></div>`,
              actions: [
                { label: "Cancel", className: "btn-quiet", onClick: (ctx) => ctx.close() },
                { label: "Yes, Close Table", className: "btn-primary", onClick: async (ctx) => {
                    ctx.button.disabled = true;
                    try {
                      const { error } = await supabase.rpc("complete_session_payment", {
                        p_session_id: session.id,
                        p_payment_method: ctx.root.querySelector("[data-admin-close-payment-method]")?.value || "upi_qr",
                        p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null
                      });
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

        <!-- Panel PIN Management -->
        <section class="admin-panel settings-panel" style="margin-bottom:16px;">
          <div
            style="display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;"
          >
            <div style="min-width:0;flex:1;">
              <span class="eyebrow">Security</span>
              <h2 style="margin:5px 0 7px;">Panel PIN Management</h2>
              <p style="margin:0;color:var(--muted);font-size:13px;line-height:1.6;">
                Manage access PINs for Captain, KOT, Cashier, Manager and Admin
                from one place.
              </p>
            </div>

            <button
              type="button"
              class="btn btn-primary"
              id="open-panel-pin-manager"
              style="background:var(--forest-900);border-color:var(--forest-900);flex-shrink:0;"
            >
              <i class="ph-bold ph-lock-key"></i>
              Manage Panel PINs
            </button>
          </div>
        </section>

        <!-- Billing Section -->
        <section class="admin-panel settings-panel">
          <form id="settings-form" class="settings-form-grid">
            <label class="field"><span>Restaurant name</span><input class="field-input" name="restaurant_name" value="${escapeHtml(settings.restaurant_name)}" required></label>
            <label class="field">
              <span>GSTIN (GST Number)</span>
              <input class="field-input" type="text" name="gst_number"
                value="${escapeHtml(String(settings.gst_number || "").trim().toUpperCase())}"
                placeholder="22AAAAA0000A1Z5" maxlength="15" minlength="15"
                pattern="[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]"
                title="Enter a valid 15-character GSTIN using uppercase letters and digits."
                autocapitalize="characters" autocomplete="off" spellcheck="false"
                aria-describedby="gst-number-help"
                ${String(settings.gst_number || "").trim() ? 'disabled aria-disabled="true"' : ""}>
              <small id="gst-number-help" style="font-size:.67rem;line-height:1.45;color:var(--muted);">
                ${String(settings.gst_number || "").trim() ? "GSTIN is locked after its first save." : "Enter the exact 15-character GSTIN. It can be saved only once."}
              </small>
            </label>
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

      // GSTIN is uppercased and restricted to its 15-character alphabet.
      const gstNumberInput = area.querySelector('[name="gst_number"]');
      gstNumberInput?.addEventListener("input", () => {
        if (gstNumberInput.disabled) return;
        const cleaned = gstNumberInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 15);
        if (gstNumberInput.value !== cleaned) {
          const position = Math.min(gstNumberInput.selectionStart ?? cleaned.length, cleaned.length);
          gstNumberInput.value = cleaned;
          gstNumberInput.setSelectionRange(position, position);
        }
        gstNumberInput.setCustomValidity("");
      });

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

          const { error } = await supabase.rpc("admin_mutate_resource", {
            p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null,
            p_resource: "branding",
            p_action: "save",
            p_record_id: restData.id,
            p_payload: {
              background_color: bgCol,
              foreground_color: fgCol,
              icon_url: iconUrl,
              logo_url: logoUrl
            }
          });

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

      area.querySelector("#open-panel-pin-manager")
        ?.addEventListener("click", async () => {
          try {
            const { openPanelPinManager } = await import(
              "./panelPinManager.js"
            );

            openPanelPinManager({
              restaurantId: window.__ACTIVE_TENANT__?.id,
              onNotice: (message, type = "success") => {
                showToast("Panel PIN Management", message, type);
              },
              onAdminPinChanged: () => {
                window.__RMS_PANEL_ACCESS__ = null;
                history.pushState({}, "", `${location.pathname}${location.search}#/panel/admin`);
                window.dispatchEvent(new Event("rms:navigate"));
              }
            });
          } catch (error) {
            console.error("Panel PIN manager failed to open:", error);

            showToast(
              "Unable to open PIN management",
              "Please refresh the page and try again.",
              "error"
            );
          }
      });

      // Panel PIN changes are handled by the dedicated panelPinManager modal.

      area.querySelector("#settings-form").addEventListener("submit", async e => {
        e.preventDefault(); 
        
        const form = e.currentTarget;
        const btn = form.querySelector("#save-billing-btn");
        const ogText = btn.innerHTML;
        
        // Instantly disable button and show loading spinner
        btn.disabled = true;
        btn.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i> Saving...`;

        const fd = new FormData(form);
        const existingGstin = String(settings.gst_number || "").trim().toUpperCase();
        const enteredGstin = String(fd.get("gst_number") || "").trim().toUpperCase();
        // A disabled field is intentionally absent from FormData. Always retain
        // the existing GSTIN in later saves so it cannot be cleared accidentally.
        const gstNumber = existingGstin || enteredGstin;
        const gstinPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

        if (!existingGstin && enteredGstin && !gstinPattern.test(enteredGstin)) {
          showToast("Invalid GSTIN", "Enter a valid 15-character GSTIN in uppercase letters and digits.", "error");
          gstNumberInput?.focus();
          btn.innerHTML = ogText;
          btn.disabled = false;
          return;
        }

        const payload = {
          restaurant_id: window.__ACTIVE_TENANT__.id,
          restaurant_name: String(fd.get("restaurant_name") || "").trim(),
          gst_number: gstNumber || null,
          restaurant_address: String(fd.get("restaurant_address") || "").trim(),
          cgst_rate: Number(fd.get("cgst_rate")),
          sgst_rate: Number(fd.get("sgst_rate")),
          upi_id: String(fd.get("upi_id") || "").trim(),
          receipt_footer: String(fd.get("receipt_footer") || "").trim()
        };

        try {
          // 1. Save Billing Settings and require an explicit server success result.
          const { data: saveResult, error } = await supabase.rpc("admin_mutate_resource", {
            p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null,
            p_resource: "settings",
            p_action: "save",
            p_record_id: null,
            p_payload: payload
          });
          if (error) throw error;
          const confirmedSave = Array.isArray(saveResult) ? saveResult[0] : saveResult;
          if (confirmedSave?.ok !== true) {
            throw new Error(confirmedSave?.message || "The server did not confirm that the settings were saved.");
          }

          // 3. Update Memory State
          Object.assign(settings, payload);
          if (payload.gst_number) {
            if (gstNumberInput) {
              gstNumberInput.value = payload.gst_number;
              gstNumberInput.disabled = true;
              gstNumberInput.setAttribute("aria-disabled", "true");
              gstNumberInput.setCustomValidity("");
            }
            const gstHelp = form.querySelector("#gst-number-help");
            if (gstHelp) gstHelp.textContent = "GSTIN is locked after its first save.";
          }
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
          try {
            const { error } = await supabase.rpc("admin_mutate_resource", {
              p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null,
              p_resource: "tables",
              p_action: editing ? "update" : "insert",
              p_record_id: editing ? table.id : null,
              p_payload: payload
            });
            if (error) throw error;
            showToast(editing ? "Table updated" : "Table created", `Table ${payload.table_no} is ready.`);
            close();
            await reload();
          } catch (error) { button.disabled = false; showToast("Could not save table", error.message, "error"); }
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
          try {
            const { error } = await supabase.rpc("admin_mutate_resource", {
              p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null,
              p_resource: "tables",
              p_action: "delete",
              p_record_id: table.id,
              p_payload: {}
            });
            if (error) throw error;
            showToast("Table deactivated", `Table ${table.table_no} will no longer accept QR orders; history is preserved.`);
            close();
            await reload();
          } catch (error) { button.disabled = false; showToast("Could not deactivate table", error.message, "error"); }
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
          const { data, error } = await supabase.rpc("get_table_daily_pin", {
            p_table_id: table.id,
            p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null
          });
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
              // Rotate the server-generated salt and return the newly active daily PIN.
              const { data, error } = await supabase.rpc("regenerate_table_daily_pin", {
                p_table_id: table.id,
                p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null
              });
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
            const { error } = await supabase.rpc("admin_mutate_resource", {
              p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null,
              p_resource: "products",
              p_action: "delete",
              p_record_id: product.id,
              p_payload: {}
            }); 
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
          <style>
            .product-editor-tabs {
              display: flex;
              gap: 8px;
              padding-bottom: 12px;
              margin-bottom: 18px;
              border-bottom: 1px solid var(--line);
            }

            .product-editor-tab {
              min-height: 40px;
              padding: 0 14px;
              border: 1px solid var(--line);
              border-radius: 11px;
              background: var(--paper);
              color: var(--forest-800);
              font: inherit;
              font-size: 12px;
              font-weight: 800;
              cursor: pointer;
            }

            .product-editor-tab.active {
              background: var(--forest-900);
              border-color: var(--forest-900);
              color: #fff;
            }

            .product-recipe-list {
              display: grid;
              gap: 10px;
              margin-top: 15px;
            }

            .product-recipe-row {
              display: grid;
              grid-template-columns: minmax(0, 1fr) 100px 42px;
              align-items: end;
              gap: 9px;
              padding: 12px;
              border: 1px solid var(--line);
              border-radius: 13px;
              background: var(--paper);
            }

            .product-recipe-row .field {
              min-width: 0;
              margin: 0;
            }

            .product-recipe-unit {
              min-height: 42px;
              display: grid;
              place-items: center;
              border: 1px solid var(--line);
              border-radius: 10px;
              color: var(--muted);
              font-size: 12px;
              font-weight: 800;
            }

            .product-recipe-empty {
              padding: 22px 14px;
              text-align: center;
              border: 1px dashed var(--line);
              border-radius: 13px;
              color: var(--muted);
              font-size: 12px;
              line-height: 1.6;
            }

            @media (max-width: 480px) {
              .product-recipe-row {
                grid-template-columns: minmax(0, 1fr) 76px 36px;
                gap: 6px;
                padding: 9px;
              }
            }
          </style>

          <div class="product-editor-tabs" role="tablist" aria-label="Product details">
            <button
              type="button"
              class="product-editor-tab active"
              data-product-tab="details"
              role="tab"
              aria-selected="true"
            >
              <i class="ph-bold ph-fork-knife"></i>
              Dish details
            </button>

            <button
              type="button"
              class="product-editor-tab"
              data-product-tab="ingredients"
              role="tab"
              aria-selected="false"
            >
              <i class="ph-bold ph-package"></i>
              Ingredients
            </button>
          </div>

          <section data-product-tab-panel="details" role="tabpanel">
            <label class="field"><span>Dish name</span><input class="field-input" name="name" value="${escapeHtml(product?.name ?? "")}" required /></label>
          
          <!-- Native HTML Combobox Datalists (Tenant Isolated) -->
          <datalist id="subcat-datalist">
            ${[...new Set(products.map(p => { const parts = String(p.category || "").split(" - "); return (parts.length > 1 ? parts.slice(1).join(" - ") : parts[0]).trim(); }).filter(Boolean))].map(sub => `<option value="${escapeHtml(sub)}">`).join("")}
          </datalist>

          <div style="display: grid; grid-template-columns: 1.2fr 1.2fr 100px; gap: 10px;">
            <label class="field">
              <span>Cuisine</span>
              <div style="position: relative; width: 100%;">
                <select class="field-input" name="main_category" required style="appearance: none; padding-right: 32px; cursor: pointer; width: 100%; background-color: var(--paper); color: var(--ink);">
                  <option value="" disabled ${!product ? "selected" : ""}>Select Cuisine...</option>
                  ${[...cuisines.filter(c => c.name !== "Global"), { name: "Global" }].map(c => {
                      const legacyParts = String(product?.category ?? "").split(" - ");
                      const currentCuisine = String(product?.cuisine || (legacyParts.length > 1 ? legacyParts[0] : "")).trim();
                      const isSelected = product && currentCuisine === c.name;
                      return `<option value="${escapeHtml(c.name)}" ${isSelected ? "selected" : ""}>${escapeHtml(c.name === "Global" ? "Global · available with every cuisine" : c.name)}</option>`;
                  }).join("")}
                </select>
                <i class="ph-bold ph-caret-down" style="position: absolute; right: 12px; top: 50%; transform: translateY(-50%); font-size: 14px; color: var(--forest-900); pointer-events: none;"></i>
              </div>
            </label>
            <label class="field">
              <span>Menu Section</span>
              <input class="field-input" list="subcat-datalist" name="sub_category" value="${escapeHtml((() => { const parts = String(product?.category ?? "").split(" - "); return (parts.length > 1 ? parts.slice(1).join(" - ") : parts[0]).trim(); })())}" placeholder="e.g. Starters & Tandoor" required autocomplete="off" />
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
          </section>

          <section data-product-tab-panel="ingredients" role="tabpanel" hidden>
            <div>
              <h3 style="margin:0 0 7px;font-size:17px;">Recipe ingredients</h3>
              <p style="margin:0;color:var(--muted);font-size:12px;line-height:1.6;">
                Select each ingredient and enter the quantity needed for one serving.
              </p>
            </div>

            <div style="margin-top:12px;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--paper);">
              <label style="display:flex;align-items:flex-start;gap:9px;cursor:pointer;">
                <input type="checkbox" data-recipe-verified style="width:17px;height:17px;margin-top:2px;accent-color:var(--forest-700);">
                <span style="display:block;">
                  <strong style="display:block;font-size:12px;color:var(--ink);">I verified these quantities against actual kitchen measurements</strong>
                  <small style="display:block;margin-top:4px;color:var(--muted);line-height:1.5;">Leave unchecked for estimated recipes. Strict inventory stays unavailable until active recipes are verified.</small>
                </span>
              </label>
              <label class="field" style="margin-top:10px;">
                <span>Verification source / note <span style="color:var(--muted);font-weight:500;">(required when verified)</span></span>
                <input class="field-input" data-recipe-verification-note type="text" maxlength="300" placeholder="e.g. weighed in kitchen on 26 Oct 2026" disabled>
              </label>
            </div>

            <div
              class="product-recipe-list"
              data-product-recipe-list
            ></div>

            <button
              type="button"
              class="btn btn-quiet"
              data-add-recipe-ingredient
              style="width:100%;justify-content:center;margin-top:13px;"
            >
              <i class="ph-bold ph-plus"></i>
              Add ingredient
            </button>

            <p
              data-product-recipe-status
              role="status"
              aria-live="polite"
              style="margin:13px 0 0;color:var(--muted);font-size:12px;line-height:1.6;"
            >
              In Automatic mode, saved recipe quantities are deducted when preparation starts, including estimated recipes; stock shortages never block the kitchen. Strict mode is optional and requires verified recipes and sufficient stock.
            </p>
          </section>
        </form>
      `,
      actions: [
        { label: "Cancel", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: editing ? "Save changes" : "Create dish", icon: "ph-floppy-disk", className: "btn-primary", onClick: async ({ root, close, button }) => {
            const form = root.querySelector("#product-form");
            if (!form.reportValidity()) return;

            const recipeSelection = [];
            const seenIngredientIds = new Set();

            const recipeVerified = Boolean(root.querySelector("[data-recipe-verified]")?.checked);
            const recipeSourceNote = String(
              root.querySelector("[data-recipe-verification-note]")?.value || ""
            ).trim();
            const recipeStatusNode = root.querySelector("[data-product-recipe-status]");

            if (recipeVerified && productRecipeSelection.length === 0) {
              switchProductTab("ingredients");
              if (recipeStatusNode) {
                recipeStatusNode.textContent = "Add recipe ingredients before marking this recipe verified.";
              }
              return;
            }

            if (recipeVerified && (!recipeSourceNote || recipeSourceNote.length > 300)) {
              switchProductTab("ingredients");
              if (recipeStatusNode) {
                recipeStatusNode.textContent = "Enter a verification source/note of 1–300 characters before marking the recipe verified.";
              }
              root.querySelector("[data-recipe-verification-note]")?.focus();
              return;
            }

            for (const item of productRecipeSelection) {
              const ingredient = ingredientDrafts.find(
                entry => entry.id === item.ingredient_id
              );

              const quantity = Number(item.quantity_per_serving);

              if (
                !ingredient ||
                item.quantity_per_serving === "" ||
                !Number.isFinite(quantity) ||
                quantity <= 0 ||
                Math.abs(quantity - Math.round(quantity * 1000) / 1000) > 1e-9
              ) {
                switchProductTab("ingredients");
                recipeStatus.textContent =
                  "Choose an ingredient and enter a positive quantity with at most three decimal places for every recipe row.";
                return;
              }

              if (seenIngredientIds.has(ingredient.id)) {
                switchProductTab("ingredients");
                recipeStatus.textContent =
                  "Each ingredient can appear only once in a dish recipe. Update its quantity in the existing row.";
                return;
              }

              seenIngredientIds.add(ingredient.id);

              recipeSelection.push({
                ingredient_id: ingredient.id,
                ingredient_name: ingredient.name,
                quantity_per_serving: quantity,
                unit: ingredient.baseUnit,
                is_estimate: !recipeVerified,
                source_note: recipeVerified
                  ? recipeSourceNote
                  : "Not yet verified against actual kitchen measurements; quantity remains estimated."
              });
            }

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
              
              // Store taxonomy in separate fields: cuisine is independent of the menu section.
              const finalCategory = subCat;

              const payload = {
                id: productId,
                restaurant_id: window.__ACTIVE_TENANT__.id,
                name: String(fd.get("name") || "").trim(),
                cuisine: mainCat,
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
              const { error } = await supabase.rpc("admin_mutate_resource", {
                p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null,
                p_resource: "products",
                p_action: editing ? "update" : "insert",
                p_record_id: editing ? product.id : productId,
                p_payload: payload
              });
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

              const { data: recipeSaveResult, error: recipeSaveError } = await supabase.rpc("admin_set_product_recipe", {
                p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null,
                p_product_id: productId,
                p_recipe: recipeSelection
              });
              if (recipeSaveError) throw recipeSaveError;
              const normalizedRecipeSave = Array.isArray(recipeSaveResult) ? recipeSaveResult[0] : recipeSaveResult;
              if (normalizedRecipeSave?.ok !== true) throw new Error("The server did not confirm the recipe save.");
              productRecipeDrafts.set(productId, recipeSelection);

              showToast(
                editing ? "Dish updated" : "Dish created",
                recipeSelection.length
                  ? `${payload.name} · ${recipeSelection.length} recipe ingredients drafted`
                  : `${payload.name} · no recipe ingredients assigned`
              );

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
    const productForm = modal.root.querySelector("#product-form");
    const recipeList = modal.root.querySelector("[data-product-recipe-list]");
    const recipeStatus = modal.root.querySelector("[data-product-recipe-status]");
    const recipeVerifiedToggle = modal.root.querySelector("[data-recipe-verified]");
    const recipeVerificationNote = modal.root.querySelector("[data-recipe-verification-note]");
    let previewUrl = null;

    // Load in-memory recipe drafts when editing an existing product.
    let productRecipeSelection = (
      product?.id ? productRecipeDrafts.get(product.id) || [] : []
    ).map(item => ({ ...item }));

    const savedRecipeVerified = productRecipeSelection.length > 0 &&
      productRecipeSelection.every(item => item.is_estimate === false);

    if (recipeVerifiedToggle) recipeVerifiedToggle.checked = savedRecipeVerified;

    if (recipeVerificationNote) {
      recipeVerificationNote.disabled = !savedRecipeVerified;
      recipeVerificationNote.value = savedRecipeVerified
        ? String(productRecipeSelection.find(item => item.source_note)?.source_note || "")
        : "";
    }

    recipeVerifiedToggle?.addEventListener("change", () => {
      const verified = Boolean(recipeVerifiedToggle.checked);

      if (recipeVerificationNote) {
        recipeVerificationNote.disabled = !verified;
        if (!verified) recipeVerificationNote.value = "";
      }

      if (recipeStatus) {
        recipeStatus.textContent = verified
          ? "Enter a verification source note before saving this recipe as verified."
          : "This recipe will remain marked as estimated until actual kitchen quantities are confirmed.";
      }
    });

    function switchProductTab(tabName) {
      modal.root.querySelectorAll("[data-product-tab]").forEach(tab => {
        const selected = tab.dataset.productTab === tabName;
        tab.classList.toggle("active", selected);
        tab.setAttribute("aria-selected", String(selected));
      });

      modal.root.querySelectorAll("[data-product-tab-panel]").forEach(panel => {
        panel.hidden = panel.dataset.productTabPanel !== tabName;
      });
    }

    function renderProductRecipeRows() {
      if (!recipeList) return;

      if (!ingredientDrafts.length) {
        recipeList.innerHTML = `
          <div class="product-recipe-empty">
            <i class="ph-bold ph-package" style="font-size:24px;"></i>
            <p style="margin:8px 0 0;">
              No saved ingredients are available. Open Admin → Inventory and add ingredients first.
            </p>
          </div>
        `;
        return;
      }

      if (!productRecipeSelection.length) {
        recipeList.innerHTML = `
          <div class="product-recipe-empty">
            No ingredients assigned to this dish yet.
          </div>
        `;
        return;
      }

      recipeList.innerHTML = productRecipeSelection.map((item, index) => {
        const selectedIngredient = ingredientDrafts.find(
          ingredient => ingredient.id === item.ingredient_id
        );

        return `
          <div class="product-recipe-row" data-recipe-row="${index}">
            <label class="field">
              <span>Ingredient</span>
              <select class="field-input" data-recipe-ingredient="${index}">
                <option value="">Select ingredient</option>
                ${ingredientDrafts.map(ingredient => `
                  <option
                    value="${escapeHtml(ingredient.id)}"
                    ${ingredient.id === item.ingredient_id ? "selected" : ""}
                  >
                    ${escapeHtml(ingredient.name)}
                  </option>
                `).join("")}
              </select>
            </label>

            <label class="field">
              <span>Qty / serving</span>
              <input
                class="field-input"
                type="number"
                min="0"
                step="0.001"
                inputmode="decimal"
                data-recipe-quantity="${index}"
                value="${escapeHtml(item.quantity_per_serving ?? "")}"
                placeholder="0"
              />
            </label>

            <div>
              <span
                style="display:block;margin-bottom:6px;color:var(--muted);font-size:11px;"
              >
                Unit
              </span>
              <div class="product-recipe-unit" data-recipe-unit="${index}">
                ${escapeHtml(selectedIngredient?.baseUnit || "—")}
              </div>
              <button
                type="button"
                class="icon-btn icon-btn-danger"
                data-remove-recipe="${index}"
                title="Remove ingredient"
                aria-label="Remove ingredient"
                style="margin-top:5px;width:100%;"
              >
                <i class="ph-bold ph-trash"></i>
              </button>
            </div>
          </div>
        `;
      }).join("");
    }

    modal.root.querySelectorAll("[data-product-tab]").forEach(tab => {
      tab.addEventListener("click", () => {
        switchProductTab(tab.dataset.productTab);
      });
    });

    modal.root.querySelector("[data-add-recipe-ingredient]")
      ?.addEventListener("click", () => {
        if (!ingredientDrafts.length) {
          recipeStatus.textContent =
            "Add ingredients in the Inventory catalogue before assigning them to a dish.";
          return;
        }

        productRecipeSelection.push({
          ingredient_id: "",
          quantity_per_serving: ""
        });

        recipeStatus.textContent =
          "Enter a valid ingredient and quantity for every recipe row.";

        renderProductRecipeRows();
      });

    recipeList?.addEventListener("change", event => {
      const select = event.target.closest("[data-recipe-ingredient]");

      if (!select) return;

      const index = Number(select.dataset.recipeIngredient);
      if (!productRecipeSelection[index]) return;

      productRecipeSelection[index].ingredient_id = select.value;

      const ingredient = ingredientDrafts.find(
        item => item.id === select.value
      );

      const unitNode = recipeList.querySelector(
        `[data-recipe-unit="${index}"]`
      );

      if (unitNode) {
        unitNode.textContent = ingredient?.baseUnit || "—";
      }

      recipeStatus.textContent = "";
    });

    recipeList?.addEventListener("input", event => {
      const input = event.target.closest("[data-recipe-quantity]");

      if (!input) return;

      const index = Number(input.dataset.recipeQuantity);
      if (!productRecipeSelection[index]) return;

      productRecipeSelection[index].quantity_per_serving = input.value;
      recipeStatus.textContent = "";
    });

    recipeList?.addEventListener("click", event => {
      const button = event.target.closest("[data-remove-recipe]");

      if (!button) return;

      const index = Number(button.dataset.removeRecipe);

      productRecipeSelection.splice(index, 1);
      renderProductRecipeRows();
    });

    renderProductRecipeRows();

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

  // Listen for the custom inbox event triggered by navigation.js (ff-admin-alerts broadcast channel)
  const adminAlertHandler = async () => {
    setTimeout(async () => {
       if (section === "overview" || section === "tables" || section === "orders") {
         await reload();
       }
    }, 300);
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
           if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
             ordersNavBtn.animate?.(
               [{ transform: "scale(1)" }, { transform: "scale(1.035)" }, { transform: "scale(1)" }],
               { duration: 190, easing: "cubic-bezier(.2,.7,.2,1)" }
             );
           }
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