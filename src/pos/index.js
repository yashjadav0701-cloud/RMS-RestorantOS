import { supabase } from "../core/supabase.js";
import { DEFAULT_SETTINGS, versionedAsset } from "../core/config.js";
import { createPOSState } from "../core/posState.js";
import { escapeHtml, money, mountNavigation, openAppModal, showToast, openUniversalReceipt } from "../components/navigation.js";
import { installPanelSignOut, requestPanelSignOut } from "../core/panelSession.js";

// Ensure global CSS animation is injected safely to avoid browser blocking
const ensureGlobalPulse = () => {
    if (!document.getElementById("premium-squircle-styles")) {
        const style = document.createElement("style");
        style.id = "premium-squircle-styles";
        style.innerHTML = `
            /* Premium iOS-style Squircle Engine */
            .premium-squircle {
                width: 104px; height: 104px; border-radius: 32px;
                display: flex; align-items: center; justify-content: center;
                margin: 0 auto 32px auto; color: #ffffff; position: relative;
                box-shadow: 0 16px 32px var(--sq-glow);
                background: var(--sq-bg);
            }
            .premium-squircle i { font-size: 52px; z-index: 2; }
            
            /* Color Themes */
            .sq-amber { --sq-bg: linear-gradient(135deg, #f59e0b, #ea580c); --sq-glow: rgba(234, 88, 12, 0.35); }
            .sq-blue  { --sq-bg: linear-gradient(135deg, #38bdf8, #0284c7); --sq-glow: rgba(2, 132, 199, 0.35); }
            .sq-green { --sq-bg: linear-gradient(135deg, #4ade80, #16a34a); --sq-glow: rgba(22, 163, 74, 0.35); }
            .sq-red   { --sq-bg: linear-gradient(135deg, #fb7185, #e11d48); --sq-glow: rgba(225, 29, 72, 0.35); }
            .sq-slate { --sq-bg: linear-gradient(135deg, #94a3b8, #475569); --sq-glow: rgba(71, 85, 105, 0.35); }

            /* Cinematic Animations */
            @keyframes sqFloat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
            @keyframes sqPop { 0% { transform: scale(0.6); opacity: 0; } 60% { transform: scale(1.15); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
            @keyframes sqPulseGlow { 0%, 100% { box-shadow: 0 16px 32px var(--sq-glow); } 50% { box-shadow: 0 24px 48px var(--sq-glow); transform: scale(1.02); } }
            
            .anim-float { animation: sqFloat 4s ease-in-out infinite; }
            .anim-pop { animation: sqPop 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
            .anim-pulse { animation: sqPulseGlow 3s ease-in-out infinite; }
        `;
        document.head.appendChild(style);
    }
};

export async function render({ mount, route }) {
  if (!supabase) {
    mount.innerHTML = `<section class="access-screen dark-access"><div class="access-card"><div class="access-logo" style="display:grid; place-items:center; color:var(--forest-900); background:#fff;"><i class="ph-bold ph-warning-circle" style="font-size:32px;"></i></div><h1>Table Forge System</h1><p>Supabase configuration is missing.</p></div></section>`;
    return () => {};
  }

  let activeTenant = window.__ACTIVE_TENANT__;

  if (!activeTenant) {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
          const { data: rest } = await supabase
            .from("restaurants")
            .select("id, name, slug, icon_url, logo_url, background_color, foreground_color")
            .eq("owner_id", user.id)
            .maybeSingle();
          if (rest) {
              activeTenant = rest;
              window.__ACTIVE_TENANT__ = rest;
              
              if (rest.background_color) {
                  document.documentElement.style.setProperty("--cream-100", rest.background_color);
                  document.documentElement.style.setProperty("--cream-50", rest.background_color);
                  document.documentElement.style.setProperty("--paper", "#ffffff");
              }
              if (rest.foreground_color) {
                  document.documentElement.style.setProperty("--forest-950", rest.foreground_color);
                  document.documentElement.style.setProperty("--forest-900", rest.foreground_color);
                  document.documentElement.style.setProperty("--forest-800", rest.foreground_color);
                  document.documentElement.style.setProperty("--forest-700", rest.foreground_color);
                  document.documentElement.style.setProperty("--ink", rest.foreground_color);
              }
          }
      }
  }

  if (!activeTenant?.id) {
      mount.innerHTML = `<section class="access-screen" style="text-align:center; padding:24px;">
        <i class="ph-bold ph-warning-circle" style="font-size:48px; color:var(--danger); margin-bottom:16px;"></i>
        <h1>Restaurant Data Missing</h1>
        <p style="color:var(--muted); margin-top:8px;">Please navigate to your specific restaurant URL or check your database configuration.</p>
      </section>`;
      return () => {};
  }
  
  const activeTenantId = activeTenant.id;
  const urlParams = new URLSearchParams(window.location.search);
  const qrTableId = urlParams.get("table") || urlParams.get("t");
  const isCustomerMode = Boolean(qrTableId);

  let settingsResult;
  let productsResult;
  let tablesResult;
  let cuisinesResult;

  if (isCustomerMode) {
    // Anonymous customers receive only the menu/settings scoped by the scanned table.
    const { data, error } = await supabase.rpc("get_public_pos_data", {
      p_table_id: qrTableId
    });
    if (error) throw error;
    if (!data || data.restaurant_id !== activeTenantId) {
      throw new Error("The scanned table does not belong to the active restaurant.");
    }
    settingsResult = { data: data.settings ?? {}, error: null };
    productsResult = { data: data.products ?? [], error: null };
    tablesResult = { data: data.tables ?? [], error: null };
    cuisinesResult = { data: data.cuisines ?? [], error: null };
  } else {
    [settingsResult, productsResult, tablesResult, cuisinesResult] = await Promise.all([
      supabase.rpc("get_operational_settings", {
        p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null
      }),
      supabase.from("products").select("*").eq("restaurant_id", activeTenantId).eq("is_active", true).order("sort_order", { ascending: true }).order("name", { ascending: true }),
      supabase.from("tables").select("id, table_no, capacity, is_active").eq("restaurant_id", activeTenantId).eq("is_active", true).order("table_no", { ascending: true }),
      supabase.from("cuisines").select("*").eq("restaurant_id", activeTenantId).order("sort_order", { ascending: true })
    ]);
    for (const result of [settingsResult, productsResult, tablesResult, cuisinesResult]) {
      if (result?.error) throw result.error;
    }
  }

  const restaurant = window.__ACTIVE_TENANT__ || { name: "Table Forge", background_color: "#fcfbf7", foreground_color: "#122216" };
  const settings = { ...DEFAULT_SETTINGS, ...(settingsResult.data ?? {}) };
  const products = productsResult.data ?? [];
  const cuisines = cuisinesResult.data ?? [];

  if (restaurant.background_color) {
    document.documentElement.style.setProperty("--cream-100", restaurant.background_color);
    document.documentElement.style.setProperty("--paper", "#ffffff");
  }
  if (restaurant.foreground_color) {
    document.documentElement.style.setProperty("--forest-900", restaurant.foreground_color);
    document.documentElement.style.setProperty("--forest-950", restaurant.foreground_color);
    document.documentElement.style.setProperty("--forest-800", restaurant.foreground_color);
  }
  
  const tables = (tablesResult.data ?? []).sort((a, b) => 
    String(a.table_no).localeCompare(String(b.table_no), undefined, { numeric: true, sensitivity: 'base' })
  );
  
  window.__FF_TABLES__ = tables;
  
  const isCaptainPanel =
    !isCustomerMode && route?.panelId === "captain";

  const isCashierPanel =
    !isCustomerMode && route?.panelId === "cashier";

  const scanParam = urlParams.get("scan");
  const isPhysicalScan = scanParam && scanParam.toLowerCase() === "true";
  
  let customerSessionToken = null;
  const currentTableObj = isCustomerMode ? tables.find(t => t.id === qrTableId) : null;

  if (isCustomerMode) {
    ensureGlobalPulse();
    
    if (!currentTableObj) {
      mount.innerHTML = `<main class="customer-page"><section class="customer-message"><div class="message-mark"><i class="ph ph-qr-code"></i></div><span class="eyebrow">${escapeHtml(restaurant.name)}</span><h1>Table unavailable</h1><p>This QR code is invalid or no longer active.</p></section></main>`;
      return () => {};
    }
    
    const sessionKey = `rms.session.${currentTableObj.id}`;
    const legacySessionKey = `fourflavours.session.${currentTableObj.id}`;
    const tabSessionKey = `rms.tab.${currentTableObj.id}`;
    
    if (isPhysicalScan) {
        localStorage.removeItem(sessionKey);
        localStorage.removeItem(legacySessionKey);
        sessionStorage.removeItem(tabSessionKey);
        const hash = window.location.hash;
        const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + "?table=" + qrTableId + hash;
        window.history.replaceState({ path: cleanUrl }, '', cleanUrl);
    }

    let existingToken = localStorage.getItem(sessionKey) || localStorage.getItem(legacySessionKey);

    if (existingToken) {
        const { data: sessionState, error: sessionStateError } = await supabase.rpc("get_customer_session_state", {
            p_table_id: currentTableObj.id,
            p_session_token: existingToken
        });
        const mySession = sessionStateError ? null : (sessionState?.[0] ?? sessionState);

        if (mySession) {
            if (["open", "bill_requested", "bill_ready"].includes(mySession.status)) {
                sessionStorage.setItem(tabSessionKey, existingToken);
            }

            // 1. Reusable Payment Success View (Rendered dynamically when server confirms payment)
            const renderPaymentSuccess = () => {
                // Wipe the tokens instantly so if they reload or hit back, they get locked out natively
                sessionStorage.removeItem(tabSessionKey);
                localStorage.removeItem(sessionKey);
                localStorage.removeItem(legacySessionKey);
                
                const rootNode = document.querySelector("#app") || mount;
                rootNode.innerHTML = `
                  <main class="premium-lock-screen" style="display: flex; align-items: center; justify-content: center; min-height: 100vh; background: var(--cream-100, #FCFCF9); padding: 24px; font-family: inherit;">
                    <div class="premium-lock-card" style="background: var(--paper, #ffffff); max-width: 440px; width: 100%; border-radius: 32px; padding: 56px 32px; box-shadow: 0 24px 48px rgba(18, 34, 22, 0.08); text-align: center; border: 1px solid rgba(0,0,0,0.04);">
                      <div class="premium-squircle sq-green anim-pop" style="margin-bottom: 24px;">
                        <i class="ph-bold ph-check"></i>
                      </div>
                      <h1 class="premium-lock-title" style="font-size: 2.2rem; font-weight: 900; color: var(--forest-950); margin-bottom: 12px; letter-spacing: -0.02em;">Payment Successful</h1>
                      <p class="premium-lock-desc" style="font-size: 1.15rem; font-weight: 600; color: var(--forest-800); margin-bottom: 32px; line-height: 1.5;">Your table has been successfully cleared. We hope you enjoyed your meal and look forward to serving you again soon!</p>
                      <button onclick="window.location.reload()" style="background: var(--forest-950); color: #fff; border: none; border-radius: 14px; padding: 14px 24px; font-size: 1.05rem; font-weight: 800; cursor: pointer; width: 100%; box-shadow: 0 8px 24px rgba(18,34,22,0.15); transition: transform 0.15s;" onmousedown="this.style.transform='scale(0.96)'" onmouseup="this.style.transform='scale(1)'">Close Session</button>
                    </div>
                  </main>
                `;
            };

            // 2. The Bill Requested State (With CSS Clock Animation)
            if (mySession.status === "bill_requested" || mySession.status === "bill_ready") {
                mount.innerHTML = `
                  <style>
                    @keyframes spinMinute { 0% { transform: translateX(-50%) rotate(0deg); } 100% { transform: translateX(-50%) rotate(360deg); } }
                    @keyframes spinHour { 0% { transform: translateX(-50%) rotate(0deg); } 100% { transform: translateX(-50%) rotate(360deg); } }
                    .css-clock { width: 48px; height: 48px; border: 4px solid var(--forest-900); border-radius: 50%; position: relative; margin: 0 auto; box-shadow: inset 0 2px 4px rgba(0,0,0,0.05); background: transparent; }
                    .css-clock::before { content: ''; position: absolute; bottom: 50%; left: 50%; width: 3px; height: 18px; background: var(--forest-900); border-radius: 2px; transform-origin: bottom center; transform: translateX(-50%); animation: spinMinute 2s linear infinite; }
                    .css-clock::after { content: ''; position: absolute; bottom: 50%; left: 50%; width: 4px; height: 12px; background: var(--forest-900); border-radius: 2px; transform-origin: bottom center; transform: translateX(-50%); animation: spinHour 24s linear infinite; }
                    .css-clock-center { position: absolute; top: 50%; left: 50%; width: 8px; height: 8px; background: var(--forest-900); border: 2px solid var(--sage-200); border-radius: 50%; transform: translate(-50%, -50%); z-index: 10; }
                  </style>
                  <main class="premium-lock-screen" style="display: flex; align-items: center; justify-content: center; min-height: 100vh; background: var(--cream-100, #FCFCF9); padding: 24px; font-family: inherit;">
                    <div class="premium-lock-card" style="background: var(--paper, #ffffff); max-width: 440px; width: 100%; border-radius: 32px; padding: 56px 32px; box-shadow: 0 24px 48px rgba(18, 34, 22, 0.08); text-align: center; border: 1px solid rgba(0,0,0,0.04);">
                      <div class="premium-squircle anim-pulse" style="margin-bottom: 24px; background: var(--sage-200); box-shadow: 0 16px 32px rgba(219, 228, 214, 0.5);">
                        <div class="css-clock"><div class="css-clock-center"></div></div>
                      </div>
                      <h1 class="premium-lock-title" style="font-size: 2.2rem; font-weight: 900; color: var(--forest-950); margin-bottom: 12px; letter-spacing: -0.02em;">Bill Requested</h1>
                      <p class="premium-lock-desc" style="font-size: 1.15rem; font-weight: 600; color: var(--forest-800); margin-bottom: 32px; line-height: 1.5;">Please settle your bill with the restaurant staff in person. Your table will close after staff records the payment.</p>
                      <div class="thank-you-divider" style="width: 40px; height: 4px; background: var(--sage-300); margin: 0 auto 32px auto; border-radius: 4px;"></div>
                      <p class="thank-you-footer" style="font-size: 0.95rem; color: var(--forest-600); line-height: 1.6; font-weight: 700;">Thank you for dining at ${escapeHtml(restaurant.name)}!</p>
                    </div>
                  </main>
                `;

                const checkServerForPayment = async () => {
                    const { data, error } = await supabase.rpc("get_customer_session_state", { p_table_id: currentTableObj.id, p_session_token: existingToken });
                    const sessionState = data?.[0] ?? data;
                    if (!error && sessionState?.status === "closed") {
                        clearInterval(pollFallback); document.removeEventListener("visibilitychange", visibilityCheck); supabase.removeChannel(pendingChannel);
                        renderPaymentSuccess();
                    }
                };
                const pendingChannel = supabase.channel(`pending-tab-${currentTableObj.id}`).on("postgres_changes", { event: "UPDATE", schema: "public", table: "dining_sessions", filter: `table_id=eq.${currentTableObj.id}` }, () => checkServerForPayment()).subscribe();
                const pollFallback = setInterval(checkServerForPayment, 3000);
                const visibilityCheck = () => { if (document.visibilityState === 'visible') checkServerForPayment(); };
                document.addEventListener("visibilitychange", visibilityCheck); checkServerForPayment();

                return () => { clearInterval(pollFallback); document.removeEventListener("visibilitychange", visibilityCheck); supabase.removeChannel(pendingChannel); };
            }

            // 3. The Standard "Session Expired" State (Triggered natively on reload/back if closed)
            if (mySession.status === "closed") {
                sessionStorage.removeItem(tabSessionKey);
                localStorage.removeItem(sessionKey);
                localStorage.removeItem(legacySessionKey);
                existingToken = null;
                
                const closedDate = new Date(mySession.closed_at || Date.now());
                const timeString = closedDate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
                
                mount.innerHTML = `
                  <main class="premium-lock-screen" style="display: flex; align-items: center; justify-content: center; min-height: 100vh; background: var(--cream-100, #FCFCF9); padding: 24px; font-family: inherit;">
                    <div class="premium-lock-card" style="background: var(--paper, #ffffff); max-width: 440px; width: 100%; border-radius: 32px; padding: 56px 32px; box-shadow: 0 24px 48px rgba(18, 34, 22, 0.08); text-align: center; border: 1px solid rgba(0,0,0,0.04);">
                      <div class="premium-squircle sq-slate anim-float" style="margin-bottom: 24px;">
                        <i class="ph-bold ph-lock-key"></i>
                      </div>
                      <p style="margin: 0 0 8px; color: var(--forest-600); font-size: 11px; font-weight: 900; letter-spacing: 0.15em; text-transform: uppercase;">Table ${escapeHtml(currentTableObj.table_no)}</p>
                      <h1 class="premium-lock-title" style="font-size: 2.2rem; font-weight: 900; color: var(--forest-950); margin-bottom: 12px; letter-spacing: -0.02em;">Session Expired</h1>
                      <p class="premium-lock-desc" style="font-size: 1.1rem; font-weight: 600; color: var(--forest-800); margin-bottom: 24px; line-height: 1.5;">Your dining session was closed by staff at ${timeString}.</p>
                      
                      <div style="width: 100%; display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 12px; align-items: start; padding: 16px; border: 1px solid rgba(18, 34, 22, 0.08); border-radius: 16px; background: #f8faf6; color: var(--forest-900); text-align: left;">
                        <i class="ph-bold ph-shield-check" style="color: var(--forest-700); font-size: 24px;"></i>
                        <div style="display: flex; flex-direction: column; gap: 4px;">
                          <strong style="font-size: 13px; line-height: 1.35; font-weight: 900;">Security lock active</strong>
                          <span style="color: var(--muted); font-size: 12.5px; line-height: 1.5; font-weight: 600;">Please scan the QR code physically displayed on your table to start a new visit.</span>
                        </div>
                      </div>
                    </div>
                  </main>
                `;
                window.history.replaceState({ locked: true }, "", window.location.href);
                return () => {};
            }
        } else {
            localStorage.removeItem(sessionKey);
            localStorage.removeItem(legacySessionKey);
            existingToken = null;
        }
    }

    if (!existingToken && !isPhysicalScan) {
        mount.innerHTML = `
          <main class="premium-lock-screen" style="display: flex; align-items: center; justify-content: center; min-height: 100vh; background: var(--cream-100, #FCFCF9); padding: 24px; font-family: inherit;">
            <div class="premium-lock-card" style="background: var(--paper, #ffffff); max-width: 440px; width: 100%; border-radius: 32px; padding: 56px 32px; box-shadow: 0 24px 48px rgba(18, 34, 22, 0.08); text-align: center; border: 1px solid rgba(0,0,0,0.04);">
              <div class="premium-squircle sq-amber anim-float">
                <i class="ph-bold ph-qr-code"></i>
              </div>
              <h1 class="premium-lock-title" style="font-size: 2.2rem; font-weight: 900; color: var(--forest-950); margin-bottom: 12px; letter-spacing: -0.02em;">Scan Required</h1>
              <p class="premium-lock-desc" style="font-size: 1.15rem; font-weight: 600; color: var(--forest-800); margin-bottom: 32px; line-height: 1.5;">To access the menu and start ordering, please scan the QR code securely located on your table.</p>
            </div>
          </main>
        `;
        return () => {};
    }

    const { data: tableAccessData, error: tableAccessError } = await supabase.rpc(
        "get_customer_table_access",
        {
            p_table_id: currentTableObj.id,
            p_session_token: existingToken
        }
    );

    if (tableAccessError) throw tableAccessError;

    const tableAccess = Array.isArray(tableAccessData)
        ? tableAccessData[0]
        : tableAccessData;

    if (tableAccess?.is_occupied && !tableAccess?.token_matches) {
        if (!isPhysicalScan) {
            mount.innerHTML = `
              <main class="premium-lock-screen" style="display: flex; align-items: center; justify-content: center; min-height: 100vh; background: var(--cream-100, #FCFCF9); padding: 24px; font-family: inherit;">
                <div class="premium-lock-card" style="background: var(--paper, #ffffff); max-width: 440px; width: 100%; border-radius: 32px; padding: 56px 32px; box-shadow: 0 24px 48px rgba(18, 34, 22, 0.08); text-align: center; border: 1px solid rgba(0,0,0,0.04);">
                  <div class="premium-squircle sq-red anim-pulse">
                    <i class="ph-bold ph-hand-palm"></i>
                  </div>
                  <h1 class="premium-lock-title" style="font-size: 2.2rem; font-weight: 900; color: var(--forest-950); margin-bottom: 12px; letter-spacing: -0.02em;">Table Occupied</h1>
                  <p class="premium-lock-desc" style="font-size: 1.15rem; font-weight: 600; color: var(--forest-800); margin-bottom: 32px; line-height: 1.5;">Table ${currentTableObj.table_no} is currently in use by another guest's device.</p>
                  <button class="try-again-btn" onclick="window.location.reload()" style="width: 100%; border-radius: 12px; height: 52px; display: flex; align-items: center; justify-content: center; gap: 8px; background: #ffffff; border: 1px solid var(--line); color: var(--forest-900); font-size: 1rem; font-weight: 800; cursor: pointer;"><i class="ph-bold ph-arrows-clockwise" style="font-size: 20px;"></i> Try Again</button>
                </div>
              </main>
            `;
            return () => {};
        }
    }

    let sessionBootstrap, sessionError;
    
    // 🧠 THE INFINITE LOOP FIX: If the user already unlocked the table and holds the valid token, skip the PIN check entirely!
    if (tableAccess?.is_occupied && tableAccess?.token_matches && existingToken) {
        sessionBootstrap = [{ session_token: existingToken }];
        sessionError = null;
    } else {
        try {
            // First attempt with a null PIN to see if the table requires one
            const { data, error } = await supabase.rpc("ensure_customer_session", { p_table_id: currentTableObj.id, p_pin: null });
            sessionBootstrap = data;
            sessionError = error;
        } catch(err) {
            sessionError = err;
        }
    }

    if (sessionError && sessionError.message.includes('INVALID_DAILY_PIN')) {
        mount.innerHTML = `
          <style>
            /* The Falling Down Animation */
            @keyframes dropOut {
              0% { transform: translateY(0) rotate(0deg); opacity: 1; }
              100% { transform: translateY(120px) rotate(15deg); opacity: 0; }
            }
            /* The Falling From Above Animation */
            @keyframes dropIn {
              0% { transform: translateY(-60px); opacity: 0; }
              70% { transform: translateY(5px); opacity: 1; }
              100% { transform: translateY(0); opacity: 1; }
            }
            /* The Shake Animation */
            @keyframes iconShake {
              0%, 100% { transform: translateX(0); }
              20% { transform: translateX(-6px) rotate(-5deg); }
              40% { transform: translateX(6px) rotate(5deg); }
              60% { transform: translateX(-6px) rotate(-5deg); }
              80% { transform: translateX(6px) rotate(5deg); }
            }
            
            /* Premium 4-Box PIN Layout */
            .pin-box-container { display: flex; gap: 12px; justify-content: center; margin-bottom: 24px; position: relative; perspective: 500px; }
            .pin-box { 
                width: 64px; height: 72px; 
                text-align: center; font-size: 32px; font-weight: 900; color: var(--forest-950);
                border-radius: 16px; border: 2px solid var(--line); background: var(--paper);
                outline: none; transition: border-color 0.2s, box-shadow 0.2s, background-color 0.2s;
                box-shadow: 0 4px 12px rgba(0,0,0,0.02);
                caret-color: transparent; 
            }
            .pin-box:focus {
                border-color: var(--forest-900); background: #ffffff;
                box-shadow: 0 8px 24px rgba(18,34,22,0.1); transform: translateY(-2px);
            }
            
            /* Animation Classes */
            .pin-box.falling-out {
               animation: dropOut 0.5s cubic-bezier(0.55, 0.085, 0.68, 0.53) forwards;
               pointer-events: none;
            }
            .pin-box.dropping-in {
               animation: dropIn 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
            }
            .sq-error-shake {
               animation: iconShake 0.5s ease-in-out;
               background: linear-gradient(135deg, #fb7185, #e11d48) !important;
               box-shadow: 0 16px 32px rgba(225, 29, 72, 0.35) !important;
            }
          </style>
          
          <main class="premium-lock-screen" style="display: flex; align-items: center; justify-content: center; min-height: 100vh; background: var(--cream-100, #FCFCF9); padding: 24px; font-family: inherit; overflow: hidden;">
            <div class="premium-lock-card" style="background: var(--paper, #ffffff); max-width: 440px; width: 100%; border-radius: 32px; padding: 56px 32px; box-shadow: 0 24px 48px rgba(18, 34, 22, 0.08); text-align: center; border: 1px solid rgba(0,0,0,0.04); position: relative;">
              <div id="lock-icon-container" class="premium-squircle sq-blue anim-float" style="margin-bottom: 24px; transition: all 0.3s ease;">
                <i id="lock-icon" class="ph-bold ph-lock-key"></i>
              </div>
              <h1 class="premium-lock-title" style="font-size: 2.2rem; font-weight: 900; color: var(--forest-950); margin-bottom: 12px; letter-spacing: -0.02em;">Table Locked</h1>
              
              <div style="height: 60px; margin-bottom: 24px; display: flex; align-items: center; justify-content: center; position: relative;">
                 <p id="pin-prompt-msg" class="premium-lock-desc" style="font-size: 1.15rem; font-weight: 600; color: var(--forest-800); margin: 0; line-height: 1.5; transition: opacity 0.2s;">Please enter the daily dining PIN to access the menu for Table ${currentTableObj.table_no}.</p>
                 <p id="pin-error-msg" style="font-size: 1.15rem; font-weight: 800; color: #e11d48; margin: 0; line-height: 1.5; display: none; position: absolute; width: 100%;">Incorrect PIN entered.</p>
              </div>
              
              <div class="pin-box-container" id="pin-box-container">
                 <input type="tel" class="pin-box" maxlength="1" pattern="[0-9]*" inputmode="numeric" autocomplete="off" />
                 <input type="tel" class="pin-box" maxlength="1" pattern="[0-9]*" inputmode="numeric" autocomplete="off" />
                 <input type="tel" class="pin-box" maxlength="1" pattern="[0-9]*" inputmode="numeric" autocomplete="off" />
                 <input type="tel" class="pin-box" maxlength="1" pattern="[0-9]*" inputmode="numeric" autocomplete="off" />
              </div>
              
              <div id="pin-loading-indicator" style="display: none; height: 24px; align-items: center; justify-content: center; color: var(--forest-900); font-weight: 800; font-size: 16px; margin-top: 16px;">
                 <i class="ph-bold ph-spinner-gap ph-spin" style="margin-right: 8px;"></i> Unlocking...
              </div>
            </div>
          </main>
        `;

        const boxContainer = mount.querySelector("#pin-box-container");
        let inputs = Array.from(mount.querySelectorAll(".pin-box"));
        const promptMsg = mount.querySelector("#pin-prompt-msg");
        const errorMsg = mount.querySelector("#pin-error-msg");
        const loadingIndicator = mount.querySelector("#pin-loading-indicator");
        const lockIconContainer = mount.querySelector("#lock-icon-container");
        const lockIcon = mount.querySelector("#lock-icon");
        
        let isProcessing = false;

        function setupInputs(inputElements) {
            inputElements[0].focus();

            inputElements.forEach((input, index) => {
                input.addEventListener('input', (e) => {
                    if (isProcessing) { e.target.value = ''; return; }
                    
                    e.target.value = e.target.value.replace(/[^0-9]/g, '');
                    
                    if (e.target.value.length === 1) {
                        if (index < inputElements.length - 1) {
                            inputElements[index + 1].focus();
                        } else {
                            // Automatically trigger submission on the 6th digit!
                            submitPin(inputElements);
                        }
                    }
                });

                input.addEventListener('keydown', (e) => {
                    if (isProcessing) return;
                    if (e.key === 'Backspace' && e.target.value === '' && index > 0) {
                        inputElements[index - 1].focus();
                        inputElements[index - 1].value = '';
                    }
                });
                
                input.addEventListener('paste', (e) => {
                    if (isProcessing) return;
                    e.preventDefault();
                    const pasteData = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '');
                    if (pasteData) {
                        for (let i = 0; i < inputElements.length; i++) {
                            if (pasteData[i]) {
                                inputElements[i].value = pasteData[i];
                                if (i < inputElements.length - 1) inputElements[i + 1].focus();
                            }
                        }
                        if (pasteData.length >= 4) submitPin(inputElements);
                    }
                });
            });
        }

        setupInputs(inputs);

        async function submitPin(currentInputs) {
            const pin = currentInputs.map(i => i.value).join("");
            if (pin.length < 4) return;
            
            isProcessing = true;
            currentInputs.forEach(i => i.disabled = true);
            loadingIndicator.style.display = "flex";
            
            const { data, error } = await supabase.rpc("ensure_customer_session", { p_table_id: currentTableObj.id, p_pin: pin });
            
            if (error && error.message.includes('INVALID_DAILY_PIN')) {
                // THE FALLING REJECTION ANIMATION
                loadingIndicator.style.display = "none";
                
                lockIconContainer.className = "premium-squircle sq-error-shake";
                lockIcon.className = "ph-bold ph-x";
                
                promptMsg.style.opacity = "0";
                setTimeout(() => { errorMsg.style.display = "block"; }, 150);

                // Right to Left Staggered Fall
                currentInputs.forEach((i, idx) => {
                    const delay = (3 - idx) * 80; // 240ms, 160ms, 80ms, 0ms
                    setTimeout(() => { i.classList.add("falling-out"); i.style.borderColor = "#e11d48"; i.style.color = "#e11d48"; }, delay);
                });

                // Rebuild boxes from above
                setTimeout(() => {
                    boxContainer.innerHTML = ''; 
                    
                    for(let i=0; i<4; i++) {
                        const newBox = document.createElement("input");
                        newBox.type = "tel";
                        newBox.className = "pin-box dropping-in";
                        newBox.maxLength = 1;
                        newBox.pattern = "[0-9]*";
                        newBox.inputMode = "numeric";
                        newBox.autocomplete = "off";
                        // Left to Right Staggered Drop In
                        newBox.style.animationDelay = `${i * 60}ms`;
                        boxContainer.appendChild(newBox);
                    }
                    
                    inputs = Array.from(mount.querySelectorAll(".pin-box"));
                    setupInputs(inputs);
                    isProcessing = false;
                    
                    setTimeout(() => {
                        inputs.forEach(i => i.classList.remove("dropping-in"));
                    }, 500);

                }, 800); 
                
            } else if (error) {
                currentInputs.forEach(i => i.disabled = false);
                loadingIndicator.style.display = "none";
                promptMsg.style.opacity = "0";
                errorMsg.textContent = error.message;
                errorMsg.style.display = "block";
                isProcessing = false;
            } else {
                // SUCCESS SEQUENCE
                loadingIndicator.style.display = "none";
                lockIconContainer.className = "premium-squircle sq-green anim-pop";
                lockIcon.className = "ph-bold ph-check";
                
                const sessionData = Array.isArray(data) ? data[0] : data;
                if (sessionData?.session_token) {
                    localStorage.setItem(sessionKey, sessionData.session_token);
                    sessionStorage.setItem(tabSessionKey, sessionData.session_token);
                    
                    setTimeout(() => {
                        window.location.reload(); 
                    }, 600);
                }
            }
        }

        return () => {};
    } else if (sessionError) {
        throw sessionError;
    }
    
    customerSessionToken = (sessionBootstrap?.[0] ?? sessionBootstrap)?.session_token;
    if (customerSessionToken) {
        localStorage.setItem(sessionKey, customerSessionToken);
        sessionStorage.setItem(tabSessionKey, customerSessionToken);
    }
  }

  const state = createPOSState({ settings });
  window.__FOUR_FLAVOURS_POS_STATE__ = state; // 🔥 Re-export global state so Admin buttons can communicate with it!
  
  // 🛡️ CUSTOMER CART & SESSION SECURITY FIX
  if (isCustomerMode) {
      const previousTableId = state.getState().tableId;

      state.setOrderType("dine_in");
      state.setTable(currentTableObj);

      // Clear the target-table draft after setTable has loaded it on a physical scan.
      if (isPhysicalScan || (previousTableId && previousTableId !== currentTableObj.id)) {
          state.clear();
      }
  } else if (isCaptainPanel) {
      // Each new Captain workspace starts with an empty, unsubmitted draft.
      // Previously submitted orders remain in the database and are not deleted.
      state.clear();
      state.setOrderType("dine_in");
      state.setTable(null);
  } else if (isCashierPanel) {
      // Each new Cashier workspace starts with an empty takeaway draft.
      state.clear();
      state.setOrderType("takeaway");
      state.setTable(null);
  }

  const adminAlertChannel = supabase.channel('ff-admin-alerts');
  adminAlertChannel.subscribe();
  
  let activeCuisine = null;
  let activeSubCategory = "All";
  let searchTerm = "";
  let drawerCleanup = null;
  let realtimeChannel = null;
  let unreadOrders = 0;
  const activeTableOrders = {}; 

  const handlePopState = (e) => {
    if (e.state?.view === "cuisine" && e.state?.cuisine) {
      activeCuisine = e.state.cuisine;
      activeSubCategory = "All";
    } else {
      activeCuisine = null;
      activeSubCategory = "All";
    }
    searchTerm = "";
    const searchField = document.querySelector("#pos-search");
    if (searchField) searchField.value = "";
    renderProducts();
  };
  window.addEventListener("popstate", handlePopState);

  mount.innerHTML = `
    <section class="pos-page ${isCustomerMode ? 'customer-viewport' : 'staff-viewport'}">
      <header class="app-topbar pos-topbar">
        <div class="topbar-side topbar-left" style="gap: 14px; align-items: center; display: flex;">
          ${isCustomerMode ? `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: auto; height: 42px; padding: 4px 12px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; flex-shrink: 0;">
              <i class="ph-bold ph-armchair" style="color: var(--gold-400); font-size: 18px; line-height: 1; margin-bottom: 4px;"></i>
              <span style="color: #fff; font-size: 10px; font-weight: 800; letter-spacing: 0.06em; line-height: 1; text-transform: uppercase; white-space: nowrap;">Table ${escapeHtml(currentTableObj?.table_no ?? "—")}</span>
            </div>
          ` : (isCaptainPanel || isCashierPanel) ? `
            <button
              class="icon-btn icon-btn-dark"
              id="operational-workspaces"
              title="Return to workspaces"
              aria-label="Return to workspaces"
            >
              <i class="ph-bold ph-arrow-left"></i>
            </button>
            <span style="font-size: 13px; font-weight: 800; color: var(--forest-900);">
              ${isCashierPanel ? "Cashier" : "Captain"}
            </span>
          ` : `
            <button class="icon-btn icon-btn-dark" id="pos-menu" title="Open menu" aria-label="Open menu" style="position: relative;">
              <i class="ph ph-list"></i>
              <span class="hamburger-dot" style="position: absolute; top: 4px; right: 4px; width: 8px; height: 8px; border-radius: 50%; background: #e11d48; display: none; border: 2px solid var(--paper);"></span>
            </button>
          `}
          ${restaurant.logo_url 
             ? `<img src="${versionedAsset(restaurant.logo_url)}" alt="${escapeHtml(restaurant.name)}" style="height: 46px; width: auto; max-height: none; object-fit: contain; flex-shrink: 0;" />`
             : `<div style="font-weight: 900; font-size: 1.2rem; color: var(--forest-950);">${escapeHtml(restaurant.name)}</div>`
          }
        </div>
        <div class="brand-center pos-brand-center main-logo-only"></div>
        <div class="topbar-side topbar-right">
          <button class="icon-btn icon-btn-dark" id="pos-search-toggle" title="Search"><i class="ph ph-magnifying-glass"></i></button>
          ${isCustomerMode ? `
            <button class="icon-btn icon-btn-dark" id="customer-live-tab" title="View Live Tab"><i class="ph-bold ph-receipt"></i></button>
          ` : ``}
        </div>
      </header>
      
      <div class="pos-search-backdrop" id="pos-search-overlay" style="z-index: 99999;" onclick="this.classList.remove('active');">
        <div class="pos-search-panel" onclick="event.stopPropagation();">
          <div class="search-bar-row">
            <div class="search-input-wrap">
              <i class="ph-bold ph-magnifying-glass"></i>
              <input id="pos-search" class="search-input" type="search" placeholder="Search dishes or categories..." autocomplete="off" oninput="document.getElementById('search-suggestions-area').style.display = this.value.trim() ? 'none' : 'block';" onkeydown="if(event.key === 'Enter') document.getElementById('pos-search-overlay').classList.remove('active');">
            </div>
            <button class="btn btn-quiet" id="pos-search-cancel" onclick="document.getElementById('pos-search-overlay').classList.remove('active'); const i = document.getElementById('pos-search'); i.value = ''; i.dispatchEvent(new Event('input')); document.getElementById('search-suggestions-area').style.display = 'block';" style="padding: 0 12px; border: none; background: transparent; color: var(--forest-900); font-weight: 800;">Cancel</button>
          </div>
          
          <div id="search-suggestions-area">
            <div class="search-group-title">Recommended</div>
            <div class="search-tags">
              <button class="search-tag" onclick="const i = document.getElementById('pos-search'); i.value = 'Paneer'; i.dispatchEvent(new Event('input')); document.getElementById('pos-search-overlay').classList.remove('active');"><i class="ph ph-trend-up"></i> Paneer</button>
              <button class="search-tag" onclick="const i = document.getElementById('pos-search'); i.value = 'Soup'; i.dispatchEvent(new Event('input')); document.getElementById('pos-search-overlay').classList.remove('active');"><i class="ph ph-fire"></i> Soups</button>
              <button class="search-tag" onclick="const i = document.getElementById('pos-search'); i.value = 'Noodles'; i.dispatchEvent(new Event('input')); document.getElementById('pos-search-overlay').classList.remove('active');"><i class="ph ph-star"></i> Noodles</button>
              <button class="search-tag" onclick="const i = document.getElementById('pos-search'); i.value = 'Rice'; i.dispatchEvent(new Event('input')); document.getElementById('pos-search-overlay').classList.remove('active');"><i class="ph ph-bowl-food"></i> Rice</button>
            </div>
          </div>
        </div>
      </div>

      <main class="pos-content">
        ${isCustomerMode ? `
          <section
            class="customer-captain-call"
            style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 14px 0;padding:10px 12px;background:var(--paper);border:1px solid var(--line);border-radius:14px;"
          >
            <div style="min-width:0;display:flex;flex-direction:column;gap:3px;">
              <strong style="font-size:13px;color:var(--forest-950);">
                Prefer personal service?
              </strong>
              <span style="font-size:11px;line-height:1.4;color:var(--muted);">
                Our Captain can take your order.
              </span>
            </div>

            <button
              type="button"
              id="customer-call-captain"
              class="btn btn-quiet"
              style="flex-shrink:0;min-height:40px;padding:0 12px;border:1px solid var(--line);border-radius:11px;font-size:12px;font-weight:800;"
            >
              <i class="ph-bold ph-bell-ringing"></i>
              <span>Call Captain</span>
            </button>
          </section>
        ` : ""}

        <div id="pos-dynamic-area"></div>
      </main>

      <footer class="pos-action-bar">
        <div class="pos-action-summary">
          <div class="action-summary-icon"><i class="ph ph-receipt"></i></div>
          <div><strong id="pos-cart-count">0 items</strong><span id="pos-cart-total">Tap Next to review</span></div>
        </div>
        <button class="btn btn-primary pos-next-btn" id="pos-next"><span>Next</span><i class="ph ph-arrow-right"></i></button>
      </footer>
      <div id="pos-overlay-root"></div>
    </section>`;

  const panelSignOutCleanup = (!isCustomerMode && (isCaptainPanel || isCashierPanel))
    ? installPanelSignOut({ mount, panelId: isCashierPanel ? "cashier" : "captain" })
    : () => {};

  drawerCleanup = (isCaptainPanel || isCashierPanel)
    ? null
    : mountNavigation({ active: "pos" });

  if (!isCustomerMode && !isCaptainPanel && !isCashierPanel) {
    mount.querySelector("#pos-menu")?.addEventListener(
      "click",
      () => window.__FOUR_FLAVOURS_NAV__?.open()
    );
  }

  if (isCaptainPanel || isCashierPanel) {
    mount.querySelector("#operational-workspaces")?.addEventListener("click", () => {
      const isManager = window.__RMS_PANEL_ACCESS__?.panelId === "manager";

      if (!isManager) {
        requestPanelSignOut({ confirmExit: true });
        return;
      }

      if (isManager) {
        history.pushState(
          {},
          "",
          `${location.pathname}${location.search}#/workspace/manager`
        );
      } else {
        window.__RMS_PANEL_ACCESS__ = null;

        history.pushState(
          {},
          "",
          `${location.pathname}${location.search}#/panels`
        );
      }

      window.dispatchEvent(new Event("rms:navigate"));
    });
  }

  if (!isCustomerMode && !isCaptainPanel) {
    mount.querySelector("#pos-menu")?.addEventListener(
      "click",
      () => window.__FOUR_FLAVOURS_NAV__?.open()
    );
  }

  if (isCaptainPanel) {
    mount.querySelector("#captain-workspaces")?.addEventListener("click", () => {
      window.__RMS_PANEL_ACCESS__ = null;

      history.pushState(
        {},
        "",
        `${location.pathname}${location.search}#/panels`
      );

      window.dispatchEvent(new Event("rms:navigate"));
    });
  }
  
  const searchInput = mount.querySelector("#pos-search");
  const searchOverlay = mount.querySelector("#pos-search-overlay");

  const customerCaptainButton = mount.querySelector("#customer-call-captain");

  const handleCustomerCaptainClick = () => {
    openCaptainRequestConfirmation();
  };

  customerCaptainButton?.addEventListener(
    "click",
    handleCustomerCaptainClick
  );
  
  mount.querySelector("#pos-search-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    searchOverlay.classList.toggle("active");
    if (searchOverlay.classList.contains("active")) searchInput.focus();
  });

  const handleOutsideClick = (e) => {
    if (searchOverlay && !searchOverlay.contains(e.target) && !e.target.closest("#pos-search-toggle")) {
      searchOverlay.classList.remove("active");
    }
  };
  document.addEventListener("click", handleOutsideClick);

  searchInput.addEventListener("input", event => { searchTerm = event.target.value.trim().toLowerCase(); renderProducts(); });
  
  if (isCustomerMode) {
    mount.querySelector("#customer-live-tab").addEventListener("click", () => openLiveTabDashboard());
  } else {
    state.setOrderType("dine_in");
  }

  mount.querySelector("#pos-next").addEventListener("click", openReview);

    let captainRequestInFlight = false;
  let captainRequestSent = false;

  function openCaptainRequestConfirmation() {
    if (!isCustomerMode || !currentTableObj) {
      showToast(
        "Unable to call Captain",
        "Please scan the QR code on your table again.",
        "error"
      );
      return;
    }

    if (captainRequestInFlight) return;

    if (captainRequestSent) {
      showToast(
        "Request already sent",
        "Your Captain has already been requested.",
        "info"
      );
      return;
    }

    openAppModal({
      title: "Call the Captain?",
      subtitle: `A staff member will be requested to visit Table ${currentTableObj.table_no}.`,
      body: `
        <div style="text-align:center;padding:8px 0;">
          <div
            style="width:60px;height:60px;margin:0 auto 16px;display:grid;place-items:center;border-radius:18px;background:var(--sage-100);color:var(--forest-900);"
          >
            <i class="ph-bold ph-bell-ringing" style="font-size:28px;"></i>
          </div>

          <h3 style="margin:0 0 8px;font-size:16px;color:var(--forest-950);">
            Prefer to order with assistance?
          </h3>

          <p style="margin:0;color:var(--muted);font-size:13px;line-height:1.6;">
            A Captain will be requested to visit your table and help you place your order.
            You can continue browsing the menu if you prefer.
          </p>
        </div>
      `,
      actions: [
        {
          label: "Not now",
          className: "btn-quiet",
          onClick: ({ close }) => close()
        },
        {
          label: "Yes, Call Captain",
          className: "btn-primary",
          onClick: async ({ close }) => {
            close();
            await submitCaptainRequest();
          }
        }
      ]
    });
  }

  async function submitCaptainRequest() {
    if (captainRequestInFlight || captainRequestSent) return;
    if (!isCustomerMode || !currentTableObj?.id) return;

    const button = customerCaptainButton;
    const originalHTML = button?.innerHTML;

    const tableId = currentTableObj.id;

    const token =
      customerSessionToken ||
      sessionStorage.getItem(`rms.tab.${tableId}`) ||
      localStorage.getItem(`rms.session.${tableId}`) ||
      localStorage.getItem(`fourflavours.session.${tableId}`);

    if (!token) {
      showToast(
        "Table session expired",
        "Please scan the QR code on your table again.",
        "error"
      );
      return;
    }

    captainRequestInFlight = true;

    if (button) {
      button.disabled = true;
      button.innerHTML = `
        <i class="ph-bold ph-spinner-gap ph-spin"></i>
        <span>Sending…</span>
      `;
    }

    try {
      /*
       * Planned database contract:
       * public.request_captain(
       *   p_table_id uuid,
       *   p_session_token text
       * )
       *
       * The final database migration must create this RPC.
       * It must validate the active table session, persist the request,
       * prevent duplicate pending requests, and notify authorized staff.
       */

      const { data, error } = await supabase.rpc("request_captain", {
        p_table_id: tableId,
        p_session_token: token
      });

      if (error) throw error;

      if (
        data === false ||
        data?.ok === false
      ) {
        throw new Error("The request was not accepted.");
      }

      captainRequestSent = true;

      if (button) {
        button.innerHTML = `
          <i class="ph-bold ph-check-circle"></i>
          <span>Requested</span>
        `;
        button.disabled = true;
        button.setAttribute("aria-label", "Captain requested");
      }

      showToast(
        "Captain requested",
        `A Captain has been requested for Table ${currentTableObj.table_no}.`,
        "success"
      );

    } catch (error) {
      console.error("Call Captain request failed:", error);

      showToast(
        "Could not call Captain",
        "Your request was not confirmed. Please try again or ask a staff member directly.",
        "error"
      );

      if (button) {
        button.disabled = false;
        button.innerHTML = originalHTML;
      }

    } finally {
      captainRequestInFlight = false;
    }
  }

  async function openLiveTabDashboard(explicitTableId = null) {
    const tableId = explicitTableId || (isCustomerMode
      ? currentTableObj?.id
      : state.getState().tableId);

    if (!tableId) return;

    const button = mount.querySelector("#customer-live-tab");
    if (button) {
      button.classList.remove("qty-pulse");
      void button.offsetWidth;
      button.classList.add("qty-pulse");
    }

    try {
      let sessionId = null;
      let sessionStatus = null;

      if (isCustomerMode) {
        const token =
          customerSessionToken ||
          localStorage.getItem(`rms.session.${tableId}`) ||
          localStorage.getItem(`fourflavours.session.${tableId}`);

        if (!token) {
          throw new Error("Your table session could not be verified. Please scan the table QR code again.");
        }

        const { data, error } = await supabase.rpc("get_customer_session_state", {
          p_table_id: tableId,
          p_session_token: token
        });

        if (error) throw error;

        const sessionState = Array.isArray(data) ? data[0] : data;

        if (!sessionState || sessionState.status === "closed") {
          return openAppModal({
            title: "Your Tab Is Empty",
            subtitle: "There is no active order for this table.",
            body: `<div class="empty-state"><i class="ph-bold ph-receipt"></i><strong>Nothing here yet</strong><span>Add dishes to your cart and tap Next to place your first order.</span></div>`,
            actions: [
              {
                label: "Browse Menu",
                icon: "ph-arrow-left",
                className: "btn-primary",
                onClick: ({ close }) => close()
              }
            ]
          });
        }

        sessionId = sessionState.id || sessionState.session_id || null;
        sessionStatus = sessionState.status;
      } else {
        const { data: session, error } = await supabase
          .from("dining_sessions")
          .select("id, status")
          .eq("table_id", tableId)
          .eq("restaurant_id", activeTenantId)
          .neq("status", "closed")
          .maybeSingle();

        if (error) throw error;

        if (!session) {
          return openAppModal({
            title: "Your Tab Is Empty",
            subtitle: "There is no active order for this table.",
            body: `<div class="empty-state"><i class="ph-bold ph-receipt"></i><strong>Nothing here yet</strong><span>Add dishes to your cart and tap Next to start an order.</span></div>`,
            actions: [
              {
                label: "Close",
                icon: "ph-x",
                className: "btn-primary",
                onClick: ({ close }) => close()
              }
            ]
          });
        }

        sessionId = session.id;
        sessionStatus = session.status;
      }

      if (sessionStatus === "bill_requested" || sessionStatus === "bill_ready") {
        showToast("Bill requested", "Please settle the bill with restaurant staff in person.", "info");
      }

      showActiveOrderDashboard({
        order: null,
        session_id: sessionId,
        settings,
        current_state: { tableId, orderType: "dine_in" },
        sessionKey: tableId
      });
    } catch (error) {
      console.error("Could not open live tab:", error);
      showToast(
        "Could not load live tab",
        error?.message || "Please check your connection and try again.",
        "error"
      );
    }
  }

  const tenantFilter = `restaurant_id=eq.${activeTenantId}`;
  realtimeChannel = supabase.channel(`pos-live-updates-${activeTenantId}-${crypto.randomUUID()}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders", filter: tenantFilter }, payload => {
        window.dispatchEvent(new Event("ff_live_update"));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "order_items", filter: tenantFilter }, payload => {
        window.dispatchEvent(new Event("ff_live_update"));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "dining_sessions", filter: tenantFilter }, payload => {
        window.dispatchEvent(new Event("ff_live_update"));
        
        // 🛑 THE INSTANT GLOBAL KICK LOGIC 🛑
        if (isCustomerMode && currentTableObj && payload.new.table_id === currentTableObj.id) {
            if (payload.new.status === 'closed') {
                // Clear any open modals
                document.querySelectorAll(".app-modal-overlay").forEach(m => m.remove());
                const rootNode = document.querySelector("#app") || mount;
                
                // ⚡ LIVE KICK: Destroy tokens instantly
                localStorage.removeItem(`rms.session.${currentTableObj.id}`);
                localStorage.removeItem(`fourflavours.session.${currentTableObj.id}`);
                sessionStorage.removeItem(`rms.tab.${currentTableObj.id}`);

                // READ THE DATABASE TRUTH: If the backend says 'paid', show the beautiful Thank You screen.
                if (payload.new.payment_status === 'paid') {
                    rootNode.innerHTML = `
                      <main class="premium-lock-screen" style="display: flex; align-items: center; justify-content: center; min-height: 100vh; background: var(--cream-100, #FCFCF9); padding: 24px; font-family: inherit;">
                        <div class="premium-lock-card" style="background: var(--paper, #ffffff); max-width: 440px; width: 100%; border-radius: 32px; padding: 56px 32px; box-shadow: 0 24px 48px rgba(18, 34, 22, 0.08); text-align: center; border: 1px solid rgba(0,0,0,0.04);">
                          <div class="premium-squircle sq-green anim-pop" style="margin-bottom: 24px;">
                            <i class="ph-bold ph-check"></i>
                          </div>
                          <h1 class="premium-lock-title" style="font-size: 2.2rem; font-weight: 900; color: var(--forest-950); margin-bottom: 12px; letter-spacing: -0.02em;">Payment Successful</h1>
                          <p class="premium-lock-desc" style="font-size: 1.15rem; font-weight: 600; color: var(--forest-800); margin-bottom: 32px; line-height: 1.5;">Your table has been successfully cleared. We hope you enjoyed your meal and look forward to serving you again soon!</p>
                          <button onclick="window.location.reload()" style="background: var(--forest-950); color: #fff; border: none; border-radius: 14px; padding: 14px 24px; font-size: 1.05rem; font-weight: 800; cursor: pointer; width: 100%; box-shadow: 0 8px 24px rgba(18,34,22,0.15); transition: transform 0.15s;" onmousedown="this.style.transform='scale(0.96)'" onmouseup="this.style.transform='scale(1)'">Close Session</button>
                        </div>
                      </main>
                    `;
                } else {
                    // Admin force-closed the table without a customer request. Show standard Session Expired.
                    const timeString = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
                    rootNode.innerHTML = `
                      <main class="customer-session-expired" role="alert" aria-live="assertive">
                        <section class="customer-session-expired__card" aria-labelledby="customer-session-expired-title">
                          <div class="customer-session-expired__icon" aria-hidden="true"><i class="ph-bold ph-lock-key"></i></div>
                          <p class="customer-session-expired__eyebrow">TABLE ${escapeHtml(currentTableObj.table_no)}</p>
                          <h1 class="customer-session-expired__title" id="customer-session-expired-title">Session Expired</h1>
                          <p class="customer-session-expired__description">Your dining session was closed by staff at ${timeString}.</p>
                          <div class="customer-session-expired__notice">
                            <i class="ph-bold ph-shield-check" aria-hidden="true"></i>
                            <p><strong>Security lock active</strong><span>Please scan the QR code physically displayed on your table to start a new visit.</span></p>
                          </div>
                        </section>
                      </main>
                    `;
                }
                window.history.replaceState({ locked: true }, "", window.location.href);
            } else if (payload.new.status === 'bill_requested' || payload.new.status === 'bill_ready') {
                window.location.reload(); // "Payment Pending" requires standard routing
            }
        }
      })
      .subscribe(status => { const node = mount.querySelector("#pos-connection"); if (!node) return; const live = status === "SUBSCRIBED"; node.innerHTML = `<span class="connection-dot ${live ? "live" : "offline"}"></span>${live ? "Live" : "Offline"}`; });

  function getSubCategoryIcon(subCat) {
    const s = subCat.toLowerCase();
    if (s.includes("starter") || s.includes("appetizer")) return "ph-bowl-food";
    if (s.includes("main")) return "ph-cooking-pot";
    if (s.includes("dessert") || s.includes("sweet")) return "ph-ice-cream";
    if (s.includes("drink") || s.includes("beverage")) return "ph-wine";
    if (s.includes("bread") || s.includes("roti")) return "ph-bread";
    if (s.includes("rice") || s.includes("biryani")) return "ph-bowl-steam";
    if (s.includes("soup")) return "ph-brandy";
    if (s.includes("salad")) return "ph-carrot";
    return "ph-fork-knife";
  }

  function getAvailableSubCategories() {
    if (!activeCuisine) return [];
    const subs = new Set();
    products.forEach(p => {
      const parts = String(p.category || "").split(" - ");
      if (parts[0].trim() === activeCuisine) {
        subs.add(parts[1]?.trim() || "Others");
      }
    });
    return ["All", ...Array.from(subs)];
  }

  function renderProducts() {
    const area = mount.querySelector("#pos-dynamic-area");
    if (!area) return;

    renderActionBar();

    if (!activeCuisine && !searchTerm) {
      area.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: calc(100vh - 180px); padding-bottom: 20px;">
          ${isCustomerMode ? '' : `
            <section class="pos-toolbar-row" style="display: flex; justify-content: center; width: 100%; gap: 8px; margin-bottom: 24px; flex-wrap: nowrap; overflow-x: auto;">
              <button class="pos-toolbar-pill ${state.getState().orderType === 'dine_in' ? 'active' : ''}" data-order-type="dine_in" style="height: 44px; padding: 0 14px; font-size: 14px; font-weight: 800; gap: 7px; border-radius: 12px; border: 1px solid ${state.getState().orderType === 'dine_in' ? 'transparent' : 'var(--line)'}; white-space: nowrap; flex-shrink: 0; ${isCashierPanel ? 'display:none;' : ''}">
                <i class="ph-bold ph-fork-knife" style="font-size: 18px; line-height: 1;"></i>
                <span style="white-space: nowrap;">Dine-in</span>
              </button>
              ${(isCaptainPanel || isCashierPanel) ? "" : `
                <button class="pos-toolbar-pill ${state.getState().orderType === 'takeaway' ? 'active' : ''}" data-order-type="takeaway" style="height: 44px; padding: 0 14px; font-size: 14px; font-weight: 800; gap: 7px; border-radius: 12px; border: 1px solid ${state.getState().orderType === 'takeaway' ? 'transparent' : 'var(--line)'}; color: var(--forest-800); white-space: nowrap; flex-shrink: 0;">
                  <i class="ph-bold ph-shopping-bag" style="font-size: 18px; color: var(--forest-800); line-height: 1;"></i>
                  <span style="white-space: nowrap;">Takeaway</span>
                </button>
              `}
              <div class="pos-toolbar-pill ${!state.getState().tableId && state.getState().orderType === 'dine_in' ? '' : 'has-table'}" id="pos-table-wrap" style="height: 44px; padding: 0 14px; font-size: 14px; font-weight: 800; gap: 7px; border-radius: 12px; border: 1px solid var(--line); color: var(--forest-800); white-space: nowrap; flex-shrink: 0; cursor: pointer; transition: all 0.2s ease; ${state.getState().orderType === 'takeaway' ? 'opacity: 0.4; pointer-events: none; background: rgba(0,0,0,0.04); border-color: transparent;' : ''}${isCashierPanel ? 'display:none;' : ''}">
                <span class="selected-text" id="pos-table-display" style="display: inline-flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 800; color: var(--forest-800); white-space: nowrap;">
                  <i class="ph-bold ph-armchair" style="font-size: 18px; color: var(--forest-800); line-height: 1;"></i>
                  <span style="white-space: nowrap;">${state.getState().tableId && state.getState().orderType === 'dine_in' ? `Table ${tables.find(t => t.id === state.getState().tableId)?.table_no || ''}` : 'Table'}</span>
                  <i class="ph-bold ph-caret-down" style="font-size: 16px; color: var(--forest-800); line-height: 1;"></i>
                </span>
              </div>
            </section>
          `}
          <div class="drill-down-header" style="display: flex; justify-content: center; align-items: center; margin-bottom: 24px; width: 100%;">
            <h2 style="font-size: 22px; margin: 0; text-align: center;">Choose a Cuisine</h2>
          </div>
          <div class="cuisine-hero-grid" id="pos-cuisine-grid" style="width: 100%; margin: 0 auto; justify-content: center; max-width: 800px;">
            ${cuisines.map(c => `
              <div class="cuisine-hero-card" data-cuisine="${escapeHtml(c.name)}">
                <div class="cuisine-hero-bg">
                  ${c.image_url ? `<img src="${versionedAsset(c.image_url)}" alt="">` : `<div class="product-placeholder"><i class="ph ph-image"></i></div>`}
                </div>
                <div class="cuisine-hero-overlay">
                  <h3>${escapeHtml(c.name)}</h3>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      `;

      area.querySelectorAll("[data-cuisine]").forEach(card => {
        card.addEventListener("click", () => {
          card.classList.add("pressed");
          setTimeout(() => {
            activeCuisine = card.dataset.cuisine;
            activeSubCategory = "All";
            searchTerm = "";
            const searchInput = mount.querySelector("#pos-search");
            if (searchInput) searchInput.value = "";
            window.history.pushState({ view: "cuisine", cuisine: activeCuisine }, "", "#" + encodeURIComponent(activeCuisine));
            renderProducts();
          }, 150);
        });
      });

      if (!isCustomerMode) {
        // Amazon-style seamless context switch (dims the workspace, disables clicks)
        const triggerContextSwitch = (callback) => {
            const workspace = mount.querySelector("#pos-dynamic-area") || mount;
            
            // Deactivate the page visually
            workspace.style.transition = "opacity 0.15s ease";
            workspace.style.opacity = "0.4";
            workspace.style.pointerEvents = "none";
            document.body.style.cursor = "wait";

            // Brief delay to make the state-change feel tactile
            setTimeout(() => {
              callback();
              
              // Reactivate the page
              workspace.style.opacity = "1";
              workspace.style.pointerEvents = "auto";
              document.body.style.cursor = "default";
              
              setTimeout(() => { workspace.style.transition = ""; }, 150);
            }, 250); 
        };

        const tableWrapBtn = area.querySelector("#pos-table-wrap");
        tableWrapBtn?.addEventListener("click", () => {
          if (state.getState().orderType === "takeaway") return;
          promptTableSelection((selectedTable) => {
            // Trigger animation only if a free table was selected (Occupied tables jump to the Live Tab directly)
            if (selectedTable) triggerContextSwitch(() => renderProducts());
          });
        });

        area.querySelectorAll("[data-order-type]").forEach(button => {
          button.addEventListener("click", () => {
            const oType = button.dataset.orderType;

            if (isCaptainPanel && oType !== "dine_in") {
              showToast(
                "Dine-in only",
                "Takeaway orders must be created from the Cashier workspace.",
                "error"
              );
              return;
            }

            if (isCashierPanel && oType !== "takeaway") {
              showToast(
                "Takeaway only",
                "Cashier can create takeaway orders only.",
                "error"
              );
              return;
            }

            if (state.getState().orderType === oType) return;
            
            triggerContextSwitch(() => {
              state.setOrderType(oType);
              if (oType === "takeaway") state.setTable(null);
              renderProducts(); 
            });
          });
        });
      }

      return;
    }

    const subCategories = getAvailableSubCategories();
    
    let html = ``;
    if (!searchTerm) {
      const activeTable = state.getState().orderType === 'dine_in' ? tables.find(t => t.id === state.getState().tableId) : null;
      html += `
        <div id="parity-unified-header">
          <div id="mega-dropdown-wrap" class="dropdown-anchor-wrap" style="flex: 1; display: flex; justify-content: flex-start; position: relative;">
            <button id="cuisine-main-toggle" class="cuisine-center-toggle">
              <span>${escapeHtml(activeCuisine)}</span>
              <i class="ph-bold ph-caret-down" style="font-size: 1.1rem; transition: transform 0.3s ease;"></i>
            </button>

            <div class="cuisine-mega-dropdown" id="cuisine-mega-dropdown">
              <div class="cuisine-mega-grid">
                ${cuisines.map(c => `
                  <div class="mini-cuisine-card ${c.name === activeCuisine ? 'active' : ''}" data-mega-cuisine="${escapeHtml(c.name)}">
                    <div class="mini-cuisine-bg">
                      ${c.image_url ? `<img src="${versionedAsset(c.image_url)}" alt="">` : `<i class="ph-fill ph-image" style="font-size: 24px; color: var(--muted); display: grid; place-items: center; height: 100%;"></i>`}
                    </div>
                    <div class="mini-cuisine-overlay"><span>${escapeHtml(c.name)}</span></div>
                  </div>
                `).join("")}
              </div>
            </div>
          </div>

          <div style="flex: 1; display: flex; justify-content: center; align-items: center; pointer-events: none;">
             ${activeTable ? `
               <div style="display: inline-flex; align-items: center; gap: 6px; background: #ffffff; padding: 5px 14px; border-radius: 99px; border: 1px solid rgba(0,0,0,0.06); box-shadow: 0 4px 12px rgba(0,0,0,0.03);">
                 <i class="ph-bold ph-armchair" style="color: var(--forest-600); font-size: 14px;"></i>
                 <span style="font-size: 11px; font-weight: 900; color: var(--forest-950); text-transform: uppercase; letter-spacing: 0.08em; padding-top: 1px;">Table ${escapeHtml(activeTable.table_no)}</span>
               </div>
             ` : ''}
          </div>

          <div id="subcat-dropdown-wrap" class="dropdown-anchor-wrap" style="flex: 1; display: flex; justify-content: flex-end; position: relative;">
            <button id="pos-cat-toggle" class="subcat-right-toggle">
              <span style="max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(activeSubCategory)}</span>
              <i class="ph-bold ph-caret-down" style="color: var(--forest-900); font-size: 1.1rem; transition: transform 0.3s ease;"></i>
            </button>
            <div class="sub-category-dropdown" id="pos-subcat-dropdown">
              ${subCategories.map(sub => `
                <button class="sub-category-tile ${activeSubCategory === sub ? "active" : ""}" data-sub="${escapeHtml(sub)}">
                  <i class="ph-bold ${getSubCategoryIcon(sub)}"></i>
                  <span>${escapeHtml(sub)}</span>
                </button>
              `).join("")}
            </div>
          </div>
        </div>
      `;
    } else {
      html += `
        <div id="parity-unified-header">
          <div style="flex: 1; display: flex; justify-content: flex-start;">
             <button id="pos-btn-back" title="Back" style="margin: 0; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; background: #ffffff; border-radius: 50%; border: 1px solid rgba(0,0,0,0.06); box-shadow: 0 2px 8px rgba(0,0,0,0.04); cursor: pointer;">
              <i class="ph-bold ph-arrow-left" style="font-size: 1.1rem; color: var(--forest-900);"></i>
            </button>
          </div>
          <div style="flex: 4; display: flex; justify-content: center;">
             <h2 style="margin: 0; font-size: 1.1rem; font-weight: 800; color: var(--forest-950); text-align: center;">Search: "${escapeHtml(searchTerm)}"</h2>
          </div>
          <div style="flex: 1;"></div>
        </div>
      `;
    }

    html += `
      <div style="position: relative; flex: 1; display: flex; flex-direction: column; min-height: 0; width: 100%;">
        <div id="menu-dropdown-backdrop" class="menu-dropdown-backdrop"></div>
        <section class="pos-product-container" id="pos-product-container">
          <div class="pos-product-grid" id="pos-product-grid"></div>
        </section>
      </div>
    `;

    area.innerHTML = html;

    area.querySelector("#pos-btn-back")?.addEventListener("click", () => {
      if (window.history.state?.view === "cuisine") {
        window.history.back(); 
      } else {
        activeCuisine = null;
        activeSubCategory = "All";
        renderProducts();
      }
    });

    const toggleBtn = area.querySelector("#pos-cat-toggle");
    const dropdown = area.querySelector("#pos-subcat-dropdown");
    const subcatWrap = area.querySelector("#subcat-dropdown-wrap");
    
    const megaToggleBtn = area.querySelector("#cuisine-main-toggle");
    const megaDropdown = area.querySelector("#cuisine-mega-dropdown");
    const megaWrap = area.querySelector("#mega-dropdown-wrap");
    
    const backdrop = area.querySelector("#menu-dropdown-backdrop");

    function closeAllDropdowns() {
      megaDropdown?.classList.remove("active");
      megaToggleBtn?.classList.remove("open");
      megaWrap?.classList.remove("focused-anchor");
      
      dropdown?.classList.remove("active");
      toggleBtn?.classList.remove("open");
      subcatWrap?.classList.remove("focused-anchor");
      
      backdrop?.classList.remove("active");
    }

    toggleBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpening = !dropdown.classList.contains("active");
      closeAllDropdowns(); 
      if (isOpening) {
        toggleBtn.classList.add("open");
        dropdown.classList.add("active");
        subcatWrap?.classList.add("focused-anchor");
        backdrop?.classList.add("active");
      }
    });

    megaToggleBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpening = !megaDropdown.classList.contains("active");
      closeAllDropdowns();
      if (isOpening) {
        megaToggleBtn.classList.add("open");
        megaDropdown.classList.add("active");
        megaWrap?.classList.add("focused-anchor");
        backdrop?.classList.add("active");
      }
    });

    backdrop?.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllDropdowns();
    });

    document.addEventListener("click", (e) => {
      if (dropdown && !dropdown.contains(e.target) && !toggleBtn.contains(e.target) &&
          megaDropdown && !megaDropdown.contains(e.target) && !megaToggleBtn.contains(e.target)) {
        closeAllDropdowns();
      }
    });

    area.querySelectorAll("[data-sub]").forEach(btn => {
      btn.addEventListener("click", () => {
        activeSubCategory = btn.dataset.sub;
        dropdown?.classList.remove("active");
        toggleBtn?.classList.remove("open");
        renderProducts();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });

    area.querySelectorAll("[data-mega-cuisine]").forEach(card => {
      card.addEventListener("click", () => {
        activeCuisine = card.dataset.megaCuisine;
        activeSubCategory = "All"; 
        megaDropdown?.classList.remove("active");
        megaToggleBtn?.classList.remove("open");
        
        window.history.pushState({ view: "cuisine", cuisine: activeCuisine }, "", "#" + encodeURIComponent(activeCuisine));
        renderProducts();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });

    const grid = area.querySelector("#pos-product-grid");
    const visible = products.filter(p => {
      const parts = String(p.category || "").split(" - ");
      const pCuisine = parts[0].trim();
      const pSub = parts[1]?.trim() || "Others";
      
      const text = `${p.name} ${p.description ?? ""} ${p.category ?? ""}`.toLowerCase();
      if (searchTerm) return text.includes(searchTerm);

      if (activeCuisine && pCuisine !== activeCuisine) return false;
      if (activeSubCategory !== "All" && pSub !== activeSubCategory) return false;
      return true;
    });

    grid.innerHTML = visible.length ? visible.map(product => {
      const isVeg = product.is_veg !== false; 
      const markColor = isVeg ? "#16a34a" : "#dc2626"; 
      const markTitle = isVeg ? "Vegetarian" : "Non-Vegetarian";

      return `
      <article class="pos-product-card" data-product-card="${product.id}">
        <div class="pos-product-media">
          ${product.image_url ? `<img src="${versionedAsset(product.image_url)}" alt="" loading="lazy">` : `<div class="product-placeholder"><i class="ph ph-fork-knife"></i></div>`}
          <span class="veg-mark" title="${markTitle}" style="border: 2px solid ${markColor}; background: #fff; width: 24px; height: 24px; box-shadow: 0 3px 10px rgba(0,0,0,0.3);"><span style="background: ${markColor}; width: 10px; height: 10px;"></span></span>
        </div>
        <div class="pos-product-copy">
          <strong>${escapeHtml(product.name)}</strong>
          <span>${escapeHtml(product.category ?? "")}</span>
          ${product.description ? `<p class="pos-product-desc">${escapeHtml(product.description)}</p>` : ""}
          <div class="pos-product-bottom">
            <b>${money(product.price, settings.currency_symbol)}</b>
            <div class="premium-qty-wrapper" data-product-control="${product.id}">
              <button class="premium-qty-btn dec-btn" data-product-dec="${product.id}" title="Decrease"><i class="ph ph-minus"></i></button>
              <span class="premium-qty-value" aria-live="polite">0</span>
              <button class="premium-qty-btn inc-btn" data-product-add="${product.id}" title="Add"><i class="ph ph-plus"></i></button>
            </div>
          </div>
        </div>
      </article>
      `;
    }).join("") : `<div class="empty-state"><i class="ph ph-magnifying-glass"></i><strong>No dishes found</strong><span>Try another search or category.</span></div>`;

    grid.classList.remove("grid-refresh-anim");
    void grid.offsetWidth;
    grid.classList.add("grid-refresh-anim");

    area.querySelector("#pos-product-grid")?.addEventListener("click", event => {
      const add = event.target.closest("[data-product-add]");
      const inc = event.target.closest("[data-product-inc]");
      const dec = event.target.closest("[data-product-dec]");
      const card = event.target.closest("[data-product-card]"); 

      if (add) { const product = products.find(item => item.id === add.dataset.productAdd); if (!product) return; state.addProduct(product); animateProductControl(add); return; }
      if (inc) { state.increment(inc.dataset.productInc); animateProductControl(inc); return; }
      if (dec) { state.decrement(dec.dataset.productDec); animateProductControl(dec); }

      if (card && !event.target.closest(".premium-qty-wrapper")) {
        const product = products.find(item => item.id === card.dataset.productCard);
        if (product) openProductDetailModal(product);
      }
    });

    function openProductDetailModal(product) {
      let currentQty = state.getState().items.find(i => i.id === product.id)?.quantity || 0;
      
      const isVeg = product.is_veg !== false;
      const markColor = isVeg ? "#16a34a" : "#dc2626"; 

      const modalBody = `
        <div class="premium-product-detail">
          <div class="detail-media">
            ${product.image_url ? `<img src="${versionedAsset(product.image_url)}" alt="">` : `<div class="product-placeholder"><i class="ph ph-fork-knife"></i></div>`}
            <span class="veg-mark" title="${isVeg ? 'Vegetarian' : 'Non-Vegetarian'}" style="border: 2px solid ${markColor}; background: #fff; width: 28px; height: 28px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); top: 16px; right: 16px;"><span style="background: ${markColor}; width: 12px; height: 12px;"></span></span>
          </div>
          <div class="detail-content">
            <div class="detail-price-row">
              <span class="detail-price-label">Price</span>
              <span class="detail-price-value">${money(product.price, settings.currency_symbol)}</span>
            </div>
            ${product.description ? `<p class="detail-description">${escapeHtml(product.description)}</p>` : ''}
            
            <div class="detail-action-container ${currentQty > 0 ? 'is-active' : ''}" id="detail-action-wrap">
              <button class="btn btn-primary detail-add-btn" id="detail-main-btn">
                <i class="ph-bold ph-plus"></i> Add to Order
              </button>
              
              <div class="detail-qty-ui" id="detail-qty-ui">
                <button class="detail-qty-btn" id="detail-dec"><i class="ph-bold ph-minus"></i></button>
                <span id="detail-qty-val">${currentQty}</span>
                <button class="detail-qty-btn" id="detail-inc"><i class="ph-bold ph-plus"></i></button>
              </div>

              <button class="detail-done-btn" id="detail-done-btn">
                Done <i class="ph-bold ph-check"></i>
              </button>
            </div>
          </div>
        </div>
      `;

      const modal = openAppModal({
        title: escapeHtml(product.name),
        subtitle: escapeHtml(product.category),
        body: modalBody,
        actions: [] 
      });

      const decBtn = modal.root.querySelector("#detail-dec");
      const incBtn = modal.root.querySelector("#detail-inc");
      const mainBtn = modal.root.querySelector("#detail-main-btn");
      const qtyVal = modal.root.querySelector("#detail-qty-val");
      const actionWrap = modal.root.querySelector("#detail-action-wrap");
      const doneBtn = modal.root.querySelector("#detail-done-btn");

      const updateUI = () => {
        const qty = state.getState().items.find(i => i.id === product.id)?.quantity || 0;
        qtyVal.textContent = qty;
        
        if (qty > 0) {
          actionWrap.classList.add("is-active");
        } else {
          actionWrap.classList.remove("is-active");
        }
        
        renderProductQuantities();
        renderActionBar();
      };

      mainBtn.addEventListener("click", () => { state.addProduct(product); updateUI(); });
      incBtn.addEventListener("click", () => { state.increment(product.id); updateUI(); });
      decBtn.addEventListener("click", () => { state.decrement(product.id); updateUI(); });
      doneBtn.addEventListener("click", () => { modal.close(); });
      
      const unsubscribe = state.subscribe(updateUI);
      const originalClose = modal.close;
      modal.close = () => { unsubscribe(); originalClose(); };
    }

    const scroller = area.querySelector("#pos-product-container");
    if (scroller) {
      let lastScroll = 0;
      scroller.addEventListener("scroll", e => {
        const current = e.target.scrollTop;
        const main = mount.querySelector(".pos-content");
        if (!main) return;
        
        if (current > lastScroll && current > 50) {
          main.classList.add("smart-scroll-hide");
        } 
        else if (current < lastScroll - 10 || current <= 0) {
          main.classList.remove("smart-scroll-hide");
        }
        lastScroll = current;
      }, { passive: true });
    }

    renderProductQuantities();
  }

  state.subscribe(current => {
    renderActionBar(current);
    renderProductQuantities(current);
  });

  renderProducts();

  function renderProductQuantities(current = state.getState()) {
    const quantities = new Map(current.items.map(item => [item.id, item.quantity]));

    mount.querySelectorAll("[data-product-control]").forEach(control => {
      const productId = control.dataset.productControl;
      const quantity = quantities.get(productId) ?? 0;
      const valSpan = control.querySelector(".premium-qty-value");

      if (quantity <= 0) {
        control.classList.remove("is-active");
        if (valSpan) valSpan.textContent = "0";
      } else {
        control.classList.add("is-active");
        if (valSpan) valSpan.textContent = quantity;
      }
    });
  }

  function animateProductControl(element) {
    const control = element.closest("[data-product-control]");
    if (!control) return;
    control.classList.remove("qty-pulse");
    void control.offsetWidth;
    control.classList.add("qty-pulse");
  }

  function renderActionBar(current = state.getState()) {
    const count = current.items.reduce((sum, i) => sum + i.quantity, 0);
    const total = current.items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
    
    mount.querySelector("#pos-cart-count").textContent = `${count} ${count === 1 ? "item" : "items"}`;
    
    mount.querySelector("#pos-cart-total").textContent = count > 0 ? `Total: ${money(total, settings.currency_symbol)}` : "Tap Next to review";
    
    mount.querySelector("#pos-next").disabled = count === 0;

    const actionBar = mount.querySelector(".pos-action-bar");
    if (actionBar) {
      if (count === 0 && !activeCuisine && !searchTerm) {
        actionBar.style.display = "none";
      } else {
        actionBar.style.display = "flex";
      }
    }
  }

  function promptTableSelection(onSelected) {
    const modal = openAppModal({
      title: "Select Table",
      subtitle: "Start a new order or manage an active table tab.",
      body: `<div id="table-selection-host" style="max-height: 65vh; overflow-y: auto; margin: -10px -24px -24px -24px; background: var(--paper); border-bottom-left-radius: 20px; border-bottom-right-radius: 20px;"><div class="empty-state"><i class="ph ph-spinner-gap ph-spin"></i><span>Loading floor plan...</span></div></div>`,
      actions: [{ label: "Cancel", icon: "ph-x", className: "btn-quiet", onClick: (ctx) => ctx.close() }]
    });

    supabase.from("dining_sessions").select("id, table_id, status")
      .neq("status", "closed")
      .eq("restaurant_id", activeTenantId)
      .then(({ data: activeSessions }) => {
        const occupiedMap = new Map((activeSessions || []).map(s => [s.table_id, s]));
        
        const host = modal.root.querySelector("#table-selection-host");
        if (!host) return;

        host.innerHTML = tables.length ? tables.map(t => {
          const activeSession = occupiedMap.get(t.id);
          const isOccupied = !!activeSession;
          const isBillReq = activeSession && activeSession.status !== 'open';

          if (isOccupied) {
            return `
              <div class="table-occupied-row">
                <div style="display: flex; align-items: center; gap: 14px;">
                  <div style="width: 46px; height: 46px; border-radius: 14px; background: ${isBillReq ? 'var(--gold-100)' : '#e0e7ff'}; color: ${isBillReq ? 'var(--gold-600)' : '#4f46e5'}; display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.15);">
                    <i class="ph-bold ${isBillReq ? 'ph-receipt' : 'ph-users'}" style="font-size: 22px;"></i>
                  </div>
                  <div style="display: flex; flex-direction: column; gap: 2px;">
                    <strong style="color: var(--forest-950); font-size: 15.5px; font-weight: 900;">Table ${escapeHtml(t.table_no)}</strong>
                    <span style="font-size: 12.5px; color: ${isBillReq ? 'var(--gold-600)' : '#4f46e5'}; font-weight: 800; display: inline-flex; align-items: center; gap: 5px;">
                      <span style="width: 6px; height: 6px; border-radius: 50%; background: ${isBillReq ? 'var(--gold-500)' : '#4f46e5'}; display: inline-block;"></span>
                      ${isBillReq ? 'Bill Requested' : 'Occupied · Live Tab'}
                    </span>
                  </div>
                </div>
                <button class="manage-active-table-btn" data-table-id="${t.id}">
                  Manage <i class="ph-bold ph-arrow-right"></i>
                </button>
              </div>
            `;
          } else {
            return `
              <button class="btn btn-quiet table-select-btn" data-table-id="${t.id}" style="width: 100%; border-radius: 0; border: none; justify-content: flex-start; padding: 14px 20px; font-size: 15px; border-bottom: 1px solid var(--line); background: transparent; transition: background 0.15s; text-align: left;">
                <div style="width: 42px; height: 42px; border-radius: 12px; background: var(--sage-100); color: var(--forest-600); display: flex; align-items: center; justify-content: center; margin-right: 14px; flex-shrink: 0;">
                  <i class="ph-bold ph-armchair" style="font-size: 22px;"></i>
                </div>
                <div style="display: flex; flex-direction: column; align-items: flex-start;">
                  <strong style="color: var(--forest-950);">Table ${escapeHtml(t.table_no)}</strong>
                  <span style="font-size: 13px; color: var(--muted); font-weight: 600;">Free · ${t.capacity} seats</span>
                </div>
              </button>
            `;
          }
        }).join("") : `<div class="empty-state"><i class="ph-bold ph-armchair"></i><strong>No tables configured</strong><span>Please add tables in the Admin dashboard.</span></div>`;

        // 1. FREE TABLE (Start New Round)
        host.querySelectorAll(".table-select-btn").forEach(btn => {
          btn.addEventListener("click", () => {
            const table = tables.find(t => t.id === btn.dataset.tableId) ?? null;
            const savedCartItems = JSON.parse(JSON.stringify(state.getState().items || []));
            state.setTable(table);
            
            if (state.getState().items.length === 0 && savedCartItems.length > 0) {
                savedCartItems.forEach(item => {
                    for (let i = 0; i < item.quantity; i++) state.addProduct(item);
                });
            }
            
            modal.close();
            onSelected?.(table);
          });
        });

        // 2. OCCUPIED TABLE (Jump to Live Tab)
        host.querySelectorAll(".manage-active-table-btn").forEach(btn => {
          btn.addEventListener("click", () => {
            const table = tables.find(t => t.id === btn.dataset.tableId) ?? null;
            
            // Set the table globally so the POS remembers where we are
            state.setTable(table);
            
            // Retain any cart items they built before selecting the table
            const savedCartItems = JSON.parse(JSON.stringify(state.getState().items || []));
            if (state.getState().items.length === 0 && savedCartItems.length > 0) {
                savedCartItems.forEach(item => {
                    for (let i = 0; i < item.quantity; i++) state.addProduct(item);
                });
            }

            modal.close();
            
            // Instantly open the Live Tab History for that specific table!
            openLiveTabDashboard(table.id);
          });
        });

      })
      .catch(err => {
        console.error(err);
        const host = modal.root.querySelector("#table-selection-host");
        if (host) host.innerHTML = `<div class="empty-state"><i class="ph ph-warning-circle"></i><strong>Error loading tables</strong><span>Please try again.</span></div>`;
      });
  }

  async function openReview() {
    const current = state.getState();
    
    if (!current.items || current.items.length === 0) { 
      showToast("Complete the order", "Add at least one dish.", "error"); 
      return; 
    }

    if (!isCustomerMode && current.orderType === "dine_in" && !current.tableId) {
      promptTableSelection(() => {
        openReview();
      });
      return;
    }
    
    const sessionKey = current.orderType === "dine_in" ? current.tableId : "takeaway_session";
    const isOpen = !!activeTableOrders[sessionKey];

    const modal = openAppModal({
      title: "Review order",
      subtitle: "Review your items before sending to the kitchen.",
      body: `<div class="pos-review-head"><div><span class="eyebrow">Order</span><strong>${current.orderType === "dine_in" ? `Dine-in · Table ${escapeHtml(tables.find(t => t.id === current.tableId)?.table_no ?? "")}` : "Takeaway"}</strong></div><span class="secure-mini"><i class="ph ph-shield-check"></i>Verified</span></div><div class="review-items">${current.items.map(item => `<div class="review-item" style="align-items: center;"><div class="review-item-copy"><strong>${escapeHtml(item.name)}</strong><span>${money(item.price)}</span></div><div class="premium-qty-wrapper is-active" style="flex-shrink: 0; margin-left: 12px;"><button class="premium-qty-btn dec-btn" data-dec="${item.id}" title="Decrease"><i class="ph ph-minus"></i></button><span class="premium-qty-value">${item.quantity}</span><button class="premium-qty-btn inc-btn" data-inc="${item.id}" title="Increase"><i class="ph ph-plus"></i></button></div></div>`).join("")}</div><div class="review-total-hint"><i class="ph ph-info"></i><span>GST and the final total are calculated securely by the server.</span></div><div id="review-error-box" class="dining-warning-box" style="display: none; background: var(--danger-soft); border-color: #f1c7c4; color: var(--danger); margin-top: 12px; align-items: center;"></div>`,
      actions: [
        { label: "Keep editing", icon: "ph-arrow-left", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: isOpen ? "Update Kitchen" : "Confirm order", icon: "ph-check", className: "btn-primary", onClick: async ({ close, button, root }) => { 
            button.disabled = true; 
            const originalText = button.innerHTML;
            button.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i><span>Processing...</span>`;
            
            const errorBox = root.querySelector("#review-error-box");
            if (errorBox) errorBox.style.display = "none";

            const success = await submitPOSOrder(close, errorBox); 
            
            if (!success) {
                button.disabled = false;
                button.innerHTML = originalText;
            }
          } 
        }
      ]
    });

    modal.root.addEventListener("click", event => { 
      const inc = event.target.closest("[data-inc]"); 
      const dec = event.target.closest("[data-dec]"); 
      if (inc) { state.increment(inc.dataset.inc); refreshReview(modal.root); } 
      if (dec) { state.decrement(dec.dataset.dec); refreshReview(modal.root); } 
    });
  }

  function refreshReview(root) {
    const current = state.getState();
    const list = root.querySelector(".review-items");
    if (!list) return;
    
    if (current.items.length === 0) {
      list.innerHTML = `<div class="empty-state compact"><i class="ph ph-shopping-cart"></i><strong>Empty</strong><span>Add items to continue.</span></div>`;
      const confirmBtn = root.querySelector(".btn-primary");
      if (confirmBtn) confirmBtn.disabled = true;
      return;
    }

    list.innerHTML = current.items.map(item => `<div class="review-item" style="align-items: center;"><div class="review-item-copy"><strong>${escapeHtml(item.name)}</strong><span>${money(item.price)}</span></div><div class="premium-qty-wrapper is-active" style="flex-shrink: 0; margin-left: 12px;"><button class="premium-qty-btn dec-btn" data-dec="${item.id}" title="Decrease"><i class="ph ph-minus"></i></button><span class="premium-qty-value">${item.quantity}</span><button class="premium-qty-btn inc-btn" data-inc="${item.id}" title="Increase"><i class="ph ph-plus"></i></button></div></div>`).join("");
  }

    async function submitPOSOrder(closeModal, errorBoxElement = null) {
    if (!isCustomerMode) {
      window.__STAFF_MUTED_UNTIL = Date.now() + 3000;
    }

    const current = state.getState();

    const posSessionKey = current.orderType === "dine_in"
      ? current.tableId
      : "takeaway_session";

    try {
      if (isCaptainPanel && current.orderType !== "dine_in") {
        throw new Error(
          "Captain can only submit dine-in orders. Please use the Cashier workspace for takeaway orders."
        );
      }

      if (isCashierPanel && current.orderType !== "takeaway") {
        throw new Error(
          "Cashier can only submit takeaway orders."
        );
      }

      if (!Array.isArray(current.items) || current.items.length === 0) {
        throw new Error("Your cart is empty. Add at least one item before submitting.");
      }

      if (current.orderType === "dine_in" && !current.tableId) {
        throw new Error("No table is selected. Please select a table and try again.");
      }

      if (
        isCustomerMode &&
        (!currentTableObj || current.tableId !== currentTableObj.id)
      ) {
        throw new Error("The table does not match this QR code. Please scan the table QR code again.");
      }

      const safeServerItems = current.items.map(item => {
        const id = String(item?.id || "");
        const quantity = Number(item?.quantity);

        if (!id || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
          throw new Error("One or more cart items have invalid details. Please review your cart.");
        }

        return { id, quantity };
      });

      let result;

      if (isCustomerMode) {
        const token =
          customerSessionToken ||
          localStorage.getItem(`rms.session.${current.tableId}`) ||
          localStorage.getItem(`fourflavours.session.${current.tableId}`);

        if (!token) {
          throw new Error("Your dining session has expired. Please scan the table QR code again.");
        }

        const { data, error } = await supabase.rpc("submit_customer_order", {
          p_table_id: currentTableObj.id,
          p_session_token: token,
          p_items: safeServerItems
        });

        if (error) throw error;
        result = Array.isArray(data) ? data[0] : data;
      } else {
        const tenantId = window.__ACTIVE_TENANT__?.id;

        if (!tenantId) {
          throw new Error("Your restaurant session is not available. Please sign in again.");
        }

        const { data, error } = await supabase.rpc("create_pos_order", {
          p_restaurant_id: tenantId,
          p_order_type: current.orderType,
          p_table_id: current.tableId,
          p_items: safeServerItems,
          p_note: "Staff Order",
          p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null
        });

        if (error) throw error;
        result = Array.isArray(data) ? data[0] : data;
      }

      // Never clear the cart or close the modal until the database confirms an order ID.
      if (!result?.id) {
        throw new Error("The server did not confirm the order. Your cart has been kept; please check the order list before retrying.");
      }

      const wasNewOrder = !activeTableOrders[posSessionKey];
      activeTableOrders[posSessionKey] = result.id;

      state.clear();
      closeModal();

      // BROADCAST ALL DINE-IN ORDERS TO ADMIN DASHBOARD (Customer & POS Waiter)
      if (current.orderType === "dine_in" && current.tableId) {
        adminAlertChannel.send({
          type: "broadcast",
          event: "customer_order",
          payload: {
            tableId: current.tableId,
            isNew: wasNewOrder
          }
        });
      }

      if (isCustomerMode) {
        showActiveOrderDashboard({
          order: result,
          settings,
          current_state: current,
          sessionKey: posSessionKey,
          showPrepAnimation: true
        });
      } else {
        showActiveOrderDashboard({
          order: result,
          settings,
          current_state: current,
          sessionKey: posSessionKey
        });
      }

      return true;
    } catch (error) {
      console.error("Order Submission Error:", error);

      const message = error?.message || "An unexpected error occurred while submitting the order.";

      if (errorBoxElement) {
        errorBoxElement.innerHTML =
          `<i class="ph-bold ph-warning-circle"></i><span><strong>Order failed</strong><br>${escapeHtml(message)}</span>`;
        errorBoxElement.style.display = "flex";
      } else {
        showToast("Order failed", message, "error");
      }

      return false;
    }
  }

  function showActiveOrderDashboard({ order, session_id, settings, current_state, sessionKey, showPrepAnimation = false }) {
    const t = tables.find(x => x.id === current_state.tableId);
    const titleStr = current_state.orderType === "dine_in" ? `Table ${t ? t.table_no : "Unknown"} · Live Tab` : `Takeaway · Active Order`;
    
    let displayRounds = [];
    let aggregatedBill = { subtotal: 0, cgst: 0, sgst: 0, rounding: 0, grand_total: 0 };
    let rootOrder = order; 
    let isPrepAnimating = showPrepAnimation;
    let sessionStatus = null;

    const handleCustomerPaymentRequest = async (ctx) => {
        const button = ctx?.button;
        const originalButtonHTML = button?.innerHTML;

        if (button) {
            button.disabled = true;
            button.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i> Requesting...`;
        }

        try {
            const tableId = current_state.tableId;
            const token =
                customerSessionToken ||
                localStorage.getItem(`rms.session.${tableId}`) ||
                localStorage.getItem(`fourflavours.session.${tableId}`);

            if (!tableId || !token) {
                throw new Error("Your dining session could not be verified. Please scan the table QR code again.");
            }

            const { error } = await supabase.rpc("request_session_bill", {
                p_table_id: tableId,
                p_session_token: token,
                p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null
            });

            if (error) throw error;

            adminAlertChannel.send({
                type: "broadcast",
                event: "customer_bill",
                payload: { tableId }
            });

            ctx.close();
            modal.close();
            delete activeTableOrders[sessionKey];

            // Set the tracking flag so the UI knows we are intentionally waiting for payment
            sessionStorage.setItem(`rms.waiting_payment.${tableId}`, "true");

            document.getElementById("app").innerHTML = `
              <style>
                @keyframes spinMinute { 0% { transform: translateX(-50%) rotate(0deg); } 100% { transform: translateX(-50%) rotate(360deg); } }
                @keyframes spinHour { 0% { transform: translateX(-50%) rotate(0deg); } 100% { transform: translateX(-50%) rotate(360deg); } }
                .css-clock { width: 48px; height: 48px; border: 4px solid var(--forest-900); border-radius: 50%; position: relative; margin: 0 auto; box-shadow: inset 0 2px 4px rgba(0,0,0,0.05); background: transparent; }
                .css-clock::before { content: ''; position: absolute; bottom: 50%; left: 50%; width: 3px; height: 18px; background: var(--forest-900); border-radius: 2px; transform-origin: bottom center; transform: translateX(-50%); animation: spinMinute 2s linear infinite; }
                .css-clock::after { content: ''; position: absolute; bottom: 50%; left: 50%; width: 4px; height: 12px; background: var(--forest-900); border-radius: 2px; transform-origin: bottom center; transform: translateX(-50%); animation: spinHour 24s linear infinite; }
                .css-clock-center { position: absolute; top: 50%; left: 50%; width: 8px; height: 8px; background: var(--forest-900); border: 2px solid var(--sage-200); border-radius: 50%; transform: translate(-50%, -50%); z-index: 10; }
              </style>
              <main class="premium-lock-screen" style="display: flex; align-items: center; justify-content: center; min-height: 100vh; background: var(--cream-100, #FCFCF9); padding: 24px; font-family: inherit;">
                <div class="premium-lock-card" style="background: var(--paper, #ffffff); max-width: 440px; width: 100%; border-radius: 32px; padding: 56px 32px; box-shadow: 0 24px 48px rgba(18, 34, 22, 0.08); text-align: center; border: 1px solid rgba(0,0,0,0.04);">
                  <div class="premium-squircle anim-pulse" style="margin-bottom: 24px; background: var(--sage-200); box-shadow: 0 16px 32px rgba(219, 228, 214, 0.5);">
                    <div class="css-clock"><div class="css-clock-center"></div></div>
                  </div>
                  <h1 class="premium-lock-title" style="font-size: 2.2rem; font-weight: 900; color: var(--forest-950); margin-bottom: 12px; letter-spacing: -0.02em;">Bill Requested</h1>
                  <p class="premium-lock-desc" style="font-size: 1.15rem; font-weight: 600; color: var(--forest-800); margin-bottom: 32px; line-height: 1.5;">Please settle your bill with the restaurant staff in person. Your table will close after staff records the payment.</p>
                  <div class="thank-you-divider" style="width: 40px; height: 4px; background: var(--sage-300); margin: 0 auto 32px auto; border-radius: 4px;"></div>
                  <p class="thank-you-footer" style="font-size: 0.95rem; color: var(--forest-600); line-height: 1.6; font-weight: 700;">Thank you for dining at ${escapeHtml(restaurant.name)}!</p>
                </div>
              </main>
            `;

            let pollFallback = null;
            let disposed = false;

            const cleanupPaymentPolling = () => {
                if (disposed) return;
                disposed = true;

                if (pollFallback) clearInterval(pollFallback);
                document.removeEventListener("visibilitychange", visibilityCheck);
                supabase.removeChannel(pendingChannel);
            };

            const checkServerForPayment = async () => {
                try {
                    const { data, error: stateError } = await supabase.rpc("get_customer_session_state", {
                        p_table_id: tableId,
                        p_session_token: token
                    });

                    if (stateError) {
                        console.warn("Session-state check failed:", stateError.message);
                        return;
                    }

                    const sessionState = Array.isArray(data) ? data[0] : data;

                    if (sessionState?.status === "closed") {
                        cleanupPaymentPolling();
                        
                        // We must wipe tokens instantly to prevent a back-button bypass
                        sessionStorage.removeItem('rms.tab.' + tableId);
                        localStorage.removeItem('rms.session.' + tableId);
                        localStorage.removeItem('fourflavours.session.' + tableId);
                        
                        document.getElementById("app").innerHTML = `
                          <main class="premium-lock-screen" style="display: flex; align-items: center; justify-content: center; min-height: 100vh; background: var(--cream-100, #FCFCF9); padding: 24px; font-family: inherit;">
                            <div class="premium-lock-card" style="background: var(--paper, #ffffff); max-width: 440px; width: 100%; border-radius: 32px; padding: 56px 32px; box-shadow: 0 24px 48px rgba(18, 34, 22, 0.08); text-align: center; border: 1px solid rgba(0,0,0,0.04);">
                              <div class="premium-squircle sq-green anim-pop" style="margin-bottom: 24px;">
                                <i class="ph-bold ph-check"></i>
                              </div>
                              <h1 class="premium-lock-title" style="font-size: 2.2rem; font-weight: 900; color: var(--forest-950); margin-bottom: 12px; letter-spacing: -0.02em;">Payment Successful</h1>
                              <p class="premium-lock-desc" style="font-size: 1.15rem; font-weight: 600; color: var(--forest-800); margin-bottom: 32px; line-height: 1.5;">Your table has been successfully cleared. We hope you enjoyed your meal and look forward to serving you again soon!</p>
                              <button onclick="window.location.reload()" style="background: var(--forest-950); color: #fff; border: none; border-radius: 14px; padding: 14px 24px; font-size: 1.05rem; font-weight: 800; cursor: pointer; width: 100%; box-shadow: 0 8px 24px rgba(18,34,22,0.15); transition: transform 0.15s;" onmousedown="this.style.transform='scale(0.96)'" onmouseup="this.style.transform='scale(1)'">Close Session</button>
                            </div>
                          </main>
                        `;
                    }
                } catch (pollError) {
                    console.warn("Could not verify payment status:", pollError);
                }
            };

            const pendingChannel = supabase
                .channel(`pending-tab-${tableId}`)
                .on(
                    "postgres_changes",
                    {
                        event: "UPDATE",
                        schema: "public",
                        table: "dining_sessions",
                        filter: `table_id=eq.${tableId}`
                    },
                    checkServerForPayment
                )
                .subscribe();

            const visibilityCheck = () => {
                if (document.visibilityState === "visible") checkServerForPayment();
            };

            pollFallback = setInterval(checkServerForPayment, 5000);
            document.addEventListener("visibilitychange", visibilityCheck);
            checkServerForPayment();
        } catch (error) {
            showToast("Could not request bill", error?.message || "Please try again.", "error");

            if (button) {
                button.disabled = false;
                button.innerHTML = originalButtonHTML || "Request Bill";
            }
        }
    };

    // Select pre-authored HTML templates; styling lives in styles.css, structure in index.html.
    const initialDashboardTemplateId = showPrepAnimation
      ? "kitchen-dispatch-template"
      : "live-tab-loading-template";
    const initialDashboardTemplate = document.getElementById(initialDashboardTemplateId);
    const liveTabModalBodyTemplate = document.getElementById("live-tab-modal-body-template");

    if (!initialDashboardTemplate || !liveTabModalBodyTemplate) {
      console.error("Live Tab templates are missing from index.html.");
      showToast(
        "Unable to open Live Tab",
        "Please reload the app so the latest interface templates can load.",
        "error"
      );
      return;
    }

    const initialDashboardLoadingHTML = initialDashboardTemplate.innerHTML.trim();
    const liveTabModalBodyHTML = liveTabModalBodyTemplate.innerHTML.replace(
      "<!-- LIVE_TAB_INITIAL_CONTENT -->",
      initialDashboardLoadingHTML
    );

    const isTakeaway = current_state.orderType === "takeaway";

        const handleCashierGenerateBill = async (ctx) => {
      const button = ctx?.button;
      const originalHTML = button?.innerHTML;

      if (!isCashierPanel || current_state.orderType !== "takeaway") {
        showToast(
          "Invalid billing action",
          "Only Cashier can generate a takeaway bill through this workflow.",
          "error"
        );
        return;
      }

      if (!rootOrder?.id) {
        showToast(
          "Order unavailable",
          "The saved takeaway order could not be identified.",
          "error"
        );
        return;
      }

      if (button) {
        button.disabled = true;
        button.innerHTML =
          '<i class="ph ph-spinner-gap ph-spin"></i> Generating…';
      }

      try {
        const { data, error } = await supabase.rpc(
          "generate_takeaway_bill",
          {
            p_order_id: rootOrder.id,
            p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null
          }
        );

        if (error) throw error;

        const billedOrder = Array.isArray(data) ? data[0] : data;

        if (!billedOrder?.id || billedOrder.id !== rootOrder.id) {
          throw new Error(
            "The server did not confirm the bill for this order."
          );
        }

        if (
          billedOrder.billing_status &&
          !["bill_ready", "closed"].includes(
            String(billedOrder.billing_status).toLowerCase()
          )
        ) {
          throw new Error(
            "The server has not confirmed that the bill is ready."
          );
        }

        const receiptItems = displayRounds
          .flatMap(round => round.items || [])
          .filter(item => String(item.status || "").toLowerCase() !== "cancelled")
          .map(item => ({
            name: item.name,
            unit_price: item.price,
            quantity: item.quantity
          }));

        if (receiptItems.length === 0) {
          throw new Error("This order has no billable items.");
        }

        rootOrder = { ...rootOrder, ...billedOrder };

        const orderNumber = billedOrder.order_number ?? rootOrder.order_number;

        ctx.close();
        modal.close();

        openUniversalReceipt({
          order: {
            ...rootOrder,
            subtotal: billedOrder.subtotal ?? aggregatedBill.subtotal,
            cgst: billedOrder.cgst ?? aggregatedBill.cgst,
            sgst: billedOrder.sgst ?? aggregatedBill.sgst,
            rounding: billedOrder.rounding ?? aggregatedBill.rounding,
            grand_total: billedOrder.grand_total ?? aggregatedBill.grand_total
          },
          items: receiptItems,
          settings,
          tables,
          tableString: `Takeaway #${orderNumber ?? ""}`,
          modalTitle: `Takeaway Order #${orderNumber ?? ""} Bill`,
          modalSubtitle: "Review, print, or save the generated bill.",
          allowPdf: true
        });

        showToast(
          "Bill ready",
          "The server confirmed the takeaway bill. You can now print or save it.",
          "success"
        );
      } catch (error) {
        console.error("Cashier takeaway bill generation failed:", error);

        showToast(
          "Bill not generated",
          error?.message || "The bill could not be generated. Please try again.",
          "error"
        );

        if (button) {
          button.disabled = false;
          button.innerHTML = originalHTML || "Generate Bill";
        }
      }
    };
    
    // Waiters on the POS never view/print bills directly; they trigger the Admin Golden Notification.
    const handleStaffBillRequest = async (ctx) => {
      const button = ctx?.button;
      const originalHTML = button?.innerHTML;
      if (button) {
        button.disabled = true;
        button.innerHTML = '<i class="ph ph-spinner-gap ph-spin"></i> Notifying Admin...';
      }

      try {
        const tableId = current_state.tableId;
        if (!tableId) {
          throw new Error("No active table selected for this bill request.");
        }

        // 1. Execute the SECURITY DEFINER RPC (computes totals & marks session bill_requested)
        const { error: rpcError } = await supabase.rpc("request_session_bill", {
          p_table_id: tableId,
          p_session_token: null,
          p_panel_token: window.__RMS_PANEL_ACCESS__?.token || null
        });

        if (rpcError) throw rpcError;

        // 2. Ensure this session is removed from seen_sessions so Admin Golden Alert always lights up
        const sid = session_id || rootOrder?.session_id;
        if (sid) {
          const updatedSessions = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_sessions") || "[]"));
          updatedSessions.delete(sid);
          localStorage.setItem("fourflavours.seen_sessions", JSON.stringify([...updatedSessions]));
        }

        // 3. Set local alert badge & broadcast Golden Notification to Admin workspace
        if (window.setTableAlert) {
          window.setTableAlert(tableId, "bill_requested", "Bill Requested");
        }
        await adminAlertChannel.send({
          type: "broadcast",
          event: "customer_bill",
          payload: { tableId }
        });

        ctx.close();
        modal.close();
        delete activeTableOrders[sessionKey];

        // 4. Reset POS view cleanly back to the floor without aborting network/toast via reload
        activeCuisine = null;
        activeSubCategory = "All";
        searchTerm = "";
        const searchField = document.querySelector("#pos-search");
        if (searchField) searchField.value = "";
        renderProducts();
        window.scrollTo({ top: 0, behavior: "smooth" });

        showToast("Bill Requested", "The Admin dashboard has been alerted with a golden notification.", "success");
      } catch (error) {
        console.error("Staff bill request failed:", error);
        showToast("Request failed", error?.message || "Please try again.", "error");
        if (button) {
          button.disabled = false;
          button.innerHTML = originalHTML;
        }
      }
    };

    const modal = openAppModal({
      title: titleStr, subtitle: isTakeaway ? "Manage this takeaway order." : "Your live table tab.",
      body: liveTabModalBodyHTML,
      actions: [
        { 
          label: isTakeaway ? "Add Items" : "Keep Ordering", 
          icon: "ph-plus-circle", 
          className: "btn-quiet", 
          onClick: ({ close }) => { 
            close();
            
            // Trigger smooth visual page load transition
            const workspace = mount.querySelector("#pos-dynamic-area") || mount;
            workspace.style.transition = "opacity 0.05s ease";
            workspace.style.opacity = "0.4";
            workspace.style.pointerEvents = "none";
            document.body.style.cursor = "wait";

            setTimeout(() => {
              activeCuisine = null;
              activeSubCategory = "All";
              searchTerm = "";
              const searchInput = document.querySelector("#pos-search");
              if (searchInput) searchInput.value = "";
              renderProducts();
              window.scrollTo({ top: 0, behavior: 'smooth' });

              workspace.style.opacity = "1";
              workspace.style.pointerEvents = "auto";
              document.body.style.cursor = "default";
              setTimeout(() => { workspace.style.transition = ""; }, 150);
            }, 500);
          } 
        },
        { 
          label: isCustomerMode
            ? "Request Bill"
            : (isTakeaway
                ? "Generate Bill"
                : (isCaptainPanel
                    ? "Request Bill from Cashier"
                    : "Request Bill from Admin")), 
          icon: "ph-receipt", 
          className: "btn-primary", 
          disabled: true, 
          onClick: ({ close }) => {
            const formattedTotal = money(aggregatedBill.grand_total, settings.currency_symbol);
            if (isCustomerMode) {
                openAppModal({
                  title: "Request Final Bill?", subtitle: "Your waiter will bring the physical bill.",
                  body: `<div class="danger-confirm" style="text-align: center;"><div class="danger-confirm-icon" style="background: var(--sage-200); color: var(--forest-900);"><i class="ph-bold ph-receipt"></i></div><h3>Ready for the bill?</h3><p>Your total is <strong>${formattedTotal}</strong>.</p></div>`,
                  actions: [ { label: "No", className: "btn-quiet", onClick: (c) => c.close() }, { label: "Yes, Request", className: "btn-primary", onClick: handleCustomerPaymentRequest } ]
                });
                        } else if (isCashierPanel && isTakeaway) {
                openAppModal({
                  title: rootOrder?.billing_status === "bill_ready"
                    ? "Print Takeaway Bill?"
                    : "Generate Takeaway Bill?",
                  subtitle: "The saved takeaway order will be used to prepare the final bill.",
                  body: `
                    <div class="danger-confirm" style="text-align:center;">
                      <div
                        class="danger-confirm-icon"
                        style="background:var(--sage-100);color:var(--forest-900);"
                      >
                        <i class="ph-bold ph-receipt"></i>
                      </div>
                      <h3>Takeaway #${escapeHtml(rootOrder?.order_number ?? "")}</h3>
                      <p>
                        Total:
                        <strong>${money(aggregatedBill.grand_total, settings.currency_symbol)}</strong>
                      </p>
                      <p>
                        Generating a bill does not mark the order as paid.
                      </p>
                    </div>
                  `,
                  actions: [
                    {
                      label: "Cancel",
                      className: "btn-quiet",
                      onClick: ({ close }) => close()
                    },
                    {
                      label: rootOrder?.billing_status === "bill_ready"
                        ? "Open Bill"
                        : "Generate Bill",
                      className: "btn-primary",
                      onClick: handleCashierGenerateBill
                    }
                  ]
                });
            } else {
                openAppModal({
                  title: "Request Bill from Admin?",
                  actions: [
                    { label: "Cancel", className: "btn-quiet", onClick: (c) => c.close() },
                    { label: "Yes, Send Request", className: "btn-primary", style: "background: var(--gold-500); color: var(--forest-950); border-color: var(--gold-500);", onClick: handleStaffBillRequest }
                  ]
                });
            }
        }}
      ]
    });

    let syncTimer = setInterval(fetchLiveSession, 3000);
    const liveUpdateHandler = () => fetchLiveSession();
    window.addEventListener("ff_live_update", liveUpdateHandler);

    let cancelRequestInFlight = false;

    const handleCaptainCancellationClick = event => {
      const button = event.target.closest(
        "[data-captain-cancel-item], [data-captain-request-cancel]"
      );

      if (!button || !isCaptainPanel || cancelRequestInFlight) return;

      const isApprovalRequest = Boolean(button.dataset.captainRequestCancel);
      const itemId = isApprovalRequest
        ? button.dataset.captainRequestCancel
        : button.dataset.captainCancelItem;

      const itemName = button.dataset.itemName || "this dish";
      const itemStatus = String(button.dataset.itemStatus || "pending").toLowerCase();

      if (!itemId) return;

      if (
        !isApprovalRequest &&
        itemStatus !== "pending"
      ) {
        showToast(
          "Cancellation not allowed",
          "A dish can be cancelled directly only before preparation starts.",
          "error"
        );
        return;
      }

      if (
        isApprovalRequest &&
        !["preparing", "ready"].includes(itemStatus)
      ) {
        showToast(
          "Status changed",
          "Refresh the live order before requesting cancellation.",
          "error"
        );
        return;
      }

      const confirmation = openAppModal({
        title: isApprovalRequest
          ? "Request Admin cancellation?"
          : "Cancel this dish?",
        subtitle: isApprovalRequest
          ? "The dish will remain active until Admin decides."
          : "This dish has not started preparation.",
        body: `
          <div style="display:grid;gap:12px;">
            <p style="margin:0;font-size:14px;font-weight:800;color:var(--forest-950);">
              ${escapeHtml(itemName)}
            </p>

            <p style="margin:0;color:var(--muted);font-size:12px;line-height:1.6;">
              ${isApprovalRequest
                ? "Submitting this request will not cancel the dish. Admin must approve it."
                : "The dish will be marked cancelled. It must not be physically deleted from the order history."}
            </p>

            <label class="field">
              <span>Reason for cancellation *</span>
              <select
                data-captain-cancellation-reason-select
                required
                style="width:100%;"
              >
                <option value="">Choose a reason</option>
                <option value="Customer changed their mind">Customer changed their mind</option>
                <option value="Dish ordered by mistake">Dish ordered by mistake</option>
                <option value="Wrong dish selected">Wrong dish selected</option>
                <option value="Duplicate order">Duplicate order</option>
                <option value="Wrong quantity ordered">Wrong quantity ordered</option>
                <option value="Customer changed the order">Customer changed the order</option>
                <option value="Dietary requirement or allergy concern">Dietary requirement or allergy concern</option>
                <option value="Ingredient or dish unavailable">Ingredient or dish unavailable</option>
                <option value="Excessive waiting time">Excessive waiting time</option>
                <option value="Food quality concern">Food quality concern</option>
                <option value="Preparation mistake">Preparation mistake</option>
                <option value="Table or customer request">Table or customer request</option>
                <option value="Payment or billing correction">Payment or billing correction</option>
                <option value="Other">Other reason</option>
              </select>
            </label>

            <label class="field">
              <span>Additional details <span style="color:var(--muted);font-weight:500;">(optional)</span></span>
              <textarea
                data-captain-cancellation-reason
                rows="3"
                maxlength="300"
                placeholder="Add details if needed…"
              ></textarea>
            </label>

            <p
              data-captain-cancellation-error
              role="alert"
              style="margin:0;color:var(--danger);font-size:12px;"
            ></p>
          </div>
        `,
        actions: [
          {
            label: "Keep dish",
            className: "btn-quiet",
            onClick: ({ close }) => close()
          },
          {
            label: isApprovalRequest
              ? "Send request to Admin"
              : "Confirm cancellation",
            className: "btn-primary",
            onClick: async ({ close, button: confirmButton, root }) => {
              if (cancelRequestInFlight) return;

              const reasonSelect = root.querySelector(
                "[data-captain-cancellation-reason-select]"
              );

              const reasonInput = root.querySelector(
                "[data-captain-cancellation-reason]"
              );

              const errorNode = root.querySelector(
                "[data-captain-cancellation-error]"
              );

              const selectedReason = reasonSelect?.value.trim() || "";
              const additionalDetails = reasonInput?.value.trim() || "";

              if (!selectedReason) {
                if (errorNode) {
                  errorNode.textContent = "Choose a cancellation reason.";
                }
                reasonSelect?.focus();
                return;
              }

              if (selectedReason === "Other" && !additionalDetails) {
                if (errorNode) {
                  errorNode.textContent = "Please describe the reason in the details box.";
                }
                reasonInput?.focus();
                return;
              }

              const reason = additionalDetails
                ? `${selectedReason}: ${additionalDetails}`
                : selectedReason;

              if (reason.length > 300) {
                if (errorNode) {
                  errorNode.textContent = "Please shorten the reason to 300 characters.";
                }
                reasonInput?.focus();
                return;
              }

              cancelRequestInFlight = true;

              const originalHTML = confirmButton?.innerHTML;

              if (confirmButton) {
                confirmButton.disabled = true;
                confirmButton.innerHTML =
                  '<i class="ph-bold ph-spinner-gap ph-spin"></i> Processing…';
              }

              try {
                                const panelAccess = window.__RMS_PANEL_ACCESS__;

                if (
                  !panelAccess ||
                  typeof panelAccess.token !== "string" ||
                  panelAccess.token.length < 20 ||
                  !Number.isFinite(panelAccess.expiresAt) ||
                  panelAccess.expiresAt <= Date.now() ||
                  panelAccess.panelId !== "captain"
                ) {
                  throw new Error(
                    "Captain authorization is missing or expired. Reopen the Captain panel using its PIN."
                  );
                }

                const { data, error } = await supabase.rpc(
                  isApprovalRequest
                    ? "request_dish_cancellation"
                    : "cancel_order_item",
                  {
                    p_item_id: itemId,
                    p_reason: reason,
                    p_session_token: panelAccess.token
                  }
                );

                if (error) throw error;

                if (data === false || data?.ok === false) {
                  throw new Error("The server did not accept this operation.");
                }

                close();

                if (isApprovalRequest) {
                  showToast(
                    "Request sent",
                    "Admin approval is required. The dish remains active until a decision is recorded.",
                    "success"
                  );
                } else {
                  showToast(
                    "Cancellation recorded",
                    "The server confirmed the cancellation.",
                    "success"
                  );
                }

                await fetchLiveSession();
              } catch (error) {
                console.error("Captain cancellation action failed:", error);

                if (errorNode) {
                  const message = String(
                    error?.message || error?.details || ""
                  );

                  if (/authorization.*expired|invalid.*panel|reopen the captain/i.test(message)) {
                    errorNode.textContent =
                      "Captain access has expired. Reopen the Captain panel using its PIN, then try again.";
                  } else if (/already pending/i.test(message)) {
                    errorNode.textContent =
                      "A cancellation request is already waiting for Admin approval.";
                  } else if (/session.*closed|session.*expired/i.test(message)) {
                    errorNode.textContent =
                      "This table session is no longer active. Refresh the order before trying again.";
                  } else {
                    errorNode.textContent =
                      "We could not send the request. " +
                      (message || "Please try again or contact the Admin.");
                  }
                }

                if (confirmButton) {
                  confirmButton.disabled = false;
                  confirmButton.innerHTML = originalHTML;
                }
              } finally {
                cancelRequestInFlight = false;
              }
            }
          }
        ]
      });
    };


    const originalClose = modal.close;

    modal.close = () => {
      clearInterval(syncTimer);
      window.removeEventListener("ff_live_update", liveUpdateHandler);
      modal.root.removeEventListener("click", handleCaptainCancellationClick);
      originalClose();
    };

    async function fetchLiveSession() {
      const host = modal.root.querySelector("#active-dash-host");
      let ordersToProcess = [];
      let nextSessionStatus = sessionStatus;

      try {
        if (current_state.orderType === "takeaway") {
          if (!rootOrder?.id) return;
          const { data, error } = await supabase
            .from("orders")
            .select("*, order_items(*)")
            .eq("id", rootOrder.id)
            .eq("restaurant_id", activeTenantId)
            .single();
          if (error) throw error;
          if (data) ordersToProcess = [data];
        } else if (isCustomerMode) {
          const token = customerSessionToken ||
            localStorage.getItem(`rms.session.${current_state.tableId}`) ||
            localStorage.getItem(`fourflavours.session.${current_state.tableId}`);
          if (!token) throw new Error("Your table session could not be verified. Please scan the QR code again.");

          const { data, error } = await supabase.rpc("get_customer_session_state", {
            p_table_id: current_state.tableId,
            p_session_token: token
          });
          if (error) throw error;

          const sessionState = Array.isArray(data) ? data[0] : data;
          if (!sessionState) {
            if (host) host.innerHTML = `<div class="empty-state"><i class="ph ph-warning-circle"></i><strong>Tab unavailable</strong><span>We could not verify this table session. Please rescan the table QR code.</span></div>`;
            return;
          }
          nextSessionStatus = sessionState.status;
          if (sessionState.status === "closed") {
            if (host) host.innerHTML = `<div class="empty-state"><i class="ph ph-check-circle"></i><strong>This tab is closed</strong><span>Please rescan the QR code if you need to start a new visit.</span></div>`;
            const primary = modal.root.querySelector(".modal-actions .btn-primary");
            if (primary) { primary.disabled = true; primary.textContent = "Tab Closed"; }
            return;
          }
          ordersToProcess = Array.isArray(sessionState.orders) ? sessionState.orders : [];
        } else {
          let sid = session_id || rootOrder?.session_id;
          if (!sid) {
            const { data: activeSession, error: activeSessionError } = await supabase
              .from("dining_sessions")
              .select("id, status")
              .eq("table_id", current_state.tableId)
              .eq("restaurant_id", activeTenantId)
              .neq("status", "closed")
              .maybeSingle();
            if (activeSessionError) throw activeSessionError;
            if (!activeSession) {
              if (host) host.innerHTML = `<div class="empty-state"><span>No active items.</span></div>`;
              return;
            }
            sid = activeSession.id;
            nextSessionStatus = activeSession.status;
          } else {
            const { data: activeSession, error: activeSessionError } = await supabase
              .from("dining_sessions")
              .select("status")
              .eq("id", sid)
              .eq("restaurant_id", activeTenantId)
              .maybeSingle();
            if (activeSessionError) throw activeSessionError;
            if (activeSession) nextSessionStatus = activeSession.status;
          }

          const { data, error } = await supabase
            .from("orders")
            .select("*, order_items(*)")
            .eq("session_id", sid)
            .eq("restaurant_id", activeTenantId)
            .neq("status", "cancelled")
            .order("round_number", { ascending: true });
          if (error) throw error;
          ordersToProcess = data ?? [];
        }

        if (ordersToProcess.length > 0 || nextSessionStatus) {
          processOrders(ordersToProcess, nextSessionStatus);
        } else if (host) {
          host.innerHTML = `<div class="empty-state"><span>No active items.</span></div>`;
        }
      } catch (error) {
        console.error("Live tab refresh failed:", error);
        if (host) host.innerHTML = `<div class="empty-state"><i class="ph ph-warning-circle"></i><strong>Could not refresh the live tab</strong><span>${escapeHtml(error?.message || "Please check the connection and try again.")}</span></div>`;
      }
    }

    function processOrders(ordersList, nextStatus = sessionStatus) {
      sessionStatus = nextStatus;
      aggregatedBill = { subtotal: 0, cgst: 0, sgst: 0, rounding: 0, grand_total: 0 };
      displayRounds = [];
      if (ordersList.length) rootOrder = ordersList[ordersList.length - 1];

      ordersList.forEach((o, index) => {
        aggregatedBill.subtotal += Number(o.subtotal || 0);
        aggregatedBill.cgst += Number(o.cgst || 0);
        aggregatedBill.sgst += Number(o.sgst || 0);
        aggregatedBill.rounding += Number(o.rounding || 0);
        aggregatedBill.grand_total += Number(o.grand_total || 0);

        const itemsArray = o.items || o.order_items || []; 
        itemsArray.sort((a, b) => {
            const dateDiff = new Date(a.created_at) - new Date(b.created_at);
            return dateDiff !== 0 ? dateDiff : (a.id > b.id ? 1 : -1);
        });

        let roundItems = [];
        itemsArray.forEach(oi => {
           const productObj = products.find(p => p.id === oi.product_id);
           roundItems.push({
             id: oi.id,
             product_id: oi.product_id,
             name: productObj ? productObj.name : (oi.name_snapshot || "Unknown Item"),
             price: oi.unit_price,
             quantity: Number(oi.quantity),
             status: oi.serving_status || 'pending'
           });
        });

        displayRounds.push({
           id: o.id,
           round_number: o.round_number || (index + 1),
           order_number: o.order_number,
           total: Number(o.grand_total),
           items: roundItems
        });
      });
      renderDash();
    }

    function getCustomerStatusStyle(status) {
        if(status === 'served') return 'color: #15803d; background: #f0fdf4; border: 1px solid #bbf7d0; box-shadow: 0 2px 4px rgba(22, 163, 74, 0.05);'; 
        if(status === 'ready') return 'color: #0369a1; background: #e0f2fe; border: 1px solid #bae6fd; box-shadow: 0 2px 8px rgba(3, 105, 161, 0.15);';
        if(status === 'preparing') return 'color: #b45309; background: #fffbeb; border: 1px solid #fde68a; box-shadow: 0 2px 8px rgba(217, 119, 6, 0.15);';
        // Beautiful Indigo badge for PENDING
        return 'color: #4338ca; background: #e0e7ff; border: 1px solid #c7d2fe; box-shadow: 0 2px 8px rgba(67, 56, 202, 0.15);'; 
    }

    function renderDash() {
      if (isPrepAnimating) return; 
      const host = modal.root.querySelector("#active-dash-host");
      if (!host) return;
      const listContainer = host.querySelector(".dining-items-list");
      const currentScroll = listContainer ? listContainer.scrollTop : 0;
      
      const isTakeaway = current_state.orderType === "takeaway";

      // Check if ANY item is unserved to lock the Bill Request button (Bypassed for takeaway)
      let hasUnservedItems = false;
      if (!isTakeaway) {
          displayRounds.forEach(r => r.items.forEach(i => { if (i.status !== 'served') hasUnservedItems = true; }));
      }

      // Never allow billing while service items remain, or after a bill has already been requested.
      const primaryBtn = modal.root.querySelector(".modal-actions .btn-primary");
      if (primaryBtn) {
          if (sessionStatus === "closed") {
              primaryBtn.disabled = true;
              primaryBtn.innerHTML = `<i class="ph-bold ph-check-circle"></i> Tab Closed`;
          } else if (sessionStatus === "bill_requested" || sessionStatus === "bill_ready") {
              primaryBtn.disabled = true;
              primaryBtn.innerHTML = `<i class="ph-bold ph-receipt"></i> Bill Requested`;
          } else if (hasUnservedItems || displayRounds.length === 0) {
              primaryBtn.disabled = true;
              primaryBtn.innerHTML = `<i class="ph-bold ph-clock"></i> ${displayRounds.length ? "Items Pending" : "Loading tab…"}`;
          } else {
              primaryBtn.disabled = false;
              primaryBtn.innerHTML = `<i class="ph-bold ph-receipt"></i> ${
                isCustomerMode
                  ? "Request Bill"
                  : (isCashierPanel && isTakeaway
                      ? (rootOrder?.billing_status === "bill_ready" ? "Print Bill" : "Generate Bill")
                      : (isCaptainPanel ? "Request Bill from Cashier" : "Request Bill from Admin"))
              }`;
          }
      }

      host.innerHTML = `
        <div class="active-dining-dashboard" style="display: flex; flex-direction: column; flex: 1; min-height: 0;">
          <div class="dining-status-banner" style="flex-shrink: 0;">
            <i class="ph-bold ${isTakeaway ? 'ph-shopping-bag' : 'ph-cooking-pot'}"></i>
            <div>
              <strong>${isTakeaway ? 'Takeaway Order Active' : 'Table Tab is Open'}</strong>
              <span id="dash-live-total">Live Total: ${money(aggregatedBill.grand_total, settings.currency_symbol)}</span>
            </div>
          </div>
          
          <div class="dining-items-list" style="flex: 1; overflow-y: auto; min-height: 0; margin-top: 12px; padding-bottom: 24px; padding-right: 4px;">
            ${displayRounds.map(r => `
              <div style="flex-shrink: 0; margin-bottom: 16px; background: var(--paper); ${isTakeaway ? '' : 'border: 1px solid var(--line); border-radius: 12px;'} overflow: hidden; display: flex; flex-direction: column;">
                ${!isTakeaway ? `
                <div style="background: var(--cream-50); padding: 10px 14px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; z-index: 2;">
                   <strong style="font-size: 14px; color: var(--forest-900);">Round ${r.round_number}</strong>
                   <span style="font-size: 14px; font-weight: 900;">${money(r.total, settings.currency_symbol)}</span>
                </div>` : ''}
                
                <!-- DYNAMIC INNER CONTAINER: No max-height, No scrollbar -->
                <div style="display: flex; flex-direction: column; background: var(--paper);">
                  ${r.items.map(i => {
                    const itemStatus = String(i.status || "pending").toLowerCase();
                    const captainCanCancel = false;
                    const captainNeedsAdmin = false;
                    const captainServed = isCaptainPanel && itemStatus === "served";

                    return `
                      <div style="padding:12px ${isTakeaway ? '4px' : '14px'};border-bottom:1px solid var(--cream-200);display:flex;justify-content:space-between;align-items:center;gap:10px;">
                        <div style="display:flex;flex-direction:column;gap:6px;min-width:0;">
                          <strong style="font-size:14px;overflow-wrap:anywhere;">
                            ${escapeHtml(i.name)}
                            <span class="qty-badge" style="background:var(--sage-200);color:var(--forest-900);padding:2px 6px;border-radius:6px;font-size:11px;">x${i.quantity}</span>
                          </strong>

                          <span style="font-size:13px;color:var(--muted);">
                            ${money(i.price, settings.currency_symbol)}
                          </span>
                        </div>

                        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:7px;flex-shrink:0;">
                          ${!isTakeaway ? `
                            <div style="padding:6px 10px;font-size:10px;font-weight:900;text-transform:uppercase;border-radius:8px;display:inline-flex;align-items:center;gap:4px;user-select:none;letter-spacing:0.05em;${getCustomerStatusStyle(itemStatus)}">
                              ${itemStatus === "served"
                                ? '<i class="ph-bold ph-check"></i> SERVED'
                                : itemStatus === "ready"
                                  ? '<i class="ph-bold ph-bell-ringing"></i> READY'
                                  : itemStatus === "preparing"
                                    ? '<i class="ph-bold ph-fire"></i> PREPARING'
                                    : itemStatus === "cancelled"
                                      ? '<i class="ph-bold ph-x-circle"></i> CANCELLED'
                                      : '<i class="ph-bold ph-clock"></i> PENDING'}
                            </div>
                          ` : ""}
                          
                          ${captainServed ? `
                            <span style="font-size:10px;color:var(--muted);font-weight:700;">
                              Already served
                            </span>
                          ` : ""}
                        </div>
                      </div>
                    `;
                  }).join("")}
                </div>
              </div>
            `).join("")}
            <div style="height: 24px; flex-shrink: 0; width: 100%;"></div>
          </div>
        </div>`;
      if (listContainer) host.querySelector(".dining-items-list").scrollTop = currentScroll;
    }

    if (isPrepAnimating) { setTimeout(() => { isPrepAnimating = false; renderDash(); }, 4000); }
    fetchLiveSession(); 
  }

  async function showReceiptPreview({ order, items, settings, current_state }) {
    let tableString = "Takeaway";
    if (current_state && current_state.orderType === "dine_in" && current_state.tableId) {
      const t = tables.find(x => x.id === current_state.tableId);
      if (t) tableString = "Dine-in · Table " + t.table_no;
    }

    openUniversalReceipt({
      order,
      items,
      settings,
      tables,
      tableString,
      isCustomerMode,
      modalTitle: isCustomerMode ? "Your Digital Bill" : ("Order #" + (order.order_number ?? "Tab") + " Confirmed"),
      modalSubtitle: isCustomerMode ? "Please settle this bill with restaurant staff in person." : "Review, save, or print the bill."
    });
  }

  return async () => {
    window.removeEventListener("popstate", handlePopState);
    document.removeEventListener("click", handleOutsideClick);

    customerCaptainButton?.removeEventListener(
      "click",
      handleCustomerCaptainClick
    );

    drawerCleanup?.();
    panelSignOutCleanup?.();

    if (realtimeChannel) {
      try {
        await supabase.removeChannel(realtimeChannel);
      } catch (error) {
        console.warn("POS realtime cleanup failed:", error);
      }
    }
  };
}