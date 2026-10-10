// Edge Function: create-store-employee
// (From the website project; also lets the store's organization owner create
// staff, since employee changes are done from the organization.)
//
// Store employees log in with Store Code + Username + PIN. They do not have a
// personal email inbox, so their generated internal Supabase auth account must
// be created as email-confirmed.
//
// Also: { action: 'change_password', employeeId, password } sets a new
// password (PIN) for an existing employee: their sign-in password and the
// store PIN together. Same permission as creating staff.
//
// Deploy: supabase functions deploy create-store-employee (deployed as dynamic-function)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  })

const clean = (value: unknown) => (value == null ? '' : String(value)).trim()

const emailDomain = (ownerEmail: unknown) => {
  const domain = clean(ownerEmail).toLowerCase().split('@')[1] || ''
  return domain.includes('.') ? domain : 'gmail.com'
}

const normalizeRole = (role: unknown) => {
  const normalized = clean(role).toLowerCase().replace(/\s+/g, '_')
  return normalized || 'cashier'
}

const canManageEmployees = (employee: any) => {
  const role = normalizeRole(employee?.role)
  const permissions = employee?.action_permissions || employee?.permissions || {}
  return role === 'owner' || role === 'manager' || Boolean(permissions.employee_management)
}

// Platform admin, the store owner, the store's organization owner, or an
// active employee of the store who can manage employees.
async function canManageStoreStaff(admin: any, store: any, callerId: string) {
  const { data: callerProfile } = await admin.from('profiles').select('subscription_tier').eq('id', callerId).maybeSingle()
  if (callerProfile?.subscription_tier === 'platform_admin' || store.owner_user_id === callerId) return true
  if (store.organization_id) {
    const { data: org } = await admin.from('organizations').select('owner_user_id').eq('id', store.organization_id).maybeSingle()
    if (org?.owner_user_id === callerId) return true
  }
  const { data: employeeAccess } = await admin
    .from('store_employees')
    .select('id, role, permissions, action_permissions')
    .eq('store_id', store.id)
    .or(`auth_user_id.eq.${callerId},employee_user_id.eq.${callerId}`)
    .eq('status', 'active')
    .maybeSingle()
  return canManageEmployees(employeeAccess)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })

  let createdAuthUserId: string | null = null
  let insertedEmployeeId: string | null = null

  try {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!token) return json({ error: 'Not authenticated' }, 401)

    const { data: authData, error: authError } = await admin.auth.getUser(token)
    const caller = authData?.user
    if (authError || !caller) return json({ error: 'Not authenticated' }, 401)

    const body = await req.json().catch(() => ({}))

    // Change an existing employee's password (PIN).
    if (body.action === 'change_password') {
      const employeeId = clean(body.employeeId)
      const password = clean(body.password)
      if (!employeeId) return json({ error: 'Missing employee.' }, 400)
      if (password.length < 4) return json({ error: 'The new password must be at least 4 characters.' }, 400)
      const { data: target } = await admin
        .from('store_employees')
        .select('id, store_id, auth_user_id, employee_user_id, username, status')
        .eq('id', employeeId)
        .maybeSingle()
      if (!target) return json({ error: 'Employee not found.' }, 404)
      const { data: targetStore } = await admin.from('stores').select('id, owner_user_id, organization_id').eq('id', target.store_id).maybeSingle()
      if (!targetStore) return json({ error: 'Store not found.' }, 404)
      if (!(await canManageStoreStaff(admin, targetStore, caller.id))) return json({ error: "You do not have permission to change this employee's password." }, 403)
      const authUserId = target.auth_user_id || target.employee_user_id
      if (!authUserId) return json({ error: 'This employee has no sign-in account to update.' }, 400)
      if (authUserId === caller.id) return json({ error: 'Change your own password from your own account.' }, 400)
      const { error: authUpdateError } = await admin.auth.admin.updateUserById(authUserId, { password })
      if (authUpdateError) return json({ error: authUpdateError.message || 'The password could not be changed.' }, 400)
      const { error: pinError } = await admin.rpc('set_store_employee_pin', { p_employee_id: target.id, p_pin: password })
      if (pinError) return json({ error: `The sign-in password was changed, but the store PIN wasn't: ${pinError.message}` }, 400)
      await admin.rpc('log_store_employee_action', {
        p_store_id: target.store_id,
        p_employee_id: target.id,
        p_action: 'employee_password_changed',
        p_metadata: { changed_by: caller.id },
      })
      return json({ ok: true, username: target.username })
    }

    const storeId = clean(body.storeId)
    const firstName = clean(body.firstName)
    const lastName = clean(body.lastName)
    const pin = clean(body.pin)
    const role = normalizeRole(body.role)
    const permissions = body.permissions && typeof body.permissions === 'object' ? body.permissions : {}
    const allLocations = body.allLocations !== false
    const locationIds = Array.isArray(body.locationIds)
      ? body.locationIds.map(clean).filter(Boolean)
      : []

    if (!storeId) return json({ error: 'Missing store.' }, 400)
    if (!firstName || !lastName) return json({ error: 'First and last name are required.' }, 400)
    if (pin.length < 4) return json({ error: 'PIN must be at least 4 characters.' }, 400)
    if (!allLocations && locationIds.length === 0) {
      return json({ error: 'Select at least one location or choose All Locations.' }, 400)
    }

    const { data: store, error: storeError } = await admin
      .from('stores')
      .select('id, store_code, store_name, owner_user_id, organization_id')
      .eq('id', storeId)
      .single()
    if (storeError || !store) return json({ error: 'Store not found.' }, 404)

    const allowed = await canManageStoreStaff(admin, store, caller.id)
    if (!allowed) return json({ error: 'You do not have permission to create employees for this store.' }, 403)

    const { data: username, error: usernameError } = await admin.rpc('generate_store_employee_username', {
      p_store_id: store.id,
      p_first_name: firstName,
      p_last_name: lastName,
    })
    if (usernameError || !username) {
      return json({ error: usernameError?.message || 'Could not generate employee username right now.' }, 400)
    }

    const { data: ownerAuth } = await admin.auth.admin.getUserById(store.owner_user_id)
    const internalEmail = `${String(username).toLowerCase()}+chstore@${emailDomain(ownerAuth?.user?.email)}`

    const { data: createdUser, error: createUserError } = await admin.auth.admin.createUser({
      email: internalEmail,
      password: pin,
      email_confirm: true,
      user_metadata: {
        first_name: firstName,
        last_name: lastName,
        role,
        store_id: store.id,
        invited_by_store_owner_id: store.owner_user_id,
        is_store_employee: true,
      },
    })
    if (createUserError || !createdUser?.user?.id) {
      return json({ error: createUserError?.message || 'Could not create the employee auth account.' }, 400)
    }
    createdAuthUserId = createdUser.user.id

    const { data: employee, error: insertError } = await admin
      .from('store_employees')
      .insert({
        store_id: store.id,
        store_owner_id: store.owner_user_id,
        employee_user_id: createdAuthUserId,
        auth_user_id: createdAuthUserId,
        first_name: firstName,
        last_name: lastName,
        email: internalEmail,
        internal_email: internalEmail,
        username,
        role,
        status: 'active',
        permissions,
        action_permissions: permissions,
        all_locations: allLocations,
      })
      .select('id, first_name, last_name, username, role, status, permissions, action_permissions, all_locations, created_at')
      .single()
    if (insertError || !employee) {
      await admin.auth.admin.deleteUser(createdAuthUserId)
      createdAuthUserId = null
      return json({ error: insertError?.message || 'Employee auth account was created but could not be linked to the store.' }, 400)
    }
    insertedEmployeeId = employee.id

    const { error: pinError } = await admin.rpc('set_store_employee_pin', {
      p_employee_id: employee.id,
      p_pin: pin,
    })
    if (pinError) {
      await admin.from('store_employees').delete().eq('id', employee.id)
      await admin.auth.admin.deleteUser(createdAuthUserId)
      createdAuthUserId = null
      insertedEmployeeId = null
      return json({ error: pinError.message || 'Employee created but PIN setup failed.' }, 400)
    }

    if (!allLocations && locationIds.length > 0) {
      const { data: validLocations } = await admin
        .from('store_locations')
        .select('id')
        .eq('store_id', store.id)
        .in('id', locationIds)

      const validLocationIds = (validLocations || []).map((location: any) => location.id)
      if (validLocationIds.length !== locationIds.length) {
        await admin.from('store_employees').delete().eq('id', employee.id)
        await admin.auth.admin.deleteUser(createdAuthUserId)
        createdAuthUserId = null
        insertedEmployeeId = null
        return json({ error: 'One or more selected locations do not belong to this store.' }, 400)
      }

      const { error: locationError } = await admin.from('store_employee_locations').insert(
        validLocationIds.map((locationId: string) => ({
          store_id: store.id,
          store_owner_id: store.owner_user_id,
          employee_id: employee.id,
          location_id: locationId,
        })),
      )
      if (locationError) {
        await admin.from('store_employees').delete().eq('id', employee.id)
        await admin.auth.admin.deleteUser(createdAuthUserId)
        createdAuthUserId = null
        insertedEmployeeId = null
        return json({ error: locationError.message || 'Employee created but location assignments failed.' }, 400)
      }
    }

    await admin.rpc('log_store_employee_action', {
      p_store_id: store.id,
      p_employee_id: employee.id,
      p_action: 'employee_created',
      p_metadata: { username, role, created_by: caller.id },
    })

    return json({
      employee: { ...employee, location_ids: allLocations ? [] : locationIds },
      username,
      storeCode: store.store_code,
      authUserId: createdAuthUserId,
    })
  } catch (error) {
    if (insertedEmployeeId) await admin.from('store_employees').delete().eq('id', insertedEmployeeId)
    if (createdAuthUserId) await admin.auth.admin.deleteUser(createdAuthUserId)
    return json({ error: error instanceof Error ? error.message : 'Could not create employee.' }, 500)
  }
})
