import { APP_VERSION } from "./src/core/config.js";
import { startRouter } from "./src/core/router.js";
import { supabase } from "./src/core/supabase.js";

// Global Platform Object
window.RMS = Object.freeze({ name: "Table Forge System", APP_VERSION, build: APP_VERSION });
const mount = document.querySelector("#app");
if (!mount) throw new Error("RMS root #app was not found.");

// SLUG-BASED SAAS ROUTER
async function bootSaaS() {
    // 1. Analyze the current URL pathname safely
    let path = window.location.pathname.replace(/^\/|\/$/g, ''); 
    
    // CRITICAL FIX: Aggressively strip "index.html" so Live Server doesn't trigger a 404
    path = path.replace(/index\.html$/i, '').replace(/\/$/, '');
    
    const urlParams = new URLSearchParams(window.location.search);
    const tableId = urlParams.get("table");

    // 2 & 3. Securely Fetch Branding via the Database Bootstrapper (Handles both QR Scans and Slug Navigation)
    if (tableId || (path && path !== "")) {
        try {
            const { data: tenant, error } = await supabase.rpc("get_tenant_branding", { 
                p_slug: path || null, 
                p_table_id: tableId || null 
            }).maybeSingle();

            if (tenant) {
                // Dynamically paint the app with the specific restaurant's brand colors
                if (tenant.background_color) {
                    document.documentElement.style.setProperty("--cream-100", tenant.background_color);
                    document.documentElement.style.setProperty("--cream-50", tenant.background_color);
                    document.documentElement.style.setProperty("--paper", "#ffffff");
                }
                if (tenant.foreground_color) {
                    document.documentElement.style.setProperty("--forest-950", tenant.foreground_color);
                    document.documentElement.style.setProperty("--forest-900", tenant.foreground_color);
                    document.documentElement.style.setProperty("--forest-800", tenant.foreground_color);
                    document.documentElement.style.setProperty("--forest-700", tenant.foreground_color);
                    document.documentElement.style.setProperty("--ink", tenant.foreground_color);
                }
                
                // CRITICAL FIX: Store tenant data globally. This safely includes the 'id' which unlocks the POS!
                window.__ACTIVE_TENANT__ = tenant;
                document.title = `${tenant.name} | Table Forge`;
            } else {
                // Failsafe: 404 Restaurant Not Found or Invalid QR Code
                mount.innerHTML = `<section style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; text-align: center; padding: 24px; font-family: system-ui, sans-serif; background: #fcfbf7;">
                    <i class="ph-fill ph-storefront" style="font-size: 56px; color: #e11d48; margin-bottom: 16px;"></i>
                    <h1 style="margin: 0 0 8px 0; color: #122216; font-size: 1.6rem; font-weight: 900;">Restaurant Not Found</h1>
                    <p style="color: #6d766d; margin: 0; font-size: 0.95rem;">This link or QR code does not match an active restaurant.</p>
                </section>`;
                return;
            }
        } catch (error) {
            console.error("RMS Tenant Boot Error:", error);
        }
    } else {
        // Base URL (Global Platform Hub)
        document.title = "Table Forge System | Cloud POS";
    }

    // 4. Start the Application Router
    startRouter({ mount });
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

bootSaaS();