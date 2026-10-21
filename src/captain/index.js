// TableForge — Captain workspace entry point.
//
// Reuses the existing POS engine while explicitly selecting
// Captain mode. Captain-specific behavior is enforced in that
// engine, and this route remains behind the panel PIN gate.

import { render as renderPOS } from "../pos/index.js";

export async function render(context) {
  return renderPOS({
    ...context,
    route: {
      ...(context.route || {}),
      name: "captain",
      panelId: "captain"
    }
  });
}