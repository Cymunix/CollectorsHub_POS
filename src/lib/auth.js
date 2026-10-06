import { supabase } from './supabaseClient'

const isOrgCode = (code) => /^org[-\s]?/i.test(code || '')

async function resolveFirstStoreLocation(storeId) {
  if (!storeId) return null

  const { data } = await supabase
    .from('store_locations')
    .select('id')
    .eq('store_id', storeId)
    .eq('status', 'active')
    .order('created_at')
    .limit(1)
    .maybeSingle()

  return data?.id || null
}

export async function signInStaff({ code, username, password }) {
  const normalizedCode = code.trim()
  const normalizedUsername = username.trim()
  const normalizedPassword = password.trim()

  if (!normalizedCode || !normalizedUsername || !normalizedPassword) {
    throw new Error('Enter your store or org code, username or email, and password.')
  }

  if (isOrgCode(normalizedCode)) {
    const { error: loginError } = await supabase.auth.signInWithPassword({
      email: normalizedUsername,
      password: normalizedPassword,
    })

    if (loginError) throw loginError

    const { data, error } = await supabase.rpc('verify_organization_login', {
      p_org_code: normalizedCode,
    })

    if (error) {
      await supabase.auth.signOut()
      throw error
    }

    const org = (data || [])[0]
    if (!org) {
      await supabase.auth.signOut()
      throw new Error('That organization code does not match this account.')
    }

    return {
      type: 'organization',
      orgId: org.org_id,
      orgCode: org.org_code,
      orgName: org.name,
      username: normalizedUsername,
    }
  }

  const usernameCandidates = [normalizedUsername]
  const shouldTryStoreScopedUsername = !normalizedUsername.includes('@') && !normalizedUsername.includes('.')
  if (shouldTryStoreScopedUsername) {
    usernameCandidates.push(`${normalizedUsername}.${normalizedCode}`)
  }

  let verified = null
  let lastVerifyError = null

  for (const usernameCandidate of usernameCandidates) {
    const { data: verifyRows, error: verifyError } = await supabase.rpc('verify_store_employee_pin', {
      p_store_code: normalizedCode,
      p_username: usernameCandidate,
      p_pin: normalizedPassword,
    })

    if (verifyError) {
      lastVerifyError = verifyError
      continue
    }

    const row = Array.isArray(verifyRows) ? verifyRows[0] : verifyRows
    if (row?.internal_email) {
      verified = row
      break
    }
  }

  if (!verified && lastVerifyError) throw lastVerifyError
  if (!verified?.internal_email) {
    throw new Error('Invalid store code, username, or password.')
  }

  const { error: loginError } = await supabase.auth.signInWithPassword({
    email: verified.internal_email,
    password: normalizedPassword,
  })

  if (loginError) throw loginError

  await supabase.rpc('log_store_employee_action', {
    p_store_id: verified.store_id,
    p_employee_id: verified.employee_id,
    p_action: 'employee_login',
    p_metadata: { login_method: 'desktop_pos', username: normalizedUsername },
  })

  const locationId = await resolveFirstStoreLocation(verified.store_id)
  // The sign-in check doesn't always return the store's name: look it up.
  const storeName = verified.store_name || await loadStoreName(verified.store_id)

  return {
    type: 'store_employee',
    storeId: verified.store_id,
    storeName: storeName || 'Store',
    storeCode: normalizedCode,
    employeeId: verified.employee_id,
    locationId,
    username: normalizedUsername,
    role: verified.role || 'cashier',
    permissions: verified.permissions || {},
  }
}

export async function loadStoreName(storeId) {
  if (!storeId) return ''
  try {
    const { data } = await supabase.from('stores').select('store_name').eq('id', storeId).maybeSingle()
    if (data?.store_name) return data.store_name
    const { data: profile } = await supabase.rpc('public_store_profile', { p_store_id: storeId })
    return (Array.isArray(profile) ? profile[0] : profile)?.store_name || ''
  } catch {
    return ''
  }
}

export async function signInAdmin({ email, password }) {
  const normalizedEmail = email.trim()

  if (!normalizedEmail || !password) {
    throw new Error('Enter your admin email and password.')
  }

  const { data: authData, error: loginError } = await supabase.auth.signInWithPassword({
    email: normalizedEmail,
    password,
  })

  if (loginError) throw loginError

  const userId = authData.user?.id
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('display_name, username, subscription_tier')
    .eq('id', userId)
    .maybeSingle()

  if (profileError) {
    await supabase.auth.signOut()
    throw profileError
  }

  if (profile?.subscription_tier !== 'platform_admin') {
    await supabase.auth.signOut()
    throw new Error('This account is not authorized for admin login.')
  }

  return {
    type: 'platform_admin',
    userId,
    email: normalizedEmail,
    displayName: profile.display_name || profile.username || 'Platform Admin',
    profile,
  }
}

export async function signOutSupabase() {
  await supabase.auth.signOut()
}
