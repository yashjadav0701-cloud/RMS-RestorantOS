-- TableForge GSTIN one-time lock patch.
-- Run in the correct Supabase project after MASTER_MIGRATION_TABLEFORGE.sql.
-- This patch is tenant-neutral and safe to rerun. It does not expose an override RPC.

BEGIN;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS gst_number text,
  ADD COLUMN IF NOT EXISTS gst_number_locked_at timestamptz;

-- Replace any prior trigger before normalizing legacy values, avoiding conflicts
-- with an older trigger version while this patch is being applied.
DROP TRIGGER IF EXISTS trg_tableforge_gst_number_once ON public.app_settings;

UPDATE public.app_settings
SET gst_number = upper(btrim(gst_number)),
    gst_number_locked_at = COALESCE(gst_number_locked_at, now())
WHERE NULLIF(btrim(gst_number), '') IS NOT NULL
  AND (gst_number IS DISTINCT FROM upper(btrim(gst_number)) OR gst_number_locked_at IS NULL);

CREATE OR REPLACE FUNCTION public._tableforge_guard_gst_number_once()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
  v_old text;
  v_new text := NULLIF(upper(btrim(COALESCE(NEW.gst_number, ''))), '');
  v_override text := COALESCE(current_setting('tableforge.allow_gst_override', true), '');
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old := NULLIF(upper(btrim(COALESCE(OLD.gst_number, ''))), '');
  ELSE
    v_old := NULL;
  END IF;

  NEW.gst_number := v_new;

  IF TG_OP = 'UPDATE'
     AND v_old IS NOT NULL
     AND v_new IS DISTINCT FROM v_old
     AND v_override <> 'on' THEN
    RAISE EXCEPTION 'GSTIN is locked after its first save. Contact the developer for an authorized change or removal.';
  END IF;

  -- Existing legacy values may be preserved unchanged while other settings are
  -- updated. New values, and any authorized replacements, must match GSTIN format.
  IF v_new IS NOT NULL
     AND v_new !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
     AND (TG_OP <> 'UPDATE' OR v_new IS DISTINCT FROM v_old) THEN
    RAISE EXCEPTION 'Enter a valid 15-character GSTIN before saving.';
  END IF;

  IF v_new IS NULL THEN
    NEW.gst_number_locked_at := NULL;
  ELSIF TG_OP <> 'UPDATE' OR v_old IS NULL OR v_override = 'on' THEN
    NEW.gst_number_locked_at := COALESCE(NEW.gst_number_locked_at, now());
  ELSE
    NEW.gst_number_locked_at := COALESCE(OLD.gst_number_locked_at, NEW.gst_number_locked_at, now());
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_tableforge_gst_number_once
BEFORE INSERT OR UPDATE OF gst_number ON public.app_settings
FOR EACH ROW EXECUTE FUNCTION public._tableforge_guard_gst_number_once();

REVOKE ALL ON FUNCTION public._tableforge_guard_gst_number_once() FROM PUBLIC, anon, authenticated;
COMMENT ON COLUMN public.app_settings.gst_number IS
  'One-time-set GSTIN. Restaurant Admin cannot alter/remove it after initial save; authorized developer maintenance only.';
COMMENT ON COLUMN public.app_settings.gst_number_locked_at IS
  'Timestamp when this GSTIN was first saved or developer-authorized change was made.';

-- Authorized developer-only correction example (run in a controlled SQL session):
-- BEGIN;
-- SET LOCAL tableforge.allow_gst_override = 'on';
-- UPDATE public.app_settings SET gst_number = '<VERIFIED_15_CHARACTER_GSTIN>'
-- WHERE restaurant_id = '<RESTAURANT_UUID>'::uuid;
-- COMMIT;

COMMIT;
