-- MyHR, part 3 (run after myhr_schedule_profile.sql): the full Personal Data
-- and Addresses screens, and Family Related Data (family members /
-- dependents). Adds name, marital status, birth, address and other personal
-- fields to the employee's own details, and a personnel number for every
-- employee (assigned automatically, read-only for staff).
--
-- Only the employee can read or change these, through the functions below;
-- there is no direct table access.

ALTER TABLE public.store_employee_details
  ADD COLUMN IF NOT EXISTS form_of_address text,
  ADD COLUMN IF NOT EXISTS middle_name     text,
  ADD COLUMN IF NOT EXISTS initials        text,
  ADD COLUMN IF NOT EXISTS known_as        text,
  ADD COLUMN IF NOT EXISTS marital_status  text,
  ADD COLUMN IF NOT EXISTS marital_since   date,
  ADD COLUMN IF NOT EXISTS date_of_birth   date,
  ADD COLUMN IF NOT EXISTS gender          text,
  ADD COLUMN IF NOT EXISTS language        text,
  ADD COLUMN IF NOT EXISTS nationality     text,
  ADD COLUMN IF NOT EXISTS country         text,
  ADD COLUMN IF NOT EXISTS care_of         text,
  ADD COLUMN IF NOT EXISTS phone_area      text;

-- Personnel numbers: 4000001, 4000002, … (every existing employee gets one now,
-- new employees on creation).
CREATE SEQUENCE IF NOT EXISTS public.store_personnel_number_seq START WITH 4000001;
ALTER TABLE public.store_employees ADD COLUMN IF NOT EXISTS personnel_number text;
UPDATE public.store_employees
   SET personnel_number = nextval('public.store_personnel_number_seq')::text
 WHERE personnel_number IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS store_employees_personnel_number_idx ON public.store_employees(personnel_number);

CREATE OR REPLACE FUNCTION public.trg_store_employee_personnel_number()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.personnel_number IS NULL THEN
    NEW.personnel_number := nextval('public.store_personnel_number_seq')::text;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS store_employee_personnel_number ON public.store_employees;
CREATE TRIGGER store_employee_personnel_number
  BEFORE INSERT ON public.store_employees
  FOR EACH ROW EXECUTE FUNCTION public.trg_store_employee_personnel_number();

-- My personal and job information (replaces part 2's version: more fields).
DROP FUNCTION IF EXISTS public.myhr_my_details(uuid);
CREATE FUNCTION public.myhr_my_details(p_store_id uuid)
RETURNS TABLE (
  first_name text, last_name text, email text, username text, role text, status text,
  employee_since timestamptz, store_name text, personnel_number text,
  phone text, address_line1 text, address_line2 text, city text, province text, postal_code text,
  emergency_name text, emergency_relationship text, emergency_phone text,
  form_of_address text, middle_name text, initials text, known_as text,
  marital_status text, marital_since date, date_of_birth date, gender text, language text, nationality text,
  country text, care_of text, phone_area text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.first_name, e.last_name, e.email, e.username, e.role, e.status, e.created_at, st.store_name, e.personnel_number,
         d.phone, d.address_line1, d.address_line2, d.city, d.province, d.postal_code,
         d.emergency_name, d.emergency_relationship, d.emergency_phone,
         d.form_of_address, d.middle_name, d.initials, d.known_as,
         d.marital_status, d.marital_since, d.date_of_birth, d.gender, d.language, d.nationality,
         d.country, d.care_of, d.phone_area
    FROM public.store_employees e
    LEFT JOIN public.stores st ON st.id = p_store_id
    LEFT JOIN public.store_employee_details d ON d.employee_id = e.id
   WHERE e.id = public.myhr_employee_id(p_store_id)
$$;
GRANT EXECUTE ON FUNCTION public.myhr_my_details(uuid) TO authenticated;

-- Save my details (only the keys given change). First and last name are
-- required whenever they're given and update the employee record itself.
CREATE OR REPLACE FUNCTION public.myhr_save_details(p_store_id uuid, p_details jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_emp uuid := public.myhr_employee_id(p_store_id);
  v_text text[] := ARRAY['phone','address_line1','address_line2','city','province','postal_code',
                         'emergency_name','emergency_relationship','emergency_phone',
                         'form_of_address','middle_name','initials','known_as',
                         'marital_status','gender','language','nationality','country','care_of','phone_area'];
  v_key text;
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'You are not an active employee of this store.'; END IF;

  IF p_details ? 'first_name' OR p_details ? 'last_name' THEN
    IF (p_details ? 'first_name' AND COALESCE(btrim(p_details->>'first_name'), '') = '')
       OR (p_details ? 'last_name' AND COALESCE(btrim(p_details->>'last_name'), '') = '') THEN
      RAISE EXCEPTION 'First and last name are required.';
    END IF;
    UPDATE public.store_employees SET
      first_name = CASE WHEN p_details ? 'first_name' THEN btrim(p_details->>'first_name') ELSE first_name END,
      last_name  = CASE WHEN p_details ? 'last_name' THEN btrim(p_details->>'last_name') ELSE last_name END
    WHERE id = v_emp;
  END IF;

  INSERT INTO public.store_employee_details (employee_id) VALUES (v_emp) ON CONFLICT (employee_id) DO NOTHING;
  FOREACH v_key IN ARRAY v_text LOOP
    IF p_details ? v_key THEN
      EXECUTE format('UPDATE public.store_employee_details SET %I = $1 WHERE employee_id = $2', v_key)
        USING NULLIF(btrim(p_details->>v_key), ''), v_emp;
    END IF;
  END LOOP;
  IF p_details ? 'date_of_birth' THEN
    UPDATE public.store_employee_details SET date_of_birth = NULLIF(p_details->>'date_of_birth', '')::date WHERE employee_id = v_emp;
  END IF;
  IF p_details ? 'marital_since' THEN
    UPDATE public.store_employee_details SET marital_since = NULLIF(p_details->>'marital_since', '')::date WHERE employee_id = v_emp;
  END IF;
  UPDATE public.store_employee_details SET updated_at = now() WHERE employee_id = v_emp;
END $$;
GRANT EXECUTE ON FUNCTION public.myhr_save_details(uuid, jsonb) TO authenticated;

-- ── Family Related Data: family members / dependents ────────────────────────
CREATE TABLE IF NOT EXISTS public.store_employee_family (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES public.store_employees(id) ON DELETE CASCADE,
  relationship  text NOT NULL,
  name          text NOT NULL,
  date_of_birth date,
  gender        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_employee_family_employee_idx ON public.store_employee_family(employee_id);
ALTER TABLE public.store_employee_family ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.myhr_my_family(p_store_id uuid)
RETURNS TABLE (id uuid, relationship text, name text, date_of_birth date, gender text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.id, f.relationship, f.name, f.date_of_birth, f.gender
    FROM public.store_employee_family f
   WHERE f.employee_id = public.myhr_employee_id(p_store_id)
   ORDER BY f.created_at
$$;

-- Add (p_id null) or update one of my family members.
CREATE OR REPLACE FUNCTION public.myhr_save_family_member(p_store_id uuid, p_id uuid, p_relationship text, p_name text, p_date_of_birth date, p_gender text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid := public.myhr_employee_id(p_store_id); v_id uuid;
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'You are not an active employee of this store.'; END IF;
  IF COALESCE(btrim(p_name), '') = '' OR COALESCE(btrim(p_relationship), '') = '' THEN
    RAISE EXCEPTION 'Relationship and name are required.';
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.store_employee_family (employee_id, relationship, name, date_of_birth, gender)
    VALUES (v_emp, btrim(p_relationship), btrim(p_name), p_date_of_birth, NULLIF(btrim(p_gender), ''))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.store_employee_family
       SET relationship = btrim(p_relationship), name = btrim(p_name), date_of_birth = p_date_of_birth, gender = NULLIF(btrim(p_gender), '')
     WHERE id = p_id AND employee_id = v_emp
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'That family member wasn''t found.'; END IF;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.myhr_delete_family_member(p_store_id uuid, p_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM public.store_employee_family WHERE id = p_id AND employee_id = public.myhr_employee_id(p_store_id)
$$;

GRANT EXECUTE ON FUNCTION public.myhr_my_family(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_save_family_member(uuid, uuid, text, text, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_delete_family_member(uuid, uuid) TO authenticated;
