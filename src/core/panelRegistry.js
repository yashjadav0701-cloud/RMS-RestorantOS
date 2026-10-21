// TableForge workspace registry.
//
// This file controls presentation and navigation only.
// It is NOT an authorization or security boundary.
// Permissions will be enforced by the verified backend.

export const PANEL_REGISTRY = Object.freeze([
  Object.freeze({
    id: "captain",
    title: "Captain",
    subtitle: "Dine-in service",
    description:
      "Manage dining tables, create dine-in orders, add rounds, monitor food progress, and request bills.",
    icon: "ph-armchair",
    route: "#/panel/captain"
  }),

  Object.freeze({
    id: "kot",
    title: "KOT / Kitchen",
    subtitle: "Kitchen operations",
    description:
      "View active kitchen tickets, update preparation progress, and handle authorized cancellation notices.",
    icon: "ph-chef-hat",
    route: "#/panel/kot"
  }),

  Object.freeze({
    id: "cashier",
    title: "Cashier",
    subtitle: "Takeaway and billing",
    description:
      "Create takeaway orders, receive bill requests, generate receipts, and manage permitted payment operations.",
    icon: "ph-receipt",
    route: "#/panel/cashier"
  }),

  Object.freeze({
    id: "manager",
    title: "Manager",
    subtitle: "Operational supervision",
    description:
      "Supervise and manage ordinary restaurant operations without access to restaurant configuration.",
    icon: "ph-chart-line-up",
    route: "#/panel/manager"
  }),

  Object.freeze({
    id: "admin",
    title: "Admin",
    subtitle: "Business control centre",
    description:
      "Manage restaurant configuration, permissions, inventory, reporting, operational overrides, and business intelligence.",
    icon: "ph-shield-check",
    route: "#/panel/admin"
  })
]);

export function getPanelDefinition(panelId) {
  const id = String(panelId ?? "").trim().toLowerCase();

  return PANEL_REGISTRY.find(panel => panel.id === id) ?? null;
}