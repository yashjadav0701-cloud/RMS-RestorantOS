// Shared reporting-period control used by Admin reports.
// Date-only values are anchored to India (Asia/Kolkata) so every panel uses
// the restaurant calendar even if a device has a different system time zone.

const PRESETS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" }
];

export function localDateString(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function createPresetRange(preset = "today", now = new Date()) {
  // Use India local calendar days for all restaurant reports regardless of the
  // computer's configured time zone.
  const indiaNow = new Date(now.getTime() + 330 * 60 * 1000);
  const today = new Date(Date.UTC(indiaNow.getUTCFullYear(), indiaNow.getUTCMonth(), indiaNow.getUTCDate()));
  if (preset === "all") return { preset: "all", startDate: "", endDate: "" };

  let start = new Date(today);
  let end = new Date(today);
  if (preset === "yesterday") {
    start.setUTCDate(start.getUTCDate() - 1);
    end = new Date(start);
  } else if (preset === "7") {
    start.setUTCDate(start.getUTCDate() - 6);
  } else if (preset === "30") {
    start.setUTCDate(start.getUTCDate() - 29);
  } else if (preset === "90") {
    start.setUTCDate(start.getUTCDate() - 89);
  } else if (preset === "month") {
    start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  } else {
    preset = "today";
  }

  return { preset, startDate: localDateString(start), endDate: localDateString(end) };
}

export function normalizeDateRange(value) {
  if (!value || typeof value !== "object") return createPresetRange("today");
  const preset = String(value.preset || "custom");
  const startDate = String(value.startDate || "");
  const endDate = String(value.endDate || "");
  if (preset === "all" && !startDate && !endDate) return { preset: "all", startDate: "", endDate: "" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate) && startDate <= endDate) {
    return { preset, startDate, endDate };
  }
  return createPresetRange("today");
}

export function dateRangeLabel(range) {
  const value = normalizeDateRange(range);
  if (value.preset === "all") return "All time";
  const format = date => new Date(`${date}T12:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  if (value.startDate === value.endDate) return format(value.startDate);
  return `${format(value.startDate)} – ${format(value.endDate)}`;
}

export function indiaDateStartISOString(dateValue) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateValue || ""))) throw new Error("Invalid start date.");
  return new Date(`${dateValue}T00:00:00+05:30`).toISOString();
}

export function indiaDateAfterISOString(dateValue) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateValue || ""))) throw new Error("Invalid end date.");
  const [year, month, day] = dateValue.split("-").map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  const yyyy = nextDate.getUTCFullYear();
  const mm = String(nextDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(nextDate.getUTCDate()).padStart(2, "0");
  return new Date(`${yyyy}-${mm}-${dd}T00:00:00+05:30`).toISOString();
}

export function dateRangeToServerPeriod(range) {
  const value = normalizeDateRange(range);
  if (value.preset === "all") return "all";
  return `range:${value.startDate}:${value.endDate}`;
}

export function renderDateRangePicker(prefix, range) {
  const value = normalizeDateRange(range);
  const escapedPrefix = String(prefix).replace(/[^a-z0-9_-]/gi, "");
  return `
    <section class="tf-date-range" data-date-range="${escapedPrefix}" aria-label="Reporting date range">
      <div class="tf-date-presets" role="group" aria-label="Quick date ranges">
        ${PRESETS.map(item => `
          <button type="button" class="tf-date-preset ${value.preset === item.value ? "active" : ""}" data-date-preset="${item.value}" aria-pressed="${value.preset === item.value}">${item.label}</button>
        `).join("")}
      </div>
      <div class="tf-date-fields">
        <label><span>From</span><input type="date" data-date-start value="${value.startDate}" aria-label="Start date"></label>
        <span class="tf-date-to" aria-hidden="true">to</span>
        <label><span>To</span><input type="date" data-date-end value="${value.endDate}" aria-label="End date"></label>
        <button type="button" class="tf-date-apply" data-date-apply>Apply range</button>
        <button type="button" class="tf-date-reset" data-date-reset>Reset</button>
      </div>
      <p class="tf-date-error" data-date-error role="alert" hidden></p>
      <p class="tf-date-caption" data-date-caption>${dateRangeLabel(value)}</p>
    </section>
  `;
}

export function bindDateRangePicker(root, prefix, initialRange, onChange) {
  const container = root.querySelector(`[data-date-range="${String(prefix).replace(/[^a-z0-9_-]/gi, "")}"]`);
  if (!container) return () => {};

  let current = normalizeDateRange(initialRange);
  const startInput = container.querySelector("[data-date-start]");
  const endInput = container.querySelector("[data-date-end]");
  const errorNode = container.querySelector("[data-date-error]");
  const caption = container.querySelector("[data-date-caption]");

  function paint(next) {
    current = normalizeDateRange(next);
    startInput.value = current.startDate;
    endInput.value = current.endDate;
    container.querySelectorAll("[data-date-preset]").forEach(button => {
      const active = button.dataset.datePreset === current.preset;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    caption.textContent = dateRangeLabel(current);
    errorNode.hidden = true;
    errorNode.textContent = "";
  }

  const selectPreset = event => {
    const button = event.target.closest("[data-date-preset]");
    if (!button) return;
    const next = createPresetRange(button.dataset.datePreset);
    paint(next);
    onChange?.(next);
  };
  const applyRange = () => {
    const startDate = startInput.value;
    const endDate = endInput.value;
    if (!startDate && !endDate && current.preset === "all") {
      onChange?.(current);
      return;
    }
    if (!startDate || !endDate) {
      errorNode.textContent = "Select both a start date and an end date, or choose All time.";
      errorNode.hidden = false;
      return;
    }
    if (startDate > endDate) {
      errorNode.textContent = "The end date must be on or after the start date.";
      errorNode.hidden = false;
      return;
    }
    const next = { preset: "custom", startDate, endDate };
    paint(next);
    onChange?.(next);
  };
  const reset = () => {
    const next = createPresetRange("today");
    paint(next);
    onChange?.(next);
  };

  container.addEventListener("click", selectPreset);
  container.querySelector("[data-date-apply]")?.addEventListener("click", applyRange);
  container.querySelector("[data-date-reset]")?.addEventListener("click", reset);
  [startInput, endInput].forEach(input => input.addEventListener("change", () => {
    container.querySelectorAll("[data-date-preset]").forEach(button => {
      button.classList.remove("active");
      button.setAttribute("aria-pressed", "false");
    });
    current = { preset: "custom", startDate: startInput.value, endDate: endInput.value };
  }));

  return () => {
    container.removeEventListener("click", selectPreset);
    container.querySelector("[data-date-apply]")?.removeEventListener("click", applyRange);
    container.querySelector("[data-date-reset]")?.removeEventListener("click", reset);
  };
}

export const DATE_RANGE_STYLES = `
  .tf-date-range { display:grid; gap:10px; margin:0 0 16px; min-width:0; }
  .tf-date-presets { display:flex; align-items:center; flex-wrap:wrap; gap:6px; }
  .tf-date-preset { min-height:34px; padding:0 11px; border:1px solid var(--line); border-radius:10px; background:var(--paper); color:var(--forest-800); font:inherit; font-size:12px; font-weight:750; cursor:pointer; }
  .tf-date-preset.active { border-color:var(--sage-200); background:var(--sage-100); color:var(--forest-950); }
  .tf-date-fields { display:flex; flex-wrap:wrap; align-items:end; gap:8px; }
  .tf-date-fields label { display:grid; gap:5px; color:var(--muted); font-size:11px; font-weight:800; }
  .tf-date-fields input { min-height:37px; box-sizing:border-box; padding:0 9px; border:1px solid var(--line); border-radius:9px; background:var(--paper); color:var(--forest-950); font:inherit; font-size:12px; }
  .tf-date-to { padding-bottom:10px; color:var(--muted); font-size:12px; }
  .tf-date-apply,.tf-date-reset { min-height:37px; padding:0 12px; border:1px solid var(--line); border-radius:9px; background:var(--paper); color:var(--forest-900); font:inherit; font-size:12px; font-weight:800; cursor:pointer; }
  .tf-date-apply { border-color:var(--forest-900); background:var(--forest-900); color:#fff; }
  .tf-date-error { margin:0; color:var(--danger); font-size:12px; font-weight:700; }
  .tf-date-caption { margin:0; color:var(--muted); font-size:11px; }
  .tf-date-preset:focus-visible,.tf-date-fields input:focus-visible,.tf-date-apply:focus-visible,.tf-date-reset:focus-visible { outline:3px solid var(--sage-300); outline-offset:2px; }
  @media(max-width:600px) { .tf-date-fields { align-items:stretch; } .tf-date-fields label { flex:1 1 135px; } .tf-date-to { display:none; } .tf-date-apply,.tf-date-reset { flex:1 1 auto; } }
`;
