-- DEVELOPMENT / TESTING ONLY: make the existing account "JoeTest" the
-- reference customer for the NORDVIK Identity interface, as Demo Verified.
-- (The account's username is TestJoe; JoeTest is accepted too.)
--
-- Run after nordvik_identity.sql and buyback_identification.sql. Rerunnable.
--
-- What it does:
--   * Finds the existing JoeTest account (never creates one; changes no other account).
--   * Gives it a NORDVIK Identity profile with verified_method = 'demo' and
--     is_demo = true. That is NOT a government identity check:
--       - only test stores (stores.is_test_store, e.g. Nordvik Test Store) see it,
--         as "Demo Verified"; every other store sees JoeTest as unverified;
--       - it never satisfies a production buyback (identity_buyback_allowed).
--   * Records a clearly labelled demo session / attempt (provider 'demo',
--     no document, no images) and an audit event.
--   * Points the identity photo at portraits/demo/joetest-demo.png in the private
--     identity-evidence bucket. Upload nordvik-identity/demo/joetest-demo-headshot.png
--     there (Storage > identity-evidence > portraits/demo/, file name
--     joetest-demo.png). It's a fictional illustration, separate from JoeTest's
--     CollectorsHub profile picture, which isn't touched.
--   * DOB 1990-04-12 is fictional. The client name is the account's own name;
--     "Joe Test" only if that's what the account says.
--   Account, username, transactions and store customer records are unchanged.

DO $$
DECLARE
  v_count   integer;
  v_account uuid;
  v_name    text;
  v_profile uuid;
  v_session uuid;
BEGIN
  SELECT count(*) INTO v_count FROM public.profiles WHERE lower(username) IN ('joetest', 'testjoe');
  IF v_count = 0 THEN RAISE EXCEPTION 'No account with the username JoeTest or TestJoe was found. Nothing was changed.'; END IF;
  IF v_count > 1 THEN RAISE EXCEPTION 'Both JoeTest and TestJoe exist; nothing was changed (say which one to use).'; END IF;

  SELECT p.id, COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.display_name), ''), p.username)
    INTO v_account, v_name
    FROM public.profiles p WHERE lower(p.username) IN ('joetest', 'testjoe');
  IF lower(v_name) <> 'joe test' THEN
    RAISE NOTICE 'The account''s name is "%", not "Joe Test"; the demo record uses the account''s name.', v_name;
  END IF;

  -- A real verification is never replaced by the demo.
  IF EXISTS (SELECT 1 FROM public.identity_profiles WHERE account_id = v_account AND verification_status = 'verified' AND NOT is_demo) THEN
    RAISE EXCEPTION 'JoeTest already has a real NORDVIK Identity verification. Nothing was changed.';
  END IF;

  INSERT INTO public.identity_profiles (account_id, legal_name, verification_status, verified_at, verification_expires_at,
         verified_document_type, verified_method, is_demo, verified_date_of_birth,
         portrait_path, portrait_status, portrait_source, portrait_display_consent, revoked_at, revoked_reason, updated_at)
  VALUES (v_account, v_name, 'verified', now(), NULL, NULL, 'demo', true, DATE '1990-04-12',
          'portraits/demo/joetest-demo.png', 'ready', 'demo_sample', true, NULL, NULL, now())
  ON CONFLICT (account_id) DO UPDATE SET
    legal_name = EXCLUDED.legal_name, verification_status = 'verified', verified_at = now(), verification_expires_at = NULL,
    verified_document_type = NULL, verified_method = 'demo', is_demo = true, verified_date_of_birth = EXCLUDED.verified_date_of_birth,
    portrait_path = EXCLUDED.portrait_path, portrait_status = 'ready', portrait_source = 'demo_sample', portrait_display_consent = true,
    revoked_at = NULL, revoked_reason = NULL, updated_at = now()
  RETURNING id INTO v_profile;

  -- A labelled demo record (no document, no images, no consent from a real person).
  INSERT INTO public.identity_verification_sessions (identity_profile_id, application_id, store_id, document_type, capture_method,
         biometric_consent, status, document_details, expires_at, completed_at)
  VALUES (v_profile, 'demo_seed', (SELECT id FROM public.stores WHERE is_test_store ORDER BY created_at LIMIT 1), NULL, 'none',
          NULL, 'verified', jsonb_build_object('demo', true, 'note', 'Development/testing demo record. Not a government identity check.'),
          now(), now())
  RETURNING id INTO v_session;
  INSERT INTO public.identity_verification_attempts (session_id, document_check_status, face_match_status, liveness_status, review_status,
         verification_provider, provider_reference, failure_reason_code)
  VALUES (v_session, 'demo', 'demo', 'demo', 'none', 'demo', 'demo-seed-joetest', NULL);
  UPDATE public.identity_profiles SET verified_session_id = v_session WHERE id = v_profile;

  PERFORM public.identity_audit(v_profile, v_session, NULL, 'system', 'demo_verification_seeded',
    jsonb_build_object('username', (SELECT username FROM public.profiles WHERE id = v_account), 'note', 'Demo Verified for development/testing; valid only at test stores'));
  RAISE NOTICE 'JoeTest is Demo Verified (test stores only). Upload the demo headshot to identity-evidence/portraits/demo/joetest-demo.png.';
END $$;
