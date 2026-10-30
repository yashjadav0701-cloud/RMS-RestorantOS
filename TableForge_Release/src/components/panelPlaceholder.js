import { getPanelDefinition } from "../core/panelRegistry.js";

export async function render({ mount, route }) {
  const panel = getPanelDefinition(route?.panelId);

  if (!panel || panel.id === "admin") {
    throw new Error("Invalid placeholder workspace.");
  }

  mount.innerHTML = `
    <section class="access-screen">
      <div class="access-card" style="text-align: center;">
        <div class="access-brand" style="justify-content: center;">
          <div
            class="access-logo"
            style="display: grid; place-items: center; color: var(--forest-900);"
          >
            <i class="ph-bold ${panel.icon}" style="font-size: 28px;"></i>
          </div>
        </div>

        <h1>${panel.title} workspace</h1>

        <p class="access-copy">
          ${panel.description}
        </p>

        <p class="access-copy">
          This workspace has been registered in the new routing architecture,
          but its operational screen and panel-specific PIN verification
          have not been connected yet. No operational controls are exposed
          here.
        </p>

        <button
          type="button"
          class="btn btn-primary btn-large"
          data-return-workspaces
          style="width: 100%; justify-content: center;"
        >
          <i class="ph-bold ph-arrow-left"></i>
          Return to workspaces
        </button>
      </div>
    </section>
  `;

  const returnButton = mount.querySelector("[data-return-workspaces]");

  const goBack = () => {
    history.pushState(
      {},
      "",
      `${location.pathname}${location.search}#/panels`
    );

    window.dispatchEvent(new Event("rms:navigate"));
  };

  returnButton.addEventListener("click", goBack);

  return () => {
    returnButton.removeEventListener("click", goBack);
  };
}