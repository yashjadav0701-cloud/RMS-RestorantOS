import { versionedAsset } from "../core/config.js";
import { getSession, supabase } from "../core/supabase.js";
import { showToast, escapeHtml } from "./navigation.js";

// ==========================================
// TIER 1: SaaS PLATFORM LANDING & LOGIN
// ==========================================
export async function renderStaffLogin({ mount, onLogin }) {
  if (!supabase) {
    mount.innerHTML = `<section class="access-screen"><div class="access-card"><div class="access-brand"><strong>Table Forge System</strong></div><h1>Connection not configured</h1><p class="access-copy">The application could not initialize its Supabase connection. Check the browser configuration and network connection, then reload.</p></div></section>`;
    return () => {};
  }

  mount.innerHTML = `
    <style>
      .saas-landing { min-height: 100vh; background: radial-gradient(circle at 50% 0%, var(--sage-200) 0%, var(--cream-100) 40%); display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: var(--ui-font); padding: 24px 24px 80px 24px; position: relative; overflow-y: auto; overflow-x: hidden; }
      
      /* Ambient Floating Orbs */
      .bg-orb-1 { position: absolute; top: -150px; left: -100px; width: 500px; height: 500px; background: radial-gradient(circle, rgba(201,164,90,0.12) 0%, transparent 70%); border-radius: 50%; pointer-events: none; }
      .bg-orb-2 { position: absolute; bottom: -200px; right: -150px; width: 600px; height: 600px; background: radial-gradient(circle, rgba(76,110,75,0.08) 0%, transparent 70%); border-radius: 50%; pointer-events: none; }

      .saas-content { position: relative; z-index: 10; display: flex; flex-direction: column; align-items: center; width: 100%; max-width: 900px; }

      /* Centered Logo */
      .saas-center-logo { width: min(100%, 360px); margin-bottom: 20px; animation: floatLogo 4s ease-in-out infinite; filter: drop-shadow(0 12px 24px rgba(0,0,0,0.04)); }
      @keyframes floatLogo { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }

      /* Minimal, Friendly Text */
      .saas-tagline { font-size: 1.15rem; font-weight: 800; color: var(--forest-950); margin: 0 0 6px 0; text-align: center; }
      .saas-sub-tagline { font-size: 0.95rem; color: var(--forest-700); margin: 0 0 44px 0; text-align: center; font-weight: 500; }

      /* Primary CTA */
      .btn-access { height: 56px; padding: 0 36px; border-radius: 99px; font-size: 1.05rem; font-weight: 800; background: var(--forest-950); color: #fff; border: none; cursor: pointer; display: flex; align-items: center; gap: 10px; box-shadow: 0 12px 24px rgba(18,34,22,0.15), inset 0 2px 4px rgba(255,255,255,0.1); transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
      .btn-access:hover { transform: translateY(-3px) scale(1.02); box-shadow: 0 16px 32px rgba(18,34,22,0.25), inset 0 2px 4px rgba(255,255,255,0.15); background: var(--forest-900); }
      .btn-access i { font-size: 20px; color: var(--gold-400); }

      /* Visual Feature Grid */
      .saas-icon-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; width: 100%; margin-top: 56px; }
      .saas-feature-pill { background: rgba(255,255,255,0.6); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.6); padding: 24px 20px; border-radius: 28px; display: flex; flex-direction: column; align-items: center; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.02); transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), background 0.3s; }
      .saas-feature-pill:hover { transform: translateY(-6px); background: #ffffff; box-shadow: 0 16px 32px rgba(0,0,0,0.05); }
      
      /* Bold Fill Icons */
      .saas-feature-icon { width: 56px; height: 56px; border-radius: 20px; background: var(--sage-100); color: var(--forest-900); display: grid; place-items: center; margin-bottom: 16px; border: 1px solid var(--sage-200); box-shadow: inset 0 4px 8px rgba(255,255,255,0.8), 0 4px 12px rgba(18,34,22,0.05); }
      .saas-feature-icon i { font-size: 28px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1)); }
      
      .saas-feature-pill strong { font-size: 0.95rem; font-weight: 800; color: var(--forest-950); margin: 0 0 4px 0; }
      .saas-feature-pill span { font-size: 0.8rem; color: var(--muted); margin: 0; line-height: 1.4; }

      @media(max-width: 720px) {
        .saas-icon-grid { grid-template-columns: 1fr; gap: 12px; margin-top: 40px; }
        .saas-feature-pill { flex-direction: row; text-align: left; padding: 16px 20px; border-radius: 20px; }
        .saas-feature-icon { margin-bottom: 0; margin-right: 16px; width: 46px; height: 46px; border-radius: 16px; flex-shrink: 0; }
        .saas-feature-icon i { font-size: 22px; }
        .saas-center-logo { width: min(100%, 280px); }
      }

      /* Modal Refinements */
      .saas-login-modal { position: fixed; inset: 0; z-index: 1000; background: rgba(18,34,22,0.3); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 24px; opacity: 0; pointer-events: none; transition: opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
      .saas-login-modal.active { opacity: 1; pointer-events: auto; }
      .saas-login-card { background: var(--paper); width: 100%; max-width: 380px; padding: 40px 32px; border-radius: 32px; box-shadow: 0 24px 64px rgba(0,0,0,0.15); transform: translateY(20px) scale(0.96); transition: transform 0.5s cubic-bezier(0.16, 1, 0.3, 1); position: relative; border: 1px solid rgba(255,255,255,0.4); }
      .saas-login-modal.active .saas-login-card { transform: translateY(0) scale(1); }
      .saas-close-btn { position: absolute; top: 16px; right: 16px; background: transparent; color: var(--muted); width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; cursor: pointer; border: none; transition: background 0.2s, color 0.2s; font-size: 20px; }
      .saas-close-btn:hover { background: var(--sage-100); color: var(--forest-900); }
    </style>

    <div class="saas-landing">
      <div class="bg-orb-1"></div>
      <div class="bg-orb-2"></div>

      <div class="saas-content">
        <!-- Giant Centered Logo -->
        <img class="saas-center-logo" src="${versionedAsset("assets/images/RMS_Logo.svg")}" alt="RMS Cloud" />
        
        <!-- Friendly, Simple Text (No large H1s) -->
        <p class="saas-tagline">Everything you need to run your restaurant.</p>
        <p class="saas-sub-tagline">Live table tabs, instant QR ordering, and custom branding.</p>
        
        <button class="btn-access" id="hero-login-btn">
          Sign In to Workspace <i class="ph-bold ph-arrow-right"></i>
        </button>

        <!-- Highly Visual Icon Grid -->
        <section class="saas-icon-grid">
          <div class="saas-feature-pill">
            <div class="saas-feature-icon" style="color: #0284c7; background: #e0f2fe; border-color: #bae6fd;">
              <i class="ph-bold ph-qr-code" style="font-size: 32px;"></i>
            </div>
            <div>
              <strong>Scan & Order</strong>
              <span>Guests order from their phones. Kitchen gets it instantly.</span>
            </div>
          </div>
          
          <div class="saas-feature-pill">
            <div class="saas-feature-icon" style="color: #16a34a; background: #dcfce7; border-color: #bbf7d0;">
              <i class="ph-bold ph-shield-check" style="font-size: 32px;"></i>
            </div>
            <div>
              <strong>Bank-Grade Security</strong>
              <span>Your data and menus are locked in a private cloud vault.</span>
            </div>
          </div>
          
          <div class="saas-feature-pill">
            <div class="saas-feature-icon" style="color: #9333ea; background: #f3e8ff; border-color: #e9d5ff;">
              <i class="ph-bold ph-swatches" style="font-size: 32px;"></i>
            </div>
            <div>
              <strong>100% Your Brand</strong>
              <span>The platform instantly repaints itself with your colors.</span>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- Classic Structured Login Modal -->
    <div class="saas-login-modal" id="login-modal">
      <div class="saas-login-card" style="padding: 36px; max-width: 440px;">
        <button class="saas-close-btn" id="close-login-modal" title="Close"><i class="ph-bold ph-x"></i></button>
        
        <!-- Classic Left-Aligned Brand Header -->
        <div class="access-brand" style="display: flex; align-items: center; gap: 12px; margin-bottom: 24px;">
          <img class="access-logo" src="${versionedAsset("assets/images/RMS_icon.svg")}" alt="RMS Logo" style="width: 48px; height: 48px; border-radius: 12px; object-fit: cover; box-shadow: 0 4px 12px rgba(0,0,0,0.06);" />
          <div style="text-align: left; line-height: 1.2;">
             <span class="eyebrow" style="color: var(--forest-600); font-size: 0.65rem; font-weight: 900; text-transform: uppercase; letter-spacing: 0.1em;">Platform Login</span>
             <strong style="display: block; font-size: 1.1rem; font-weight: 900; color: var(--forest-950);">RMS Cloud</strong>
          </div>
        </div>
        
        <h1 style="margin: 0 0 8px; font-size: 1.65rem; color: var(--forest-950); font-weight: 900; letter-spacing: -0.03em;">Welcome back</h1>
        <p style="color: var(--muted); margin: 0 0 28px; font-size: 0.85rem; line-height: 1.5;">Sign in to securely access your restaurant's Point of Sale and management dashboard.</p>
        
        <form id="staff-login-form" class="stack-form" style="display: flex; flex-direction: column; gap: 16px;">
          <label class="field">
             <span style="font-size: 0.8rem; font-weight: 800; color: var(--forest-800);">Email Address</span>
             <input class="field-input" id="staff-email" type="email" autocomplete="username" placeholder="manager@restaurant.com" required style="height: 48px; border-radius: 12px; background: var(--cream-50);" />
          </label>
          <label class="field">
             <span style="font-size: 0.8rem; font-weight: 800; color: var(--forest-800);">Password</span>
             <input class="field-input" id="staff-password" type="password" autocomplete="current-password" placeholder="••••••••" required style="height: 48px; border-radius: 12px; background: var(--cream-50);" />
          </label>
          
          <button class="btn btn-dark btn-large" type="submit" style="width: 100%; margin-top: 8px; border-radius: 14px; font-size: 1.05rem; height: 52px; box-shadow: 0 8px 24px rgba(18,34,22,0.15);">
             <i class="ph-bold ph-sign-in" style="font-size: 20px;"></i> Access POS
          </button>
          
          <div class="access-status" id="staff-status" style="text-align: center; margin-top: 10px; font-weight: 700; color: var(--forest-700); min-height: 20px; font-size: 0.85rem;"></div>
        </form>
      </div>
    </div>
  `;

  // --- INTERACTIVITY ---
  const modal = mount.querySelector("#login-modal");
  const emailInput = mount.querySelector("#staff-email");

  const openModal = () => { 
      modal.classList.add("active"); 
      setTimeout(() => emailInput.focus(), 100); 
  };
  const closeModal = () => modal.classList.remove("active");

  mount.querySelector("#hero-login-btn").addEventListener("click", openModal);
  mount.querySelector("#close-login-modal").addEventListener("click", closeModal);
  
  modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
  });

  // --- AUTH LOGIC ---
  const form = mount.querySelector("#staff-login-form");
  const status = mount.querySelector("#staff-status");

  form.addEventListener("submit", async event => {
    event.preventDefault();
    status.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i> Authenticating…`;
    
    const submitBtn = form.querySelector("button[type='submit']");
    submitBtn.disabled = true;

    try {
      const email = emailInput.value.trim();
      const password = mount.querySelector("#staff-password").value;
      
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (!data.session) throw new Error("Authentication failed.");
      
      status.innerHTML = `<i class="ph-bold ph-check" style="color: var(--success);"></i> Success!`;
      setTimeout(() => onLogin(), 400); 

    } catch (error) {
      submitBtn.disabled = false;
      status.textContent = "";
      showToast("Login failed", error.message, "error");
    }
  });

  return () => {};
}

// ==========================================
// TIER 2: ADMIN WORKSPACE UNLOCK (6-Digit PIN)
// ==========================================
export async function renderAdminLock({ mount, onUnlocked }) {
  // Securely pull the authenticated restaurant's custom branding from the active state
  const tenant = window.__ACTIVE_TENANT__ || {};
  const tenantName = tenant.name ? escapeHtml(tenant.name) : "RMS Workspace";
  const tenantIcon = tenant.icon_url ? versionedAsset(tenant.icon_url) : versionedAsset("assets/images/RMS_icon.svg");

  // V2 ENGINE: Safely checks PIN existence with explicit tenant ID
  const { data: hasPin } = await supabase.rpc("rms_check_pin_v2", { p_restaurant_id: tenant?.id || null });

  // Dynamically render either the "Setup" screen or the "Unlock" screen
  mount.innerHTML = `
    <section class="access-screen">
      <div class="access-card">
        <div class="access-brand">
          <img class="access-logo" src="${tenantIcon}" alt="Logo" style="border-radius: 12px; object-fit: cover;" />
          <div><span class="eyebrow">Manager workspace</span><strong>${tenantName}</strong></div>
        </div>
        
        ${!hasPin ? `
          <h1>Welcome to RMS</h1>
          <p class="access-copy">This is your first time logging in. Please create a 6-digit Master PIN to secure your Admin Dashboard.</p>
          <p id="admin-pin-error" style="color: var(--danger); font-size: 0.85rem; display: none; text-align: center; margin-bottom: 12px; font-weight: 800;"></p>
          <form id="admin-pin-form" class="stack-form" style="display: flex; flex-direction: column; gap: 14px;">
            <label class="field">
              <span style="font-size: 0.8rem; font-weight: 800; color: var(--forest-800);">Create 6-digit PIN</span>
              <div class="pin-box-container" id="admin-pin-container" style="gap: 8px; margin-bottom: 0;">
                 <input type="password" class="pin-box" maxlength="1" inputmode="numeric" placeholder="." autocomplete="off" style="width: 46px; height: 54px; font-size: 26px; font-family: 'Courier New', Courier, monospace;" autofocus />
                 <input type="password" class="pin-box" maxlength="1" inputmode="numeric" placeholder="." autocomplete="off" style="width: 46px; height: 54px; font-size: 26px; font-family: 'Courier New', Courier, monospace;" />
                 <input type="password" class="pin-box" maxlength="1" inputmode="numeric" placeholder="." autocomplete="off" style="width: 46px; height: 54px; font-size: 26px; font-family: 'Courier New', Courier, monospace;" />
                 <input type="password" class="pin-box" maxlength="1" inputmode="numeric" placeholder="." autocomplete="off" style="width: 46px; height: 54px; font-size: 26px; font-family: 'Courier New', Courier, monospace;" />
                 <input type="password" class="pin-box" maxlength="1" inputmode="numeric" placeholder="." autocomplete="off" style="width: 46px; height: 54px; font-size: 26px; font-family: 'Courier New', Courier, monospace;" />
                 <input type="password" class="pin-box" maxlength="1" inputmode="numeric" placeholder="." autocomplete="off" style="width: 46px; height: 54px; font-size: 26px; font-family: 'Courier New', Courier, monospace;" />
              </div>
            </label>
            <button class="btn btn-primary btn-large" type="submit" style="width: 100%; margin-top: 8px;"><i class="ph-bold ph-shield-check"></i> Set PIN & Continue</button>
        ` : `
          <h1>Secure admin access</h1>
          <p class="access-copy">Enter your 6-digit manager PIN to unlock the control centre.</p>
          <p id="admin-pin-error" style="color: var(--danger); font-size: 0.85rem; display: none; text-align: center; margin-bottom: 12px; font-weight: 800;"></p>
          <form id="admin-pin-form" class="stack-form" style="display: flex; flex-direction: column; gap: 14px;">
            <label class="field">
              <span style="font-size: 0.8rem; font-weight: 800; color: var(--forest-800);">6-digit PIN</span>
              <div class="pin-box-container" id="admin-pin-container" style="gap: 8px; margin-bottom: 0;">
                 <input type="password" class="pin-box" maxlength="1" inputmode="numeric" placeholder="." autocomplete="off" style="width: 46px; height: 54px; font-size: 26px; font-family: 'Courier New', Courier, monospace;" autofocus />
                 <input type="password" class="pin-box" maxlength="1" inputmode="numeric" placeholder="." autocomplete="off" style="width: 46px; height: 54px; font-size: 26px; font-family: 'Courier New', Courier, monospace;" />
                 <input type="password" class="pin-box" maxlength="1" inputmode="numeric" placeholder="." autocomplete="off" style="width: 46px; height: 54px; font-size: 26px; font-family: 'Courier New', Courier, monospace;" />
                 <input type="password" class="pin-box" maxlength="1" inputmode="numeric" placeholder="." autocomplete="off" style="width: 46px; height: 54px; font-size: 26px; font-family: 'Courier New', Courier, monospace;" />
                 <input type="password" class="pin-box" maxlength="1" inputmode="numeric" placeholder="." autocomplete="off" style="width: 46px; height: 54px; font-size: 26px; font-family: 'Courier New', Courier, monospace;" />
                 <input type="password" class="pin-box" maxlength="1" inputmode="numeric" placeholder="." autocomplete="off" style="width: 46px; height: 54px; font-size: 26px; font-family: 'Courier New', Courier, monospace;" />
              </div>
            </label>
            <button class="btn btn-dark btn-large" type="submit" style="width: 100%; margin-top: 8px;"><i class="ph-bold ph-lock-key"></i> Unlock workspace</button>
        `}
          <button class="btn btn-quiet" id="admin-back" type="button" style="width: 100%; margin-top: 8px;"><i class="ph-bold ph-arrow-left"></i> Return to POS</button>
          <div class="access-status" id="admin-status" style="text-align: center; margin-top: 10px; font-weight: 700; color: var(--forest-700);"></div>
        </form>
      </div>
    </section>`;

  const form = mount.querySelector("#admin-pin-form");
  const status = mount.querySelector("#admin-status");
  const errorMsg = mount.querySelector("#admin-pin-error");
  const boxContainer = mount.querySelector("#admin-pin-container");
  let inputs = Array.from(mount.querySelectorAll(".pin-box"));
  let isProcessing = false;

  function setupInputs(inputElements) {
      inputElements[0]?.focus();

      inputElements.forEach((input, index) => {
          input.addEventListener('input', (e) => {
              if (isProcessing) { e.target.value = ''; return; }
              e.target.value = e.target.value.replace(/[^0-9]/g, '');
              
              if (errorMsg) errorMsg.style.display = "none";
              status.textContent = "";

              if (e.target.value.length === 1) {
                  if (index < inputElements.length - 1) {
                      inputElements[index + 1].focus();
                  } else {
                      submitPin(inputElements);
                  }
              }
          });

          input.addEventListener('keydown', (e) => {
              if (isProcessing) return;
              if (e.key === 'Backspace' && e.target.value === '' && index > 0) {
                  inputElements[index - 1].focus();
                  inputElements[index - 1].value = '';
              } else if (e.key === 'Enter') {
                  e.preventDefault();
                  submitPin(inputElements);
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
                  if (pasteData.length >= 6) submitPin(inputElements);
              }
          });
      });
  }

  if (inputs.length) setupInputs(inputs);

  async function submitPin(currentInputs) {
      const pin = currentInputs.map(i => i.value).join("");
      if (pin.length < 6) return; // Wait for full code before auto-submitting

      isProcessing = true;
      currentInputs.forEach(i => i.disabled = true);
      status.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i> ${!hasPin ? "Securing Workspace…" : "Verifying PIN…"}`;
      
      const submitBtn = form.querySelector("button[type='submit']");
      if(submitBtn) submitBtn.disabled = true;

      try {
          if (!hasPin) {
              const { error } = await supabase.rpc("rms_set_pin_v2", { p_restaurant_id: tenant?.id || null, p_new_pin: pin });
              if (error) throw error;
              showToast("Workspace Secured", "Your master PIN has been saved.", "success");
              onUnlocked();
          } else {
              const { data, error } = await supabase.rpc("rms_verify_pin_v2", { p_restaurant_id: tenant?.id || null, p_pin: pin });
              if (error) throw error;
              if (data !== true) throw new Error("Invalid PIN or unauthorized.");
              onUnlocked();
          }
      } catch (error) {
          if(submitBtn) submitBtn.disabled = false;
          status.textContent = "";
          if (errorMsg) {
              errorMsg.textContent = !hasPin ? "Setup Failed: " + error.message : "Access Denied: " + error.message;
              errorMsg.style.display = "block";
          }
          
          // Trigger the 'falling' sequence
          currentInputs.forEach((i, idx) => {
              const delay = (5 - idx) * 60; 
              setTimeout(() => { 
                  i.classList.add("falling-out"); 
                  i.style.borderColor = "var(--danger)"; 
                  i.style.color = "var(--danger)"; 
              }, delay);
          });

          // Regenerate clean boxes from above
          setTimeout(() => {
              boxContainer.innerHTML = ''; 
              for(let i=0; i<6; i++) {
                  const newBox = document.createElement("input");
                  newBox.type = "password";
                  newBox.className = "pin-box dropping-in";
                  newBox.maxLength = 1;
                  newBox.inputMode = "numeric";
                  newBox.autocomplete = "off";
                  newBox.placeholder = ".";
                  newBox.style.cssText = "width: 46px; height: 54px; font-size: 26px; font-family: 'Courier New', Courier, monospace;";
                  newBox.style.animationDelay = `${i * 50}ms`; 
                  boxContainer.appendChild(newBox);
              }
              
              inputs = Array.from(mount.querySelectorAll("#admin-pin-container .pin-box"));
              setupInputs(inputs);
              isProcessing = false;
              
              setTimeout(() => {
                  inputs.forEach(i => i.classList.remove("dropping-in"));
                  inputs[0]?.focus();
              }, 500);

          }, 800);
      }
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    submitPin(inputs);
  });

  mount.querySelector("#admin-back").addEventListener("click", () => {
    history.pushState({}, "", location.pathname);
    location.hash = "";
    window.dispatchEvent(new Event("rms:navigate"));
  });

  return () => {};
}

export function clearAdminUnlock() { 
  // Maintained for backward compatibility
}