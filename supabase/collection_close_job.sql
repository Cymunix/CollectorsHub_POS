-- Collection Drop-Off: close a job that is Ready for collection when the store
-- never recorded holding the collection ("Confirm handover" was skipped), so
-- there is nothing to return. Same function as in collection_scanning.sql;
-- run this file on its own to add it.
CREATE OR REPLACE FUNCTION public.cs_close_job(p_job_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.collection_intake_jobs;
BEGIN
  j := public.cs_staff_job(p_job_id);
  IF j.status <> 'ready_for_collection' THEN RAISE EXCEPTION 'Only a job that is ready for collection can be closed.'; END IF;
  IF j.custody_status IN ('in_store', 'partially_returned') THEN RAISE EXCEPTION 'The store still holds this collection: record the return instead.'; END IF;
  UPDATE public.collection_intake_jobs SET status = 'completed', completed_at = now() WHERE id = j.id;
  UPDATE public.collection_scan_authorisations SET status = 'completed' WHERE job_id = j.id AND status = 'approved';
  PERFORM public.cs_log(j.id, 'employee', 'job_closed', jsonb_build_object('custody', j.custody_status), public.myhr_employee_id(j.store_id));
END $$;
REVOKE ALL ON FUNCTION public.cs_close_job(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cs_close_job(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';
