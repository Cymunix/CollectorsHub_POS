import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Archive,
  ArrowRight,
  BarChart3,
  Banknote,
  Boxes,
  Building2,
  CircleDollarSign,
  CreditCard,
  EyeOff,
  Gift,
  History,
  Home,
  Keyboard,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  MapPin,
  Minus,
  PackageSearch,
  Pause,
  Plus,
  ReceiptText,
  RefreshCw,
  ScanLine,
  Search,
  Settings,
  ShoppingCart,
  Store,
  Tag,
  Trash2,
  User,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import './styles.css'
import AdminWorkspace from './AdminWorkspace'
import StoreScanIntake from './StoreScanIntake'
import { analyseRecognizedCard } from './lib/adminData'
import { signInAdmin, signInStaff, signOutSupabase } from './lib/auth'
import { calcLocationTax, closeRegisterShift, completeDesktopCheckout, completeDesktopRefund, loadActiveStorePromotions, loadReceiptBranding, loadRegisterLocation, openRegisterShift, searchDesktopTradeCatalogue, verifyRegisterManagerApproval } from './lib/registerBackend'
import { syncCustomersFromSupabase, syncInventoryFromSupabase } from './lib/sync'
import { supabase } from './lib/supabaseClient'

const emptyStore = {
  meta: { version: 1 },
  register: { status: 'closed', cashFloat: 0, openedAt: null },
  inventory: [],
  customers: [],
  transactions: [],
  scanSessions: [],
  sync: {
    online: true,
    lastSyncAt: null,
    inventoryCount: 0,
    pendingLocalChanges: 0,
    error: '',
  },
}

const money = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
})

const REFUND_APPROVAL_THRESHOLD = 50

function roundCanadianCash(amount) {
  return Math.round((Number(amount || 0) + Number.EPSILON) * 20) / 20
}

const browserStoreKey = 'collectorshub-desktop-preview-store'
const AUTO_LOGOUT_MS = 30 * 60 * 1000
const defaultStaffLogin = {
  orgCode: 'NOR001',
  username: 'HaydenM8',
  password: '181222',
}
// Store codes whose register data is kept in memory only (fake sales, no
// shifts, nothing saved). Empty: NOR001 (Nordvik Test Store) now runs live
// like any store, kept apart in Supabase instead - stores.is_test_store marks
// its sales as test data (excluded from in-store prices and sales history)
// and store_settings hides the store and its stock from the public website.
const transientStoreCodes = new Set([])
const storeOpeningCashByCode = {
  NOR001: 300,
}

const generalRetailCategories = [
  'General Merchandise',
  'Supplies',
  'Accessories',
  'Apparel',
  'Food & Drink',
  'Books & Media',
  'Electronics',
  'Services',
  'Other',
]

function isCollectibleCategory(category) {
  const text = String(category || '').toLowerCase()
  return /card|lego|building|comic|coin|collectible|memorabilia|video game|game|toy|figure/.test(text)
}

function desktopApi() {
  if (window.nordvikDesktop) return window.nordvikDesktop

  return {
    async loadStore() {
      try {
        return JSON.parse(window.localStorage.getItem(browserStoreKey) || 'null') || emptyStore
      } catch {
        return emptyStore
      }
    },
    async saveStore(store) {
      window.localStorage.setItem(browserStoreKey, JSON.stringify(store))
      return store
    },
    async getDataPath() {
      return 'Browser preview storage'
    },
    async getVersion() {
      return 'dev'
    },
    async exitApp() {
      window.close()
    },
    async selectScanImages() {
      return []
    },
    async scanImage() {
      throw new Error('Direct scanner control is only available in the installed Windows desktop app.')
    },
    async recognizeCard() {
      throw new Error('Local AI card recognition is only available in the installed Windows desktop app.')
    },
    async listEbayItem() {
      throw new Error('eBay listing is only available in the installed desktop app after eBay seller API setup.')
    },
  }
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function registerRetailPrice(item) {
  return Number(item?.inStorePrice ?? item?.price ?? item?.unitPrice ?? 0)
}

function getDefaultOpeningCashForSession(session) {
  const storeCode = String(session?.storeCode || '').trim().toUpperCase()
  return Number(storeOpeningCashByCode[storeCode] || 0)
}

function isTransientStoreSession(session) {
  const storeCode = String(session?.storeCode || session?.orgCode || '').trim().toUpperCase()
  return transientStoreCodes.has(storeCode)
}

function getRegisterOpeningCash(register, session) {
  const savedCash = Number(register?.cashFloat || 0)
  return savedCash > 0 ? savedCash : getDefaultOpeningCashForSession(session)
}

function App() {
  const [activeView, setActiveView] = useState('register')
  const [store, setStore] = useState(emptyStore)
  // Latest store for saves made from long-running screens (store scan intake).
  const storeRef = useRef(store)
  storeRef.current = store
  const [isLoaded, setIsLoaded] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [dataPath, setDataPath] = useState('')
  const [search, setSearch] = useState('')
  const [cart, setCart] = useState([])
  const [pendingRegisterItem, setPendingRegisterItem] = useState(null)
  const [registerHasDraft, setRegisterHasDraft] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [authSession, setAuthSession] = useState(null)
  // The app's own sign-in state outlives the Supabase token behind it. If the
  // token can't be renewed (sleep, network drop, revoked), every save runs as
  // an anonymous request and is refused by row-level security, so say so.
  const [authExpired, setAuthExpired] = useState(false)
  const signingOutRef = useRef(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState(emptyStore.sync)
  const [appVersion, setAppVersion] = useState('')
  const [registerLocation, setRegisterLocation] = useState(null)
  const [receiptBranding, setReceiptBranding] = useState(null)
  const [loginMode, setLoginMode] = useState('staff')
  const [loginError, setLoginError] = useState('')
  const [loginDraft, setLoginDraft] = useState({
    orgCode: '',
    username: '',
    password: '',
  })

  useEffect(() => {
    let cancelled = false

    async function load() {
      const [loadedStore, loadedPath, loadedVersion] = await Promise.all([
        desktopApi().loadStore(),
        desktopApi().getDataPath(),
        desktopApi().getVersion(),
      ])

      if (!cancelled) {
        const nextStore = { ...emptyStore, ...(loadedStore || {}) }
        nextStore.sync = { ...emptyStore.sync, ...(loadedStore?.sync || {}) }
        nextStore.scanSessions = loadedStore?.scanSessions || []
        setStore(nextStore)
        setSyncStatus(nextStore.sync)
        setDataPath(loadedPath)
        setAppVersion(loadedVersion || '')
        setIsLoaded(true)
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [])

  async function persist(nextStore) {
    const mergedStore = { ...nextStore, sync: { ...emptyStore.sync, ...(nextStore.sync || {}) } }
    setStore(mergedStore)
    setSyncStatus(mergedStore.sync)
    if (isTransientStoreSession(authSession)) {
      return mergedStore
    }
    setIsSaving(true)
    try {
      const savedStore = await desktopApi().saveStore(mergedStore)
      setStore(savedStore)
      setSyncStatus({ ...emptyStore.sync, ...(savedStore.sync || {}) })
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSyncNow() {
    if (!authSession) return
    const online = typeof navigator === 'undefined' ? true : navigator.onLine

    const startingSync = {
      ...emptyStore.sync,
      ...(store.sync || {}),
      ...syncStatus,
      online,
      error: online ? '' : 'Offline. Showing last synced inventory.',
    }
    setSyncStatus(startingSync)
    if (!online) {
      await persist({ ...store, sync: startingSync })
      return
    }

    setIsSyncing(true)
    try {
      const [result, customers] = await Promise.all([
        syncInventoryFromSupabase(authSession),
        syncCustomersFromSupabase(authSession),
      ])
      const nextSync = {
        online: true,
        lastSyncAt: result.status.completedAt,
        inventoryCount: result.inventory.length,
        pendingLocalChanges: Number(store.sync?.pendingLocalChanges) || 0,
        error: '',
        context: result.context,
        failedRecords: result.status.failedRecords || [],
      }
      await persist({ ...store, inventory: result.inventory, customers, sync: nextSync })
    } catch (error) {
      console.error('[Desktop Sync] Failed:', error)
      const failedSync = {
        ...emptyStore.sync,
        ...(store.sync || {}),
        ...syncStatus,
        online,
        error: error?.message || 'Sync failed.',
      }
      await persist({ ...store, sync: failedSync })
    } finally {
      setIsSyncing(false)
    }
  }

  const inventoryValue = useMemo(() => (
    store.inventory.reduce((total, item) => total + Number(item.price || 0) * Number(item.quantity || 0), 0)
  ), [store.inventory])

  const todaysSales = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)
    return store.transactions
      .filter((transaction) => transaction.createdAt?.startsWith(today))
      .reduce((total, transaction) => total + Number(transaction.total || 0), 0)
  }, [store.transactions])

  const registerMetrics = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)
    const openedAt = store.register?.openedAt || null
    const transactions = store.transactions.filter((transaction) => {
      const createdAt = transaction.createdAt || ''
      if (openedAt && createdAt) return createdAt >= openedAt
      return createdAt.startsWith(today)
    })

    const saleTransactions = transactions.filter((transaction) => (
      transaction.type !== 'buy' && (transaction.items || []).some((item) => item.direction !== 'incoming')
    ))

    const salesToday = saleTransactions.reduce((total, transaction) => total + Number(transaction.total || 0), 0)
    const itemsSold = saleTransactions.reduce((total, transaction) => (
      total + (transaction.items || [])
        .filter((item) => item.direction !== 'incoming')
        .reduce((sum, item) => sum + Number(item.quantity || 0), 0)
    ), 0)
    const transactionCount = saleTransactions.length
    const openingCash = getRegisterOpeningCash(store.register, authSession)
    const cashDelta = transactions.reduce((total, transaction) => {
      const cashPayments = (transaction.payments || [])
        .filter((payment) => payment.method === 'cash')
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
      const cashPayout = transaction.payout?.method === 'cash' ? Number(transaction.payout.amount || 0) : 0
      return total + cashPayments - cashPayout
    }, 0)

    return {
      salesToday,
      transactionCount,
      itemsSold,
      registerBalance: openingCash + cashDelta,
    }
  }, [authSession, store.register, store.transactions])

  function addToCart(item) {
    setCart((currentCart) => {
      const existing = currentCart.find((cartItem) => cartItem.id === item.id)
      if (existing) {
        return currentCart.map((cartItem) => (
          cartItem.id === item.id
            ? { ...cartItem, quantity: Math.min(cartItem.quantity + 1, Number(item.quantity || 0)) }
            : cartItem
        ))
      }

      return [...currentCart, { ...item, quantity: 1 }]
    })
  }

  function removeFromCart(itemId) {
    setCart((currentCart) => currentCart.filter((item) => item.id !== itemId))
  }

  async function updateInventoryItem(itemId, patch) {
    const nextSync = {
      ...syncStatus,
      pendingLocalChanges: Number(syncStatus?.pendingLocalChanges || 0) + 1,
    }
    const nextInventory = (store.inventory || []).map((item) => (
      item.id === itemId
        ? { ...item, ...patch, syncedAt: patch.syncedAt || new Date().toISOString() }
        : item
    ))
    await persist({ ...store, inventory: nextInventory, sync: nextSync })
  }

  async function createInventoryItem(draft) {
    const now = new Date().toISOString()
    const quantity = Math.max(0, Number(draft.quantityAvailable ?? draft.quantity ?? draft.available ?? 0))
    const item = {
      id: createId('inventory'),
      inventoryId: '',
      catalogItemId: '',
      name: String(draft.name || draft.title || 'New item').trim(),
      title: String(draft.name || draft.title || 'New item').trim(),
      sku: String(draft.sku || '').trim(),
      barcode: String(draft.barcode || '').trim(),
      category: String(draft.category || 'General Merchandise').trim(),
      itemType: String(draft.itemType || 'general').trim(),
      condition: String(draft.condition || 'New').trim(),
      cost: Number(draft.cost || 0),
      buyPrice: Number(draft.cost || 0),
      inStorePrice: Number(draft.inStorePrice || 0),
      onlinePrice: Number(draft.onlinePrice || draft.inStorePrice || 0),
      price: Number(draft.inStorePrice || 0),
      quantity,
      quantityAvailable: quantity,
      available: quantity,
      onHand: quantity,
      reserved: 0,
      hasExplicitPrice: Number(draft.inStorePrice || draft.onlinePrice || 0) > 0,
      hasOnlineDraft: false,
      listedForSale: false,
      listingApproved: false,
      isTradeIn: false,
      isGeneralRetail: !isCollectibleCategory(draft.category),
      syncedAt: now,
      createdAt: now,
    }
    const nextSync = {
      ...syncStatus,
      pendingLocalChanges: Number(syncStatus?.pendingLocalChanges || 0) + 1,
    }
    await persist({ ...store, inventory: [...(store.inventory || []), item], sync: nextSync })
    return item
  }

  function requestNavigate(nextView) {
    if (nextView === activeView) return
    if (activeView === 'register' && registerHasDraft) {
      const shouldLeave = window.confirm('Leaving will erase the current transaction. Leave Register and erase this transaction?')
      // Native confirm() can leave Electron unable to take keystrokes on Windows.
      window.nordvikDesktop?.refocusWindow?.()
      if (!shouldLeave) return
      setRegisterHasDraft(false)
    }
    setActiveView(nextView)
  }

  async function completeRegisterTransaction(draft) {
    const online = typeof navigator === 'undefined' ? true : navigator.onLine
    const isTransientStore = isTransientStoreSession(authSession)
    if (!isTransientStore && !online) {
      throw new Error('Offline. This Register cannot mark a sale complete until Supabase commits the transaction.')
    }

    const backendResult = isTransientStore
      ? {
        transaction_id: createId('test_txn'),
        transaction_number: `TEST-${String(store.transactions.length + 1).padStart(6, '0')}`,
      }
      : await completeDesktopCheckout(authSession, draft)
    const transaction = {
      ...draft,
      id: backendResult?.transaction_id || createId('txn'),
      checkoutGroupId: backendResult?.checkout_group_id || null,
      checkoutGroupNumber: backendResult?.group_number || null,
      number: backendResult?.transaction_number || `CH-${String(store.transactions.length + 1).padStart(6, '0')}`,
      storeId: authSession?.storeId || store.sync?.context?.storeId || '',
      locationId: authSession?.locationId || store.sync?.context?.locationId || '',
      employeeId: authSession?.employeeId || '',
      employeeName: authSession?.username || authSession?.displayName || 'Employee',
      registerName: store.register?.name || 'Main Register',
      createdAt: new Date().toISOString(),
      transient: isTransientStore,
    }

    const [nextInventory, customers, nextSync] = isTransientStore
      ? [
        applyTransientInventoryChanges(store.inventory, draft.items || []),
        store.customers || [],
        {
          ...emptyStore.sync,
          ...(store.sync || {}),
          online: true,
          lastSyncAt: new Date().toISOString(),
          inventoryCount: store.inventory.length,
          pendingLocalChanges: 0,
          error: '',
          context: {
            ...(store.sync?.context || {}),
            storeCode: authSession?.storeCode || '',
            storeId: authSession?.storeId || '',
            locationId: authSession?.locationId || '',
          },
          failedRecords: [],
        },
      ]
      : await Promise.all([
        syncInventoryFromSupabase(authSession),
        syncCustomersFromSupabase(authSession),
      ]).then(([syncResult, syncedCustomers]) => [
        syncResult.inventory,
        syncedCustomers,
        {
          online: true,
          lastSyncAt: syncResult.status.completedAt,
          inventoryCount: syncResult.inventory.length,
          pendingLocalChanges: 0,
          error: '',
          context: syncResult.context,
          failedRecords: syncResult.status.failedRecords || [],
        },
      ])

    const nextScanSessions = draft.scanSessionId
      ? (store.scanSessions || []).map((session) => (
        session.id === draft.scanSessionId
          ? { ...session, status: 'complete', linkedTransactionId: transaction.id, updatedAt: transaction.createdAt }
          : session
      ))
      : store.scanSessions

    await persist({
      ...store,
      inventory: nextInventory,
      customers,
      transactions: [transaction, ...store.transactions],
      scanSessions: nextScanSessions,
      sync: nextSync,
    })

    return transaction
  }

  async function completeRegisterRefund(draft) {
    const isTransientStore = isTransientStoreSession(authSession)
    const result = isTransientStore
      ? {
        transaction_id: createId('test_refund'),
        transaction_number: `TEST-REF-${String(store.transactions.length + 1).padStart(6, '0')}`,
      }
      : await completeDesktopRefund(authSession, draft)
    const refundTransaction = {
      id: result?.transaction_id || createId('refund'),
      number: result?.transaction_number || `REF-${String(store.transactions.length + 1).padStart(6, '0')}`,
      type: 'refund',
      total: -Math.abs(Number(draft.refundAmount || 0)),
      subtotal: -Math.abs(Number(draft.refundAmount || 0)),
      tax: 0,
      items: [],
      payments: [{ method: draft.refundMethod || 'cash', amount: -Math.abs(Number(draft.refundAmount || 0)) }],
      originalTransactionId: draft.originalTransactionId,
      reason: draft.reason || '',
      employeeId: authSession?.employeeId || '',
      employeeName: authSession?.username || authSession?.displayName || 'Employee',
      storeId: authSession?.storeId || '',
      locationId: authSession?.locationId || '',
      approvedBy: draft.approvedBy || '',
      transient: isTransientStore,
      createdAt: new Date().toISOString(),
    }
    await persist({ ...store, transactions: [refundTransaction, ...store.transactions] })
    return refundTransaction
  }

  async function saveScanSessions(nextSessions) {
    await persist({ ...store, scanSessions: nextSessions })
  }

  async function toggleRegister() {
    const isOpen = store.register.status === 'open'
    const openingCash = getRegisterOpeningCash(store.register, authSession)
    const transientStore = isTransientStoreSession(authSession)
    if (!transientStore && isOpen && store.register.shiftId) {
      await closeRegisterShift(store.register.shiftId, { countedCash: openingCash })
    }
    let shift = null
    if (!transientStore && !isOpen && authSession?.storeId && authSession?.locationId && (typeof navigator === 'undefined' || navigator.onLine)) {
      shift = await openRegisterShift(authSession, {
        openingCash,
        registerName: store.register.name || 'Till 1',
      })
    }
    persist({
      ...store,
      register: {
        ...store.register,
        cashFloat: openingCash,
        status: isOpen ? 'closed' : 'open',
        openedAt: isOpen ? null : new Date().toISOString(),
        shiftId: isOpen ? null : (shift?.id || store.register.shiftId || null),
      },
    })
  }

  async function handleLogin(event) {
    event.preventDefault()
    setIsAuthenticating(true)
    setLoginError('')

    try {
      const staffDraft = {
        orgCode: loginDraft.orgCode.trim() || defaultStaffLogin.orgCode,
        username: loginDraft.username.trim() || defaultStaffLogin.username,
        password: loginDraft.password || defaultStaffLogin.password,
      }
      const session = loginMode === 'admin'
        ? await signInAdmin({ email: loginDraft.username, password: loginDraft.password })
        : await signInStaff({
          code: staffDraft.orgCode,
          username: staffDraft.username,
          password: staffDraft.password,
        })

      setAuthSession(session)
      if (isTransientStoreSession(session)) {
        const transientStore = {
          ...emptyStore,
          meta: store.meta,
          register: {
            ...emptyStore.register,
            cashFloat: getDefaultOpeningCashForSession(session),
          },
          sync: {
            ...emptyStore.sync,
            online: typeof navigator === 'undefined' ? true : navigator.onLine,
            context: {
              storeCode: session.storeCode || '',
              storeId: session.storeId || '',
              locationId: session.locationId || '',
            },
          },
        }
        setStore(transientStore)
        setSyncStatus(transientStore.sync)
      }
      setIsAuthenticated(true)
      setLoginDraft({ orgCode: '', username: '', password: '' })
    } catch (error) {
      setLoginError(error?.message || 'Could not sign in.')
    } finally {
      setIsAuthenticating(false)
    }
  }

  // Keeps the Supabase sign-in alive while the app is open: renews on window
  // focus and every minute (the library's own timer can miss a renewal after
  // the PC sleeps), and flags when it can no longer be renewed.
  useEffect(() => {
    if (!isAuthenticated) return undefined
    let cancelled = false
    let hadSupabaseSession = false
    const markExpired = () => { if (!cancelled && hadSupabaseSession && !signingOutRef.current) setAuthExpired(true) }

    async function check() {
      const { data } = await supabase.auth.getSession().catch(() => ({ data: {} }))
      const current = data?.session
      if (!current) { markExpired(); return }
      hadSupabaseSession = true
      // Renew when under five minutes remain.
      if ((current.expires_at || 0) * 1000 - Date.now() < 5 * 60 * 1000) {
        const { data: refreshed, error } = await supabase.auth.refreshSession().catch((refreshError) => ({ data: {}, error: refreshError }))
        if (error || !refreshed?.session) { markExpired(); return }
      }
      if (!cancelled) setAuthExpired(false)
    }

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) { hadSupabaseSession = true; if (!cancelled) setAuthExpired(false) }
      else if (event === 'SIGNED_OUT') markExpired()
    })
    check()
    const timer = window.setInterval(check, 60 * 1000)
    const onFocus = () => { check() }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      listener?.subscription?.unsubscribe()
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [isAuthenticated])

  async function handleLogout() {
    const wasTransientStore = isTransientStoreSession(authSession)
    signingOutRef.current = true
    try {
      await signOutSupabase()
    } finally {
      signingOutRef.current = false
      setAuthExpired(false)
      setAuthSession(null)
      setIsAuthenticated(false)
      if (wasTransientStore) {
        const resetStore = { ...emptyStore, meta: store.meta }
        setStore(resetStore)
        setSyncStatus(resetStore.sync)
      }
      setActiveView('register')
      setCart([])
      setSearch('')
      setLoginError('')
    }
  }

  useEffect(() => {
    if (!isAuthenticated || !authSession) return undefined
    if (authSession.type === 'platform_admin') return undefined
    handleSyncNow()
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, authSession])

  useEffect(() => {
    if (!isAuthenticated || !authSession?.locationId || authSession.type === 'platform_admin') {
      setRegisterLocation(null)
      setReceiptBranding(null)
      return undefined
    }
    let cancelled = false
    loadRegisterLocation(authSession.locationId)
      .then((location) => {
        if (!cancelled) {
          setRegisterLocation(location)
          loadReceiptBranding(authSession, location).then((branding) => {
            if (!cancelled) setReceiptBranding(branding)
          })
        }
      })
      .catch((error) => {
        console.error('[Desktop Register] Location load failed:', error)
        if (!cancelled) setRegisterLocation(null)
      })
    return () => { cancelled = true }
  }, [isAuthenticated, authSession])

  useEffect(() => {
    const refreshOnlineStatus = () => {
      setSyncStatus((current) => ({ ...current, online: typeof navigator === 'undefined' ? true : navigator.onLine }))
    }

    window.addEventListener('online', refreshOnlineStatus)
    window.addEventListener('offline', refreshOnlineStatus)
    refreshOnlineStatus()

    return () => {
      window.removeEventListener('online', refreshOnlineStatus)
      window.removeEventListener('offline', refreshOnlineStatus)
    }
  }, [])

  useEffect(() => {
    if (!isAuthenticated) return undefined

    let logoutTimer = null
    const resetLogoutTimer = () => {
      window.clearTimeout(logoutTimer)
      logoutTimer = window.setTimeout(() => {
        handleLogout()
      }, AUTO_LOGOUT_MS)
    }

    const activityEvents = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'pointerdown']
    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, resetLogoutTimer, { passive: true })
    })
    resetLogoutTimer()

    return () => {
      window.clearTimeout(logoutTimer)
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, resetLogoutTimer)
      })
    }
  }, [isAuthenticated])

  if (!isLoaded) {
    return (
      <main className="loading-screen">
        <div>
          <strong>CollectorsHub Desktop</strong>
          <span>Preparing local store...</span>
        </div>
      </main>
    )
  }

  if (!isAuthenticated) {
    return (
      <LoginScreen
        draft={loginDraft}
        error={loginError}
        isAuthenticating={isAuthenticating}
        appVersion={appVersion}
        mode={loginMode}
        onChange={setLoginDraft}
        onClearError={() => setLoginError('')}
        onModeChange={(nextMode) => {
          setLoginMode(nextMode)
          setLoginError('')
        }}
        onSubmit={handleLogin}
      />
    )
  }

  const expiredBanner = authExpired ? (
    <div className="auth-expired-banner" role="alert">
      <span><strong>Your sign-in has expired.</strong> Changes can't be saved until you sign in again.</span>
      <button type="button" onClick={handleLogout}>Sign in again</button>
    </div>
  ) : null

  if (authSession?.type === 'platform_admin') {
    return (
      <>
        {expiredBanner}
        <AdminWorkspace
          session={authSession}
          syncStatus={syncStatus}
          onLogout={handleLogout}
        />
      </>
    )
  }

  return (
    <main className="app-shell">
      {expiredBanner}
      <aside className="sidebar">
        <div className="brand-block">
          <img className="brand-logo" src="/collectorshub-logo.png" alt="CollectorsHub" />
          <div>
            <strong>CollectorsHub</strong>
            <small>Collect. Track. Connect.</small>
          </div>
        </div>

        <nav className="nav-list" aria-label="Main">
          <NavButton icon={LayoutDashboard} label="Register" active={activeView === 'register'} onClick={() => requestNavigate('register')} />
          <NavButton icon={Boxes} label="Inventory" active={activeView === 'inventory'} onClick={() => requestNavigate('inventory')} />
          {authSession?.storeId ? <NavButton icon={ScanLine} label="Scan to Inventory" active={activeView === 'scan'} onClick={() => requestNavigate('scan')} /> : null}
          <NavButton icon={Users} label="Customers" active={activeView === 'customers'} onClick={() => requestNavigate('customers')} />
          <NavButton icon={ReceiptText} label="Transactions" active={activeView === 'transactions'} onClick={() => requestNavigate('transactions')} />
          <NavButton icon={BarChart3} label="Reports" active={activeView === 'reports'} onClick={() => requestNavigate('reports')} />
          <NavButton icon={Settings} label="Settings" active={activeView === 'settings'} onClick={() => requestNavigate('settings')} />
        </nav>

        <div className="sidebar-footer">
          <span className={store.register.status === 'open' ? 'status-pill open' : 'status-pill'}>
            {store.register.status === 'open' ? 'Register open' : 'Register closed'}
          </span>
          <small>{isSaving ? 'Saving...' : 'Local data saved'}</small>
          <small>{describeAuthSession(authSession)}</small>
          <button className="sidebar-logout" type="button" onClick={handleLogout}>
            <LogOut size={16} />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      <section className="workspace">
        {activeView !== 'register' && activeView !== 'inventory' && activeView !== 'scan' ? (
          <>
            <header className="topbar">
              <div>
                <h1>{viewTitle(activeView)}</h1>
              </div>
              <div className="topbar-actions">
                <button className="secondary-action" type="button" onClick={handleSyncNow} disabled={isSyncing}>
                  <RefreshIcon />
                  {isSyncing ? 'Syncing...' : 'Sync Now'}
                </button>
                <button className="primary-action" type="button" onClick={toggleRegister}>
                  <CircleDollarSign size={18} />
                  {store.register.status === 'open' ? 'Close Register' : 'Open Register'}
                </button>
              </div>
            </header>

            <SyncStatusPanel
              status={syncStatus}
              isSyncing={isSyncing}
              onDismissError={() => persist({ ...store, sync: { ...syncStatus, error: '' } })}
            />

            <section className="metric-row" aria-label="Store metrics">
              <Metric label="Today" value={money.format(todaysSales)} />
              <Metric label="Inventory Value" value={money.format(inventoryValue)} />
              <Metric label="Items" value={String(store.inventory.length)} />
              <Metric label="Transactions" value={String(store.transactions.length)} />
            </section>
          </>
        ) : null}

        {activeView === 'register' ? (
          <RegisterView
            authSession={authSession}
            customers={store.customers || []}
            inventory={store.inventory}
            isSyncing={isSyncing}
            pendingRegisterItem={pendingRegisterItem}
            onCompleteTransaction={completeRegisterTransaction}
            onCompleteRefund={completeRegisterRefund}
            onNavigate={requestNavigate}
            onPendingRegisterItemConsumed={() => setPendingRegisterItem(null)}
            onRegisterDraftChange={setRegisterHasDraft}
            transactions={store.transactions}
            onSyncNow={handleSyncNow}
            onToggleRegister={toggleRegister}
            register={store.register}
            registerLocation={registerLocation}
            receiptBranding={receiptBranding}
            syncStatus={syncStatus}
            todaysSales={todaysSales}
            inventoryValue={inventoryValue}
            transactionCount={store.transactions.length}
            registerMetrics={registerMetrics}
            scanSessions={store.scanSessions || []}
            onSaveScanSessions={saveScanSessions}
          />
        ) : null}

        {activeView === 'inventory' ? (
          <InventoryView
            inventory={store.inventory}
            isSyncing={isSyncing}
            onNavigate={requestNavigate}
            onSellItem={(item) => {
              setPendingRegisterItem({ ...item, handoffId: createId('register_handoff') })
              setActiveView('register')
            }}
            onSyncNow={handleSyncNow}
            onCreateItem={createInventoryItem}
            onUpdateItem={updateInventoryItem}
            search={search}
            setSearch={setSearch}
            syncStatus={syncStatus}
          />
        ) : null}

        {activeView === 'scan' ? (
          <StoreScanIntake
            session={authSession}
            savedQueue={store.storeScanQueue || []}
            onSaveQueue={(queue) => persist({ ...storeRef.current, storeScanQueue: queue })}
            onStockChanged={handleSyncNow}
          />
        ) : null}

        {activeView === 'dashboard' ? <PlaceholderView icon={Home} title="Dashboard" copy="Store operating overview, register status, daily sales, and urgent tasks will live here." /> : null}
        {activeView === 'catalog' ? <PlaceholderView icon={PackageSearch} title="Catalog" copy="Catalogue search, product records, category data, and item references will live here." /> : null}
        {activeView === 'customers' ? <PlaceholderView icon={Users} title="Customers" copy="Local customer profiles, store credit, trade notes, and purchase history will live here." /> : null}
        {activeView === 'transactions' ? <TransactionsView transactions={store.transactions} /> : null}
        {activeView === 'reports' ? <PlaceholderView icon={BarChart3} title="Reports" copy="Daily closeout, stock movement, margin, category performance, and tax summaries will live here." /> : null}
        {activeView === 'settings' ? <SettingsView dataPath={dataPath} /> : null}
      </section>
    </main>
  )
}

function LoginScreen({ appVersion, draft, error, isAuthenticating, mode, onChange, onClearError, onModeChange, onSubmit }) {
  const isAdminMode = mode === 'admin'

  function handleExit() {
    desktopApi().exitApp()
  }

  return (
    <main className="login-screen">
      <div className="login-bg-shape login-bg-shape-left" aria-hidden="true" />
      <div className="login-bg-shape login-bg-shape-right" aria-hidden="true" />
      <div className="login-gold-line login-gold-line-left" aria-hidden="true" />
      <div className="login-gold-line login-gold-line-right" aria-hidden="true" />

      <section className="pos-login" aria-label="CollectorsHub POS sign in">
        <img className="pos-login-logo" src="/collectorshub-pos-logo.png" alt="CollectorsHub POS" />

        <form className={isAdminMode ? 'login-form admin-mode' : 'login-form'} onSubmit={onSubmit}>
          <div className="login-heading">
            <h1>{isAdminMode ? 'Admin Login' : 'Sign in to CollectorsHub POS'}</h1>
            <p>{isAdminMode ? 'For CollectorsHub administrators' : 'For Stores, Organisations, and authorised staff'}</p>
          </div>

          {!isAdminMode ? (
            <label className="login-field">
              <span>Store or organisation code</span>
              <span className="login-input-wrap">
                <Building2 size={22} aria-hidden="true" />
                <input
                  autoFocus
                  autoComplete="organization"
                  value={draft.orgCode}
                  onChange={(event) => onChange({ ...draft, orgCode: event.target.value })}
                  placeholder="BAM-HALIFAX"
                />
              </span>
            </label>
          ) : null}

          <label className="login-field">
            <span>{isAdminMode ? 'Admin email' : 'Email or username'}</span>
            <span className="login-input-wrap">
              <Users size={22} aria-hidden="true" />
              <input
                autoFocus={isAdminMode}
                autoComplete="username"
                value={draft.username}
                onChange={(event) => onChange({ ...draft, username: event.target.value })}
                placeholder={isAdminMode ? 'admin@collectorshub.ca' : 'employee@store.ca'}
              />
            </span>
          </label>

          <label className="login-field">
            <span>Password</span>
            <span className="login-input-wrap">
              <LockKeyhole size={21} aria-hidden="true" />
              <input
                autoComplete="current-password"
                type="password"
                value={draft.password}
                onChange={(event) => onChange({ ...draft, password: event.target.value })}
                placeholder="••••••••"
              />
              <button className="password-visibility" type="button" aria-label="Show password">
                <EyeOff size={21} />
              </button>
            </span>
          </label>

          {error ? (
            <DismissibleAlert className="login-error" onDismiss={onClearError}>
              {error}
            </DismissibleAlert>
          ) : null}

          <button className="login-submit" type="submit" disabled={isAuthenticating}>
            <span>{isAuthenticating ? 'Signing In...' : 'Sign In'}</span>
            <ArrowRight size={24} />
          </button>

          <button className="forgot-password" type="button">Forgot password?</button>

          <div className="login-version" aria-label="Application version">
            <span />
            <small>CollectorsHub POS v{appVersion || 'dev'}</small>
            <span />
          </div>
        </form>
      </section>

      <button
        className="admin-login"
        type="button"
        onClick={() => onModeChange(isAdminMode ? 'staff' : 'admin')}
      >
        {isAdminMode ? <Building2 size={22} /> : <Settings size={22} />}
        <span>{isAdminMode ? 'Store Login' : 'Admin Login'}</span>
      </button>
      <button className="exit-login" type="button" onClick={handleExit}>
        <span>Exit</span>
        <LogOut size={22} />
      </button>
    </main>
  )
}

function describeAuthSession(session) {
  if (!session) return 'Not connected'
  if (session.type === 'platform_admin') return `Admin: ${session.displayName}`
  if (session.type === 'organization') return `Org: ${session.orgName || session.orgCode}`
  return `${session.storeName || 'Store'}: ${session.username || session.role || 'Employee'}`
}

function NavButton({ icon: Icon, label, active, onClick }) {
  return (
    <button className={active ? 'nav-button active' : 'nav-button'} type="button" onClick={onClick}>
      <Icon size={18} />
      <span>{label}</span>
    </button>
  )
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function RefreshIcon() {
  return <RefreshCw size={16} />
}

function DismissibleAlert({ className, children, onDismiss }) {
  return (
    <div className={`${className || ''} dismissible-alert`} role="alert">
      <span>{children}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss message">
        <X size={16} />
      </button>
    </div>
  )
}

function formatSyncTime(value) {
  if (!value) return 'Never'
  return new Date(value).toLocaleString()
}

function SyncStatusPanel({ status, isSyncing, onDismissError }) {
  const error = status?.error || ''
  return (
    <section className={error ? 'sync-panel sync-panel-error' : 'sync-panel'} aria-label="Sync status">
      <span><strong>{status?.online ? 'Online' : 'Offline'}</strong>{isSyncing ? ' · Syncing' : ''}</span>
      <span>Last sync: {formatSyncTime(status?.lastSyncAt)}</span>
      <span>Inventory: {Number(status?.inventoryCount || 0).toLocaleString()} records</span>
      <span>Pending local changes: {Number(status?.pendingLocalChanges || 0).toLocaleString()}</span>
      {error ? (
        <span className="sync-error dismissible-inline-error">
          Error: {error}
          <button type="button" onClick={onDismissError} aria-label="Dismiss sync error"><X size={14} /></button>
        </span>
      ) : null}
    </section>
  )
}

function viewTitle(activeView) {
  const titles = {
    register: 'Register',
    dashboard: 'Dashboard',
    inventory: 'Inventory',
    catalog: 'Catalog',
    customers: 'Customers',
    transactions: 'Transactions',
    reports: 'Reports',
    settings: 'Settings',
    scan: 'Scan to Inventory',
  }

  return titles[activeView] || 'Register'
}

function RegisterView({
  authSession,
  customers,
  inventory,
  inventoryValue,
  isSyncing,
  pendingRegisterItem,
  onCompleteTransaction,
  onCompleteRefund,
  onNavigate,
  onPendingRegisterItemConsumed,
  onRegisterDraftChange,
  onSyncNow,
  onToggleRegister,
  register,
  registerLocation,
  receiptBranding,
  registerMetrics,
  scanSessions,
  syncStatus,
  transactions,
  todaysSales,
  transactionCount,
  onSaveScanSessions,
}) {
  const scannerRef = useRef(null)
  const [mode, setMode] = useState('sale')
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const [stockNotice, setStockNotice] = useState(null)
  const [activeScanSessionId, setActiveScanSessionId] = useState('')
  const [scanStatus, setScanStatus] = useState('Ready')
  const [scanIntakeQuery, setScanIntakeQuery] = useState('')
  const [scanReviewFilter, setScanReviewFilter] = useState('Needs Review')
  const [saleScannerStats, setSaleScannerStats] = useState({ scanned: 0, added: 0, unavailable: 0, pending: 0 })
  const [lines, setLines] = useState([])
  const [selectedLineId, setSelectedLineId] = useState('')
  const [customerQuery, setCustomerQuery] = useState('')
  const [customer, setCustomer] = useState(null)
  const [profileMatches, setProfileMatches] = useState([])
  const [isSearchingProfiles, setIsSearchingProfiles] = useState(false)
  const [profileSearchError, setProfileSearchError] = useState('')
  const [buyCatalogueResults, setBuyCatalogueResults] = useState([])
  const [isSearchingBuyCatalogue, setIsSearchingBuyCatalogue] = useState(false)
  const [buyCatalogueSearchError, setBuyCatalogueSearchError] = useState('')
  const [guestLegalName, setGuestLegalName] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [cashReceived, setCashReceived] = useState('')
  const [appliedPayments, setAppliedPayments] = useState([])
  const [orderDiscount, setOrderDiscount] = useState({ type: 'percent', value: 0, code: '', approved: false })
  const [pendingOrderDiscount, setPendingOrderDiscount] = useState({ type: 'percent', value: 0, code: '' })
  const [saleNote, setSaleNote] = useState('')
  const [heldSales, setHeldSales] = useState([])
  const [activeMenu, setActiveMenu] = useState('')
  const [activeModal, setActiveModal] = useState('')
  const [managerRequest, setManagerRequest] = useState(null)
  const [managerUsername, setManagerUsername] = useState('')
  const [managerPin, setManagerPin] = useState('')
  const [managerError, setManagerError] = useState('')
  const [isApprovingManager, setIsApprovingManager] = useState(false)
  const [cashAdjustment, setCashAdjustment] = useState({ type: 'in', amount: '', reason: '' })
  const [refundDraft, setRefundDraft] = useState({ transactionNumber: '', amount: '', method: 'cash', reason: '' })
  const [transactionSaveState, setTransactionSaveState] = useState('synced')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [completedTransaction, setCompletedTransaction] = useState(null)
  const [receiptActionNotice, setReceiptActionNotice] = useState('')
  const [receiptEmailDraft, setReceiptEmailDraft] = useState('')
  const [isReceiptEmailPromptOpen, setIsReceiptEmailPromptOpen] = useState(false)
  const [isResolvingReceiptEmail, setIsResolvingReceiptEmail] = useState(false)
  const [transactionError, setTransactionError] = useState('')
  const [isCustomerCollapsed, setIsCustomerCollapsed] = useState(false)
  const [isCurrentSaleCollapsed, setIsCurrentSaleCollapsed] = useState(false)
  const [isRecommendedCollapsed, setIsRecommendedCollapsed] = useState(true)
  const [activePromotions, setActivePromotions] = useState([])

  const isOpen = register?.status === 'open'
  const taxPreview = calcLocationTax(registerLocation, 1)
  const taxRate = Number(taxPreview.rate || 0)
  const storeName = authSession?.storeName || authSession?.orgName || 'CollectorsHub Store'
  const locationName = authSession?.locationName || register?.locationName || 'Primary Location'
  const registerName = register?.name || 'Main Register'
  const employeeName = authSession?.username || authSession?.displayName || 'Employee'
  const lineCount = lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0)
  const taxLabel = registerLocation?.tax_label_1 || registerLocation?.taxName || 'HST'
  const operatorRole = String(authSession?.role || '').toLowerCase()
  const operatorCanDiscount = ['supervisor', 'manager', 'owner'].includes(operatorRole)
    || authSession?.permissions?.discount_override === true

  useEffect(() => {
    onRegisterDraftChange?.(lines.length > 0)
  }, [lines.length, onRegisterDraftChange])

  useEffect(() => {
    let cancelled = false
    if (!authSession?.storeId) {
      setActivePromotions([])
      return undefined
    }
    loadActiveStorePromotions(authSession.storeId)
      .then((promotions) => { if (!cancelled) setActivePromotions(promotions) })
      .catch((error) => {
        console.error('[Desktop Register] Active promotions load failed:', error)
        if (!cancelled) setActivePromotions([])
      })
    return () => { cancelled = true }
  }, [authSession?.storeId])

  useEffect(() => {
    if (!pendingRegisterItem) return
    setMode('sale')
    addInventoryItem(pendingRegisterItem)
    onPendingRegisterItemConsumed?.()
  }, [pendingRegisterItem])

  const filteredInventory = useMemo(() => {
    const value = query.trim().toLowerCase()
    const available = inventory.filter((item) => remainingInventoryForCart(item, lines) > 0)
    if (!value) return available.slice(0, 8)
    return available.filter((item) => (
      [item.name, item.title, item.sku, item.barcode, item.category, item.number]
        .some((field) => String(field || '').toLowerCase().includes(value))
    )).slice(0, 12)
  }, [inventory, lines, query])

  const scannerResults = useMemo(() => {
    const value = query.trim().toLowerCase()
    if (!value) return []

    if (mode === 'buy') {
      const seen = new Set()
      return buyCatalogueResults.filter((item) => (
        itemSearchValues(item).some((field) => field.includes(value))
      ))
        .filter((item) => {
          const identity = item.catalogItemId || item.sku || item.name
          if (seen.has(identity)) return false
          seen.add(identity)
          return true
        })
        .slice(0, 8)
    }

    return filteredInventory.slice(0, 6)
  }, [buyCatalogueResults, filteredInventory, inventory, mode, query])

  const recommendedItems = useMemo(() => {
    const saleInventoryIds = new Set(lines.map((line) => String(line.id || line.inventoryId || '')))
    const available = inventory
      .filter((item) => remainingInventoryForCart(item, lines) > 0)
      .filter((item) => !saleInventoryIds.has(String(item.id || item.inventoryId || '')))

    if (!lines.length) return []

    const saleTerms = new Set(lines.flatMap((line) => recommendationTerms(line)))
    return available
      .map((item) => {
        const terms = recommendationTerms(item)
        const score = terms.reduce((total, term) => total + (saleTerms.has(term) ? 1 : 0), 0)
        return { item, score }
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || String(a.item.name || '').localeCompare(String(b.item.name || '')))
      .map((entry) => entry.item)
      .slice(0, 4)
  }, [inventory, lines])
  const hasRecommendationSeed = lines.some((line) => line.direction !== 'incoming')
  const shouldShowRecommendedBody = !isRecommendedCollapsed && (recommendedItems.length > 0 || (hasRecommendationSeed && lines.length > 0))
  const activeScanSession = (scanSessions || []).find((session) => session.id === activeScanSessionId)
    || (scanSessions || []).find((session) => session.status === 'active' || session.status === 'paused')
    || null
  // Latest sessions for scans that add several cards in one go (FastFoto stacks).
  // Taken from state only when it changes, so a render in between doesn't
  // undo a save made a moment ago.
  const scanSessionsRef = useRef(scanSessions)
  const activeScanSessionIdRef = useRef(activeScanSessionId)
  const seenScanStateRef = useRef({ sessions: scanSessions, activeId: activeScanSessionId })
  if (seenScanStateRef.current.sessions !== scanSessions) { seenScanStateRef.current.sessions = scanSessions; scanSessionsRef.current = scanSessions }
  if (seenScanStateRef.current.activeId !== activeScanSessionId) { seenScanStateRef.current.activeId = activeScanSessionId; activeScanSessionIdRef.current = activeScanSessionId }
  const scanSessionItems = activeScanSession?.items || []
  const scanStats = useMemo(() => buildScanStats(scanSessionItems), [scanSessionItems])
  const scanReviewItems = useMemo(() => (
    scanSessionItems
      .filter((item) => {
        if (scanReviewFilter === 'All') return true
        if (scanReviewFilter === 'Needs Review') return item.reviewState === 'needs_review' || item.confidenceState === 'medium'
        if (scanReviewFilter === 'Unidentified') return item.confidenceState === 'low' || item.reviewReason === 'Item not found'
        if (scanReviewFilter === 'Ambiguous Match') return item.reviewReason === 'Multiple possible matches'
        if (scanReviewFilter === 'Duplicate') return Number(item.duplicateCount || 0) > 1 || item.duplicateWarning
        if (scanReviewFilter === 'Graded') return item.graded
        if (scanReviewFilter === 'Pricing Missing') return Number(item.marketValue || 0) <= 0
        return true
      })
      .slice(0, 80)
  ), [scanSessionItems, scanReviewFilter])

  const customerMatches = useMemo(() => {
    const value = customerQuery.trim().toLowerCase()
    if (!value) return []
    const cachedMatches = customers.filter((entry) => (
      [entry.name, entry.email, entry.phone, entry.username]
        .some((field) => String(field || '').toLowerCase().includes(value))
    )).slice(0, 5)
    const cachedIds = new Set(cachedMatches.map((entry) => entry.profileId || entry.collectorshub_user_id || entry.id))
    const profiles = profileMatches
      .filter((entry) => !cachedIds.has(entry.profileId || entry.collectorshub_user_id || entry.id))
      .slice(0, 8)
    return [...profiles, ...cachedMatches].slice(0, 8)
  }, [customers, customerQuery, profileMatches])

  const grossItemSubtotal = lines
    .filter((line) => line.direction !== 'incoming')
    .reduce((sum, line) => sum + line.quantity * line.unitPrice, 0)
  const itemSubtotal = lines
    .filter((line) => line.direction !== 'incoming')
    .reduce((sum, line) => sum + line.quantity * line.unitPrice - discountAmount(line), 0)
  const tradeOfferTotal = lines
    .filter((line) => line.direction === 'incoming')
    .reduce((sum, line) => sum + line.quantity * Number(line.storeOffer || 0), 0)
  const hasUnpricedTradeItems = lines.some((line) => line.direction === 'incoming' && Number(line.storeOffer || 0) <= 0)
  const itemDiscounts = lines.reduce((sum, line) => sum + discountAmount(line), 0)
  const orderDiscountTotal = orderDiscountAmount(orderDiscount, itemSubtotal)
  const discounts = itemDiscounts + orderDiscountTotal
  const subtotal = Math.max(0, itemSubtotal - orderDiscountTotal)
  const taxableSubtotal = Math.max(0, subtotal)
  const taxApplies = mode === 'sale' || (mode === 'buy' && taxableSubtotal > tradeOfferTotal)
  const tax = taxApplies ? calcLocationTax(registerLocation, taxableSubtotal).total : 0
  const saleTotal = taxableSubtotal + tax
  const netDue = mode === 'buy' ? saleTotal - tradeOfferTotal : saleTotal
  const amountDue = Math.max(0, netDue)
  const payoutDue = Math.max(0, -netDue)
  const paidTotal = appliedPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
  const remaining = Math.max(0, amountDue - paidTotal)
  const cashAmount = Number(cashReceived || 0)
  const cashDue = paymentMethod === 'cash' ? roundCanadianCash(remaining) : remaining
  const cashRounding = cashDue - remaining
  const changeDue = paymentMethod === 'cash' ? Math.max(0, cashAmount - cashDue) : 0
  const requiresRecordedGuestName = Boolean(customer?.guest && mode === 'buy')
  const hasRecordedGuestName = !requiresRecordedGuestName || guestLegalName.trim().length > 1
  const effectiveCustomer = customer?.guest
    ? { ...customer, name: guestLegalName.trim() || customer.name, legalName: guestLegalName.trim() || customer.legalName || customer.name }
    : customer
  const cashCoversRemaining = paymentMethod === 'cash' && cashAmount >= cashDue
  const splitCoversRemaining = appliedPayments.length > 0 && remaining <= 0
  const canComplete = mode !== 'scan_intake' && isOpen && lines.length > 0 && !isSubmitting && hasRecordedGuestName && (
    mode === 'buy'
      ? customer && hasRecordedGuestName && !hasUnpricedTradeItems && (
        (amountDue === 0 && payoutDue === 0)
        || (payoutDue > 0 && (paymentMethod === 'cash' || (paymentMethod === 'store_credit' && !customer.guest)))
        || (amountDue > 0 && (splitCoversRemaining || cashCoversRemaining || paymentMethod === 'card' || paymentMethod === 'gift_card' || (paymentMethod === 'store_credit' && !customer.guest)))
      )
      : splitCoversRemaining || cashCoversRemaining || (paymentMethod === 'card' && remaining > 0) || (paymentMethod === 'gift_card' && remaining > 0) || (paymentMethod === 'store_credit' && remaining > 0 && customer && !customer.guest)
  )
  const disabledCheckoutReason = checkoutDisabledReason({
    amountDue,
    canComplete,
    cashAmount,
    cashDue,
    customer,
    hasRecordedGuestName,
    isOpen,
    lines,
    mode,
    paymentMethod,
    payoutDue,
    remaining,
    hasUnpricedTradeItems,
  })

  useEffect(() => {
    if (!activeScanSessionId && activeScanSession?.id) {
      setActiveScanSessionId(activeScanSession.id)
    }
  }, [activeScanSession?.id, activeScanSessionId])

  useEffect(() => {
    if (!isOpen) return undefined
    const focusTimer = window.setTimeout(() => scannerRef.current?.focus(), 20)
    return () => window.clearTimeout(focusTimer)
  }, [isOpen, lines.length, mode])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (!isOpen) return
      if (event.key === 'F2') {
        event.preventDefault()
        scannerRef.current?.focus()
      }
      if (event.key === 'F4') {
        event.preventDefault()
        document.querySelector('[data-customer-search]')?.focus()
      }
      if (event.key === 'F8') {
        event.preventDefault()
        setPaymentMethod((current) => current || 'card')
      }
      if ((event.key === '+' || event.key === '-') && selectedLineId) {
        event.preventDefault()
        adjustLineQuantity(selectedLineId, event.key === '+' ? 1 : -1)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, selectedLineId])

  useEffect(() => {
    const value = customerQuery.trim()
    if (!value || !authSession?.storeId) {
      setProfileMatches([])
      setProfileSearchError('')
      setIsSearchingProfiles(false)
      return undefined
    }

    let cancelled = false
    setIsSearchingProfiles(true)
    const timer = window.setTimeout(async () => {
      try {
        const { data, error } = await supabase.rpc('search_store_credit_profiles', {
          p_store_id: authSession.storeId,
          p_query: value,
        })
        if (error) throw error
        if (!cancelled) {
          setProfileMatches((data || []).map((row) => ({
            id: `profile_${row.id}`,
            profileId: row.id,
            collectorshub_user_id: row.id,
            name: row.display_name || row.username || 'CollectorsHub user',
            username: row.username || '',
            email: '',
            phone: '',
            storeCredit: 0,
            kind: 'profile',
          })))
          setProfileSearchError('')
        }
      } catch (error) {
        if (!cancelled) {
          setProfileMatches([])
          setProfileSearchError(error?.message || 'Could not search CollectorsHub usernames.')
        }
      } finally {
        if (!cancelled) setIsSearchingProfiles(false)
      }
    }, 200)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [authSession?.storeId, customerQuery])

  useEffect(() => {
    const value = query.trim()
    if (mode !== 'buy' || value.length < 2) {
      setBuyCatalogueResults([])
      setBuyCatalogueSearchError('')
      setIsSearchingBuyCatalogue(false)
      return undefined
    }

    let cancelled = false
    setIsSearchingBuyCatalogue(true)
    const timer = window.setTimeout(async () => {
      try {
        const results = await searchDesktopTradeCatalogue(value)
        if (!cancelled) {
          setBuyCatalogueResults(results)
          setBuyCatalogueSearchError('')
        }
      } catch (error) {
        console.error('[Desktop Register] Buy catalogue search failed:', error)
        if (!cancelled) {
          setBuyCatalogueResults([])
          setBuyCatalogueSearchError(error?.message || 'Could not search the CollectorsHub catalogue.')
        }
      } finally {
        if (!cancelled) setIsSearchingBuyCatalogue(false)
      }
    }, 220)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [mode, query])

  async function persistScanSession(nextSession) {
    const existing = scanSessionsRef.current || []
    const nextSessions = existing.some((session) => session.id === nextSession.id)
      ? existing.map((session) => (session.id === nextSession.id ? nextSession : session))
      : [nextSession, ...existing]
    scanSessionsRef.current = nextSessions
    activeScanSessionIdRef.current = nextSession.id
    await onSaveScanSessions(nextSessions)
    setActiveScanSessionId(nextSession.id)
    return nextSession
  }

  async function startScanIntakeSession() {
    const sessionNumber = nextScanSessionNumber(scanSessionsRef.current || [])
    const now = new Date().toISOString()
    const session = {
      id: createId('scan_session'),
      number: sessionNumber,
      status: 'active',
      scannerStatus: 'Ready',
      storeId: authSession?.storeId || '',
      locationId: authSession?.locationId || '',
      registerName,
      employeeId: authSession?.employeeId || '',
      employeeName,
      customer: effectiveCustomer,
      startedAt: now,
      updatedAt: now,
      savedState: 'saved_locally',
      linkedTransactionId: '',
      items: [],
      events: [],
    }
    setScanStatus('Ready')
    await persistScanSession(session)
    setNotice(`Scan session ${session.number} started and saved locally.`)
    return session
  }

  async function patchScanSession(patch) {
    if (!activeScanSession) return null
    const nextSession = {
      ...activeScanSession,
      ...patch,
      updatedAt: new Date().toISOString(),
      savedState: 'saved_locally',
    }
    return persistScanSession(nextSession)
  }

  async function addScanSessionItem(seed = {}) {
    const latest = scanSessionsRef.current || []
    const session = latest.find((entry) => entry.id === activeScanSessionIdRef.current)
      || latest.find((entry) => entry.status === 'active' || entry.status === 'paused')
      || await startScanIntakeSession()
    const now = new Date().toISOString()
    const candidate = seed.catalogueItem || null
    const name = seed.name || candidate?.name || candidate?.title || scanIntakeQuery.trim() || 'Unidentified item'
    const sku = seed.sku || candidate?.sku || ''
    const marketValue = Number(seed.marketValue ?? candidate?.marketValue ?? candidate?.price ?? candidate?.inStorePrice ?? 0)
    const duplicateCount = duplicateCountForScanItem(session.items || [], { sku, name, catalogItemId: candidate?.catalogItemId || seed.catalogItemId })
    const confidenceState = seed.confidenceState || (candidate ? 'high' : 'low')
    const reviewState = seed.reviewState || (confidenceState === 'high' ? 'accepted' : 'needs_review')
    const item = {
      id: createId('scan_item'),
      eventId: seed.eventId || '',
      createdAt: now,
      updatedAt: now,
      sourceDevice: seed.sourceDevice || 'Register scanner',
      scanImageUrl: seed.scanImageUrl || '',
      scanImagePath: seed.scanImagePath || '',
      barcode: seed.barcode || '',
      catalogItemId: seed.catalogItemId || candidate?.catalogItemId || '',
      name,
      sku,
      category: seed.category || candidate?.category || '',
      condition: seed.condition || 'Near Mint',
      quantity: 1,
      graded: !!seed.graded,
      gradingCompany: seed.gradingCompany || '',
      grade: seed.grade || '',
      certificationNumber: seed.certificationNumber || '',
      confidenceScore: Number(seed.confidenceScore ?? (candidate ? 92 : 0)),
      confidenceState,
      reviewState,
      reviewReason: seed.reviewReason || (candidate ? '' : 'Item not found'),
      duplicateCount,
      duplicateWarning: duplicateCount > 1,
      marketValue,
      lastSale: Number(seed.lastSale || 0),
      pricingSource: seed.pricingSource || candidate?.marketValueSource || (marketValue ? 'Local catalogue/cache' : ''),
      marketStats: seed.marketStats || candidate?.marketStats || null,
      priceUpdatedAt: seed.priceUpdatedAt || '',
      cashOffer: Number(seed.cashOffer ?? suggestedCashOffer(marketValue)),
      storeCreditOffer: Number(seed.storeCreditOffer ?? suggestedStoreCreditOffer(marketValue)),
      notes: seed.notes || '',
    }
    const nextSession = {
      ...session,
      items: [item, ...(session.items || [])],
      events: seed.event ? [seed.event, ...(session.events || [])] : (session.events || []),
      updatedAt: now,
      savedState: 'saved_locally',
    }
    await persistScanSession(nextSession)
    setScanIntakeQuery('')
    setNotice(item.reviewState === 'accepted' ? `${item.name} added to scan intake.` : `${item.name} added to review queue.`)
    return item
  }

  // Scans with the FastFoto when one is connected: every card loaded in the
  // feeder comes back as its own scan event (front and back). Returns null
  // when no FastFoto is connected.
  async function captureFeederScanEvents(workflow) {
    const api = desktopApi()
    if (typeof api.feedStack !== 'function') return null
    const status = await api.refreshFeeder?.().catch(() => null)
    if (!status?.feederName) return null
    setScanStatus('Scanning')
    const events = []
    const offCard = api.onFeedCard?.((card) => {
      const event = normaliseScanEvent(card.frontImage, workflow)
      events.push({ ...event, sourceDevice: card.frontImage?.scannerName || status.feederName, backImage: card.backImage ? { path: card.backImage.path || '', url: card.backImage.url || '' } : null })
    })
    try {
      const result = await api.feedStack({ loadFaceDown: true })
      if (!events.length) {
        setScanStatus(result?.ok === false ? 'Error' : 'Paused')
        setNotice(result?.message || 'No cards came through the FastFoto. Load the cards and scan again.')
        return []
      }
      if (result?.code) setNotice(`${events.length} card${events.length === 1 ? '' : 's'} scanned, then: ${result.message}`)
      setScanStatus('Processing')
      return events
    } catch (error) {
      setScanStatus('Error')
      setNotice(error?.message || 'The FastFoto scan failed.')
      return events
    } finally {
      offCard?.()
    }
  }

  async function captureScanImageEvent(workflow) {
    const events = await captureScanImageEvents(workflow)
    return events[0] || null
  }

  async function captureScanImageEvents(workflow) {
    const fed = await captureFeederScanEvents(workflow)
    if (fed) return fed
    const event = await captureFlatbedScanEvent(workflow)
    return event ? [event] : []
  }

  async function captureFlatbedScanEvent(workflow) {
    setScanStatus('Detecting')
    const waitingTimer = window.setTimeout(() => {
      setScanStatus('Scanning')
    }, 1500)
    try {
      const image = await desktopApi().scanImage()
      window.clearTimeout(waitingTimer)
      if (image?.needsSelection) {
        const names = (image.scanners || []).map((scanner) => scanner.name).filter(Boolean)
        setScanStatus('Paused')
        setNotice(names.length ? `${image.message} Found: ${names.join(', ')}` : image.message || 'Choose a WIA scanner before scanning.')
        return null
      }
      if (image?.canceled) {
        setScanStatus('Paused')
        setNotice('Scanner canceled.')
        return null
      }
      const event = normaliseScanEvent(image, workflow)
      setScanStatus('Processing')
      return event
    } catch (error) {
      setScanStatus('Error')
      setNotice(error?.message || 'Scanner could not capture an image.')
      return null
    } finally {
      window.clearTimeout(waitingTimer)
    }
  }

  async function recognizeScanEvent(event, fallbackCategory = 'Sports Cards') {
    const imagePath = event?.image?.path || ''
    if (!imagePath) throw new Error('No scan image was saved for recognition.')
    const response = await desktopApi().recognizeCard({
      jobId: createId('register_ai_job'),
      front: { path: imagePath },
      back: event?.backImage?.path ? { path: event.backImage.path } : null,
      // Quick identify: only what finds the card in the catalogue.
      mode: 'identify',
    })
    if (!response?.ok) throw new Error(response?.message || 'Local AI could not identify this card.')
    const analysis = await analyseRecognizedCard(response.result, response.result?.category || fallbackCategory)
    return {
      ...analysis,
      result: response.result,
      providerLabel: response.providerLabel || response.provider || 'Local AI',
      model: response.model || '',
    }
  }

  async function scanIntakeFromDevice() {
    const events = await captureScanImageEvents('scan_intake')
    for (const event of events) await identifyScanIntakeEvent(event)
  }

  async function identifyScanIntakeEvent(event) {
    try {
      setScanStatus('Identifying')
      const recognition = await recognizeScanEvent(event, 'Sports Cards')
      const best = recognition.scanAnalysis?.bestMatch || null
      const catalogueItem = best ? await enrichRecognizedCatalogueItem(best, recognition.result) : null
      const confidenceScore = Number(recognition.scanAnalysis?.confidence || best?.score || 0)
      if (catalogueItem && ['exact', 'likely'].includes(recognition.scanAnalysis?.matchStatus)) {
        await addScanSessionItem({
          event,
          eventId: event.scanId,
          sourceDevice: event.sourceDevice,
          scanImageUrl: event.image?.url || '',
          scanImagePath: event.image?.path || '',
          catalogueItem,
          confidenceState: recognition.scanAnalysis.matchStatus === 'exact' ? 'high' : 'medium',
          reviewState: recognition.scanAnalysis.matchStatus === 'exact' ? 'accepted' : 'needs_review',
          reviewReason: recognition.scanAnalysis.matchStatus === 'exact' ? '' : 'AI likely match',
          confidenceScore,
          notes: `${recognition.providerLabel} identified ${recognition.result?.subject || catalogueItem.name}. ${(best?.reasons || []).join(' ')}`.trim(),
        })
      } else {
        const possible = (recognition.scanAnalysis?.candidates || []).slice(0, 3).map((candidate) => candidate.item?.name || candidate.item?.subject).filter(Boolean)
        await addScanSessionItem({
          event,
          eventId: event.scanId,
          sourceDevice: event.sourceDevice,
          scanImageUrl: event.image?.url || '',
          scanImagePath: event.image?.path || '',
          name: recognition.result?.subject || recognition.result?.description || 'AI identified card',
          sku: recognition.result?.id_number || '',
          category: recognition.taxonomy?.category || recognition.result?.category || 'Sports Cards',
          confidenceState: possible.length ? 'medium' : 'low',
          reviewState: 'needs_review',
          reviewReason: possible.length ? 'Multiple possible matches' : 'No catalogue match found',
          confidenceScore,
          notes: possible.length
            ? `AI possible matches: ${possible.join(', ')}`
            : `${recognition.providerLabel} identified the scan, but no catalogue match was found.`,
        })
      }
    } catch (error) {
      console.error('[Desktop Scan Intake] AI recognition failed:', error)
      await addScanSessionItem({
        event,
        eventId: event.scanId,
        sourceDevice: event.sourceDevice,
        scanImageUrl: event.image?.url || '',
        scanImagePath: event.image?.path || '',
        confidenceState: 'low',
        reviewState: 'needs_review',
        reviewReason: 'AI identification failed',
        notes: error?.message || 'Local AI could not identify this scan.',
      })
      setNotice(error?.message || 'AI identification failed. Item saved for review.')
    } finally {
      setScanStatus('Ready')
    }
  }

  async function addScanIntakeManualMatch() {
    const value = scanIntakeQuery.trim()
    if (!value) return
    setScanStatus('Processing')
    try {
      const results = await searchDesktopTradeCatalogue(value)
      if (results.length === 1) {
        await addScanSessionItem({ catalogueItem: results[0], confidenceState: 'high', reviewState: 'accepted' })
        setScanStatus('Ready')
        return
      }
      if (results.length > 1) {
        await addScanSessionItem({
          name: value,
          confidenceState: 'medium',
          reviewState: 'needs_review',
          reviewReason: 'Multiple possible matches',
          notes: `Possible matches: ${results.slice(0, 3).map((item) => item.name || item.title || item.sku).join(', ')}`,
        })
        setScanStatus('Ready')
        return
      }
    } catch (error) {
      console.error('[Desktop Scan Intake] Catalogue lookup failed:', error)
      setNotice(error?.message || 'Catalogue lookup failed. Item saved for review.')
    } finally {
      setScanStatus('Ready')
    }
    await addScanSessionItem({ name: value, confidenceState: 'low', reviewState: 'needs_review', reviewReason: 'Item not found' })
  }

  async function updateScanItem(itemId, patch) {
    if (!activeScanSession) return
    await patchScanSession({
      items: scanSessionItems.map((item) => (
        item.id === itemId ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item
      )),
    })
  }

  async function removeScanItem(itemId) {
    if (!activeScanSession) return
    await patchScanSession({ items: scanSessionItems.filter((item) => item.id !== itemId) })
  }

  async function setScanSessionStatus(status) {
    if (!activeScanSession) return
    setScanStatus(status === 'paused' ? 'Paused' : 'Ready')
    await patchScanSession({ status, scannerStatus: status === 'paused' ? 'Paused' : 'Ready' })
  }

  function convertScanSessionToBuy() {
    if (!activeScanSession) return
    const accepted = (activeScanSession.items || []).filter((item) => item.reviewState === 'accepted' && item.confidenceState !== 'low')
    if (!accepted.length) {
      setNotice('Accept at least one scanned item before continuing to Buy / Trade-In.')
      return
    }
    setLines((current) => [
      ...current,
      ...accepted.map((item) => ({
        id: createId('trade_item'),
        inventoryId: '',
        catalogItemId: item.catalogItemId || '',
        localId: createId('line'),
        direction: 'incoming',
        name: item.name,
        sku: item.sku || '',
        category: item.category || '',
        image: item.scanImageUrl || '',
        condition: item.graded ? `${item.gradingCompany || 'Graded'} ${item.grade || ''}`.trim() : item.condition || 'Near Mint',
        quantity: Number(item.quantity || 1),
        unitPrice: 0,
        marketValue: Number(item.marketValue || 0),
        storeOffer: Number(item.cashOffer || 0),
        discount: 0,
        graded: item.graded,
        gradingCompany: item.gradingCompany,
        grade: item.grade,
        certificationNumber: item.certificationNumber,
        scanSessionId: activeScanSession.id,
        scanItemId: item.id,
      })),
    ])
    setMode('buy')
    setCustomer(activeScanSession.customer || customer)
    setNotice(`${activeScanSession.number} moved into Buy / Trade-In.`)
  }

  async function runSaleScanner() {
    const value = query.trim().toLowerCase()
    if (!value) {
      const event = await captureScanImageEvent('sale')
      if (event) {
        setSaleScannerStats((current) => ({ ...current, scanned: current.scanned + 1 }))
        try {
          setScanStatus('Identifying')
          const recognition = await recognizeScanEvent(event, 'Sports Cards')
          const best = recognition.scanAnalysis?.bestMatch || null
          const catalogueItem = best ? await enrichRecognizedCatalogueItem(best, recognition.result) : null
          const inventoryMatch = catalogueItem
            ? inventory.find((item) => inventoryMatchesCatalogueCandidate(item, catalogueItem) && remainingInventoryForCart(item, lines) > 0)
            : null
          if (inventoryMatch) {
            addInventoryItem(inventoryMatch)
            setSaleScannerStats((current) => ({ ...current, added: current.added + 1 }))
            setNotice(`${inventoryMatch.name || inventoryMatch.title || 'Item'} identified and added to the sale.`)
          } else {
            setSaleScannerStats((current) => ({ ...current, pending: current.pending + 1 }))
            setNotice(catalogueItem
              ? `${catalogueItem.name || 'Card'} identified, but no available store inventory was found at this location.`
              : 'AI identified the scan, but no catalogue/store inventory match was found.')
          }
        } catch (error) {
          console.error('[Desktop Sale Scanner] AI recognition failed:', error)
          setSaleScannerStats((current) => ({ ...current, pending: current.pending + 1 }))
          setNotice(error?.message || 'AI identification failed. Search SKU/barcode to add stocked inventory.')
        } finally {
          setScanStatus('Ready')
        }
      }
      return
    }

    setSaleScannerStats((current) => ({ ...current, scanned: current.scanned + 1 }))
    const match = inventory.find((item) => (
      [item.barcode, item.sku, item.number, item.name, item.title].some((field) => String(field || '').toLowerCase() === value)
    ))
    if (!match) {
      setSaleScannerStats((current) => ({ ...current, unavailable: current.unavailable + 1 }))
      setNotice('No matching inventory found at this location.')
      return
    }
    if (remainingInventoryForCart(match, lines) <= 0) {
      setSaleScannerStats((current) => ({ ...current, unavailable: current.unavailable + 1 }))
      setStockNotice({ name: match.name || match.title || match.sku || 'This item', available: inventoryStock(match) })
      return
    }
    addInventoryItem(match)
    setSaleScannerStats((current) => ({ ...current, added: current.added + 1 }))
  }

  function addInventoryItem(item) {
    const available = inventoryStock(item)
    if (available <= 0) return

    setLines((current) => {
      const itemIdentity = inventoryIdentity(item)
      const existing = itemIdentity
        ? current.find((line) => line.direction !== 'incoming' && inventoryIdentity(line) === itemIdentity)
        : null
      const inCartQuantity = cartQuantityForInventoryItem(current, item)
      if (inCartQuantity >= available) {
        setStockNotice({ name: item.name || item.title || item.sku || 'This item', available })
        return current
      }
      if (existing) {
        return current.map((line) => (
          line.localId === existing.localId
            ? { ...line, quantity: Math.min(available, line.quantity + 1) }
            : line
        ))
      }

      return [
        ...current,
        {
          ...item,
          localId: createId('line'),
          direction: 'outgoing',
          quantity: 1,
          quantityAvailable: available,
          unitPrice: registerRetailPrice(item),
          discount: 0,
          condition: item.condition || item.rawCondition || '',
        },
      ]
    })
    setNotice('')
    setStockNotice(null)
    setTransactionError('')
    setQuery('')
    window.setTimeout(() => scannerRef.current?.focus(), 15)
  }

  function addTradeItem(sourceItem = null) {
    const name = sourceItem?.name || sourceItem?.title || query.trim()
    if (!name) return
    const category = sourceItem?.category || ''
    const condition = sourceItem?.condition || conditionOptions('buy', category)[0] || 'Near Mint'
    const priced = marketValueForLineCondition(sourceItem, condition)
    const marketValue = Number(priced.value ?? sourceItem?.marketValue ?? sourceItem?.price ?? sourceItem?.inStorePrice ?? 0)
    setLines((current) => [
      ...current,
      {
        id: createId('trade_item'),
        // Catalogue candidates do not have an inventory row yet. Never send
        // their display id (catalog_<uuid>) as store_inventory.id.
        inventoryId: sourceItem?.inventoryId || '',
        catalogItemId: sourceItem?.catalogItemId || sourceItem?.catalogueItemId || '',
        localId: createId('line'),
        direction: 'incoming',
        name,
        sku: sourceItem?.sku || '',
        category,
        image: sourceItem?.image || sourceItem?.imageUrl || sourceItem?.frontImage || '',
        condition,
        quantity: 1,
        unitPrice: 0,
        marketValue,
        marketStats: sourceItem?.marketStats || null,
        conditionMarketValues: sourceItem?.conditionMarketValues || sourceItem?.marketStats?.byCondition || null,
        marketValueSource: priced.source || sourceItem?.marketValueSource || '',
        salesUsed: Number(priced.count || sourceItem?.salesUsed || sourceItem?.marketStats?.sales_count || 0),
        storeOffer: suggestedStoreCreditOffer(marketValue),
        discount: 0,
      },
    ])
    setQuery('')
    setNotice('')
    setStockNotice(null)
    setTransactionError('')
  }

  function handleScannerSubmit(event) {
    event.preventDefault()
    const value = query.trim()
    if (!value) return

    const exact = inventory.find((item) => (
      [item.barcode, item.sku, item.number].some((field) => String(field || '').toLowerCase() === value.toLowerCase())
    ))
    if (exact && mode !== 'buy' && remainingInventoryForCart(exact, lines) > 0) {
      addInventoryItem(exact)
      return
    }

    if (mode === 'buy') {
      if (scannerResults.length === 1) {
        addTradeItem(scannerResults[0])
        return
      }
      addTradeItem()
      return
    }

    if (filteredInventory.length === 1) {
      addInventoryItem(filteredInventory[0])
      return
    }

    setNotice(`No exact match for "${value}". Choose an item from the results or keep scanning.`)
    scannerRef.current?.focus()
  }

  function updateLine(localId, patch) {
    setLines((current) => current.map((line) => line.localId === localId ? { ...line, ...patch } : line))
  }

  function adjustLineQuantity(localId, delta) {
    setLines((current) => current.map((line) => {
      if (line.localId !== localId) return line
      const max = line.direction === 'incoming' ? 999 : Number(line.quantityAvailable || line.available || line.onHand || 999)
      return { ...line, quantity: Math.max(1, Math.min(max, Number(line.quantity || 1) + delta)) }
    }))
  }

  function removeLine(localId) {
    setLines((current) => current.filter((line) => line.localId !== localId))
    if (selectedLineId === localId) setSelectedLineId('')
  }

  function resetTransactionDraft() {
    setLines([])
    setAppliedPayments([])
    setPaymentMethod('')
    setCashReceived('')
    setSelectedLineId('')
    setNotice('')
    setStockNotice(null)
    setGuestLegalName('')
    setOrderDiscount({ type: 'percent', value: 0, code: '', approved: false })
    setPendingOrderDiscount({ type: 'percent', value: 0, code: '' })
    setSaleNote('')
    setCustomer(null)
    setCustomerQuery('')
    setTransactionSaveState('synced')
  }

  function clearSale() {
    resetTransactionDraft()
    window.setTimeout(() => scannerRef.current?.focus(), 20)
  }

  function applyPayment(method, amount, metadata = {}) {
    const paymentAmount = Math.max(0, Math.min(Number(amount || 0), remaining))
    if (!paymentAmount) return
    setAppliedPayments((current) => [...current, { id: createId('payment'), method, amount: paymentAmount, ...metadata }])
    setCashReceived('')
  }

  function openModal(name) {
    setActiveMenu('')
    setActiveModal(name)
  }

  function holdSale() {
    if (!lines.length) {
      setNotice('Add an item before holding a sale.')
      setActiveMenu('')
      return
    }
    const heldSale = {
      id: createId('held'),
      createdAt: new Date().toISOString(),
      mode,
      lines,
      customer,
      customerQuery,
      guestLegalName,
      orderDiscount,
      saleNote,
      appliedPayments,
      paymentMethod,
      cashReceived,
      total: amountDue || payoutDue,
    }
    setHeldSales((current) => [heldSale, ...current])
    resetTransactionDraft()
    setCompletedTransaction(null)
    setNotice('Sale held. Ready for the next transaction.')
    setActiveMenu('')
    window.setTimeout(() => scannerRef.current?.focus(), 20)
  }

  function resumeHeldSale(heldSale) {
    setMode(heldSale.mode || 'sale')
    setLines(heldSale.lines || [])
    setCustomer(heldSale.customer || null)
    setCustomerQuery(heldSale.customerQuery || '')
    setGuestLegalName(heldSale.guestLegalName || '')
    setOrderDiscount(heldSale.orderDiscount || { type: 'percent', value: 0, code: '', approved: false })
    setSaleNote(heldSale.saleNote || '')
    setAppliedPayments(heldSale.appliedPayments || [])
    setPaymentMethod(heldSale.paymentMethod || '')
    setCashReceived(heldSale.cashReceived || '')
    setHeldSales((current) => current.filter((entry) => entry.id !== heldSale.id))
    setActiveModal('')
    setNotice('')
    setTransactionError('')
    window.setTimeout(() => scannerRef.current?.focus(), 20)
  }

  function requestManagerApproval(reason, onApprove) {
    setManagerUsername('')
    setManagerPin('')
    setManagerError('')
    setManagerRequest({ reason, onApprove })
  }

  async function approveManagerRequest() {
    if (!managerRequest || isApprovingManager) return
    setIsApprovingManager(true)
    setManagerError('')
    const result = await verifyRegisterManagerApproval({
      storeCode: authSession?.storeCode,
      username: managerUsername,
      pin: managerPin,
    })
    if (!result.ok) {
      setManagerError(result.error)
      setIsApprovingManager(false)
      return
    }
    managerRequest.onApprove(result.approver)
    setManagerRequest(null)
    setIsApprovingManager(false)
  }

  function findValidPromotion(code) {
    const normalizedCode = String(code || '').trim().toLowerCase()
    if (!normalizedCode) return null
    const locationNameValue = String(registerLocation?.location_name || '').trim().toLowerCase()
    return activePromotions.find((promotion) => {
      const promotionLocation = String(promotion.location_name || '').trim().toLowerCase()
      if (promotionLocation && locationNameValue && promotionLocation !== locationNameValue) return false
      const candidates = [promotion.code, promotion.promo_code, promotion.name, promotion.id]
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
      if (!candidates.includes(normalizedCode)) return false
      const now = Date.now()
      if (promotion.starts_at && new Date(promotion.starts_at).getTime() > now) return false
      if (promotion.ends_at && new Date(promotion.ends_at).getTime() < now) return false
      return true
    }) || null
  }

  function applyItemDiscount(localId, value, approver = null) {
    const nextValue = Math.max(0, Math.min(100, Number(value || 0)))
    if (nextValue <= 0 || operatorCanDiscount) {
      updateLine(localId, { discount: nextValue, discountApprovedBy: approver?.username || (operatorCanDiscount ? employeeName : '') })
      return
    }
    requestManagerApproval('Approve this item discount before applying it.', (approvedBy) => {
      updateLine(localId, { discount: nextValue, discountApprovedBy: approvedBy.username })
    })
  }

  function applyOrderDiscount() {
    const nextDiscount = {
      ...pendingOrderDiscount,
      value: Number(pendingOrderDiscount.value || 0),
      approved: false,
    }
    const discountValue = orderDiscountAmount(nextDiscount, itemSubtotal)
    const validPromotion = findValidPromotion(nextDiscount.code)
    const promoMatchesDiscount = validPromotion && (
      !validPromotion.discount_kind
      || (validPromotion.discount_kind === nextDiscount.type && Number(validPromotion.discount_value || 0) === Number(nextDiscount.value || 0))
    )
    const needsApproval = !operatorCanDiscount && !promoMatchesDiscount
    const commit = (approved = false) => {
      setOrderDiscount({ ...nextDiscount, approved, approvalSource: validPromotion ? 'promotion' : (approved ? 'manager' : 'role') })
      setActiveModal('')
    }
    if (needsApproval) {
      requestManagerApproval('Approve this order-level discount before applying it.', () => commit(true))
      return
    }
    commit(false)
  }

  function recordCashAdjustment() {
    const amount = Number(cashAdjustment.amount || 0)
    if (!amount) return
    setNotice(`${cashAdjustment.type === 'out' ? 'Cash out' : 'Cash in'} recorded locally: ${money.format(amount)}.`)
    setCashAdjustment({ type: 'in', amount: '', reason: '' })
    setActiveModal('')
  }

  async function completeTransaction() {
    if (!canComplete) return
    setIsSubmitting(true)
    setTransactionError('')
    setTransactionSaveState('saving')
    try {
      const automaticPayment = mode !== 'buy' && remaining > 0
        ? [{
          id: createId('payment'),
          method: paymentMethod || 'card',
          amount: remaining,
          tendered: paymentMethod === 'cash' ? cashAmount : remaining,
          changeDue,
          cashRounding: paymentMethod === 'cash' ? cashRounding : 0,
          status: paymentMethod === 'card' ? 'approved' : 'received',
        }]
        : []

      const transaction = await onCompleteTransaction({
        type: mode,
        customer: effectiveCustomer,
        items: lines.map((line) => ({
          id: line.id,
          // Only outgoing sale lines can fall back to their existing line id.
          // Incoming trade lines may be catalogue-only and must not send a
          // local trade_item_* id into a Supabase UUID column.
          inventoryId: line.direction === 'incoming' ? (line.inventoryId || '') : (line.inventoryId || line.id),
          catalogItemId: line.catalogItemId || '',
          name: line.name,
          sku: line.sku || '',
          condition: line.condition || '',
          direction: line.direction,
          quantity: Number(line.quantity || 1),
          unitPrice: Number(line.unitPrice || 0),
          discount: Number(line.discount || 0),
          discountPercent: Number(line.discount || 0),
          discountTotal: discountAmount(line),
          discountApprovedBy: line.discountApprovedBy || null,
          marketValue: Number(line.marketValue || 0),
          storeOffer: Number(line.storeOffer || 0),
          total: line.direction === 'incoming'
            ? Number(line.storeOffer || 0) * Number(line.quantity || 1)
            : Number(line.unitPrice || 0) * Number(line.quantity || 1) - discountAmount(line),
        })),
        subtotal,
        discounts,
        itemDiscounts,
        orderDiscount: {
          ...orderDiscount,
          amount: orderDiscountTotal,
        },
        tax,
        taxRate,
        taxLabel,
        total: mode === 'buy' ? netDue : amountDue,
        netDue,
        payments: [...appliedPayments, ...automaticPayment],
        payout: mode === 'buy' || payoutDue > 0 ? { amount: payoutDue, method: paymentMethod || 'cash' } : null,
        storeCreditApplied: [...appliedPayments, ...automaticPayment].filter((payment) => payment.method === 'store_credit').reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
        giftCardApplied: [...appliedPayments, ...automaticPayment].filter((payment) => payment.method === 'gift_card').reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
        notes: saleNote,
        status: 'complete',
      })

      setTransactionSaveState('synced')
      setCompletedTransaction({
        ...transaction,
        customer: effectiveCustomer,
        receiptBranding,
        registerLocation,
        collectionUpdate: effectiveCustomer && !effectiveCustomer.guest ? makeCollectionUpdate(effectiveCustomer, lines) : null,
      })
      resetTransactionDraft()
    } catch (error) {
      setTransactionSaveState('failed')
      setTransactionError(error?.message || 'The transaction was not completed.')
    } finally {
      setIsSubmitting(false)
      window.setTimeout(() => scannerRef.current?.focus(), 20)
    }
  }

  async function submitRefund(approvedBy = null) {
    const original = transactions.find((transaction) => (
      String(transaction.id) === String(refundDraft.transactionNumber).trim()
      || String(transaction.number || '').toLowerCase() === refundDraft.transactionNumber.trim().toLowerCase()
    ))
    const amount = Number(refundDraft.amount || 0)
    if (!original || amount <= 0) {
      setNotice('Enter a valid completed transaction number and refund amount.')
      return
    }
    try {
      await onCompleteRefund({
        originalTransactionId: original.id,
        refundAmount: amount,
        refundMethod: refundDraft.method,
        reason: refundDraft.reason,
        approvedBy: approvedBy?.username || '',
      })
      setNotice(`Refund recorded for ${original.number || original.id}.`)
      setRefundDraft({ transactionNumber: '', amount: '', method: 'cash', reason: '' })
      setActiveModal('')
    } catch (error) {
      setNotice(error?.message || 'Refund could not be completed.')
    }
  }

  function startRefund() {
    const original = transactions.find((transaction) => (
      String(transaction.id) === String(refundDraft.transactionNumber).trim()
      || String(transaction.number || '').toLowerCase() === refundDraft.transactionNumber.trim().toLowerCase()
    ))
    const amount = Number(refundDraft.amount || 0)
    if (!original) {
      setNotice('Enter a valid completed transaction number before requesting a refund.')
      return
    }
    if (amount <= 0) {
      setNotice('Enter a valid refund amount.')
      return
    }
    if (amount <= REFUND_APPROVAL_THRESHOLD) {
      submitRefund()
      return
    }
    if (operatorCanDiscount) {
      submitRefund({ username: employeeName })
      return
    }
    requestManagerApproval(`Approve this ${money.format(amount)} refund before completing it. Refunds over ${money.format(REFUND_APPROVAL_THRESHOLD)} require supervisor or manager approval.`, submitRefund)
  }

  function newSale() {
    setCompletedTransaction(null)
    setReceiptActionNotice('')
    setReceiptEmailDraft('')
    setIsReceiptEmailPromptOpen(false)
    setIsResolvingReceiptEmail(false)
    setMode('sale')
    setTransactionSaveState('synced')
    window.setTimeout(() => scannerRef.current?.focus(), 20)
  }

  function printReceipt() {
    setReceiptActionNotice('Opening the Windows print dialog...')
    window.print()
  }

  function sendReceiptEmail(recipient) {
    const branding = completedTransaction.receiptBranding || {}
    const itemLines = (completedTransaction.items || []).map((item) => {
      const quantity = Number(item.quantity || 1)
      const lineTotal = Number(item.total || 0)
      return `${quantity} x ${item.name || item.sku || 'Item'} - ${money.format(lineTotal)}`
    }).join('\n')
    const subject = `${branding.storeName || 'Store'} receipt ${completedTransaction.number}`
    const body = [
      branding.storeName || 'Store',
      branding.address,
      branding.phone,
      '',
      completedTransaction.type === 'buy' ? 'Trade Complete' : 'Purchase Complete',
      `Receipt #: ${completedTransaction.number}`,
      `Date: ${new Date(completedTransaction.createdAt || Date.now()).toLocaleString('en-CA')}`,
      '',
      itemLines || 'No item details available.',
      '',
      `Subtotal: ${money.format(Number(completedTransaction.subtotal || 0))}`,
      `Tax: ${money.format(Number(completedTransaction.tax || 0))}`,
      `Total: ${money.format(Number(completedTransaction.total || 0))}`,
      '',
      `Powered by CollectorsHub`,
    ].filter((line) => line !== undefined && line !== null).join('\n')
    window.open(`mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank')
    setReceiptActionNotice(`Email draft opened for ${recipient}.`)
    setIsReceiptEmailPromptOpen(false)
  }

  async function resolveReceiptCustomerEmail(customerRecord) {
    const existing = String(customerRecord?.email || '').trim()
    if (existing) return existing

    const profileId = customerRecord?.profileId || customerRecord?.collectorshub_user_id
    if (!profileId) return ''

    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('email')
        .eq('id', profileId)
        .maybeSingle()
      if (error) throw error

      const resolved = String(data?.email || '').trim()
      if (resolved) {
        setCompletedTransaction((current) => (
          current?.number === completedTransaction?.number
            ? { ...current, customer: { ...(current.customer || {}), email: resolved } }
            : current
        ))
      }
      return resolved
    } catch (error) {
      console.warn('[Desktop Receipt] Could not resolve customer email:', error)
      return ''
    }
  }

  async function emailReceipt() {
    if (!completedTransaction) return

    setReceiptActionNotice('')
    setIsResolvingReceiptEmail(true)
    try {
      const recipient = await resolveReceiptCustomerEmail(completedTransaction.customer)
      if (recipient) {
        sendReceiptEmail(recipient)
        return
      }

      setReceiptEmailDraft('')
      setIsReceiptEmailPromptOpen(true)
      setReceiptActionNotice('Enter an email address for this receipt.')
    } finally {
      setIsResolvingReceiptEmail(false)
    }
  }

  function submitReceiptEmail(event) {
    event.preventDefault()
    const recipient = receiptEmailDraft.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      setReceiptActionNotice('Enter a valid email address for this receipt.')
      return
    }

    setCompletedTransaction((current) => (
      current
        ? { ...current, customer: { ...(current.customer || {}), email: recipient } }
        : current
    ))
    sendReceiptEmail(recipient)
  }

  return (
    <section className="register-workspace">
      <header className="register-header register-screen-header">
        <div>
          <h1>Register</h1>
        </div>
        <div className="register-action-cluster">
          <div className="register-actions-menu">
            <button className="register-actions-trigger" type="button" onClick={() => setActiveMenu((current) => current === 'actions' ? '' : 'actions')}>
              Register Actions
              {heldSales.length ? <b>{heldSales.length}</b> : null}
            </button>
            {activeMenu === 'actions' ? (
              <div className="register-actions-popover">
                <button type="button" onClick={holdSale}>Hold Sale</button>
                <button type="button" onClick={() => openModal('heldSales')}>Held Sales {heldSales.length ? `(${heldSales.length})` : ''}</button>
                <button type="button" onClick={() => setNotice('Cash drawer opened locally.')}>Open Cash Drawer</button>
                <button type="button" onClick={() => { setCashAdjustment({ type: 'in', amount: '', reason: '' }); openModal('cashAdjustment') }}>Cash In</button>
                <button type="button" onClick={() => { setCashAdjustment({ type: 'out', amount: '', reason: '' }); openModal('cashAdjustment') }}>Cash Out / Paid Out</button>
                <button type="button" onClick={() => openModal('refund')}>Refund</button>
                <button type="button" onClick={() => { setPendingOrderDiscount(orderDiscount); openModal('orderDiscount') }}>Order Discount</button>
                <button type="button" onClick={() => openModal('saleNote')}>Add Sale Note</button>
                <button type="button" onClick={() => openModal('registerHistory')}>Register History</button>
              </div>
            ) : null}
          </div>
          <button className={isOpen ? 'open-register-button secondary-register-button' : 'gold-button open-register-button'} type="button" onClick={onToggleRegister}>
            <Plus size={18} />
            {isOpen ? 'Close Register' : 'Open Register'}
          </button>
        </div>
      </header>

      <section className="register-metric-row" aria-label="Register metrics">
        <RegisterMetric icon={ShoppingCart} label="Sales Today" value={money.format(Number(registerMetrics?.salesToday || 0))} />
        <RegisterMetric icon={ReceiptText} label="Transactions" value={String(Number(registerMetrics?.transactionCount || 0))} gold />
        <RegisterMetric icon={Boxes} label="Items Sold" value={String(Number(registerMetrics?.itemsSold || 0))} />
        <RegisterMetric icon={Banknote} label="Cash Drawer" value={money.format(Number(registerMetrics?.registerBalance || 0))} gold />
      </section>

      <div className="register-grid register-dashboard-grid">
        <section className="register-main-panel register-pos-panel">
          <div className="mode-tabs" role="tablist" aria-label="Transaction mode">
            {[
              ['sale', 'Sale', ShoppingCart],
              ['buy', 'Buy / Trade-In', RefreshCw],
              ['scan_intake', 'Scan Intake', ScanLine],
            ].map(([key, label, Icon]) => (
              <button
                className={mode === key ? 'active-lite' : ''}
                type="button"
                key={key}
                onClick={() => setMode(key === 'customer_buy' ? 'sale' : key)}
              >
                <Icon size={18} />
                {label}
              </button>
            ))}
          </div>

          {mode === 'scan_intake' ? (
            <ScanIntakePanel
              activeSession={activeScanSession}
              customer={effectiveCustomer}
              filters={['All', 'Needs Review', 'Unidentified', 'Ambiguous Match', 'Duplicate', 'Graded', 'Pricing Missing']}
              onAddManualMatch={addScanIntakeManualMatch}
              onAbandon={() => setScanSessionStatus('abandoned')}
              onConvert={convertScanSessionToBuy}
              onPause={() => setScanSessionStatus('paused')}
              onRemoveItem={removeScanItem}
              onResume={() => setScanSessionStatus('active')}
              onScan={scanIntakeFromDevice}
              onStart={startScanIntakeSession}
              onUpdateItem={updateScanItem}
              query={scanIntakeQuery}
              reviewFilter={scanReviewFilter}
              reviewItems={scanReviewItems}
              scannerStatus={scanStatus}
              setQuery={setScanIntakeQuery}
              setReviewFilter={setScanReviewFilter}
              stats={scanStats}
            />
          ) : (
          <>
          <div className="scanner-search-popover">
            <form className="scanner-entry" onSubmit={handleScannerSubmit}>
              <Keyboard size={24} />
              <input
                ref={scannerRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={mode === 'buy' ? 'Scan, search, or add an item being bought or sold...' : 'Scan barcode, SKU, card, or search catalogue...'}
              />
              {mode === 'sale' ? (
                <button type="button" onClick={runSaleScanner} title="Run sale scanner">
                  <ScanLine size={18} />
                </button>
              ) : null}
            </form>
            {mode === 'sale' && (saleScannerStats.scanned || saleScannerStats.pending || saleScannerStats.unavailable) ? (
              <div className="sale-scanner-strip">
                <span>Scanner: {scanStatus}</span>
                <span>{saleScannerStats.scanned} scanned</span>
                <span>{saleScannerStats.added} added</span>
                <span>{saleScannerStats.unavailable} unavailable</span>
                {saleScannerStats.pending ? <span>{saleScannerStats.pending} pending ID</span> : null}
              </div>
            ) : null}
            {query.trim() ? (
              <div className="scanner-results">
                {scannerResults.length ? scannerResults.map((item) => {
                  const remainingStock = remainingInventoryForCart(item, lines)
                  if (mode === 'buy') {
                    return (
                      <div className="scanner-buy-result" key={`${mode}-${item.id || item.sku || item.name}`}>
                        <ItemThumb item={item} />
                        <span>
                          <strong>{item.name || item.title || 'Untitled item'}</strong>
                          <small>{[item.sku ? `SKU ${item.sku}` : '', item.category, item.marketValueSource, item.salesUsed ? `${item.salesUsed} sales used` : ''].filter(Boolean).join(' | ')}</small>
                        </span>
                        <button type="button" onClick={() => addTradeItem(item)}>Buy</button>
                      </div>
                    )
                  }
                  return (
                    <button
                      type="button"
                      key={`${mode}-${item.id || item.sku || item.name}`}
                      onClick={() => addInventoryItem(item)}
                    >
                      <ItemThumb item={item} />
                      <span>
                        <strong>{item.name || item.title || 'Untitled item'}</strong>
                        <small>{[item.sku ? `SKU ${item.sku}` : '', item.category, mode === 'buy' ? 'Buy candidate' : `${remainingStock} in stock`].filter(Boolean).join(' | ')}</small>
                      </span>
                      <b>{mode === 'buy' ? 'Buy' : 'Add'}</b>
                    </button>
                  )
                }) : (
                  <div className="scanner-results-empty">
                    {mode === 'buy' && isSearchingBuyCatalogue
                      ? 'Searching the CollectorsHub catalogue...'
                      : mode === 'buy' && buyCatalogueSearchError
                        ? buyCatalogueSearchError
                        : mode === 'buy'
                          ? 'No matching buy candidates. Press Enter to add this as a new customer item.'
                          : 'No matching stocked inventory at this location.'}
                  </div>
                )}
                {mode === 'buy' && isSearchingBuyCatalogue && scannerResults.length ? (
                  <div className="scanner-results-empty">Searching the full CollectorsHub catalogue...</div>
                ) : null}
              </div>
            ) : null}
          </div>
          {stockNotice ? (
            <p className="register-notice stock-notice">
              <span>Low stock: {stockNotice.name} - {stockNotice.available} remaining at this location.</span>
              <button type="button" onClick={() => setStockNotice(null)} aria-label="Dismiss stock notice">x</button>
            </p>
          ) : null}
          {notice ? (
            <DismissibleAlert className="register-notice" onDismiss={() => setNotice('')}>
              {notice}
            </DismissibleAlert>
          ) : null}
          {transactionError ? (
            <DismissibleAlert className="register-warning" onDismiss={() => setTransactionError('')}>
              {transactionError}
            </DismissibleAlert>
          ) : null}

          <section className="sale-items-panel">
            <div className="sale-items-header">
              <span><strong>{mode === 'buy' ? 'Trade Items' : 'Sale Items'}</strong><small>{mode === 'buy' ? 'Customer items in and store items out' : 'Leaving store inventory'}</small></span>
              <small>{lineCount} item{lineCount === 1 ? '' : 's'}</small>
            </div>

            {!lines.length ? (
              <div className="register-empty">
                <Archive size={76} />
                <strong>Scan or search for an item to begin.</strong>
                <span>Items added to this sale will appear here.</span>
              </div>
            ) : (
              <div className="transaction-table-wrap">
                <table className="transaction-table">
                  <thead>
                    <tr>
                      <th>Qty</th>
                      <th>Item</th>
                      <th>Condition</th>
                      <th>{mode === 'buy' ? 'Market' : 'Unit Price'}</th>
                      <th>{mode === 'buy' ? 'Store Offer' : 'Discount'}</th>
                      <th>Total</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => {
                      const incoming = line.direction === 'incoming'
                      const lineTotal = incoming
                        ? Number(line.storeOffer || 0) * Number(line.quantity || 1)
                        : Number(line.unitPrice || 0) * Number(line.quantity || 1) - discountAmount(line)
                      const isDiscounted = Number(line.discount || 0) > 0
                      return (
                        <tr className={`${selectedLineId === line.localId ? 'selected' : ''} ${isDiscounted ? 'discounted' : ''}`} key={line.localId} onClick={() => setSelectedLineId(line.localId)}>
                          <td>
                            <div className="qty-stepper">
                              <button type="button" onClick={() => adjustLineQuantity(line.localId, -1)}><Minus size={14} /></button>
                              <strong>{line.quantity}</strong>
                              <button type="button" onClick={() => adjustLineQuantity(line.localId, 1)}><Plus size={14} /></button>
                            </div>
                          </td>
                          <td>
                            <span className="register-item-cell">
                              <ItemThumb item={line} />
                              <span>
                                <strong>{line.name}</strong>
                                <small>{[line.sku ? `SKU ${line.sku}` : '', incoming ? 'Customer item' : line.category].filter(Boolean).join(' | ')}</small>
                              </span>
                            </span>
                          </td>
                          <td>
                            <select
                              value={line.condition || ''}
                              onChange={(event) => {
                                const condition = event.target.value
                                if (!incoming) {
                                  updateLine(line.localId, { condition })
                                  return
                                }
                                const priced = marketValueForLineCondition(line, condition)
                                const patch = { condition }
                                if (priced.value != null) {
                                  patch.marketValue = priced.value
                                  patch.marketValueSource = priced.source
                                  patch.salesUsed = priced.count
                                  patch.storeOffer = suggestedStoreCreditOffer(priced.value)
                                }
                                updateLine(line.localId, patch)
                              }}
                            >
                              {conditionOptions(mode, line.category).map((option) => <option key={option}>{option}</option>)}
                            </select>
                          </td>
                          <td>
                            {incoming ? (
                              <span className="readonly-money-value">{money.format(Number(line.marketValue || 0))}</span>
                            ) : (
                              <MoneyInput
                                value={line.unitPrice}
                                onChange={(value) => updateLine(line.localId, { unitPrice: value })}
                              />
                            )}
                          </td>
                          <td>
                            {incoming ? (
                              <MoneyInput
                                value={line.storeOffer}
                                onChange={(value) => updateLine(line.localId, { storeOffer: value })}
                              />
                            ) : (
                              <PercentInput
                                value={line.discount}
                                onChange={(value) => applyItemDiscount(line.localId, value)}
                              />
                            )}
                          </td>
                          <td><strong>{money.format(lineTotal)}</strong></td>
                          <td>
                            <span className="line-actions">
                              <button className="icon-action delete" type="button" onClick={() => removeLine(line.localId)} aria-label="Remove item">
                                <Trash2 size={16} />
                              </button>
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <div className="transaction-footer">
                  <button type="button" onClick={clearSale} disabled={!lines.length}><Trash2 size={16} /> Clear Sale</button>
                  <span />
                  <strong>{lineCount} item{lineCount === 1 ? '' : 's'} · {money.format(subtotal)}</strong>
                </div>
              </div>
            )}
          </section>

          <section className="browse-inventory-panel">
            <div className="browse-inventory-header">
              <span><strong>Recommended Items</strong><small>Based on the current sale and store inventory</small></span>
              <button type="button" onClick={() => setIsRecommendedCollapsed((current) => !current)} aria-label="Toggle recommended items">
                {isRecommendedCollapsed ? 'v' : '^'}
              </button>
            </div>
            {shouldShowRecommendedBody ? (
              <div className="browse-results">
                {recommendedItems.map((item) => (
                  <button type="button" key={item.id} onClick={() => addInventoryItem(item)}>
                    <ItemThumb item={item} />
                    <span>
                      <strong>{item.name || item.title || 'Untitled item'}</strong>
                      <small>{[item.sku ? `SKU ${item.sku}` : '', item.category].filter(Boolean).join(' | ')}</small>
                      <b>{money.format(registerRetailPrice(item))}</b>
                      <em><Plus size={15} /> Add to Sale</em>
                    </span>
                  </button>
                ))}
                {!recommendedItems.length ? (
                  <div className="recommended-empty">
                    No matching recommendations found.
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
          </>
          )}
        </section>
        <aside className="register-side-panel">
              <section className="customer-card">
                <div className="side-title">
                  <User size={20} />
                  <strong>Customer</strong>
                  <button type="button" onClick={() => setIsCustomerCollapsed((current) => !current)}>{isCustomerCollapsed ? 'v' : '^'}</button>
                </div>
                {!isCustomerCollapsed && customer ? (
                  <div className="attached-customer">
                    <span className="customer-avatar">{initials(customer.name || customer.username || 'Guest')}</span>
                    <span>
                      <strong>{customer.name || customer.username || 'CollectorsHub Customer'}</strong>
                      <span>{customer.guest ? 'Guest' : customer.kind === 'profile' ? 'Member' : 'Customer'}</span>
                      <small>Store Credit <b>{money.format(Number(customer.storeCredit || 0))}</b></small>
                      {!customer.guest ? <small>Purchase XP <b>+250 XP</b></small> : null}
                    </span>
                    {!customer.guest ? <button type="button">View Customer</button> : null}
                    <button type="button" aria-label="Remove customer" onClick={() => { setCustomer(null); setGuestLegalName('') }}>x</button>
                  </div>
                ) : null}
                {!isCustomerCollapsed && customer?.guest && mode === 'buy' ? (
                  <label className="guest-legal-name">
                    <span>Guest legal name</span>
                    <input
                      value={guestLegalName}
                      onChange={(event) => setGuestLegalName(event.target.value)}
                      placeholder="Required for store buy/trade-in"
                    />
                  </label>
                ) : null}
                {!isCustomerCollapsed && !customer ? (
                  <>
                    <div className="customer-actions">
                      <button type="button" onClick={() => { setCustomer({ name: 'Guest', guest: true, storeCredit: 0 }); setGuestLegalName('') }}><User size={15} /> Guest</button>
                      <button type="button"><Keyboard size={17} /> Scan Membership</button>
                    </div>
                    <div className="customer-search-popover">
                      <label className="customer-search compact-customer-search">
                        <Search size={16} />
                        <input data-customer-search value={customerQuery} onChange={(event) => setCustomerQuery(event.target.value)} placeholder="Search customer" />
                      </label>
                      {customerQuery.trim() ? (
                        <div className="customer-results-overlay">
                          {customerMatches.length ? (
                            <div className="customer-matches">
                              {customerMatches.map((entry) => (
                                <button type="button" key={entry.id || entry.email} onClick={() => { setCustomer(entry); setGuestLegalName('') }}>
                                  <strong>{entry.name || entry.username || entry.email}</strong>
                                  <small>{entry.username ? `@${entry.username}` : entry.email || entry.phone || 'Customer'}</small>
                                </button>
                              ))}
                            </div>
                          ) : null}
                          {isSearchingProfiles ? <p className="customer-search-state">Searching CollectorsHub usernames...</p> : null}
                          {!isSearchingProfiles && !customerMatches.length && !profileSearchError ? <p className="customer-search-state">No matching CollectorsHub username found.</p> : null}
                          {profileSearchError ? <p className="customer-search-state error">{profileSearchError}</p> : null}
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : null}
                {!isCustomerCollapsed && mode === 'buy' && !customer ? <p className="register-warning">Attach a customer before completing a trade-in.</p> : null}
                {!isCustomerCollapsed && requiresRecordedGuestName && !hasRecordedGuestName ? <p className="register-warning">Record the guest's legal name before completing this buy.</p> : null}
              </section>

              <section className="totals-card">
                <div className="side-title">
                  <ShoppingCart size={20} />
                  <strong>{mode === 'buy' ? 'Trade Summary' : 'Current Sale'}</strong>
                  <span className="side-title-actions">
                    <button className="order-discount-button" type="button" onClick={() => { setPendingOrderDiscount(orderDiscount); openModal('orderDiscount') }} title="Add transaction-wide discount">
                      <Tag size={15} />
                      <span>Discount</span>
                    </button>
                    <button type="button" onClick={() => setIsCurrentSaleCollapsed((current) => !current)} aria-label={isCurrentSaleCollapsed ? 'Expand current sale' : 'Collapse current sale'}>{isCurrentSaleCollapsed ? 'v' : '^'}</button>
                  </span>
                </div>
                {!isCurrentSaleCollapsed ? (
                  <>
                    <TotalRow label="Customer purchases" value={grossItemSubtotal} />
                    <TotalRow label="Trade-in credit" value={-tradeOfferTotal} muted />
                    <TotalRow label="Discounts" value={-discounts} />
                    <div className="totals-divider" aria-hidden="true" />
                    <TotalRow label="Subtotal" value={subtotal} />
                    <TotalRow label={taxLabel} value={tax} />
                    <div className="grand-total">
                      <span>Total</span>
                      <strong>{money.format(payoutDue > 0 ? payoutDue : amountDue)}</strong>
                    </div>
                    {amountDue > 0 || payoutDue > 0 ? (
                      <div className="current-payment-controls">
                        <button className={paymentMethod === 'cash' ? 'active' : ''} type="button" onClick={() => setPaymentMethod('cash')}><Banknote size={16} /> Cash</button>
                        {payoutDue > 0 ? (
                          <button className={paymentMethod === 'store_credit' ? 'active' : ''} type="button" disabled={!customer || customer.guest} onClick={() => setPaymentMethod('store_credit')}><Gift size={16} /> Store Credit</button>
                        ) : (
                          <>
                            <button className={paymentMethod === 'card' ? 'active' : ''} type="button" onClick={() => setPaymentMethod('card')}><CreditCard size={16} /> Card</button>
                            <button className={paymentMethod === 'other' ? 'active' : ''} type="button" onClick={() => { setPaymentMethod('other'); openModal('otherPayment') }}><Gift size={16} /> Other</button>
                          </>
                        )}
                        {paymentMethod === 'cash' && amountDue > 0 ? (
                          <div className="cash-payment-summary">
                            <span>Total Due <strong>{money.format(cashDue)}</strong></span>
                            {cashRounding ? <small className="cash-rounding-note">Cash rounding: {cashRounding > 0 ? '+' : ''}{money.format(cashRounding)}</small> : null}
                            <label>Cash Received<input value={cashReceived} onChange={(event) => setCashReceived(event.target.value)} inputMode="decimal" placeholder="0.00" /></label>
                            <span className={cashAmount > 0 ? 'change-due active' : 'change-due'}>Change Due <strong>{money.format(changeDue)}</strong></span>
                          </div>
                        ) : null}
                        {paymentMethod === 'cash' && payoutDue > 0 ? <div className="cash-payment-summary"><span>Cash payout <strong>{money.format(payoutDue)}</strong></span></div> : null}
                        {appliedPayments.length ? (
                          <div className="applied-payment-list">
                            {appliedPayments.map((payment) => <span key={payment.id}>{payment.method.replace('_', ' ')} {money.format(payment.amount)}</span>)}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <div className={`transaction-save-state ${transactionSaveState}`}>
                      {transactionSaveState === 'saving' ? 'Saving transaction...' : transactionSaveState === 'failed' ? 'Save failed. Review before retrying.' : appliedPayments.length ? 'Payments saved locally' : 'Ready'}
                    </div>
                    <button className="pay-button" type="button" onClick={completeTransaction} disabled={!canComplete}>
                      <ReceiptText size={20} />
                      {mode === 'buy' ? (payoutDue > 0 ? `Complete Buy - ${money.format(payoutDue)}` : `Complete Settlement - ${money.format(amountDue)}`) : `Complete Checkout - ${money.format(amountDue)}`}
                    </button>
                    {disabledCheckoutReason ? <p className="checkout-disabled-reason">{disabledCheckoutReason}</p> : null}
                  </>
                ) : null}
              </section>

              <section className="payment-card compact-payment-card">
                <div className="side-title"><strong>{payoutDue > 0 ? 'Payout Method' : 'Payment Method'}</strong></div>
                <div className="payment-buttons">
                  <button className={paymentMethod === 'cash' ? 'active' : ''} type="button" onClick={() => setPaymentMethod('cash')}><Banknote size={16} /> Cash</button>
                  {payoutDue <= 0 ? <button className={paymentMethod === 'card' ? 'active' : ''} type="button" onClick={() => setPaymentMethod('card')}><CreditCard size={16} /> Card</button> : null}
                  {payoutDue <= 0 ? <button className={paymentMethod === 'store_credit' ? 'active' : ''} type="button" onClick={() => setPaymentMethod('store_credit')} disabled={!customer || customer.guest}>Store Credit</button> : null}
                  {payoutDue <= 0 ? <button className={paymentMethod === 'gift_card' ? 'active' : ''} type="button" onClick={() => setPaymentMethod('gift_card')}><Gift size={16} /> Gift Card</button> : null}
                  {payoutDue <= 0 ? <button className={paymentMethod === 'split' ? 'active' : ''} type="button" onClick={() => setPaymentMethod('split')}>Split</button> : null}
                </div>

                {paymentMethod === 'cash' ? (
                  <div className="cash-pad">
                    <label>Amount tendered<input value={cashReceived} onChange={(event) => setCashReceived(event.target.value)} inputMode="decimal" placeholder="0.00" /></label>
                    <div>
                      {[cashDue, Math.ceil(cashDue / 5) * 5, Math.ceil(cashDue / 10) * 10, 50].filter((value, index, array) => value > 0 && array.indexOf(value) === index).map((value) => (
                        <button type="button" key={value} onClick={() => setCashReceived(String(value.toFixed(2)))}>{value === cashDue ? 'Exact' : money.format(value)}</button>
                      ))}
                    </div>
                    <strong>Change Due {money.format(changeDue)}</strong>
                  </div>
                ) : null}

                {paymentMethod === 'card' ? <p className="payment-state">Card terminal: Ready. The transaction completes after approval.</p> : null}
                {paymentMethod === 'split' ? (
                  <div className="split-payment-box">
                    <span>Remaining: {money.format(remaining)}</span>
                    <button type="button" onClick={() => applyPayment('cash', Number(cashReceived || 0))}>Apply Cash</button>
                    <button type="button" onClick={() => applyPayment('card', remaining)}>Apply Card Balance</button>
                  </div>
                ) : null}
                {appliedPayments.length ? (
                  <div className="applied-payments">
                    {appliedPayments.map((payment) => <span key={payment.id}>{payment.method.replace('_', ' ')} {money.format(payment.amount)}</span>)}
                  </div>
                ) : null}
                <div className="amount-remaining">Amount Remaining: <strong>{money.format(remaining)}</strong></div>

                <button className="pay-button" type="button" onClick={completeTransaction} disabled={!canComplete}>
                  <LockKeyhole size={20} />
                  {mode === 'buy' ? `Complete Buy - ${money.format(payoutDue)}` : `Pay ${money.format(amountDue)}`}
                </button>
              </section>
        </aside>
      </div>

      {activeModal ? (
        <div className="register-modal" role="dialog" aria-modal="true">
          <section>
            <button className="modal-close" type="button" onClick={() => setActiveModal('')}><X size={18} /></button>
            {activeModal === 'otherPayment' ? (
              <>
                <h2>Other Payment</h2>
                <p>Apply Store Credit, Gift Card, or split tenders without changing the main checkout layout.</p>
                <div className="modal-summary-row"><span>Remaining</span><strong>{money.format(remaining)}</strong></div>
                <div className="modal-action-grid">
                  <button type="button" disabled={!customer || customer.guest || Number(customer?.storeCredit || 0) <= 0} onClick={() => applyPayment('store_credit', Math.min(remaining, Number(customer?.storeCredit || 0)), { status: 'applied' })}>
                    Store Credit
                    <small>{customer && !customer.guest ? money.format(Number(customer.storeCredit || 0)) : 'Attach customer'}</small>
                  </button>
                  <button type="button" onClick={() => applyPayment('gift_card', remaining, { status: 'applied' })}>Gift Card / Certificate</button>
                  <button type="button" onClick={() => setPaymentMethod('split')}>Split Payment</button>
                  <button type="button" onClick={() => applyPayment('card', remaining, { status: 'approved' })}>Card Balance</button>
                  <button type="button" onClick={() => applyPayment('cash', Number(cashReceived || 0), { tendered: Number(cashReceived || 0), status: 'received' })}>Apply Cash Entered</button>
                </div>
                {paymentMethod === 'split' ? (
                  <p className="payment-state">Split mode is active. Apply one tender at a time until the remaining amount reaches $0.00.</p>
                ) : null}
                {appliedPayments.length ? (
                  <div className="modal-chip-list">
                    {appliedPayments.map((payment) => <span key={payment.id}>{payment.method.replace('_', ' ')} {money.format(payment.amount)}</span>)}
                  </div>
                ) : null}
              </>
            ) : null}

            {activeModal === 'orderDiscount' ? (
              <>
                <h2>Order Discount</h2>
                <p>Apply a transaction-wide discount. Cashiers need an approved active promo or manager authorization.</p>
                <div className="modal-form-grid">
                  <label>
                    <span>Discount Type</span>
                    <select value={pendingOrderDiscount.type} onChange={(event) => setPendingOrderDiscount((current) => ({ ...current, type: event.target.value }))}>
                      <option value="percent">Percentage</option>
                      <option value="fixed">Fixed Dollar</option>
                    </select>
                  </label>
                  <label>
                    <span>{pendingOrderDiscount.type === 'percent' ? 'Percent' : 'Amount'}</span>
                    <input value={pendingOrderDiscount.value} onChange={(event) => setPendingOrderDiscount((current) => ({ ...current, value: event.target.value }))} inputMode="decimal" />
                  </label>
                  <label>
                    <span>Promo Code</span>
                    <input value={pendingOrderDiscount.code} onChange={(event) => setPendingOrderDiscount((current) => ({ ...current, code: event.target.value }))} placeholder="Optional" />
                  </label>
                </div>
                <div className="modal-summary-row"><span>Discount</span><strong>{money.format(orderDiscountAmount(pendingOrderDiscount, itemSubtotal))}</strong></div>
                <div className="modal-actions">
                  <button type="button" onClick={() => setOrderDiscount({ type: 'percent', value: 0, code: '', approved: false })}>Remove Discount</button>
                  <button className="gold-button" type="button" onClick={applyOrderDiscount}>Apply Discount</button>
                </div>
              </>
            ) : null}

            {activeModal === 'heldSales' ? (
              <>
                <h2>Held Sales</h2>
                <p>Resume a suspended transaction without losing the current register session.</p>
                <div className="held-sales-list">
                  {heldSales.length ? heldSales.map((heldSale) => (
                    <button type="button" key={heldSale.id} onClick={() => resumeHeldSale(heldSale)}>
                      <strong>{heldSale.customer?.name || heldSale.customer?.username || 'Guest sale'}</strong>
                      <small>{new Date(heldSale.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {heldSale.lines.length} item{heldSale.lines.length === 1 ? '' : 's'} · {money.format(Number(heldSale.total || 0))}</small>
                    </button>
                  )) : <span className="empty-modal-state">No held sales.</span>}
                </div>
              </>
            ) : null}

            {activeModal === 'saleNote' ? (
              <>
                <h2>Sale Note</h2>
                <p>Internal transaction note. This is not customer-facing.</p>
                <textarea value={saleNote} onChange={(event) => setSaleNote(event.target.value)} placeholder="Add a register note..." />
                <div className="modal-actions">
                  <button type="button" onClick={() => setSaleNote('')}>Clear Note</button>
                  <button className="gold-button" type="button" onClick={() => setActiveModal('')}>Save Note</button>
                </div>
              </>
            ) : null}

            {activeModal === 'cashAdjustment' ? (
              <>
                <h2>{cashAdjustment.type === 'out' ? 'Cash Out / Paid Out' : 'Cash In'}</h2>
                <p>Record drawer adjustments locally for expected cash balance review.</p>
                <div className="modal-form-grid">
                  <label>
                    <span>Amount</span>
                    <input value={cashAdjustment.amount} onChange={(event) => setCashAdjustment((current) => ({ ...current, amount: event.target.value }))} inputMode="decimal" />
                  </label>
                  <label>
                    <span>Reason</span>
                    <input value={cashAdjustment.reason} onChange={(event) => setCashAdjustment((current) => ({ ...current, reason: event.target.value }))} placeholder="Paid out, cash drop, correction..." />
                  </label>
                </div>
                <div className="modal-actions">
                  <button type="button" onClick={() => setActiveModal('')}>Cancel</button>
                  <button className="gold-button" type="button" onClick={() => requestManagerApproval('Approve this cash drawer adjustment.', recordCashAdjustment)}>Record Adjustment</button>
                </div>
              </>
            ) : null}

            {activeModal === 'refund' ? (
              <>
                <h2>Refund</h2>
                <p>Refunds are linked to the original completed transaction. Refunds over {money.format(REFUND_APPROVAL_THRESHOLD)} require supervisor or manager approval.</p>
                <div className="modal-form-grid">
                  <label>
                    <span>Original transaction</span>
                    <input value={refundDraft.transactionNumber} onChange={(event) => setRefundDraft((current) => ({ ...current, transactionNumber: event.target.value }))} placeholder="Transaction number" autoFocus />
                  </label>
                  <label>
                    <span>Refund amount</span>
                    <input value={refundDraft.amount} onChange={(event) => setRefundDraft((current) => ({ ...current, amount: event.target.value }))} inputMode="decimal" placeholder="0.00" />
                  </label>
                  <label>
                    <span>Refund method</span>
                    <select value={refundDraft.method} onChange={(event) => setRefundDraft((current) => ({ ...current, method: event.target.value }))}>
                      <option value="cash">Cash</option>
                      <option value="card">Card</option>
                      <option value="store_credit">Store Credit</option>
                    </select>
                  </label>
                  <label>
                    <span>Reason</span>
                    <input value={refundDraft.reason} onChange={(event) => setRefundDraft((current) => ({ ...current, reason: event.target.value }))} placeholder="Reason for refund" />
                  </label>
                </div>
                <div className="modal-actions">
                  <button type="button" onClick={() => setActiveModal('')}>Cancel</button>
                  <button className="gold-button" type="button" onClick={startRefund}>Request Refund</button>
                </div>
              </>
            ) : null}

            {activeModal === 'registerHistory' ? (
              <>
                <h2>Register History</h2>
                <p>Recent local register activity for this workstation.</p>
                <div className="held-sales-list">
                  <span>Held sales: {heldSales.length}</span>
                  <span>Applied payments: {appliedPayments.length}</span>
                  <span>Transaction status: {transactionSaveState}</span>
                  {saleNote ? <span>Sale note saved locally.</span> : null}
                </div>
              </>
            ) : null}
          </section>
        </div>
      ) : null}

      {managerRequest ? (
        <div className="register-modal manager-modal" role="dialog" aria-modal="true">
          <section>
            <button className="modal-close" type="button" onClick={() => setManagerRequest(null)}><X size={18} /></button>
            <LockKeyhole size={34} />
            <h2>Manager Approval</h2>
            <p>{managerRequest.reason}</p>
            <div className="modal-form-grid">
              <label><span>Manager username</span><input value={managerUsername} onChange={(event) => setManagerUsername(event.target.value)} placeholder="Supervisor username" autoFocus /></label>
              <label><span>Manager PIN</span><input value={managerPin} onChange={(event) => setManagerPin(event.target.value)} type="password" placeholder="Required" onKeyDown={(event) => { if (event.key === 'Enter') approveManagerRequest() }} /></label>
            </div>
            {managerError ? <p className="register-warning">{managerError}</p> : null}
            <div className="modal-actions">
              <button type="button" onClick={() => setManagerRequest(null)}>Cancel</button>
              <button className="gold-button" type="button" onClick={approveManagerRequest} disabled={isApprovingManager || !managerUsername.trim() || !managerPin.trim()}>{isApprovingManager ? 'Checking...' : 'Approve'}</button>
            </div>
          </section>
        </div>
      ) : null}

      {completedTransaction ? (
        <div className="completion-modal" role="dialog" aria-modal="true">
          <section>
            <button className="modal-close" type="button" onClick={newSale}><X size={18} /></button>
            <div className="completion-screen-summary">
              <ReceiptText size={38} />
              <h2>{completedTransaction.type === 'buy' ? 'Trade Complete' : completedTransaction.type === 'refund' ? 'Refund Complete' : 'Purchase Complete'}</h2>
              <strong>{completedTransaction.number}</strong>
              <span>{money.format(Math.abs(Number(completedTransaction.total || 0)))}</span>
            </div>
            <ReceiptDocument transaction={completedTransaction} />
            <p className="receipt-email-hint">
              {completedTransaction.customer?.email
                ? `Email receipt to ${completedTransaction.customer.email}`
                : completedTransaction.customer?.guest
                  ? 'Guest receipt: enter an email when choosing Email Receipt.'
                  : 'Email receipt uses the linked CollectorsHub account when available.'}
            </p>
            {receiptActionNotice ? <p className="receipt-action-notice">{receiptActionNotice}</p> : null}
            {isReceiptEmailPromptOpen ? (
              <form className="receipt-email-prompt" onSubmit={submitReceiptEmail}>
                <label>
                  Receipt email
                  <input
                    type="email"
                    value={receiptEmailDraft}
                    onChange={(event) => setReceiptEmailDraft(event.target.value)}
                    placeholder="customer@email.com"
                    autoFocus
                  />
                </label>
                <div className="receipt-email-prompt-actions">
                  <button type="button" onClick={() => { setIsReceiptEmailPromptOpen(false); setReceiptEmailDraft('') }}>Cancel</button>
                  <button className="gold-button" type="submit" disabled={!receiptEmailDraft.trim()}>Email Receipt</button>
                </div>
              </form>
            ) : null}
            <div className="completion-actions">
              <button type="button" onClick={printReceipt}><ReceiptText size={16} /> Print / Save PDF</button>
              <button type="button" onClick={emailReceipt} disabled={isResolvingReceiptEmail}>
                {isResolvingReceiptEmail ? 'Finding Email...' : 'Email Receipt'}
              </button>
              <button type="button" onClick={newSale}>No Receipt</button>
              <button type="button" onClick={() => { onNavigate('transactions'); setCompletedTransaction(null) }}>View Transaction</button>
              <button className="gold-button" type="button" onClick={newSale}>New Sale</button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  )
}

function ScanIntakePanel({
  activeSession,
  customer,
  filters,
  onAbandon,
  onAddManualMatch,
  onConvert,
  onPause,
  onRemoveItem,
  onResume,
  onScan,
  onStart,
  onUpdateItem,
  query,
  reviewFilter,
  reviewItems,
  scannerStatus,
  setQuery,
  setReviewFilter,
  stats,
}) {
  const sessionItems = activeSession?.items || []
  const acceptedCount = sessionItems.filter((item) => item.reviewState === 'accepted' && item.confidenceState !== 'low').length
  const isPaused = activeSession?.status === 'paused'
  const canScan = activeSession && activeSession.status !== 'abandoned' && activeSession.status !== 'complete'

  return (
    <section className="scan-intake-register-panel">
      <div className="scan-intake-hero">
        <div>
          <p className="register-kicker">Scan Intake</p>
          <h2>Bulk collection intake</h2>
          <span>Customer: <strong>{customer?.name || customer?.username || activeSession?.customer?.name || 'No customer attached'}</strong></span>
        </div>
        <div className="scan-intake-actions">
          {!activeSession ? <button className="gold-button" type="button" onClick={onStart}><ScanLine size={17} /> Start Scanner</button> : null}
          {canScan ? <button className="gold-button" type="button" onClick={onScan} disabled={isPaused}><ScanLine size={17} /> Scan Item</button> : null}
          {activeSession && !isPaused ? <button type="button" onClick={onPause}>Pause</button> : null}
          {activeSession && isPaused ? <button type="button" onClick={onResume}>Resume</button> : null}
          {activeSession ? <button type="button" onClick={onAbandon}>Abandon</button> : null}
        </div>
      </div>

      <div className="scan-session-grid">
        <section className="scan-session-card">
          <span className={`scanner-status-dot ${scannerStatus.toLowerCase()}`}><i /> Scanner {scannerStatus}</span>
          <strong>{activeSession?.number || 'No active scan session'}</strong>
          <small>Started: {activeSession?.startedAt ? new Date(activeSession.startedAt).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : '-'}</small>
          <small>{activeSession?.savedState === 'saved_locally' ? 'Saved locally ✓' : 'Waiting for first save'}</small>
        </section>
        <ScanStat label="Items scanned" value={stats.total} />
        <ScanStat label="Identified" value={stats.identified} />
        <ScanStat label="Needs Review" value={stats.needsReview} />
        <ScanStat label="Unidentified" value={stats.unidentified} />
        <ScanStat label="Duplicates" value={stats.duplicates} />
        <ScanStat label="Estimated Market" value={money.format(stats.marketValue)} />
        <ScanStat label="Store Offer" value={money.format(stats.cashOffer)} />
      </div>

      <div className="scan-intake-lookup">
        <form onSubmit={(event) => { event.preventDefault(); onAddManualMatch() }}>
          <Keyboard size={20} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Scan barcode/SKU, or type catalogue search for this intake..." />
          <button type="submit">Add / Match</button>
        </form>
      </div>

      <section className="scan-queue-panel">
        <div className="scan-queue-header">
          <span><strong>Scanned Item Queue</strong><small>{acceptedCount} accepted for Buy / Trade-In</small></span>
          <button className="gold-button" type="button" onClick={onConvert} disabled={!acceptedCount}>Review & Continue</button>
        </div>
        <div className="scan-review-filters">
          {filters.map((filter) => (
            <button className={reviewFilter === filter ? 'active' : ''} type="button" key={filter} onClick={() => setReviewFilter(filter)}>
              {filter}
            </button>
          ))}
        </div>
        <div className="scan-queue-list">
          {!activeSession ? (
            <div className="scan-empty-state">Start a scan session to capture bulk intake items.</div>
          ) : !reviewItems.length ? (
            <div className="scan-empty-state">No items match this review filter.</div>
          ) : reviewItems.map((item) => (
            <ScannedItemRow key={item.id} item={item} onRemove={() => onRemoveItem(item.id)} onUpdate={(patch) => onUpdateItem(item.id, patch)} />
          ))}
        </div>
      </section>
    </section>
  )
}

function ScanStat({ label, value }) {
  return (
    <section className="scan-stat-card">
      <small>{label}</small>
      <strong>{value}</strong>
    </section>
  )
}

function ScannedItemRow({ item, onRemove, onUpdate }) {
  return (
    <article className={`scanned-item-row ${item.reviewState}`}>
      <div className="scan-confidence-mark">{confidenceSymbol(item)}</div>
      <div className="scanned-item-main">
        <strong>{item.name || 'Unidentified item'}</strong>
        <small>{[item.category, item.sku ? `SKU ${item.sku}` : '', item.reviewReason].filter(Boolean).join(' | ')}</small>
        {item.notes ? <small>{item.notes}</small> : null}
        {item.duplicateWarning ? <em>Possible duplicate: verify this is another physical copy.</em> : null}
      </div>
      <label>
        Condition
        <select value={item.condition || 'Near Mint'} onChange={(event) => onUpdate({ condition: event.target.value })}>
          {conditionOptions('buy', item.category).map((option) => <option key={option}>{option}</option>)}
        </select>
      </label>
      <label>
        Qty
        <input value={item.quantity || 1} onChange={(event) => onUpdate({ quantity: Math.max(1, Number(event.target.value || 1)) })} inputMode="numeric" />
      </label>
      <label>
        Market
        <MoneyInput value={item.marketValue} onChange={(value) => onUpdate({ marketValue: value, cashOffer: suggestedCashOffer(value), storeCreditOffer: suggestedStoreCreditOffer(value) })} />
      </label>
      <label>
        Cash Offer
        <MoneyInput value={item.cashOffer} onChange={(value) => onUpdate({ cashOffer: value })} />
      </label>
      <label className="scan-graded-toggle">
        Graded
        <input type="checkbox" checked={!!item.graded} onChange={(event) => onUpdate({ graded: event.target.checked })} />
      </label>
      {item.graded ? (
        <div className="scan-graded-fields">
          <input value={item.gradingCompany || ''} onChange={(event) => onUpdate({ gradingCompany: event.target.value })} placeholder="Company" />
          <input value={item.grade || ''} onChange={(event) => onUpdate({ grade: event.target.value })} placeholder="Grade" />
          <input value={item.certificationNumber || ''} onChange={(event) => onUpdate({ certificationNumber: event.target.value })} placeholder="Cert #" />
        </div>
      ) : null}
      <div className="scan-row-actions">
        <button type="button" onClick={() => onUpdate({ reviewState: 'accepted', confidenceState: item.confidenceState === 'low' ? 'medium' : item.confidenceState })}>Accept</button>
        <button type="button" onClick={() => onUpdate({ reviewState: 'needs_review' })}>Review</button>
        <button type="button" onClick={() => onUpdate({ reviewState: 'unable_to_identify', confidenceState: 'low', reviewReason: 'Unable to identify' })}>Unable</button>
        <button className="delete" type="button" onClick={onRemove}>Remove</button>
      </div>
    </article>
  )
}

function ReceiptDocument({ transaction }) {
  const branding = transaction.receiptBranding || {}
  const items = transaction.items || []
  const outgoing = items.filter((item) => item.direction !== 'incoming')
  const incoming = items.filter((item) => item.direction === 'incoming')
  const grossPurchases = outgoing.reduce((sum, item) => sum + Number(item.unitPrice || 0) * Number(item.quantity || 1), 0)
  const tradeCredit = incoming.reduce((sum, item) => sum + Number(item.storeOffer || 0) * Number(item.quantity || 1), 0)
  const discountTotal = Number(transaction.discounts || 0)
  const subtotal = Number(transaction.subtotal || 0)
  const tax = Number(transaction.tax || 0)
  const total = Number(transaction.total || 0)
  const payout = Number(transaction.payout?.amount || 0)
  const isRefund = transaction.type === 'refund'
  const isBuy = transaction.type === 'buy'
  const isEven = Math.abs(total) < 0.005
  const receiptTitle = isRefund
    ? 'Refund Complete'
    : isBuy
      ? 'Trade Complete'
      : transaction.type === 'exchange' ? 'Exchange Complete' : 'Purchase Complete'
  const totalLabel = isEven ? 'EVEN TRADE' : payout > 0 ? 'STORE OWES' : 'TOTAL DUE'
  const createdAt = new Date(transaction.createdAt || Date.now())
  const dateText = createdAt.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
  const timeText = createdAt.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })
  const customer = transaction.customer
  const paymentRows = (transaction.payments || []).filter((payment) => Number(payment.amount || 0) !== 0)

  return (
    <article className="receipt-paper">
      <header className="receipt-store-header">
        {branding.logoUrl ? <img src={branding.logoUrl} alt={`${branding.storeName || 'Store'} logo`} /> : <div className="receipt-store-mark">{String(branding.storeName || 'Store').slice(0, 1).toUpperCase()}</div>}
        <div>
          <h1>{branding.storeName || 'Store'}</h1>
          {branding.address ? <p>{branding.address}</p> : null}
          {branding.phone ? <p>{branding.phone}</p> : null}
          {branding.email ? <p>{branding.email}</p> : null}
          {branding.locationName ? <p>{branding.locationName}</p> : null}
        </div>
      </header>
      <div className="receipt-gold-rule" />

      <section className="receipt-completion-heading">
        <span className="receipt-check">✓</span>
        <div>
          <h2>{receiptTitle}</h2>
          <p>Thank you for supporting {branding.storeName || 'our store'}.</p>
        </div>
        <div className="receipt-meta">
          <span>Receipt # <strong>{transaction.number || '—'}</strong></span>
          <span>{dateText} · {timeText}</span>
        </div>
      </section>

      <section className="receipt-info-grid">
        <div><small>Register</small><strong>{transaction.registerName || 'Till 1'}</strong></div>
        <div><small>Cashier</small><strong>{transaction.employeeName || 'Employee'}</strong></div>
        <div><small>Location</small><strong>{branding.locationName || 'Primary Location'}</strong></div>
      </section>

      {!customer?.guest && customer ? (
        <section className="receipt-customer-block">
          <small>Customer</small>
          <strong>{customer.name || customer.username || customer.email}</strong>
          <span>{customer.username ? `CollectorsHub Member · @${customer.username}` : customer.email || 'CollectorsHub Member'}</span>
        </section>
      ) : null}

      <section className="receipt-items-section">
        <h3>Items</h3>
        <div className="receipt-item-table">
          <div className="receipt-item-head"><span>Item</span><span>Qty</span><span>Condition</span><span>Unit Price</span><span>Discount</span><span>Trade / Offer</span><span>Total</span></div>
          {items.length ? items.map((item, index) => {
            const quantity = Number(item.quantity || 1)
            const lineTotal = Number(item.total ?? (item.direction === 'incoming' ? item.storeOffer : item.unitPrice) * quantity)
            const itemDiscount = Number(item.discountTotal || 0)
            return (
              <div className="receipt-item-row" key={`${item.id || item.localId || item.sku || 'item'}-${index}`}>
                <div className="receipt-item-name"><strong>{item.name || item.sku || 'Item'}</strong><small>{[item.category, item.sku ? `SKU ${item.sku}` : '', item.direction === 'incoming' ? 'Customer trade-in' : 'Store item'].filter(Boolean).join(' · ')}</small></div>
                <span>{quantity}</span>
                <span>{item.condition || '—'}</span>
                <span>{money.format(Number(item.direction === 'incoming' ? item.marketValue || item.storeOffer : item.unitPrice || 0))}</span>
                <span>{itemDiscount ? `-${money.format(itemDiscount)}` : '$0.00'}</span>
                <span>{item.direction === 'incoming' ? money.format(Number(item.storeOffer || 0)) : '—'}</span>
                <strong>{money.format(lineTotal)}</strong>
              </div>
            )
          }) : <div className="receipt-empty-row">No item details available.</div>}
        </div>
      </section>

      <section className="receipt-summary">
        <h3>Transaction Summary</h3>
        <ReceiptAmount label="Customer Purchases" value={grossPurchases} />
        <ReceiptAmount label="Discounts" value={-discountTotal} positive={discountTotal > 0} />
        <div className="receipt-rule" />
        <ReceiptAmount label="Purchase Subtotal" value={subtotal} />
        <ReceiptAmount label={`${transaction.taxLabel || 'HST'} · ${(Number(transaction.taxRate || 0) * 100).toFixed(2)}%`} value={tax} />
        <ReceiptAmount label="Trade-In Credit" value={-tradeCredit} positive={tradeCredit > 0} />
        <div className="receipt-rule" />
        <ReceiptAmount label={totalLabel} value={payout > 0 ? payout : total} total />
      </section>

      <section className="receipt-payment">
        <h3>Payment Details</h3>
        {paymentRows.length ? paymentRows.map((payment, index) => <ReceiptAmount key={`${payment.method || 'payment'}-${index}`} label={String(payment.method || 'Payment').replaceAll('_', ' ')} value={payment.amount} />) : <ReceiptAmount label="Payment Method" value={0} />}
        {transaction.payout?.method ? <ReceiptAmount label={`${String(transaction.payout.method).replaceAll('_', ' ')} payout`} value={payout} /> : null}
      </section>

      {transaction.collectionUpdate && customer && !customer.guest ? (
        <section className="receipt-collection-update"><h3>Collection Update</h3><p>{transaction.collectionUpdate.message}</p></section>
      ) : null}
      {branding.returnPolicy ? <section className="receipt-policy"><h3>Returns & Exchanges</h3><p>{branding.returnPolicy}</p></section> : null}

      <footer className="receipt-footer">
        <strong>Thank you for supporting {branding.storeName || 'our store'}</strong>
        <span>Powered by CollectorsHub</span>
        <small>Collect. Track. Connect.</small>
      </footer>
    </article>
  )
}

function ReceiptAmount({ label, value, positive = false, total = false }) {
  return <div className={total ? 'receipt-amount total' : 'receipt-amount'}><span>{label}</span><strong className={positive ? 'positive' : ''}>{money.format(Number(value || 0))}</strong></div>
}

function MoneyInput({ value, onChange, zeroAsDash = false }) {
  const [isEditing, setIsEditing] = useState(false)
  const numericValue = Number(value || 0)
  const displayValue = isEditing
    ? String(value ?? 0)
    : (zeroAsDash && numericValue === 0 ? '-' : money.format(numericValue))

  function commit(nextValue) {
    const numeric = Number(String(nextValue || '').replace(/[^0-9.-]/g, '')) || 0
    onChange(numeric)
  }

  return (
    <input
      className="money-input"
      inputMode="decimal"
      value={displayValue}
      onBlur={(event) => {
        commit(event.target.value)
        setIsEditing(false)
      }}
      onChange={(event) => onChange(Number(String(event.target.value || '').replace(/[^0-9.-]/g, '')) || 0)}
      onFocus={(event) => {
        setIsEditing(true)
        window.setTimeout(() => event.target.select(), 0)
      }}
    />
  )
}

function PercentInput({ value, onChange }) {
  const [isEditing, setIsEditing] = useState(false)
  const numericValue = Number(value || 0)
  const displayValue = isEditing
    ? String(value ?? 0)
    : (numericValue === 0 ? '-' : `${numericValue}%`)

  function parsePercent(nextValue) {
    return Math.max(0, Math.min(100, Number(String(nextValue || '').replace(/[^0-9.-]/g, '')) || 0))
  }

  return (
    <input
      className="money-input percent-input"
      inputMode="decimal"
      value={displayValue}
      onBlur={(event) => {
        onChange(parsePercent(event.target.value))
        setIsEditing(false)
      }}
      onChange={(event) => onChange(parsePercent(event.target.value))}
      onFocus={(event) => {
        setIsEditing(true)
        window.setTimeout(() => event.target.select(), 0)
      }}
    />
  )
}

function discountAmount(line) {
  const percent = Math.max(0, Math.min(100, Number(line.discount || 0)))
  if (!percent) return 0
  return (Number(line.unitPrice || 0) * Number(line.quantity || 1) * percent) / 100
}

function orderDiscountAmount(discount, subtotal) {
  const base = Math.max(0, Number(subtotal || 0))
  const value = Math.max(0, Number(discount?.value || 0))
  if (!base || !value) return 0
  if (discount?.type === 'fixed') return Math.min(base, value)
  return Math.min(base, base * (Math.min(100, value) / 100))
}

function makeCollectionUpdate(customer, lines) {
  const firstItem = lines.find((line) => line.direction !== 'incoming')
  const itemName = firstItem?.name || 'Purchased item'
  const customerName = customer?.name || customer?.username || 'Customer'
  return {
    message: `${itemName} was checked against ${customerName}'s CollectorsHub profile.`,
    detail: 'Wishlist, collection, set completion, and XP hooks are ready for the backend collection service.',
  }
}

function TotalRow({ label, value, muted }) {
  return (
    <div className={muted ? 'total-row muted' : 'total-row'}>
      <span>{label}</span>
      <strong>{money.format(Number(value || 0))}</strong>
    </div>
  )
}

function checkoutDisabledReason({ amountDue, canComplete, cashAmount, cashDue, customer, hasRecordedGuestName, hasUnpricedTradeItems, isOpen, lines, mode, paymentMethod, payoutDue, remaining }) {
  if (canComplete) return ''
  if (!isOpen) return 'Open the register to continue.'
  if (!lines.length) return 'Add at least one item to continue.'
  if (mode === 'buy' && !customer) return 'Attach a customer before completing this transaction.'
  if (!hasRecordedGuestName) return "Record the guest's legal name to continue."
  if (mode === 'buy' && hasUnpricedTradeItems) return 'Enter a store offer for each trade-in item.'
  if ((amountDue > 0 || payoutDue > 0) && !paymentMethod) return 'Select a settlement method to continue.'
  if (paymentMethod === 'other' && remaining > 0) return 'Apply a tender from Other payment to continue.'
  if (paymentMethod === 'cash' && cashAmount < cashDue) return 'Enter enough cash received to cover the rounded cash total.'
  return 'Complete the required transaction details to continue.'
}

function RegisterMetric({ gold, icon: Icon, label, value }) {
  return (
    <article className="register-metric-card">
      <span className={gold ? 'metric-icon gold' : 'metric-icon'}>
        <Icon size={30} />
      </span>
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
      </span>
      <ArrowRight size={20} />
    </article>
  )
}

function recommendationTerms(item) {
  return [
    item.category,
    item.subcategory,
    item.franchise,
    item.game,
    item.brand,
    item.manufacturer,
    item.publisher,
    item.set,
    item.series,
    item.product,
    item.sport,
    item.league,
    item.team,
    item.cardType,
    item.itemType,
  ]
    .flatMap((value) => String(value || '').split(/[|;,/]/))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 1)
}

function itemSearchValues(item) {
  return [
    item.name,
    item.title,
    item.sku,
    item.barcode,
    item.number,
    item.category,
    item.subcategory,
    item.franchise,
    item.game,
    item.brand,
    item.manufacturer,
    item.publisher,
    item.set,
    item.series,
    item.product,
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
}

function nextScanSessionNumber(sessions) {
  const max = (sessions || []).reduce((highest, session) => {
    const number = Number(String(session.number || '').replace(/\D/g, ''))
    return Number.isFinite(number) ? Math.max(highest, number) : highest
  }, 0)
  return `SI-${String(max + 1).padStart(6, '0')}`
}

function normaliseScanEvent(image, workflow) {
  return {
    scanId: createId('scan_event'),
    timestamp: new Date().toISOString(),
    sourceDevice: 'Windows WIA scanner',
    workflow,
    image: {
      path: image?.path || '',
      url: image?.url || '',
      fileName: image?.fileName || '',
    },
    barcode: '',
    metadata: {},
    status: 'saved_locally',
  }
}

function recognisedCardSearchTerms(result = {}) {
  return [
    result.id_number,
    [result.subject, result.id_number].filter(Boolean).join(' '),
    [result.subject, result.property].filter(Boolean).join(' '),
    result.subject,
    result.property,
  ]
    .map((value) => String(value || '').trim())
    .filter((value, index, list) => value.length > 1 && list.indexOf(value) === index)
}

async function enrichRecognizedCatalogueItem(candidate, result = {}) {
  const itemId = candidate?.item?.item_id || ''
  for (const term of recognisedCardSearchTerms(result)) {
    const results = await searchDesktopTradeCatalogue(term)
    const match = results.find((item) => item.catalogItemId === itemId || item.catalogueItemId === itemId)
    if (match) return match
  }

  const item = candidate?.item
  if (!item) return null
  return {
    id: `catalog_${item.item_id}`,
    catalogItemId: item.item_id,
    catalogueItemId: item.item_id,
    sku: item.card_number || item.catalog_code || item.upc || '',
    number: item.card_number || item.catalog_code || item.upc || '',
    name: item.name || item.subject || result.subject || 'Recognized card',
    title: item.name || item.subject || result.subject || 'Recognized card',
    category: result.category || '',
    image: item.imageUrl || '',
    imageUrl: item.imageUrl || '',
    marketValue: Number(item.market_price ?? item.retail_price ?? 0),
    price: Number(item.market_price ?? item.retail_price ?? 0),
    marketValueSource: item.market_price || item.retail_price ? 'Catalogue pricing' : '',
    releaseYear: item.release_year || '',
    dynamicFields: item.dynamic_fields || {},
    isCatalogueCandidate: true,
  }
}

function inventoryMatchesCatalogueCandidate(inventoryItem, candidateItem) {
  const candidateId = candidateItem?.catalogItemId || candidateItem?.catalogueItemId || candidateItem?.item_id || ''
  if (!candidateId) return false
  return [
    inventoryItem?.catalogItemId,
    inventoryItem?.catalogueItemId,
    inventoryItem?.catalog_item_id,
    inventoryItem?.item_id,
    inventoryItem?.catalogue_item_id,
  ].some((value) => String(value || '') === String(candidateId))
}

function duplicateCountForScanItem(items, candidate) {
  const identity = candidate.catalogItemId
    ? `catalog:${candidate.catalogItemId}`
    : candidate.sku
      ? `sku:${String(candidate.sku).toLowerCase()}`
      : `name:${String(candidate.name || '').toLowerCase()}`
  if (!identity || identity === 'name:') return 1
  return 1 + (items || []).filter((item) => {
    const itemIdentity = item.catalogItemId
      ? `catalog:${item.catalogItemId}`
      : item.sku
        ? `sku:${String(item.sku).toLowerCase()}`
        : `name:${String(item.name || '').toLowerCase()}`
    return itemIdentity === identity
  }).length
}

function suggestedCashOffer(marketValue) {
  return Math.round(Number(marketValue || 0) * 0.65 * 100) / 100
}

function suggestedStoreCreditOffer(marketValue) {
  return Math.round(Number(marketValue || 0) * 0.75 * 100) / 100
}

function marketValueForLineCondition(item, condition) {
  const normalized = normalizeRegisterCondition(condition)
  const values = item?.conditionMarketValues || item?.marketStats?.byCondition || {}
  const stat = values[normalized] || Object.entries(values).find(([key]) => normalizeRegisterCondition(key) === normalized)?.[1]
  if (!stat) return { value: null, source: '', count: 0 }
  const value = Number(stat.average30Day ?? stat.average ?? stat.marketValue ?? stat.value)
  if (!Number.isFinite(value)) return { value: null, source: '', count: Number(stat.count || 0) }
  const usedRecent = stat.average30Day != null
  const count = Number((usedRecent ? stat.recentCount : stat.count) || stat.salesCount || 0)
  return {
    value,
    count,
    source: `${count || 'Approved'} sale${count === 1 ? '' : 's'} ${usedRecent ? '30-day' : 'all-time'} avg (${normalized})`,
  }
}

function normalizeRegisterCondition(condition) {
  const text = String(condition || '').trim()
  const compact = text.toLowerCase().replace(/[^a-z0-9]/g, '')
  const map = {
    sealed: 'New/Sealed',
    newsealed: 'New/Sealed',
    new: 'New/Sealed',
    complete: 'Pre-Owned 100%',
    preowned100: 'Pre-Owned 100%',
    preownedcomplete: 'Pre-Owned 100%',
    missingparts: 'Pre-Owned - Missing Parts',
    preownedmissingparts: 'Pre-Owned - Missing Parts',
    dmg: 'Damaged',
    damaged: 'Damaged',
    nm: 'Near Mint',
    nearmint: 'Near Mint',
    lp: 'Lightly Played',
    lightlyplayed: 'Lightly Played',
    mp: 'Moderately Played',
    moderatelyplayed: 'Moderately Played',
    hp: 'Heavily Played',
    heavilyplayed: 'Heavily Played',
    usedcomplete: 'Used/Complete',
  }
  return map[compact] || text
}

function buildScanStats(items) {
  return (items || []).reduce((stats, item) => {
    stats.total += Number(item.quantity || 1)
    if (item.confidenceState === 'high' || item.reviewState === 'accepted') stats.identified += Number(item.quantity || 1)
    if (item.reviewState === 'needs_review' || item.confidenceState === 'medium') stats.needsReview += Number(item.quantity || 1)
    if (item.confidenceState === 'low') stats.unidentified += Number(item.quantity || 1)
    if (Number(item.duplicateCount || 0) > 1 || item.duplicateWarning) stats.duplicates += 1
    stats.marketValue += Number(item.marketValue || 0) * Number(item.quantity || 1)
    stats.cashOffer += Number(item.cashOffer || 0) * Number(item.quantity || 1)
    return stats
  }, { total: 0, identified: 0, needsReview: 0, unidentified: 0, duplicates: 0, marketValue: 0, cashOffer: 0 })
}

function confidenceSymbol(item) {
  if (item.reviewState === 'accepted' || item.confidenceState === 'high') return '✓'
  if (item.confidenceState === 'medium' || item.reviewState === 'needs_review') return '!'
  return 'x'
}

function inventoryIdentity(item) {
  const id = item?.inventoryId || item?.id
  if (id) return `id:${id}`
  const sku = String(item?.sku || '').trim().toLowerCase()
  return sku ? `sku:${sku}` : ''
}

function inventoryStock(item) {
  return Number(item?.quantityAvailable ?? item?.quantity ?? item?.available ?? item?.onHand ?? 0)
}

function cartQuantityForInventoryItem(lines, item) {
  const targetIdentity = inventoryIdentity(item)
  if (!targetIdentity) return 0
  return lines
    .filter((line) => line.direction !== 'incoming' && inventoryIdentity(line) === targetIdentity)
    .reduce((sum, line) => sum + Number(line.quantity || 0), 0)
}

function remainingInventoryForCart(item, lines) {
  return Math.max(0, inventoryStock(item) - cartQuantityForInventoryItem(lines, item))
}

function applyTransientInventoryChanges(inventory, lines) {
  const outgoingLines = (lines || []).filter((line) => line.direction !== 'incoming')
  if (!outgoingLines.length) return inventory
  return (inventory || []).map((item) => {
    const soldQuantity = outgoingLines
      .filter((line) => inventoryIdentity(line) && inventoryIdentity(line) === inventoryIdentity(item))
      .reduce((sum, line) => sum + Number(line.quantity || 0), 0)
    if (!soldQuantity) return item
    const nextQuantity = Math.max(0, inventoryStock(item) - soldQuantity)
    return {
      ...item,
      quantity: nextQuantity,
      quantityAvailable: nextQuantity,
      available: nextQuantity,
    }
  })
}

function RegisterContextItem({ icon: Icon, label, value, status }) {
  return (
    <span className={status ? `register-context-item ${status}` : 'register-context-item'}>
      {Icon ? <Icon size={17} /> : <i />}
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
      </span>
    </span>
  )
}

function initials(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'CH'
}

function conditionOptions(mode, category) {
  const categoryText = String(category || '').toLowerCase()
  if (categoryText.includes('service')) return ['N/A']
  if (mode === 'buy' && (categoryText.includes('lego') || categoryText.includes('building'))) {
    return ['New/Sealed', 'Pre-Owned 100%', 'Pre-Owned - Missing Parts', 'Damaged']
  }
  if (!isCollectibleCategory(category)) {
    return ['New', 'Open Box', 'Used - Like New', 'Used - Good', 'Used - Fair', 'Damaged', 'N/A']
  }

  return ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged', 'New/Sealed', 'Used/Complete']
}

function InventoryView({ inventory, isSyncing, onNavigate, onSellItem, onSyncNow, onCreateItem, onUpdateItem, search, setSearch, syncStatus }) {
  const [activeWorkflow, setActiveWorkflow] = useState('')
  const [itemOverrides, setItemOverrides] = useState({})
  const [inventoryNotice, setInventoryNotice] = useState('')
  const [rowMenu, setRowMenu] = useState(null)
  const [stockFilter, setStockFilter] = useState('all')
  const [sortMode, setSortMode] = useState('name')
  const [selectedId, setSelectedId] = useState('')

  const inventoryRows = useMemo(() => (
    (inventory || []).map((item) => {
      const override = itemOverrides[item.id] || {}
      const cost = Number(item.cost ?? item.buyPrice ?? 0)
      const baseInStorePrice = override.inStorePrice ?? item.inStorePrice ?? item.price
      const suggestedPrice = cost > 0 ? Math.round(cost * 1.15 * 100) / 100 : 0
      const inStorePrice = Number(baseInStorePrice ?? suggestedPrice ?? 0)
      const onlinePrice = Number(override.onlinePrice ?? item.onlinePrice ?? inStorePrice ?? 0)
      const hasExplicitPrice = Boolean(override.hasExplicitPrice ?? item.hasExplicitPrice ?? baseInStorePrice != null)
      const hasOnlineDraft = Boolean(override.hasOnlineDraft ?? item.hasOnlineDraft ?? item.listedForSale ?? item.listingApproved ?? false)
      const listingApproved = Boolean(override.listingApproved ?? item.listingApproved ?? false)
      const listedForSale = Boolean((override.listedForSale ?? item.listedForSale) && listingApproved)
      return {
        ...item,
        ...override,
        cost,
        inStorePrice,
        listedForSale,
        listingApproved,
        onlinePrice,
        price: inStorePrice,
        hasExplicitPrice,
        hasOnlineDraft,
        priceIsSuggested: !hasExplicitPrice && suggestedPrice > 0,
      }
    })
  ), [inventory, itemOverrides])

  const categories = useMemo(() => (
    [...new Set(inventoryRows.map((item) => item.category).filter(Boolean))].sort()
  ), [inventoryRows])
  const [categoryFilter, setCategoryFilter] = useState('all')

  const stats = useMemo(() => {
    const rows = inventoryRows
    const availableUnits = rows.reduce((sum, item) => sum + inventoryStock(item), 0)
    const retailValue = rows.reduce((sum, item) => sum + Number(item.inStorePrice || 0) * inventoryStock(item), 0)
    const costValue = rows.reduce((sum, item) => sum + Number(item.cost ?? item.buyPrice ?? 0) * inventoryStock(item), 0)
    const lowStock = rows.filter((item) => inventoryStock(item) <= 1).length
    const unpriced = rows.filter((item) => !item.hasExplicitPrice).length
    const needsApproval = rows.filter((item) => item.hasExplicitPrice && !item.listingApproved && !item.listedForSale).length
    return { rows: rows.length, availableUnits, retailValue, costValue, lowStock, needsApproval, unpriced }
  }, [inventoryRows])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    const rows = inventoryRows.filter((item) => {
      const available = inventoryStock(item)
      if (stockFilter === 'available' && available <= 0) return false
      if (stockFilter === 'low' && available > 1) return false
      if (stockFilter === 'unpriced' && item.hasExplicitPrice) return false
      if (stockFilter === 'approval' && (!item.hasExplicitPrice || item.listingApproved || item.listedForSale)) return false
      if (stockFilter === 'listed' && !item.hasOnlineDraft && !item.listedForSale && !item.listingApproved) return false
      if (categoryFilter !== 'all' && item.category !== categoryFilter) return false
      if (!term) return true
      return [
        item.name,
        item.title,
        item.sku,
        item.barcode,
        item.number,
        item.category,
        item.condition,
        item.gradingCompany,
        item.catalogItemId,
      ].some((value) => String(value || '').toLowerCase().includes(term))
    })

    return [...rows].sort((a, b) => {
      if (sortMode === 'stock') return inventoryStock(b) - inventoryStock(a)
      if (sortMode === 'price') return Number(b.inStorePrice || 0) - Number(a.inStorePrice || 0)
      if (sortMode === 'updated') return new Date(b.syncedAt || 0) - new Date(a.syncedAt || 0)
      return String(a.name || a.title || '').localeCompare(String(b.name || b.title || ''))
    })
  }, [categoryFilter, inventoryRows, search, sortMode, stockFilter])

  useEffect(() => {
    if (!filtered.length) {
      setSelectedId('')
      return
    }
    if (!filtered.some((item) => item.id === selectedId)) {
      setSelectedId(filtered[0].id)
    }
  }, [filtered, selectedId])

  const selected = filtered.find((item) => item.id === selectedId) || filtered[0] || null
  const workflowItem = activeWorkflow === 'create'
    ? {
        id: 'new',
        name: '',
        sku: '',
        barcode: '',
        category: 'General Merchandise',
        itemType: 'general',
        condition: 'New',
        quantityAvailable: 1,
        cost: 0,
        inStorePrice: 0,
        onlinePrice: 0,
      }
    : selected
  const pendingChanges = Number(syncStatus?.pendingLocalChanges || 0)
  const lastSynced = formatSyncTime(syncStatus?.lastSyncAt)

  function updateInventoryItem(itemId, patch) {
    const nextPatch = {
      ...patch,
      syncedAt: patch.syncedAt || new Date().toISOString(),
    }
    setItemOverrides((current) => ({
      ...current,
      [itemId]: {
        ...(current[itemId] || {}),
        ...nextPatch,
      },
    }))
    onUpdateItem?.(itemId, nextPatch)
  }

  function showInventoryNotice(message) {
    setInventoryNotice(message)
  }

  function openWorkflow(workflow, item = selected) {
    if (workflow !== 'create' && !item) return
    if (item) selectInventoryRow(item)
    setActiveWorkflow(workflow)
    setInventoryNotice('')
    setRowMenu(null)
  }

  async function createInventoryItem(patch) {
    const created = await onCreateItem?.(patch)
    if (created?.id) {
      setSelectedId(created.id)
      setStockFilter('all')
      setCategoryFilter('all')
    }
    setInventoryNotice(`${patch.name || 'Item'} was added to inventory.`)
    setActiveWorkflow('')
  }

  function sellSelectedItem() {
    if (!selected) return
    onSellItem?.(selected)
  }

  function selectInventoryRow(item) {
    setSelectedId(item.id)
  }

  async function approveListing(item = selected) {
    if (!item) return
    try {
      const result = await desktopApi().listEbayItem({
        ...item,
        onlinePrice: Number(item.onlinePrice || item.inStorePrice || 0),
      })
      updateInventoryItem(item.id, {
        listedForSale: true,
        listingApproved: true,
        hasOnlineDraft: true,
        onlinePrice: Number(item.onlinePrice || item.inStorePrice || 0),
        ebaySku: result?.sku || item.sku || '',
        ebayOfferId: result?.offerId || '',
        ebayListingId: result?.listingId || '',
        ebayMarketplaceId: result?.marketplaceId || '',
      })
      setStockFilter('listed')
      setSelectedId(item.id)
      setInventoryNotice(`${item.name || item.title || item.sku || 'Item'} was published to eBay${result?.listingId ? ` as listing ${result.listingId}` : ''}.`)
    } catch (error) {
      setInventoryNotice(error?.message || 'Could not publish this item to eBay.')
    }
  }

  function applyDefaultMarkup(item = selected) {
    if (!item) return
    const cost = Number(item.cost ?? item.buyPrice ?? 0)
    if (cost <= 0) {
      setInventoryNotice('Add a purchase cost before applying the 15% pricing rule.')
      return
    }
    const price = Math.round(cost * 1.15 * 100) / 100
    updateInventoryItem(item.id, {
      inStorePrice: price,
      onlinePrice: price,
      hasExplicitPrice: true,
      hasOnlineDraft: false,
      listedForSale: false,
      listingApproved: false,
    })
    setInventoryNotice(`${item.name || item.title || item.sku || 'Item'} was priced at ${money.format(price)} and is waiting for listing approval.`)
  }

  function adjustStock(item = selected, delta = 1) {
    if (!item) return
    const nextQuantity = Math.max(0, inventoryStock(item) + delta)
    updateInventoryItem(item.id, {
      available: nextQuantity,
      quantity: nextQuantity,
      onHand: Math.max(0, Number(item.onHand ?? inventoryStock(item)) + delta),
    })
    setInventoryNotice(`${item.name || item.title || item.sku || 'Item'} stock adjusted to ${nextQuantity}.`)
  }

  function handleInventoryRowKey(event, item) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      selectInventoryRow(item)
    }
  }

  return (
    <div className="inventory-workspace">
      <header className="inventory-page-header">
        <div>
          <h2>Inventory</h2>
          <span>
            {stats.rows.toLocaleString()} {stats.rows === 1 ? 'item' : 'items'} · {money.format(stats.retailValue)} retail value · Last synced {lastSynced} · {pendingChanges.toLocaleString()} pending changes
          </span>
        </div>
        <div className="inventory-page-actions">
          <button className="gold-button" type="button" onClick={() => openWorkflow('create')}>
            <Plus size={17} /> Add Item
          </button>
          <button className="secondary-action" type="button" onClick={onSyncNow} disabled={isSyncing}>
            <RefreshIcon /> {isSyncing ? 'Syncing' : 'Sync'}
          </button>
        </div>
      </header>

      <section className="inventory-summary-grid" aria-label="Inventory summary">
        <InventorySummary label="Retail" value={money.format(stats.retailValue)} />
        <InventorySummary label="Cost" value={money.format(stats.costValue)} />
        <InventorySummary label="Available" value={stats.availableUnits.toLocaleString()} />
        <InventorySummary label="Low Stock" value={String(stats.lowStock)} tone={stats.lowStock ? 'warn' : ''} />
        <InventorySummary label="Needs Approval" value={String(stats.needsApproval)} tone={stats.needsApproval ? 'warn' : ''} />
        <InventorySummary label="Unpriced" value={String(stats.unpriced)} tone={stats.unpriced ? 'warn' : ''} />
      </section>

      {inventoryNotice ? (
        <DismissibleAlert className="inventory-notice" onDismiss={() => setInventoryNotice('')}>
          {inventoryNotice}
        </DismissibleAlert>
      ) : null}

      <section className="inventory-controls">
        <div className="inventory-filter-row" role="group" aria-label="Inventory filters">
          {[
            ['all', 'All'],
            ['available', 'Available'],
            ['low', 'Low Stock'],
            ['unpriced', 'Unpriced'],
            ['approval', 'Needs Approval'],
            ['listed', 'Listed'],
          ].map(([key, label]) => (
            <button className={stockFilter === key ? 'active' : ''} type="button" key={key} onClick={() => setStockFilter(key)}>
              {label}
            </button>
          ))}
        </div>
        <div className="inventory-control-row">
          <label>
            <span>Category</span>
            <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
              <option value="all">All categories</option>
              {categories.map((category) => <option key={category}>{category}</option>)}
            </select>
          </label>
          <label>
            <span>Sort</span>
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value)}>
              <option value="name">Name</option>
              <option value="stock">Available stock</option>
              <option value="price">Price high to low</option>
              <option value="updated">Last synced</option>
            </select>
          </label>
          <SearchBox value={search} onChange={setSearch} />
        </div>
      </section>

      <div className="inventory-detail-layout">
        <section className="inventory-table-panel panel">
          <div className="inventory-table-head">
            <span><strong>{filtered.length.toLocaleString()}</strong> matching records</span>
            <small>{search.trim() ? `Search: ${search.trim()}` : 'Local inventory view'}</small>
          </div>
          <div className="inventory-table">
            <div className="inventory-table-row inventory-table-header">
              <span>Item</span>
              <span>SKU</span>
              <span>Available</span>
              <span>Cost</span>
              <span>In-Store</span>
              <span>Online</span>
              <span>Listing</span>
              <span aria-label="More actions" />
            </div>
            {!filtered.length ? <EmptyState text="No inventory matches the current filters." /> : null}
            {filtered.map((item) => {
              const available = inventoryStock(item)
              const cost = Number(item.cost ?? item.buyPrice ?? 0)
              const inStorePrice = Number(item.inStorePrice || 0)
              const onlinePrice = Number(item.onlinePrice || 0)
              const lowStock = available <= 1
              const unpriced = !item.hasExplicitPrice
              return (
                <div
                  className={selected?.id === item.id ? 'inventory-table-row selected' : 'inventory-table-row'}
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectInventoryRow(item)}
                  onKeyDown={(event) => handleInventoryRowKey(event, item)}
                >
                  <span className="inventory-row-main">
                    <ItemThumb item={item} />
                    <span>
                      <strong>{item.name || item.title}</strong>
                      <small>{[item.category, item.condition, item.grade ? `Grade ${item.grade}` : ''].filter(Boolean).join(' · ')}</small>
                    </span>
                  </span>
                  <span>
                    <strong>{item.sku || '—'}</strong>
                    <small>{item.barcode || item.number || 'No barcode'}</small>
                  </span>
                  <span>
                    <strong>{available}</strong>
                    <small>{Number(item.reserved || 0) ? `${item.reserved} reserved` : `${item.onHand ?? available} on hand`}</small>
                  </span>
                  <span>
                    <strong>{cost > 0 ? money.format(cost) : '—'}</strong>
                    <small>Basis</small>
                  </span>
                  <span>
                    <strong>{inStorePrice > 0 ? money.format(inStorePrice) : '—'}</strong>
                    <small>{item.priceIsSuggested ? 'Suggested' : 'POS'}</small>
                  </span>
                  <span>
                    <strong>{onlinePrice > 0 ? money.format(onlinePrice) : '—'}</strong>
                    <small>Marketplace</small>
                  </span>
                  <span className="inventory-status-stack">
                    <b className={item.listedForSale ? 'inventory-chip' : item.hasOnlineDraft || item.listingApproved ? 'inventory-chip muted' : 'inventory-chip warn'}>
                      {item.listedForSale ? 'Listed' : item.listingApproved ? 'Approved' : item.hasOnlineDraft ? 'Draft' : 'Needs approval'}
                    </b>
                    {lowStock ? <b className="inventory-chip warn">Low</b> : null}
                    {unpriced ? <b className="inventory-chip warn">Unpriced</b> : null}
                  </span>
                  <span className="inventory-row-actions">
                    <button
                      className="inventory-row-more"
                      type="button"
                      aria-label={`Open actions for ${item.name || item.title || item.sku || 'inventory item'}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        selectInventoryRow(item)
                        const rect = event.currentTarget.getBoundingClientRect()
                        setRowMenu(rowMenu?.id === item.id ? null : {
                          id: item.id,
                          left: Math.min(rect.left - 86, window.innerWidth - 130),
                          top: Math.min(rect.bottom + 6, window.innerHeight - 120),
                        })
                      }}
                    >
                      ...
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
        </section>

        <aside className="inventory-detail-panel panel">
          {selected ? (
            <>
              <div className="inventory-detail-card">
                <ItemThumb item={selected} />
                <span>
                  <p className="eyebrow">Selected Item</p>
                  <h3>{selected.name || selected.title}</h3>
                  <small>{[selected.category, selected.condition].filter(Boolean).join(' · ') || selected.inventoryId}</small>
                </span>
              </div>
              <div className="inventory-detail-actions inventory-detail-actions-top">
                <button className="gold-button" type="button" onClick={() => openWorkflow('edit')}>
                  Edit Item
                </button>
                <button type="button" onClick={() => openWorkflow('stock')}>
                  Adjust Stock
                </button>
                <button type="button" onClick={sellSelectedItem}>
                  Sell
                </button>
                <button type="button" onClick={() => openWorkflow('list')}>
                  List Online
                </button>
              </div>
              <div className="inventory-detail-scroll">
                <div className="inventory-detail-metrics">
                  <InventorySummary label="Available" value={String(inventoryStock(selected))} />
                  <InventorySummary label="On Hand" value={String(Number(selected.onHand ?? selected.quantity ?? 0))} />
                  <InventorySummary label="Reserved" value={String(Number(selected.reserved || 0))} />
                  <InventorySummary label="In-Store" value={Number(selected.inStorePrice ?? selected.price ?? 0) > 0 ? money.format(Number(selected.inStorePrice ?? selected.price ?? 0)) : '—'} tone={Number(selected.inStorePrice ?? selected.price ?? 0) <= 0 ? 'warn' : ''} />
                </div>
                <InventoryWorkflowPanel
                  item={selected}
                  mode={activeWorkflow}
                  onAdjustStock={adjustStock}
                  onApplyDefaultMarkup={applyDefaultMarkup}
                  onApproveListing={approveListing}
                  onClose={() => setActiveWorkflow('')}
                  onSaveItem={(patch) => {
                    updateInventoryItem(selected.id, patch)
                    setInventoryNotice(`${selected.name || selected.title || selected.sku || 'Item'} was updated locally.`)
                    setActiveWorkflow('')
                  }}
                />
                <div className="inventory-field-list">
                  <InventoryField label="SKU" value={selected.sku} />
                  <InventoryField label="Barcode" value={selected.barcode} />
                  <InventoryField label="Cost" value={selected.cost != null || selected.buyPrice != null ? money.format(Number(selected.cost ?? selected.buyPrice)) : ''} />
                  <InventoryField label="In-Store Price" value={selected.inStorePrice != null || selected.price != null ? money.format(Number(selected.inStorePrice ?? selected.price)) : ''} />
                  <InventoryField label="Online Price" value={selected.onlinePrice != null ? money.format(Number(selected.onlinePrice)) : ''} />
                <InventoryField label="Price Source" value={selected.priceIsSuggested ? 'Suggested from cost' : 'Employee set'} />
                <InventoryField label="Listing Status" value={selected.listedForSale ? 'Listed' : selected.listingApproved ? 'Approved' : selected.hasOnlineDraft ? 'Draft' : 'Needs approval'} />
                <InventoryField label="eBay Listing" value={selected.ebayListingId || selected.ebayOfferId} />
                  <InventoryField label="Trade-In" value={selected.isTradeIn ? 'Yes' : 'No'} />
                  <InventoryField label="Last Synced" value={selected.syncedAt ? new Date(selected.syncedAt).toLocaleString() : ''} />
                </div>
                <details className="inventory-more-details">
                  <summary>More details</summary>
                  <div className="inventory-field-list compact">
                    <InventoryField label="Catalogue ID" value={selected.catalogItemId} />
                    <InventoryField label="Inventory ID" value={selected.inventoryId || selected.id} />
                  </div>
                </details>
                <div className="inventory-detail-actions">
                  <button type="button" onClick={() => setSearch(selected.sku || selected.barcode || selected.name || '')}>Search Similar</button>
                  <button type="button" onClick={() => openWorkflow('label')}>Print Label</button>
                </div>
              </div>
            </>
          ) : (
            <EmptyState text="Select an inventory item to inspect details." />
          )}
        </aside>
      </div>
      {rowMenu ? (
        <div className="inventory-row-menu" style={{ left: rowMenu.left, top: rowMenu.top }}>
          <button type="button" onClick={() => openWorkflow('edit', inventoryRows.find((item) => item.id === rowMenu.id))}>Edit</button>
          <button type="button" onClick={() => openWorkflow('stock', inventoryRows.find((item) => item.id === rowMenu.id))}>Adjust</button>
          <button type="button" onClick={() => openWorkflow('list', inventoryRows.find((item) => item.id === rowMenu.id))}>List</button>
        </div>
      ) : null}
    </div>
  )
}

function InventorySummary({ label, value, tone = '' }) {
  return (
    <article className={tone ? `inventory-summary ${tone}` : 'inventory-summary'}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function InventoryField({ label, value }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value || '—'}</strong>
    </div>
  )
}

function InventoryWorkflowPanel({ item, mode, onAdjustStock, onApplyDefaultMarkup, onApproveListing, onClose, onSaveItem }) {
  const itemName = item.name || item.title || item.sku || 'Inventory item'
  const cost = Number(item.cost ?? item.buyPrice ?? 0)
  const suggestedPrice = cost > 0 ? Math.round(cost * 1.15 * 100) / 100 : 0
  const [editDraft, setEditDraft] = useState({
    category: '',
    condition: '',
    inStorePrice: '',
    onlinePrice: '',
  })

  useEffect(() => {
    if (!item || mode !== 'edit') return
    setEditDraft({
      category: item.category || '',
      condition: item.condition || '',
      inStorePrice: String(Number(item.inStorePrice || item.price || suggestedPrice || 0) || ''),
      onlinePrice: String(Number(item.onlinePrice || item.inStorePrice || item.price || suggestedPrice || 0) || ''),
    })
  }, [item?.id, item?.inStorePrice, item?.onlinePrice, item?.price, item?.category, item?.condition, mode, suggestedPrice])

  if (!mode || !item) return null

  function saveEdit(event) {
    event.preventDefault()
    const inStoreDraft = String(editDraft.inStorePrice || '').trim()
    const onlineDraft = String(editDraft.onlinePrice || '').trim()
    const inStorePrice = inStoreDraft ? Number(inStoreDraft) : Number(item.inStorePrice || item.price || suggestedPrice || 0)
    const onlinePrice = onlineDraft ? Number(onlineDraft) : Number(item.onlinePrice || item.inStorePrice || item.price || suggestedPrice || 0)
    onSaveItem({
      category: String(editDraft.category || item.category || ''),
      condition: String(editDraft.condition || item.condition || ''),
      inStorePrice,
      onlinePrice,
      hasExplicitPrice: inStorePrice > 0 || onlinePrice > 0,
      hasOnlineDraft: false,
      listedForSale: false,
      listingApproved: false,
    })
  }

  function fillMarkupPrice() {
    if (suggestedPrice <= 0) return
    const value = String(suggestedPrice)
    setEditDraft((current) => ({ ...current, inStorePrice: value, onlinePrice: value }))
  }

  return (
    <section className="inventory-workflow-card" aria-label="Inventory action">
      <div className="inventory-workflow-head">
        <strong>
          {mode === 'edit' ? 'Edit item' : mode === 'stock' ? 'Adjust stock' : mode === 'list' ? 'List online' : 'Print label'}
        </strong>
        <button type="button" onClick={onClose} aria-label="Close inventory action">
          <X size={15} />
        </button>
      </div>

      {mode === 'edit' ? (
        <form className="inventory-workflow-form" onSubmit={saveEdit}>
          <div className="inventory-readonly-field">
            <span>Cost</span>
            <strong>{cost > 0 ? money.format(cost) : '—'}</strong>
          </div>
          <label>
            <span>In-store price</span>
            <input name="inStorePrice" type="number" min="0" step="0.01" value={editDraft.inStorePrice} onChange={(event) => setEditDraft((current) => ({ ...current, inStorePrice: event.target.value }))} />
          </label>
          <label>
            <span>Online price</span>
            <input name="onlinePrice" type="number" min="0" step="0.01" value={editDraft.onlinePrice} onChange={(event) => setEditDraft((current) => ({ ...current, onlinePrice: event.target.value }))} />
          </label>
          <label>
            <span>Category</span>
            <input name="category" value={editDraft.category} onChange={(event) => setEditDraft((current) => ({ ...current, category: event.target.value }))} />
          </label>
          <label>
            <span>Condition</span>
            <input name="condition" value={editDraft.condition} onChange={(event) => setEditDraft((current) => ({ ...current, condition: event.target.value }))} />
          </label>
          <div className="inventory-workflow-actions">
            <button type="button" onClick={fillMarkupPrice}>Use 15% markup</button>
            <button className="gold-button" type="submit">Save</button>
          </div>
          <small>Saving resets online listing approval until the item is reviewed.</small>
        </form>
      ) : null}

      {mode === 'stock' ? (
        <div className="inventory-workflow-stack">
          <p>{inventoryStock(item)} available · {Number(item.reserved || 0)} reserved</p>
          <div className="inventory-workflow-actions">
            <button type="button" onClick={() => onAdjustStock(item, -1)}>-1</button>
            <button type="button" onClick={() => onAdjustStock(item, 1)}>+1</button>
            <button type="button" onClick={() => onAdjustStock(item, 5)}>+5</button>
          </div>
        </div>
      ) : null}

      {mode === 'list' ? (
        <div className="inventory-workflow-stack">
          <p>{item.listingApproved ? 'Approved for online sale.' : 'Not listed until approved.'}</p>
          <p>Online price: {Number(item.onlinePrice || 0) > 0 ? money.format(Number(item.onlinePrice)) : money.format(Number(item.inStorePrice || suggestedPrice || 0))}</p>
          <div className="inventory-workflow-actions">
            <button type="button" onClick={() => onApplyDefaultMarkup(item)}>Use 15% markup</button>
            <button type="button" onClick={() => onSaveItem({ hasOnlineDraft: true, listedForSale: false, listingApproved: false })}>Save draft</button>
            <button className="gold-button" type="button" onClick={() => onApproveListing(item)}>Approve listing</button>
          </div>
        </div>
      ) : null}

      {mode === 'label' ? (
        <div className="inventory-label-preview">
          <strong>{itemName}</strong>
          <span>{item.sku || item.barcode || 'No SKU'}</span>
          <b>{Number(item.inStorePrice || 0) > 0 ? money.format(Number(item.inStorePrice)) : 'Price pending'}</b>
        </div>
      ) : null}
    </section>
  )
}

function ItemThumb({ item }) {
  return (
    <span className="item-thumb">
      {item.imageUrl || item.image ? <img src={item.imageUrl || item.image} alt="" loading="lazy" /> : <Boxes size={22} />}
    </span>
  )
}

function TransactionsView({ transactions }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Local sales ledger</p>
          <h2>Transactions</h2>
        </div>
        <Archive size={22} />
      </div>
      <div className="inventory-list">
        {transactions.length === 0 ? <EmptyState text="Completed sales will appear here." /> : null}
        {transactions.map((transaction) => (
          <div className="inventory-row" key={transaction.id}>
            <span>
              <strong>{transaction.number}</strong>
              <small>{new Date(transaction.createdAt).toLocaleString()}</small>
            </span>
            <span className="row-meta">
              <strong>{money.format(Number(transaction.total || 0))}</strong>
              <small>{transaction.items.length} item{transaction.items.length === 1 ? '' : 's'}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function SettingsView({ dataPath }) {
  return (
    <section className="panel settings-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Desktop storage</p>
          <h2>Settings</h2>
        </div>
        <Settings size={22} />
      </div>
      <div className="settings-row">
        <span>Local data file</span>
        <code>{dataPath}</code>
      </div>
      <div className="settings-row">
        <span>Connection mode</span>
        <strong>Offline/local first</strong>
      </div>
    </section>
  )
}

function PlaceholderView({ icon: Icon, title, copy }) {
  return (
    <section className="panel placeholder-panel">
      <Icon size={32} />
      <h2>{title}</h2>
      <p>{copy}</p>
    </section>
  )
}

function SearchBox({ value, onChange }) {
  return (
    <label className="search-box">
      <Search size={16} />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="Search" />
    </label>
  )
}

function EmptyState({ text }) {
  return <p className="empty-state">{text}</p>
}

function UpdatePrompt() {
  const [update, setUpdate] = useState(null)
  const [dismissed, setDismissed] = useState(false)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    const api = window.nordvikDesktop
    if (!api?.onUpdateReady) return undefined
    api.getPendingUpdate?.().then((pending) => { if (pending) setUpdate(pending) }).catch(() => {})
    return api.onUpdateReady((next) => {
      setUpdate(next)
      setDismissed(false)
    })
  }, [])

  if (!update || dismissed) return null

  async function installNow() {
    setInstalling(true)
    try {
      await window.nordvikDesktop.installUpdate()
    } catch {
      setInstalling(false)
    }
  }

  return (
    <div className="register-modal update-prompt" role="dialog" aria-modal="true" aria-labelledby="update-prompt-title">
      <section>
        <img className="update-prompt-logo" src="/collectorshub-pos-logo.png" alt="CollectorsHub POS" />
        <p className="update-prompt-kicker">Update ready</p>
        <h2 id="update-prompt-title">CollectorsHub POS {update.version ? `v${update.version}` : ''} is ready to install</h2>
        <p>
          {update.currentVersion ? `You're on v${update.currentVersion}. ` : ''}
          Restart now to finish updating, or choose Later and it will install the next time CollectorsHub POS closes.
        </p>
        <div className="modal-actions">
          <button type="button" disabled={installing} onClick={() => setDismissed(true)}>Later</button>
          <button className="update-prompt-primary" type="button" disabled={installing} onClick={installNow}>
            {installing ? 'Restarting...' : 'Restart now'}
          </button>
        </div>
      </section>
    </div>
  )
}

// A screen that crashes shows what went wrong (and logs it) instead of
// leaving the window blank.
class ErrorScreen extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    window.nordvikDesktop?.logError?.({ message: String(error?.message || error), stack: String(error?.stack || ''), componentStack: String(info?.componentStack || '') })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ padding: 32, fontFamily: 'system-ui, sans-serif', color: '#1f2a3a' }}>
        <h2>Something went wrong on this screen</h2>
        <p>The error has been saved to the app's log. Send this message to support:</p>
        <pre style={{ whiteSpace: 'pre-wrap', background: '#f4f6f9', padding: 12, borderRadius: 8, maxHeight: '50vh', overflow: 'auto' }}>{String(this.state.error?.stack || this.state.error)}</pre>
        <button type="button" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    )
  }
}

window.addEventListener('error', (event) => window.nordvikDesktop?.logError?.({ message: String(event.message || ''), stack: String(event.error?.stack || '') }))
window.addEventListener('unhandledrejection', (event) => window.nordvikDesktop?.logError?.({ message: `Unhandled: ${String(event.reason?.message || event.reason || '')}`, stack: String(event.reason?.stack || '') }))

createRoot(document.getElementById('root')).render(
  <ErrorScreen>
    <App />
    <UpdatePrompt />
  </ErrorScreen>,
)
