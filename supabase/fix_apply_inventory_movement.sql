-- Fix: removing stock through apply_inventory_movement always failed with
--   new row for relation "store_inventory_quantities" violates check
--   constraint "store_inventory_quantities_nonnegative_check"
--
-- The function used INSERT ... ON CONFLICT DO UPDATE. Postgres checks CHECK
-- constraints on the row being inserted *before* it notices the conflict, so
-- a negative change (e.g. -1) was rejected as a new row with quantity -1 even
-- when the location held plenty of stock.
--
-- Now the existing row is updated first; a new row is only inserted when the
-- item has no stock row at that location yet (and then only for additions).
-- Same signature, same permission checks, same ledger entry.

CREATE OR REPLACE FUNCTION public.apply_inventory_movement(
  p_inventory_id   uuid,
  p_location_id    uuid,
  p_quantity_change integer,
  p_movement_type  text,
  p_reason         text DEFAULT NULL,
  p_transaction_id uuid DEFAULT NULL
) RETURNS integer  -- returns the new on-hand at that location
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_store_id   uuid;
  v_employee   uuid;
  v_new_qty    integer;
BEGIN
  SELECT store_id INTO v_store_id FROM public.store_inventory WHERE id = p_inventory_id;
  IF v_store_id IS NULL THEN RAISE EXCEPTION 'inventory item % not found', p_inventory_id; END IF;
  IF v_store_id NOT IN (SELECT public.user_store_ids()) THEN
    RAISE EXCEPTION 'not authorised for store %', v_store_id;
  END IF;

  SELECT e.id INTO v_employee FROM public.store_employees e
    JOIN public.stores s ON s.owner_user_id = e.store_owner_id
   WHERE s.id = v_store_id AND e.employee_user_id = auth.uid()
   LIMIT 1;

  INSERT INTO public.store_inventory_movements
    (store_id, inventory_id, location_id, quantity_change, movement_type, transaction_id, employee_id, reason)
  VALUES
    (v_store_id, p_inventory_id, p_location_id, p_quantity_change, p_movement_type, p_transaction_id, v_employee, p_reason);

  UPDATE public.store_inventory_quantities
     SET quantity = quantity + p_quantity_change,
         updated_at = now()
   WHERE inventory_id = p_inventory_id
     AND location_id = p_location_id
  RETURNING quantity INTO v_new_qty;

  IF NOT FOUND THEN
    IF p_quantity_change < 0 THEN
      RAISE EXCEPTION 'Not enough stock at this location to remove %.', -p_quantity_change;
    END IF;
    INSERT INTO public.store_inventory_quantities (store_id, inventory_id, location_id, quantity)
    VALUES (v_store_id, p_inventory_id, p_location_id, p_quantity_change)
    ON CONFLICT (inventory_id, location_id)
    DO UPDATE SET quantity = public.store_inventory_quantities.quantity + EXCLUDED.quantity,
                  updated_at = now()
    RETURNING quantity INTO v_new_qty;
  END IF;

  RETURN v_new_qty;
END $$;

GRANT EXECUTE ON FUNCTION public.apply_inventory_movement(uuid,uuid,integer,text,text,uuid) TO authenticated;
