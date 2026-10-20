-- Listing messages (2026-10-21): a store messages the collector who listed an item for sale
-- (Collector Listings in the POS), and the collector replies on the website (#/messages). The
-- collector is emailed each store message with a link to reply on the site
-- (supabase/functions/send-listing-message). Run after collector_listings.sql and
-- wishlist_stock_emails.sql. Safe to run more than once.
--
-- * One conversation per store and listed copy. The item's title and asking price are kept on
--   the conversation, so it still reads right after the copy is sold or taken off sale.
-- * A store can start a conversation only while the copy is listed, and can send at most
--   3 messages in a row before the collector replies (no spamming sellers).
-- * The collector can stop a store's messages for a conversation; the store then can't send more.
-- * The store never sees the collector's email address; it sees @username only when the
--   collector's profile is open, otherwise "a CollectorsHub member" (same as Collector Listings).
-- * Test stores can only message admins / testers.
-- All reads and writes go through the functions below; the tables are closed to clients.

CREATE TABLE IF NOT EXISTS public.listing_conversations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  collector_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  copy_id            uuid REFERENCES public.owned_copies(id) ON DELETE SET NULL,
  catalog_item_id    uuid,
  item_title         text,
  asking_price       numeric(12,2),
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_message_at    timestamptz NOT NULL DEFAULT now(),
  store_read_at      timestamptz,
  collector_read_at  timestamptz,
  collector_blocked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS listing_conversations_store_copy_idx ON public.listing_conversations (store_id, copy_id) WHERE copy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS listing_conversations_store_idx ON public.listing_conversations (store_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS listing_conversations_collector_idx ON public.listing_conversations (collector_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS public.listing_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES public.listing_conversations(id) ON DELETE CASCADE,
  sender           text NOT NULL CHECK (sender IN ('store', 'collector')),
  sender_user_id   uuid,
  sender_name      text,
  body             text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  emailed_at       timestamptz,
  email_error      text
);
CREATE INDEX IF NOT EXISTS listing_messages_conversation_idx ON public.listing_messages (conversation_id, created_at);

ALTER TABLE public.listing_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.listing_conversations FROM anon, authenticated;
REVOKE ALL ON public.listing_messages FROM anon, authenticated;

-- How the store sees the collector: @username when their profile is open, else nothing.
CREATE OR REPLACE FUNCTION public.listing_collector_label(p_user_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN COALESCE(p.public_profile_enabled, false) THEN p.username END FROM public.profiles p WHERE p.id = p_user_id
$$;
REVOKE ALL ON FUNCTION public.listing_collector_label(uuid) FROM PUBLIC, anon, authenticated;

-- A conversation's messages, oldest first.
CREATE OR REPLACE FUNCTION public.listing_conversation_messages(p_conversation_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m.id, 'sender', m.sender, 'sender_name', m.sender_name, 'body', m.body,
                                               'created_at', m.created_at, 'emailed_at', m.emailed_at) ORDER BY m.created_at), '[]'::jsonb)
    FROM public.listing_messages m WHERE m.conversation_id = p_conversation_id
$$;
REVOKE ALL ON FUNCTION public.listing_conversation_messages(uuid) FROM PUBLIC, anon, authenticated;

-- ── Store side (POS) ──────────────────────────────────────────────────────────────────

-- Send a message: to a listed copy (starts or continues that conversation) or to an existing
-- conversation. Returns { conversation_id, message_id }; the POS then calls send-listing-message
-- to email it.
DROP FUNCTION IF EXISTS public.store_listing_send_message(uuid, uuid, uuid, text, text);
CREATE OR REPLACE FUNCTION public.store_listing_send_message(p_store_id uuid, p_copy_id uuid, p_conversation_id uuid,
                                                             p_body text, p_sender_name text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_body text := btrim(COALESCE(p_body, ''));
  v_conv public.listing_conversations;
  v_copy record;
  v_test boolean;
  v_in_a_row integer;
  v_message uuid;
BEGIN
  IF p_store_id IS NULL OR p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  IF v_body = '' THEN RAISE EXCEPTION 'Write a message first.'; END IF;
  IF char_length(v_body) > 2000 THEN RAISE EXCEPTION 'Messages can be up to 2000 characters.'; END IF;

  IF p_conversation_id IS NOT NULL THEN
    SELECT * INTO v_conv FROM public.listing_conversations WHERE id = p_conversation_id AND store_id = p_store_id;
    IF v_conv.id IS NULL THEN RAISE EXCEPTION 'Conversation not found.'; END IF;
  ELSE
    SELECT oc.id, oc.user_id, oc.catalog_item_id, oc.sale_status, oc.sale_price,
           concat_ws(' ', COALESCE(i.name, 'Catalogue item'), '#' || NULLIF(i.card_number, ''), '(' || i.release_year || ')') AS title
      INTO v_copy
      FROM public.owned_copies oc LEFT JOIN public.items i ON i.item_id = oc.catalog_item_id
     WHERE oc.id = p_copy_id;
    IF v_copy.id IS NULL THEN RAISE EXCEPTION 'This listing no longer exists.'; END IF;
    SELECT * INTO v_conv FROM public.listing_conversations WHERE store_id = p_store_id AND copy_id = p_copy_id;
    IF v_conv.id IS NULL THEN
      IF v_copy.sale_status IS DISTINCT FROM 'listed' THEN RAISE EXCEPTION 'This item is no longer listed for sale.'; END IF;
      SELECT COALESCE(s.is_test_store, false) INTO v_test FROM public.stores s WHERE s.id = p_store_id;
      IF v_test AND NOT public.wishlist_user_sees_test_data(v_copy.user_id) THEN
        RAISE EXCEPTION 'Test stores can only message admins and testers.';
      END IF;
      INSERT INTO public.listing_conversations (store_id, collector_id, copy_id, catalog_item_id, item_title, asking_price)
      VALUES (p_store_id, v_copy.user_id, v_copy.id, v_copy.catalog_item_id, v_copy.title, v_copy.sale_price)
      RETURNING * INTO v_conv;
    END IF;
  END IF;

  IF v_conv.collector_blocked_at IS NOT NULL THEN RAISE EXCEPTION 'This collector has stopped messages from your store.'; END IF;

  -- Store messages since the collector last replied.
  SELECT count(*) INTO v_in_a_row FROM public.listing_messages m
   WHERE m.conversation_id = v_conv.id AND m.sender = 'store'
     AND m.created_at > COALESCE((SELECT max(c.created_at) FROM public.listing_messages c WHERE c.conversation_id = v_conv.id AND c.sender = 'collector'), '-infinity');
  IF v_in_a_row >= 3 THEN RAISE EXCEPTION 'Wait for the collector to reply before sending more messages.'; END IF;

  INSERT INTO public.listing_messages (conversation_id, sender, sender_user_id, sender_name, body)
  VALUES (v_conv.id, 'store', auth.uid(), NULLIF(left(btrim(COALESCE(p_sender_name, '')), 60), ''), v_body)
  RETURNING id INTO v_message;
  UPDATE public.listing_conversations SET last_message_at = now(), store_read_at = now() WHERE id = v_conv.id;
  RETURN jsonb_build_object('conversation_id', v_conv.id, 'message_id', v_message);
END $$;
REVOKE ALL ON FUNCTION public.store_listing_send_message(uuid, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_listing_send_message(uuid, uuid, uuid, text, text) TO authenticated;

-- The store's conversations, newest first, with the last message and whether it's unread.
DROP FUNCTION IF EXISTS public.store_listing_conversations(uuid);
CREATE OR REPLACE FUNCTION public.store_listing_conversations(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_store_id IS NULL OR p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id', c.id, 'copy_id', c.copy_id, 'catalog_item_id', c.catalog_item_id, 'item_title', c.item_title,
             'asking_price', c.asking_price, 'image_path', i.image_path, 'front_image_url', oc.front_image_url,
             'still_listed', COALESCE(oc.sale_status = 'listed', false),
             'collector_username', public.listing_collector_label(c.collector_id),
             'collector_blocked', c.collector_blocked_at IS NOT NULL,
             'last_message_at', c.last_message_at,
             'last_sender', lm.sender, 'last_body', left(lm.body, 160),
             'unread', lm.sender = 'collector' AND lm.created_at > COALESCE(c.store_read_at, '-infinity'))
           ORDER BY c.last_message_at DESC)
      FROM public.listing_conversations c
      LEFT JOIN public.owned_copies oc ON oc.id = c.copy_id
      LEFT JOIN public.items i ON i.item_id = c.catalog_item_id
      LEFT JOIN LATERAL (SELECT m.sender, m.body, m.created_at FROM public.listing_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) lm ON true
     WHERE c.store_id = p_store_id), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.store_listing_conversations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_listing_conversations(uuid) TO authenticated;

-- One conversation with its messages (by id, or by the listed copy); marks it read for the store.
-- Returns null when the store hasn't messaged about that copy yet.
DROP FUNCTION IF EXISTS public.store_listing_conversation(uuid, uuid, uuid);
CREATE OR REPLACE FUNCTION public.store_listing_conversation(p_store_id uuid, p_conversation_id uuid, p_copy_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_conv public.listing_conversations;
BEGIN
  IF p_store_id IS NULL OR p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  SELECT * INTO v_conv FROM public.listing_conversations
   WHERE store_id = p_store_id AND (id = p_conversation_id OR (p_conversation_id IS NULL AND copy_id = p_copy_id));
  IF v_conv.id IS NULL THEN RETURN NULL; END IF;
  UPDATE public.listing_conversations SET store_read_at = now() WHERE id = v_conv.id;
  RETURN jsonb_build_object(
    'id', v_conv.id, 'copy_id', v_conv.copy_id, 'item_title', v_conv.item_title, 'asking_price', v_conv.asking_price,
    'still_listed', COALESCE((SELECT oc.sale_status = 'listed' FROM public.owned_copies oc WHERE oc.id = v_conv.copy_id), false),
    'collector_username', public.listing_collector_label(v_conv.collector_id),
    'collector_blocked', v_conv.collector_blocked_at IS NOT NULL,
    'messages', public.listing_conversation_messages(v_conv.id));
END $$;
REVOKE ALL ON FUNCTION public.store_listing_conversation(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_listing_conversation(uuid, uuid, uuid) TO authenticated;

-- Conversations with a collector reply the store hasn't read (the POS nav badge).
CREATE OR REPLACE FUNCTION public.store_listing_unread_count(p_store_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::integer FROM public.listing_conversations c
   WHERE c.store_id = p_store_id AND p_store_id IN (SELECT public.user_store_ids())
     AND EXISTS (SELECT 1 FROM public.listing_messages m WHERE m.conversation_id = c.id AND m.sender = 'collector'
                    AND m.created_at > COALESCE(c.store_read_at, '-infinity'))
$$;
REVOKE ALL ON FUNCTION public.store_listing_unread_count(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_listing_unread_count(uuid) TO authenticated;

-- ── Collector side (website) ──────────────────────────────────────────────────────────

-- The signed-in collector's conversations, newest first.
CREATE OR REPLACE FUNCTION public.collector_listing_conversations()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', c.id, 'copy_id', c.copy_id, 'catalog_item_id', c.catalog_item_id, 'item_title', c.item_title,
           'asking_price', c.asking_price, 'image_path', i.image_path, 'front_image_url', oc.front_image_url,
           'store_id', c.store_id, 'store_name', s.store_name,
           'blocked', c.collector_blocked_at IS NOT NULL,
           'last_message_at', c.last_message_at,
           'last_sender', lm.sender, 'last_body', left(lm.body, 160),
           'unread', lm.sender = 'store' AND lm.created_at > COALESCE(c.collector_read_at, '-infinity'))
         ORDER BY c.last_message_at DESC), '[]'::jsonb)
    FROM public.listing_conversations c
    JOIN public.stores s ON s.id = c.store_id
    LEFT JOIN public.owned_copies oc ON oc.id = c.copy_id
    LEFT JOIN public.items i ON i.item_id = c.catalog_item_id
    LEFT JOIN LATERAL (SELECT m.sender, m.body, m.created_at FROM public.listing_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) lm ON true
   WHERE c.collector_id = auth.uid()
$$;
REVOKE ALL ON FUNCTION public.collector_listing_conversations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collector_listing_conversations() TO authenticated;

-- One of the collector's conversations with its messages; marks it read.
CREATE OR REPLACE FUNCTION public.collector_listing_conversation(p_conversation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_conv public.listing_conversations;
BEGIN
  SELECT * INTO v_conv FROM public.listing_conversations WHERE id = p_conversation_id AND collector_id = auth.uid();
  IF v_conv.id IS NULL THEN RETURN NULL; END IF;
  UPDATE public.listing_conversations SET collector_read_at = now() WHERE id = v_conv.id;
  RETURN jsonb_build_object(
    'id', v_conv.id, 'copy_id', v_conv.copy_id, 'catalog_item_id', v_conv.catalog_item_id, 'item_title', v_conv.item_title,
    'asking_price', v_conv.asking_price, 'store_id', v_conv.store_id,
    'store_name', (SELECT s.store_name FROM public.stores s WHERE s.id = v_conv.store_id),
    'blocked', v_conv.collector_blocked_at IS NOT NULL,
    'messages', public.listing_conversation_messages(v_conv.id));
END $$;
REVOKE ALL ON FUNCTION public.collector_listing_conversation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collector_listing_conversation(uuid) TO authenticated;

-- Reply to a store.
CREATE OR REPLACE FUNCTION public.collector_listing_reply(p_conversation_id uuid, p_body text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_body text := btrim(COALESCE(p_body, '')); v_conv uuid; v_message uuid;
BEGIN
  SELECT id INTO v_conv FROM public.listing_conversations WHERE id = p_conversation_id AND collector_id = auth.uid();
  IF v_conv IS NULL THEN RAISE EXCEPTION 'Conversation not found.'; END IF;
  IF v_body = '' THEN RAISE EXCEPTION 'Write a message first.'; END IF;
  IF char_length(v_body) > 2000 THEN RAISE EXCEPTION 'Messages can be up to 2000 characters.'; END IF;
  INSERT INTO public.listing_messages (conversation_id, sender, sender_user_id, body)
  VALUES (v_conv, 'collector', auth.uid(), v_body) RETURNING id INTO v_message;
  UPDATE public.listing_conversations SET last_message_at = now(), collector_read_at = now() WHERE id = v_conv;
  RETURN v_message;
END $$;
REVOKE ALL ON FUNCTION public.collector_listing_reply(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collector_listing_reply(uuid, text) TO authenticated;

-- Stop (or allow again) a store's messages in this conversation.
CREATE OR REPLACE FUNCTION public.collector_listing_block(p_conversation_id uuid, p_blocked boolean)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.listing_conversations SET collector_blocked_at = CASE WHEN p_blocked THEN now() END
   WHERE id = p_conversation_id AND collector_id = auth.uid()
$$;
REVOKE ALL ON FUNCTION public.collector_listing_block(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collector_listing_block(uuid, boolean) TO authenticated;

-- Conversations with a store message the collector hasn't read (the website nav badge).
CREATE OR REPLACE FUNCTION public.collector_listing_unread_count()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::integer FROM public.listing_conversations c
   WHERE c.collector_id = auth.uid()
     AND EXISTS (SELECT 1 FROM public.listing_messages m WHERE m.conversation_id = c.id AND m.sender = 'store'
                    AND m.created_at > COALESCE(c.collector_read_at, '-infinity'))
$$;
REVOKE ALL ON FUNCTION public.collector_listing_unread_count() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collector_listing_unread_count() TO authenticated;
