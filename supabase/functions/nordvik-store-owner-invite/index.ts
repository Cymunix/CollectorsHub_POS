import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' }
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers })

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' })
  const authorization = req.headers.get('Authorization') || ''
  if (!authorization.startsWith('Bearer ')) return reply(401, { error: 'Authentication required' })
  const url = Deno.env.get('SUPABASE_URL')!
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } })
  let inviteOrganizationId: string | undefined
  try {
    const { data: auth, error: authError } = await caller.auth.getUser()
    if (authError || !auth.user) return reply(401, { error: 'Authentication required' })
    const { data: allowed, error: accessError } = await caller.rpc('nordvik_is_admin')
    if (accessError || allowed !== true) return reply(403, { error: 'NORDVIK administrator required' })
    const { organizationId } = await req.json()
    if (typeof organizationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(organizationId)) return reply(400, { error: 'Valid organisation required' })
    // Email is read from the approved organisation, never accepted from input.
    const { data: invite, error: inviteAccessError } = await caller.rpc('nordvik_manage_store', { p_action: 'invite_requested', p_org_id: organizationId })
    if (inviteAccessError) return reply(400, { error: inviteAccessError.message })
    inviteOrganizationId = organizationId
    if (invite.linked) return reply(200, { ok: true, alreadyLinked: true })
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
    // Existing users keep their login. Lookup is bounded per page, with no user
    // list or auth credentials ever returned to the browser.
    let ownerId: string | undefined
    for (let page = 1; !ownerId; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
      if (error) throw error
      ownerId = data.users.find(u => u.email?.toLowerCase() === invite.email)?.id
      if (data.users.length < 1000) break
    }
    if (!ownerId) {
      const redirectTo = Deno.env.get('RETAILER_OWNER_INVITE_REDIRECT_URL')
      if (!redirectTo) throw new Error('Configure RETAILER_OWNER_INVITE_REDIRECT_URL for the existing NORDVIK account setup page.')
      const { data, error } = await admin.auth.admin.inviteUserByEmail(invite.email, { redirectTo })
      if (error) throw error
      ownerId = data.user?.id
    }
    if (!ownerId) throw new Error('Owner invitation did not return an account')
    // Database repeats the admin/status/email checks and locks the organisation.
    const { error } = await caller.rpc('nordvik_manage_store', { p_action: 'link_owner', p_org_id: organizationId, p_data: { user_id: ownerId } })
    if (error) throw error
    return reply(200, { ok: true })
  } catch (error) {
    if (inviteOrganizationId) await caller.rpc('nordvik_manage_store', { p_action: 'invite_failed', p_org_id: inviteOrganizationId, p_data: { error: error instanceof Error ? error.message : 'Owner invitation failed' } })
    return reply(400, { error: error instanceof Error ? error.message : 'Owner invitation failed' })
  }
})
