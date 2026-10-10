-- MyHR, part 2 (run after myhr_pay.sql):
--   * My Schedule: shifts managers schedule for staff (store_shifts)
--   * Personal information: contact details, address, emergency contact
--     (store_employee_details and store_employees)
--   * Clock-in status, so the POS can ask staff to clock in before working
-- Like part 1, everything goes through functions that work out who the
-- signed-in employee is and check roles.

-- ── Schedule ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.store_shifts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  employee_id uuid REFERENCES public.store_employees(id) ON DELETE CASCADE,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  note        text,
  created_by  uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_shifts_order CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS store_shifts_store_idx ON public.store_shifts(store_id, starts_at);
CREATE INDEX IF NOT EXISTS store_shifts_employee_idx ON public.store_shifts(employee_id, starts_at);
ALTER TABLE public.store_shifts ENABLE ROW LEVEL SECURITY;

-- My shifts in a date range.
CREATE OR REPLACE FUNCTION public.myhr_my_schedule(p_store_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (id uuid, starts_at timestamptz, ends_at timestamptz, note text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.starts_at, s.ends_at, s.note FROM public.store_shifts s
   WHERE s.employee_id = public.myhr_employee_id(p_store_id)
     AND s.starts_at < p_to AND s.ends_at > p_from
   ORDER BY s.starts_at
$$;

-- Managers: the store's active staff (for scheduling).
CREATE OR REPLACE FUNCTION public.myhr_store_staff(p_store_id uuid)
RETURNS TABLE (id uuid, name text, role text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can see the store''s staff.'; END IF;
  RETURN QUERY
  SELECT e.id, COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username, 'Employee'), e.role
    FROM public.store_employees e
   WHERE COALESCE(e.store_id, p_store_id) = p_store_id AND e.status = 'active'
   ORDER BY 2;
END $$;

-- Managers: everyone's shifts in a date range.
CREATE OR REPLACE FUNCTION public.myhr_store_schedule(p_store_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (id uuid, employee_id uuid, employee_name text, starts_at timestamptz, ends_at timestamptz, note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can see the store schedule.'; END IF;
  RETURN QUERY
  SELECT s.id, s.employee_id,
         COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username, 'Employee'),
         s.starts_at, s.ends_at, s.note
    FROM public.store_shifts s
    JOIN public.store_employees e ON e.id = s.employee_id
   WHERE s.store_id = p_store_id AND s.starts_at < p_to AND s.ends_at > p_from
   ORDER BY s.starts_at, 3;
END $$;

-- Managers: add a shift.
CREATE OR REPLACE FUNCTION public.myhr_add_shift(p_store_id uuid, p_employee_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_note text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can schedule shifts.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_employees e WHERE e.id = p_employee_id AND COALESCE(e.store_id, p_store_id) = p_store_id AND e.status = 'active') THEN
    RAISE EXCEPTION 'That employee isn''t active at this store.';
  END IF;
  INSERT INTO public.store_shifts (store_id, employee_id, starts_at, ends_at, note, created_by)
  VALUES (p_store_id, p_employee_id, p_starts_at, p_ends_at, NULLIF(btrim(p_note), ''), public.myhr_employee_id(p_store_id))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Managers: remove a shift.
CREATE OR REPLACE FUNCTION public.myhr_delete_shift(p_store_id uuid, p_shift_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can change the schedule.'; END IF;
  DELETE FROM public.store_shifts WHERE id = p_shift_id AND store_id = p_store_id;
END $$;

-- ── Personal information ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.store_employee_details (
  employee_id            uuid PRIMARY KEY REFERENCES public.store_employees(id) ON DELETE CASCADE,
  phone                  text,
  contact_email          text,
  address_line1          text,
  address_line2          text,
  city                   text,
  province               text,
  postal_code            text,
  emergency_name         text,
  emergency_relationship text,
  emergency_phone        text,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.store_employee_details
  ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE public.store_employee_details ENABLE ROW LEVEL SECURITY;

-- My personal and job information.
CREATE OR REPLACE FUNCTION public.myhr_my_details(p_store_id uuid)
RETURNS TABLE (
  first_name text, last_name text, email text, username text, role text, status text,
  employee_since timestamptz, store_name text,
  phone text, address_line1 text, address_line2 text, city text, province text, postal_code text,
  emergency_name text, emergency_relationship text, emergency_phone text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.first_name, e.last_name, d.contact_email, e.username, e.role, e.status, e.created_at, st.store_name,
         d.phone, d.address_line1, d.address_line2, d.city, d.province, d.postal_code,
         d.emergency_name, d.emergency_relationship, d.emergency_phone
    FROM public.store_employees e
    LEFT JOIN public.stores st ON st.id = p_store_id
    LEFT JOIN public.store_employee_details d ON d.employee_id = e.id
   WHERE e.id = public.myhr_employee_id(p_store_id)
$$;

-- Save my contact details / address / emergency contact (only the keys given change).
CREATE OR REPLACE FUNCTION public.myhr_save_details(p_store_id uuid, p_details jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid := public.myhr_employee_id(p_store_id);
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'You are not an active employee of this store.'; END IF;

  INSERT INTO public.store_employee_details (employee_id) VALUES (v_emp) ON CONFLICT (employee_id) DO NOTHING;
  UPDATE public.store_employee_details SET
    phone                  = CASE WHEN p_details ? 'phone' THEN NULLIF(btrim(p_details->>'phone'), '') ELSE phone END,
    contact_email          = CASE WHEN p_details ? 'email' THEN NULLIF(btrim(p_details->>'email'), '') ELSE contact_email END,
    address_line1          = CASE WHEN p_details ? 'address_line1' THEN NULLIF(btrim(p_details->>'address_line1'), '') ELSE address_line1 END,
    address_line2          = CASE WHEN p_details ? 'address_line2' THEN NULLIF(btrim(p_details->>'address_line2'), '') ELSE address_line2 END,
    city                   = CASE WHEN p_details ? 'city' THEN NULLIF(btrim(p_details->>'city'), '') ELSE city END,
    province               = CASE WHEN p_details ? 'province' THEN NULLIF(btrim(p_details->>'province'), '') ELSE province END,
    postal_code            = CASE WHEN p_details ? 'postal_code' THEN NULLIF(btrim(p_details->>'postal_code'), '') ELSE postal_code END,
    emergency_name         = CASE WHEN p_details ? 'emergency_name' THEN NULLIF(btrim(p_details->>'emergency_name'), '') ELSE emergency_name END,
    emergency_relationship = CASE WHEN p_details ? 'emergency_relationship' THEN NULLIF(btrim(p_details->>'emergency_relationship'), '') ELSE emergency_relationship END,
    emergency_phone        = CASE WHEN p_details ? 'emergency_phone' THEN NULLIF(btrim(p_details->>'emergency_phone'), '') ELSE emergency_phone END,
    updated_at             = now()
  WHERE employee_id = v_emp;
END $$;

-- ── Clock-in status (for the POS's "clock in first") ────────────────────────
-- is_employee: the signed-in user is an active employee of this store (only
-- they are asked to clock in). clocked_in_at: their open shift, or null.
CREATE OR REPLACE FUNCTION public.myhr_clock_status(p_store_id uuid)
RETURNS TABLE (is_employee boolean, clocked_in_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.myhr_employee_id(p_store_id) IS NOT NULL,
         (SELECT t.clock_in FROM public.store_time_entries t
           WHERE t.employee_id = public.myhr_employee_id(p_store_id) AND t.clock_out IS NULL
           ORDER BY t.clock_in DESC LIMIT 1)
$$;

GRANT EXECUTE ON FUNCTION public.myhr_my_schedule(uuid, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_store_staff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_store_schedule(uuid, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_add_shift(uuid, uuid, timestamptz, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_delete_shift(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_my_details(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_save_details(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_clock_status(uuid) TO authenticated;
