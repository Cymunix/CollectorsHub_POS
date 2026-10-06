// Ported from the website (Nordvik-main src/lib/retail/org.js), same Supabase
// functions. Plus the province tax table and loadStoreLocations from its pos.js.
// Parent Organization service layer.
//
// An organization is an oversight account (own ORG-xxxx code + email/password
// login) that owns child stores. It is NOT a till: there is no item intake here.

import { supabase } from '../lib/supabaseClient'

// Validate that the given org code belongs to the currently signed-in user.
// Call AFTER supabase.auth sign-in. Returns { orgId, orgCode, name } or null.
export async function verifyOrganizationLogin(orgCode) {
  const { data, error } = await supabase.rpc('verify_organization_login', { p_org_code: orgCode })
  if (error) throw new Error(error.message)
  const row = (data || [])[0]
  return row ? { orgId: row.org_id, orgCode: row.org_code, name: row.name } : null
}

// Organizations owned by the signed-in user (for logging in by account when the
// org code isn't known). Call AFTER supabase.auth sign-in.
export async function myOrganizations() {
  const { data, error } = await supabase.rpc('my_organizations')
  if (error) throw new Error(error.message)
  return (data || []).map(r => ({ orgId: r.org_id, orgCode: r.org_code, name: r.name }))
}

export async function createOrganization(name) {
  const { data, error } = await supabase.rpc('create_organization', { p_name: name || 'Organization' })
  if (error) throw new Error(error.message)
  const row = (data || [])[0]
  return row ? { orgId: row.org_id, orgCode: row.org_code, name: row.name } : null
}

export async function loadOrganizationStores(orgId) {
  if (!orgId) return []
  const { data, error } = await supabase.rpc('organization_stores', { p_org_id: orgId })
  if (error) { console.error('organization_stores error:', error); return [] }
  return (data || []).map(r => ({
    storeId: r.store_id, storeCode: r.store_code, storeName: r.store_name, status: r.status || 'active',
    regionId: r.region_id || null, regionName: r.region_name || null,
    notificationRegionId: r.notification_region_id || null, primaryProvince: r.primary_province || null,
    primaryLocation: r.primary_location || null,
    locationCount: Number(r.location_count) || 0, staffCount: Number(r.staff_count) || 0,
    inventoryCount: Number(r.inventory_count) || 0,
  }))
}

export async function loadOrganizationInfo(orgId) {
  if (!orgId) return null
  const { data, error } = await supabase.rpc('organization_info_for', { p_org_id: orgId })
  if (error || !data) return null
  return {
    orgId: data.organization_id,
    name: data.name || '',
    orgCode: data.org_code || '',
    logoUrl: data.logo_url || '',
    bannerUrl: data.banner_url || '',
  }
}

const ORG_BRANDING_BUCKET = 'store-branding'
export async function uploadOrganizationBrandingImage(orgId, file, kind) {
  if (!orgId || !file) throw new Error('Missing organization or file.')
  if (!file.type?.startsWith('image/')) throw new Error('Please choose an image file.')
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
  const path = `org/${orgId}/${kind === 'banner' ? 'banner' : 'logo'}-${Date.now()}.${ext}`
  const { error } = await supabase.storage.from(ORG_BRANDING_BUCKET).upload(path, file, { upsert: true, contentType: file.type || undefined })
  if (error) throw new Error(error.message)
  return supabase.storage.from(ORG_BRANDING_BUCKET).getPublicUrl(path).data?.publicUrl || ''
}

export async function saveOrganizationBranding(orgId, { logoUrl, bannerUrl } = {}) {
  const { error } = await supabase.rpc('save_organization_branding', {
    p_org_id: orgId,
    p_logo_url: logoUrl === undefined ? null : logoUrl,
    p_banner_url: bannerUrl === undefined ? null : bannerUrl,
  })
  if (error) throw new Error(error.message)
}

// ── Regions ─────────────────────────────────────────────────────────────────
export async function listOrgRegions(orgId) {
  if (!orgId) return []
  const { data, error } = await supabase.rpc('list_org_regions', { p_org_id: orgId })
  if (error) { console.error('list_org_regions error:', error); return [] }
  return (data || []).map(r => ({ id: r.id, name: r.name, code: r.code, status: r.status, storeCount: Number(r.store_count) || 0 }))
}
export async function createOrgRegion(orgId, name, code) {
  const { data, error } = await supabase.rpc('create_org_region', { p_org_id: orgId, p_name: name, p_code: code || null })
  if (error) throw new Error(error.message)
  return data
}
export async function setStoreRegion(storeId, regionId) {
  const { error } = await supabase.rpc('set_store_region', { p_store_id: storeId, p_region_id: regionId || null })
  if (error) throw new Error(error.message)
}
// Town/city typeahead over the StatCan communities directory (same source the
// collector notification settings use). Each hit carries province, coordinates
// and the collector notification region.
export async function searchCommunities(query) {
  const q = (query || '').trim()
  if (q.length < 2) return []
  const { data, error } = await supabase.rpc('search_notification_communities', { p_query: q, p_limit: 10 })
  if (error) { console.error('searchCommunities error:', error); return [] }
  return (data || []).map(c => ({
    id: c.csduid, name: c.name, province: c.province, provinceName: c.province_name,
    latitude: c.latitude, longitude: c.longitude, regionId: c.notification_region_id,
  }))
}

// The store's collector NOTIFICATION region (auto-derived from its address province).
export async function setStoreNotificationRegion(storeId, regionId) {
  const { error } = await supabase.rpc('set_store_notification_region', { p_store_id: storeId, p_region: regionId || null })
  if (error) throw new Error(error.message)
}

// ── Create Store + Primary Location (head office) ───────────────────────────
export async function createStoreFull(orgId, store) {
  const { data, error } = await supabase.rpc('create_store_full', {
    p_org_id: orgId,
    p_store_name: store.storeName, p_store_code: store.storeCode || null,
    p_region_id: store.regionId || null, p_status: store.status || 'active',
    p_location_name: store.locationName || 'Primary Location',
    p_address1: store.address1 || null, p_address2: store.address2 || null,
    p_city: store.city || null, p_province: store.province || null,
    p_postal: store.postal || null, p_country: store.country || 'Canada',
    p_time_zone: store.timeZone || null, p_currency: store.currency || 'CAD',
    p_tax_rate: store.taxRate != null ? store.taxRate : null, p_tax_label: store.taxLabel || null,
    p_config: store.config || {},
    p_notification_region: store.notificationRegion || null,
  })
  if (error) throw new Error(error.message)
  return data // { store_id, store_code, location_id }
}

// ── Phase 1 head-office modules: Locations / Staff / Inventory ──────────────
export async function orgLocations(orgId, scope = {}, search = '') {
  if (!orgId) return []
  const { data, error } = await supabase.rpc('org_locations', {
    ...scopeArgs(orgId, scope),
    p_search: search?.trim() || null,
  })
  if (error) { console.error('org_locations error:', error); return [] }
  return (data || []).map(l => ({
    locationId: l.location_id, name: l.location_name, storeId: l.store_id, storeName: l.store_name,
    regionId: l.notification_region_id, address1: l.street_address, city: l.city, province: l.province,
    postal: l.postal_code, country: l.country, taxRate: l.tax_rate_1, taxLabel: l.tax_label_1,
    geocodeStatus: l.geocode_status, status: l.status, staffCount: Number(l.staff_count) || 0,
    inventoryCount: Number(l.inventory_count) || 0,
    services: { tradeIns: l.trade_ins, pickup: l.pickup, dropoff: l.dropoff, layaway: l.layaway, preorders: l.preorders },
  }))
}

const scopeArgs = (orgId, scope = {}) => ({
  p_org_id: orgId,
  p_region_id: scope.regionId || null,
  p_store_id: scope.storeId || null,
  p_location_id: scope.locationId || null,
})
export async function createOrgLocation(storeId, loc) {
  const { data, error } = await supabase.rpc('create_org_location', {
    p_store_id: storeId, p_name: loc.name || 'Location', p_address1: loc.address1 || null, p_address2: loc.address2 || null,
    p_city: loc.city || null, p_province: loc.province || null, p_postal: loc.postal || null, p_country: loc.country || 'Canada',
    p_phone: loc.phone || null, p_time_zone: loc.timeZone || null, p_currency: loc.currency || 'CAD',
    p_tax_rate: loc.taxRate ?? null, p_tax_label: loc.taxLabel || null, p_latitude: loc.latitude ?? null, p_longitude: loc.longitude ?? null,
  })
  if (error) throw new Error(error.message)
  return data
}
export async function orgStaff(orgId, { scope = {}, search = '', role = null, status = null } = {}) {
  if (!orgId) return []
  const { data, error } = await supabase.rpc('org_staff', {
    ...scopeArgs(orgId, scope),
    p_search: search?.trim() || null,
    p_role: role || null,
    p_status: status || null,
  })
  if (error) { console.error('org_staff error:', error); return [] }
  return (data || []).map(e => ({
    id: e.id, firstName: e.first_name, lastName: e.last_name, username: e.username, role: e.role,
    status: e.status, storeId: e.store_id, storeName: e.store_name, allLocations: e.all_locations, lastLogin: e.last_login,
  }))
}
export async function orgInventoryKpis(orgId, scope = {}) {
  const { data, error } = await supabase.rpc('org_inventory_kpis', {
    ...scopeArgs(orgId, scope),
    p_category_id: scope.categoryId || null,
    p_condition: scope.condition || null,
    p_availability: scope.availability || null,
    p_low_stock: !!scope.lowStock,
    p_reserved: !!scope.reserved,
    p_transfer_status: scope.transferStatus || null,
  })
  if (error) { console.error('org_inventory_kpis error:', error); return {} }
  return data || {}
}
export async function orgInventory(orgId, { scope = {}, search = '', lowStock = false, categoryId = null, condition = null, availability = null, reserved = false, transferStatus = null, limit = 50, offset = 0 } = {}) {
  if (!orgId) return []
  const { data, error } = await supabase.rpc('org_inventory', {
    ...scopeArgs(orgId, scope),
    p_search: search?.trim() || null,
    p_category_id: categoryId || null,
    p_condition: condition || null,
    p_availability: availability || null,
    p_low_stock: lowStock,
    p_reserved: reserved,
    p_transfer_status: transferStatus || null,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) { console.error('org_inventory error:', error); return [] }
  return (data || []).map(r => ({
    inventoryId: r.inventory_id, name: r.name, sku: r.sku, condition: r.condition, grade: r.grade,
    storeId: r.store_id, storeName: r.store_name, locationName: r.location_name || null,
    category: r.category || null, onHand: Number(r.on_hand) || 0, reserved: Number(r.reserved) || 0,
    available: Number(r.available) || 0, sellPrice: r.sell_price, listed: r.listed,
  }))
}
export async function listOrgTransfers(orgId, status) {
  if (!orgId) return []
  const { data, error } = await supabase.rpc('list_org_transfers', { p_org_id: orgId, p_status: status || null })
  if (error) { console.error('list_org_transfers error:', error); return [] }
  return (data || []).map(t => ({ id: t.id, item: t.item, from: t.from_location, to: t.to_location, quantity: t.quantity, status: t.status, createdAt: t.created_at }))
}
export async function requestInventoryTransfer(inventoryId, fromLocation, toLocation, quantity, notes) {
  const { error } = await supabase.rpc('request_inventory_transfer', { p_inventory_id: inventoryId, p_from_location: fromLocation, p_to_location: toLocation, p_quantity: quantity, p_notes: notes || null })
  if (error) throw new Error(error.message)
}
export async function setTransferStatus(transferId, status) {
  const { error } = await supabase.rpc('set_transfer_status', { p_transfer_id: transferId, p_status: status })
  if (error) throw new Error(error.message)
}

// ── Phase 2 head-office modules: Orders / Trade-Ins / Sales ─────────────────
export async function orgOrderKpis(orgId, scope = {}) {
  const { data, error } = await supabase.rpc('org_order_kpis', {
    ...scopeArgs(orgId, scope),
    p_order_type: scope.orderType || null,
    p_status: scope.status || null,
    p_date_from: scope.dateFrom || null,
    p_date_to: scope.dateTo || null,
    p_due_from: scope.dueFrom || null,
    p_due_to: scope.dueTo || null,
    p_release_from: scope.releaseFrom || null,
    p_release_to: scope.releaseTo || null,
  })
  if (error) { console.error('org_order_kpis error:', error); return {} }
  return data || {}
}
export async function orgOrders(orgId, { scope = {}, type = null, status = null, search = '', limit = 50, offset = 0 } = {}) {
  if (!orgId) return []
  const { data, error } = await supabase.rpc('org_orders', {
    ...scopeArgs(orgId, scope),
    p_order_type: type || scope.orderType || null,
    p_status: status || scope.status || null,
    p_date_from: scope.dateFrom || null,
    p_date_to: scope.dateTo || null,
    p_due_from: scope.dueFrom || null,
    p_due_to: scope.dueTo || null,
    p_release_from: scope.releaseFrom || null,
    p_release_to: scope.releaseTo || null,
    p_search: search?.trim() || null,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) { console.error('org_orders error:', error); return [] }
  return (data || []).map(o => ({ id: o.id, number: o.order_number, type: o.order_type, customer: o.customer, storeName: o.store_name, locationName: o.location_name, total: Number(o.total) || 0, paid: Number(o.amount_paid) || 0, balance: Number(o.balance_due) || 0, status: o.status, dueDate: o.due_date, releaseDate: o.release_date, createdAt: o.created_at }))
}
export async function orgTradeinKpis(orgId, scope = {}) {
  const { data, error } = await supabase.rpc('org_tradein_kpis', {
    ...scopeArgs(orgId, scope),
    p_employee_id: scope.employeeId || null,
    p_date_from: scope.dateFrom || null,
    p_date_to: scope.dateTo || null,
    p_payout_kind: scope.payoutKind || null,
    p_approval_status: scope.approvalStatus || null,
  })
  if (error) { console.error('org_tradein_kpis error:', error); return {} }
  return data || {}
}
export async function orgTradeins(orgId, { scope = {}, limit = 50, offset = 0 } = {}) {
  if (!orgId) return []
  const { data, error } = await supabase.rpc('org_tradeins', {
    ...scopeArgs(orgId, scope),
    p_employee_id: scope.employeeId || null,
    p_date_from: scope.dateFrom || null,
    p_date_to: scope.dateTo || null,
    p_payout_kind: scope.payoutKind || null,
    p_approval_status: scope.approvalStatus || null,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) { console.error('org_tradeins error:', error); return [] }
  return (data || []).map(t => ({ id: t.id, number: t.transaction_number, seller: t.seller, storeName: t.store_name, locationName: t.location_name, employee: t.employee, items: Number(t.items) || 0, amount: Number(t.amount) || 0, tradeCredit: Number(t.trade_credit) || 0, idVerified: t.id_verified, status: t.status, createdAt: t.created_at }))
}
export async function orgSalesKpis(orgId, scope = {}) {
  const { data, error } = await supabase.rpc('org_sales_kpis', {
    ...scopeArgs(orgId, scope),
    p_date_from: scope.dateFrom || null,
    p_date_to: scope.dateTo || null,
    p_category_id: scope.categoryId || null,
    p_employee_id: scope.employeeId || null,
    p_payment_method: scope.paymentMethod || null,
    p_promotion_id: scope.promotionId || null,
    p_transaction_type: scope.transactionType || null,
  })
  if (error) { console.error('org_sales_kpis error:', error); return {} }
  return data || {}
}
export async function orgSalesByStore(orgId, days = 30, scope = {}) {
  if (!orgId) return []
  const { data, error } = await supabase.rpc('org_sales_by_store', {
    ...scopeArgs(orgId, scope),
    p_days: days,
    p_date_from: scope.dateFrom || null,
    p_date_to: scope.dateTo || null,
    p_category_id: scope.categoryId || null,
    p_employee_id: scope.employeeId || null,
    p_payment_method: scope.paymentMethod || null,
    p_promotion_id: scope.promotionId || null,
    p_transaction_type: scope.transactionType || null,
  })
  if (error) { console.error('org_sales_by_store error:', error); return [] }
  return (data || []).map(r => ({ storeId: r.store_id, storeName: r.store_name, transactions: Number(r.transactions) || 0, sales: Number(r.sales) || 0, avgBasket: Number(r.avg_basket) || 0 }))
}

// ── Phase 3/4 head-office modules ──────────────────────────────────────────
export async function orgPromotionsEvents(orgId, { scope = {}, status = null, kind = null, limit = 100, offset = 0 } = {}) {
  if (!orgId) return []
  const { data, error } = await supabase.rpc('org_promotions_events', {
    ...scopeArgs(orgId, scope),
    p_status: status || null,
    p_kind: kind || null,
    p_date_from: scope.dateFrom || null,
    p_date_to: scope.dateTo || null,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) { console.error('org_promotions_events error:', error); return [] }
  return (data || []).map(r => ({
    id: r.id, title: r.title, kind: r.kind, status: r.status, storeName: r.store_name,
    locationName: r.location_name, regionName: r.region_name, startsAt: r.starts_at,
    endsAt: r.ends_at, discountSummary: r.discount_summary, description: r.description,
  }))
}

export async function saveOrgPromotionEvent(orgId, item) {
  const { data, error } = await supabase.rpc('save_org_promotion_event', {
    p_org_id: orgId,
    p_id: item.id || null,
    p_region_id: item.regionId || null,
    p_store_id: item.storeId || null,
    p_location_id: item.locationId || null,
    p_kind: item.kind || 'promotion',
    p_title: item.title,
    p_status: item.status || 'draft',
    p_starts_at: item.startsAt || null,
    p_ends_at: item.endsAt || null,
    p_discount_summary: item.discountSummary || null,
    p_description: item.description || null,
  })
  if (error) throw new Error(error.message)
  return data
}

export async function orgPolicies(orgId, { scope = {}, type = null, status = null, limit = 100, offset = 0 } = {}) {
  if (!orgId) return []
  const { data, error } = await supabase.rpc('org_policies', {
    ...scopeArgs(orgId, scope),
    p_policy_type: type || null,
    p_status: status || null,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) { console.error('org_policies error:', error); return [] }
  return data || []
}

export async function saveOrgPolicy(orgId, policy) {
  const { data, error } = await supabase.rpc('save_org_policy', {
    p_org_id: orgId,
    p_id: policy.id || null,
    p_region_id: policy.regionId || null,
    p_store_id: policy.storeId || null,
    p_location_id: policy.locationId || null,
    p_policy_type: policy.policyType || 'general',
    p_title: policy.title,
    p_body: policy.body || null,
    p_status: policy.status || 'draft',
    p_effective_at: policy.effectiveAt || null,
  })
  if (error) throw new Error(error.message)
  return data
}

export async function orgReportSummary(orgId, scope = {}) {
  if (!orgId) return {}
  const { data, error } = await supabase.rpc('org_report_summary', {
    ...scopeArgs(orgId, scope),
    p_date_from: scope.dateFrom || null,
    p_date_to: scope.dateTo || null,
  })
  if (error) { console.error('org_report_summary error:', error); return {} }
  return data || {}
}

export async function orgIntegrations(orgId) {
  if (!orgId) return []
  const { data, error } = await supabase.rpc('org_integrations', { p_org_id: orgId })
  if (error) { console.error('org_integrations error:', error); return [] }
  return data || []
}

export async function saveOrgIntegration(orgId, integration) {
  const { data, error } = await supabase.rpc('save_org_integration', {
    p_org_id: orgId,
    p_id: integration.id || null,
    p_provider: integration.provider,
    p_status: integration.status || 'disabled',
    p_config: integration.config || {},
  })
  if (error) throw new Error(error.message)
  return data
}

export async function updateLocationAddress(locationId, addr) {
  const { error } = await supabase.rpc('update_location_address', {
    p_location_id: locationId, p_address1: addr.address1 || null, p_address2: addr.address2 || null,
    p_city: addr.city || null, p_province: addr.province || null, p_postal: addr.postal || null,
    p_country: addr.country || 'Canada',
  })
  if (error) throw new Error(error.message)
}

export async function myUnattachedStores() {
  const { data, error } = await supabase.rpc('my_unattached_stores')
  if (error) { console.error('my_unattached_stores error:', error); return [] }
  return (data || []).map(r => ({ storeId: r.store_id, storeCode: r.store_code, storeName: r.store_name }))
}

export async function attachStoreToOrganization(storeId, orgId) {
  const { error } = await supabase.rpc('set_store_organization', { p_store_id: storeId, p_org_id: orgId })
  if (error) throw new Error(error.message)
}

export async function detachStoreFromOrganization(storeId) {
  const { error } = await supabase.rpc('set_store_organization', { p_store_id: storeId, p_org_id: null })
  if (error) throw new Error(error.message)
}

// ── Applications ────────────────────────────────────────────────────────────
export async function submitOrganizationApplication(name, details) {
  const { data, error } = await supabase.rpc('submit_organization_application', { p_name: name, p_details: details || null })
  if (error) throw new Error(error.message)
  return data
}

export async function myOrganizationApplication() {
  const { data, error } = await supabase.rpc('my_organization_application')
  if (error) { console.error('my_organization_application error:', error); return null }
  return data || null
}

// ── Org-provisioned stores ──────────────────────────────────────────────────
export async function createStoreUnderOrganization(orgId, storeName) {
  const { data, error } = await supabase.rpc('create_store_under_organization', { p_org_id: orgId, p_store_name: storeName })
  if (error) throw new Error(error.message)
  return data // { store_id, store_code }
}

// ── Store employees (POS logins) ────────────────────────────────────────────
// Role → POS capability (mirrors ROLE_ACTIONS in pos.js: manager/owner get all).
export const ORG_EMPLOYEE_ROLES = [['manager', 'Manager'], ['cashier', 'Cashier'], ['assistant_manager', 'Assistant Manager']]

export async function listStoreEmployees(storeId) {
  if (!storeId) return []
  const { data, error } = await supabase.from('store_employees')
    .select('id, first_name, last_name, username, role, status')
    .eq('store_id', storeId).order('created_at')
  if (error) { console.error('listStoreEmployees error:', error); return [] }
  return data || []
}

// Provision a POS login for a store. Store employees use an internal auth email
// behind Store Code + Username + PIN, so the Edge Function creates the auth user
// as email-confirmed with the service role.
export async function createStoreEmployee({
  storeId,
  firstName,
  lastName,
  role = 'cashier',
  pin,
  permissions = {},
  allLocations = true,
  locationIds = [],
}) {
  if (!storeId) throw new Error('Missing store.')
  if (!firstName?.trim() || !lastName?.trim()) throw new Error('First and last name are required.')
  if (!pin || pin.trim().length < 4) throw new Error('PIN must be at least 4 characters.')

  const { data, error } = await supabase.functions.invoke('create-store-employee', {
    body: {
      storeId,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      role,
      pin: pin.trim(),
      permissions,
      allLocations,
      locationIds,
    },
  })
  if (error || data?.error) {
    // The function isn't deployed in Supabase (404, or the request never got through).
    if (!data?.error && (/failed to send a request/i.test(error?.message || '') || error?.context?.status === 404)) {
      throw new Error('Adding staff needs the "create-store-employee" Edge Function, which isn’t deployed in Supabase yet.')
    }
    let message = data?.error || error?.message || 'Could not create the employee account.'
    if (!data?.error && error?.context?.json) {
      try {
        const body = await error.context.json()
        message = body?.error || message
      } catch {
        // Supabase may already have consumed the function response body.
      }
    }
    throw new Error(message)
  }

  return {
    id: data.employee?.id,
    username: data.username || data.employee?.username,
    role: data.employee?.role,
    storeCode: data.storeCode,
    employee: data.employee,
  }
}

// ── Organization category scope (what the org deals in) ─────────────────────
// Empty allow-list = unrestricted (sells/sees everything). Powers the POS
// catalogue picker filter and collector-facing listing scope.
export async function orgAllowedCategories(orgId) {
  if (!orgId) return []
  const { data } = await supabase.rpc('organization_categories', { p_org_id: orgId })
  return (data || []).map((r) => ({ id: r.category_id, name: r.name }))
}
export async function setOrgAllowedCategories(orgId, categoryIds) {
  const { error } = await supabase.rpc('set_organization_categories', { p_org_id: orgId, p_category_ids: categoryIds })
  if (error) throw new Error(error.message)
}
export async function allCatalogueCategories() {
  const { data } = await supabase.from('categories').select('category_id, name').order('name')
  return (data || []).map((r) => ({ id: r.category_id, name: r.name }))
}

// ── From the website's pos.js ─────────────────────────────────────────────
export const PROVINCE_TAX = {
  AB: { rate: 0.05,    label: 'GST' },
  BC: { rate: 0.12,    label: 'GST+PST' },
  MB: { rate: 0.12,    label: 'GST+RST' },
  NB: { rate: 0.15,    label: 'HST' },
  NL: { rate: 0.15,    label: 'HST' },
  NS: { rate: 0.14,    label: 'HST' },
  NT: { rate: 0.05,    label: 'GST' },
  NU: { rate: 0.05,    label: 'GST' },
  ON: { rate: 0.13,    label: 'HST' },
  PE: { rate: 0.15,    label: 'HST' },
  QC: { rate: 0.14975, label: 'GST+QST' },
  SK: { rate: 0.11,    label: 'GST+PST' },
  YT: { rate: 0.05,    label: 'GST' },
}
// Returns { rate (fraction), label } for a province code, or null if unknown.
export function taxForProvince(province) {
  if (!province) return null
  return PROVINCE_TAX[String(province).trim().toUpperCase()] || null
}

export async function loadStoreLocations(storeId) {
  if (!storeId) return []
  const { data, error } = await supabase.rpc('list_store_locations', { p_store_id: storeId })
  if (error) { console.error('list_store_locations error:', error); return [] }
  return data || []
}
