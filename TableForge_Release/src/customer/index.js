// --- INTELLIGENT CUSTOMER BOOTSTRAPPER ---
// This file acts as the secure entry point for unauthenticated QR code scans.

import { supabase } from "../core/supabase.js";
import { render as renderPOS } from "../pos/index.js";

export async function render(context) {
  const { mount } = context;

  // 1. If the Tenant Identity is missing (e.g., direct QR scan without a URL slug)
  if (!window.__ACTIVE_TENANT__) {
    const urlParams = new URLSearchParams(window.location.search);
    const tableId = urlParams.get("table") || urlParams.get("t");

    if (tableId) {
      try {
        // Display a sleek loading state while resolving the cryptographic QR token
        mount.innerHTML = `
          <section class="loading-screen" style="min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--paper, #fff);">
            <div class="empty-state" style="text-align: center;">
              <i class="ph-bold ph-spinner-gap ph-spin" style="font-size: 42px; color: var(--forest-900); margin-bottom: 16px;"></i>
              <strong style="display: block; font-size: 1.2rem; color: var(--forest-950);">Connecting to Table...</strong>
              <span style="color: var(--muted); font-size: 0.95rem;">Preparing your digital menu</span>
            </div>
          </section>`;

        // 2. Because Table UUIDs are globally unique, we can securely query the database 
        // to reverse-lookup exactly which restaurant this table belongs to.
        const { data: brandingRows, error } = await supabase.rpc("get_tenant_branding", {
          p_slug: null,
          p_table_id: tableId
        });
        if (error) throw error;
        const tableBranding = Array.isArray(brandingRows) ? brandingRows[0] : brandingRows;

        if (tableBranding?.id) {
          // Resolve branding through the scoped RPC; anonymous table reads are disabled.
          window.__ACTIVE_TENANT__ = tableBranding;
          
          // Apply dynamic branding immediately to prevent layout flashes
          const r = tableBranding;
          if (r.background_color) {
              document.documentElement.style.setProperty("--cream-100", r.background_color);
              document.documentElement.style.setProperty("--cream-50", r.background_color);
              document.documentElement.style.setProperty("--paper", "#ffffff");
          }
          if (r.foreground_color) {
              document.documentElement.style.setProperty("--forest-950", r.foreground_color);
              document.documentElement.style.setProperty("--forest-900", r.foreground_color);
              document.documentElement.style.setProperty("--forest-800", r.foreground_color);
              document.documentElement.style.setProperty("--forest-700", r.foreground_color);
              document.documentElement.style.setProperty("--ink", r.foreground_color);
          }
        } else {
           // Security catch: Table was deleted or turned off by the Admin
           mount.innerHTML = `
             <section class="access-screen" style="display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #fff; padding: 24px; text-align: center;">
               <div>
                 <i class="ph-bold ph-warning-circle" style="font-size: 56px; color: var(--danger); margin-bottom: 16px;"></i>
                 <h1 style="font-size: 1.75rem; color: var(--forest-950); margin-bottom: 8px;">Invalid QR Code</h1>
                 <p style="color: var(--muted); font-size: 1rem; line-height: 1.5;">This table does not exist or is currently inactive.<br>Please ask a staff member for assistance.</p>
               </div>
             </section>`;
           return () => {};
        }
      } catch (err) {
        console.error("QR Resolution Error:", err);
        mount.innerHTML = `
          <section class="access-screen" style="display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #fff; padding: 24px; text-align: center;">
            <div>
              <i class="ph-bold ph-wifi-slash" style="font-size: 56px; color: var(--danger); margin-bottom: 16px;"></i>
              <h1 style="font-size: 1.75rem; color: var(--forest-950); margin-bottom: 8px;">Connection Error</h1>
              <p style="color: var(--muted); font-size: 1rem; line-height: 1.5;">Could not connect to the restaurant database.<br>Please check your internet and refresh.</p>
            </div>
          </section>`;
        return () => {};
      }
    }
  }

  // 4. Hand off the securely hydrated context to the Master POS Engine
  return await renderPOS(context);
}