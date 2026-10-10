import { supabase } from './supabaseClient'
import { setLanguage } from '../i18n/runtime'

// Personal Settings (supabase/personal_settings.sql + Supabase Auth). Only the
// signed-in employee's own account; nothing here changes store or organization settings.

async function call(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    if (/could not find the function/i.test(error.message || '')) throw new Error(`Personal settings aren't installed in Supabase yet: ${name} wasn't found (run supabase/personal_settings.sql).`)
    throw new Error(error.message)
  }
  return data
}

export const myProfile = (storeId) => call('me_profile', { p_store_id: storeId })
export const updateMyPhoto = (storeId, photoPath) => call('me_update_photo', { p_store_id: storeId, p_photo_path: photoPath || null })

// Password: the same one used to sign in (the Supabase sign-in and the store PIN change together).
export async function changeMyPassword(storeId, current, next) {
  const now = String(current || '').trim()
  const fresh = String(next || '').trim()
  if (fresh.length < 6) throw new Error('Use at least 6 characters.')
  if (fresh === now) throw new Error('Choose a password different from your current one.')
  if (!(await call('me_check_password', { p_store_id: storeId, p_password: now }))) throw new Error('Your current password isn\'t correct.')
  const { error: authError } = await supabase.auth.updateUser({ password: fresh })
  if (authError) throw new Error(authError.message)
  try {
    await call('me_change_pin', { p_store_id: storeId, p_current: now, p_new: fresh })
  } catch (error) {
    // Keep both halves the same: put the sign-in password back if the PIN couldn't change.
    await supabase.auth.updateUser({ password: now }).catch(() => {})
    throw error
  }
}

// Profile photo: private bucket, the signed-in user's own folder; resized to 512px.
export async function uploadMyPhoto(file) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Sign in first.')
  const blob = await resizeImage(file, 512)
  const path = `${user.id}/photo-${Date.now()}.jpg`
  const { error } = await supabase.storage.from('employee-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false })
  if (error) throw new Error(error.message)
  return path
}
export async function photoUrl(path) {
  if (!path) return ''
  const { data } = await supabase.storage.from('employee-photos').createSignedUrl(path, 3600)
  return data?.signedUrl || ''
}
async function resizeImage(file, size) {
  const source = typeof file === 'string' ? await (await fetch(file)).blob() : file
  const bitmap = await createImageBitmap(source)
  const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88))
}

// Two-step sign-in (Supabase Auth authenticator-app factors).
export async function mfaFactors() {
  const { data, error } = await supabase.auth.mfa.listFactors()
  if (error) throw new Error(error.message)
  return (data?.totp || [])
}
export async function mfaStart() {
  // Clear any half-finished setup first.
  const { data: list } = await supabase.auth.mfa.listFactors()
  for (const factor of list?.all || []) if (factor.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: factor.id }).catch(() => {})
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `CollectorsHub POS ${new Date().toISOString().slice(0, 10)}` })
  if (error) throw new Error(error.message)
  return { factorId: data.id, qr: data.totp?.qr_code, secret: data.totp?.secret }
}
export async function mfaVerify(factorId, code) {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: String(code || '').replace(/\s/g, '') })
  if (error) throw new Error(error.message === 'Invalid TOTP code entered' ? 'That code isn\'t right. Check the time on your phone and try the newest code.' : error.message)
}
export async function mfaRemove(factorId) {
  const { error } = await supabase.auth.mfa.unenroll({ factorId })
  if (error) throw new Error(/aal2/i.test(error.message) ? 'Sign out and back in with your authenticator code first, then remove it.' : error.message)
}
// After a password sign-in: does this account need its authenticator code?
export async function mfaNeeded() {
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (!data || data.nextLevel !== 'aal2' || data.currentLevel === 'aal2') return null
  const factors = await mfaFactors().catch(() => [])
  const verified = factors.find((factor) => factor.status === 'verified')
  return verified ? verified.id : null
}

export const signOutOtherDevices = async () => {
  const { error } = await supabase.auth.signOut({ scope: 'others' })
  if (error) throw new Error(error.message)
}

// Personal preferences live on the signed-in account (Supabase user metadata), so they
// follow the employee to any register and never affect anyone else.
export const DEFAULT_PREFERENCES = { language: 'en', textSize: 'normal', reduceMotion: false, strongFocus: false }
export async function loadPreferences() {
  const { data: { user } } = await supabase.auth.getUser()
  return { ...DEFAULT_PREFERENCES, ...(user?.user_metadata?.pos_preferences || {}) }
}
export async function savePreferences(preferences) {
  const { error } = await supabase.auth.updateUser({ data: { pos_preferences: preferences } })
  if (error) throw new Error(error.message)
  applyPreferences(preferences)
}
export function applyPreferences(preferences = DEFAULT_PREFERENCES) {
  const root = document.documentElement
  const zoom = { normal: 1, large: 1.12, larger: 1.25 }[preferences.textSize] || 1
  root.style.zoom = zoom === 1 ? '' : String(zoom)
  root.classList.toggle('pref-reduce-motion', Boolean(preferences.reduceMotion))
  root.classList.toggle('pref-strong-focus', Boolean(preferences.strongFocus))
  if (preferences.language) setLanguage(preferences.language)
}
