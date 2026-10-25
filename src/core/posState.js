/**
 * Client-side order/cart state. Money uses integer paise internally.
 * PostgreSQL remains the authority for actual prices and taxes.
 */
const PAISA = 100;
const toPaise = value => Number.isFinite(Number(value)) ? Math.round(Number(value) * PAISA) : 0;
const fromPaise = value => Math.round(value) / PAISA;
const qty = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1000, Math.round(Number(value)))) : 0;

export function calculateTotals(items, settings = {}) {
  const cgstRate = Math.max(0, Number(settings.cgst_rate) || 0);
  const sgstRate = Math.max(0, Number(settings.sgst_rate) || 0);
  let subtotalPaise = 0;
  let taxablePaise = 0;

  for (const item of items) {
    const line = toPaise(item.price) * qty(item.quantity);
    subtotalPaise += line;
    if (!item.tax_exempt) taxablePaise += line;
  }

  const cgstPaise = Math.round(taxablePaise * cgstRate / 100);
  const sgstPaise = Math.round(taxablePaise * sgstRate / 100);
  const preRoundPaise = subtotalPaise + cgstPaise + sgstPaise;
  const grandPaise = Math.round(preRoundPaise / PAISA) * PAISA;

  return {
    subtotal: fromPaise(subtotalPaise),
    cgst: fromPaise(cgstPaise),
    sgst: fromPaise(sgstPaise),
    rounding: fromPaise(grandPaise - preRoundPaise),
    grandTotal: fromPaise(grandPaise),
    cgstRate,
    sgstRate
  };
}

export function createPOSState(initial = {}) {
  let orderType = initial.orderType ?? "dine_in";
  let tableId = initial.tableId ?? null;
  let settings = { cgst_rate: 2.5, sgst_rate: 2.5, ...(initial.settings ?? {}) };
  const cart = new Map();
  const listeners = new Set();

  // Draft persistence is coalesced during rapid taps so synchronous storage I/O
  // does not compete with animation frames. Pending changes are flushed before a
  // draft switch and whenever the page becomes hidden or is being left.
  const getDraftKey = () => `rms.draft.${window.__ACTIVE_TENANT__?.id || 'sys'}.${orderType}.${tableId || 'none'}`;
  let pendingDraftKey = null;
  let draftSaveTimer = null;

  const persistDraft = (key, items) => {
    if (!key) return;
    try {
      if (items.length > 0) localStorage.setItem(key, JSON.stringify(items));
      else localStorage.removeItem(key);
    } catch (error) {
      // Ordering must remain usable even when browser storage is unavailable/full.
      console.warn("Draft persistence failed", error);
    }
  };

  const flushDraft = () => {
    if (draftSaveTimer !== null) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = null;
    }
    const key = pendingDraftKey;
    pendingDraftKey = null;
    if (!key) return;

    // Clone and serialize only when the coalesced write is flushed, not on every tap.
    const items = [...cart.values()].map(item => ({ ...item }));
    persistDraft(key, items);
  };

  const saveDraft = () => {
    pendingDraftKey = getDraftKey();
    if (draftSaveTimer !== null) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(flushDraft, 120);
  };

  const loadDraft = () => {
    // Commit the previous cart under its captured key before changing the active
    // order/table context; otherwise a pending save could overwrite another draft.
    flushDraft();
    cart.clear();
    try {
      const saved = localStorage.getItem(getDraftKey());
      if (saved) JSON.parse(saved).forEach(item => cart.set(item.id, item));
    } catch (e) { console.warn("Draft restore failed", e); }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushDraft);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushDraft();
    }, { passive: true });
  }

  const snapshot = () => {
    const items = [...cart.values()].map(item => ({ ...item }));
    return { items, orderType, tableId, totals: calculateTotals(items, settings) };
  };
  
  const emit = change => {
    saveDraft(); // Coalesce storage writes so rapid taps stay responsive.
    // Build one snapshot per change. Every subscriber receives the same immutable
    // view instead of cloning the cart and calculating totals once per subscriber.
    const current = snapshot();
    listeners.forEach(listener => listener(current, change));
  };

  // Restore initial state on load
  loadDraft();

  return {
    subscribe(listener) { listeners.add(listener); listener(snapshot(), { resync: true }); return () => listeners.delete(listener); },
    getState() { return snapshot(); },
    setSettings(next) { settings = { ...settings, ...(next ?? {}) }; emit({ quantitiesUnchanged: true }); },
    setOrderType(next) {
      flushDraft(); // Flush under the old key before changing context.
      orderType = next === "takeaway" ? "takeaway" : "dine_in";
      if (orderType === "takeaway") tableId = null;
      loadDraft(); // Switch cart memory when changing modes.
      emit({ resync: true });
    },
    setTable(table) {
      flushDraft(); // Flush under the old key before changing context.
      tableId = table?.id ?? null;
      loadDraft(); // Switch cart memory when switching between tables.
      emit({ resync: true });
    },
    addProduct(product) {
      if (!product?.id) return;
      const current = cart.get(product.id);
      const quantity = qty((current?.quantity ?? 0) + 1);
      cart.set(product.id, {
        id: product.id,
        name: product.name,
        category: product.category ?? "Uncategorized",
        price: Number(product.price) || 0,
        tax_exempt: Boolean(product.tax_exempt),
        quantity
      });
      emit({ productId: product.id, quantity });
    },
    increment(id) {
      const item = cart.get(id);
      if (!item) return;
      item.quantity = qty(item.quantity + 1);
      cart.set(id, item);
      emit({ productId: id, quantity: item.quantity });
    },
    decrement(id) {
      const item = cart.get(id);
      if (!item) return;
      item.quantity = qty(item.quantity - 1);
      if (item.quantity <= 0) cart.delete(id); else cart.set(id, item);
      emit({ productId: id, quantity: item.quantity });
    },
    remove(id) { cart.delete(id); emit({ productId: id, quantity: 0 }); },
    clear() { cart.clear(); emit({ resync: true }); },
    canSubmit() {
      const value = snapshot();
      return value.items.length > 0 && (value.orderType === "takeaway" || Boolean(value.tableId));
    },
    toServerItems() { return snapshot().items.map(item => ({ product_id: item.id, quantity: item.quantity })); }
  };
}
