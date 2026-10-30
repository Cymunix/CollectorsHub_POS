// The organization sidebar, grouped (the same destinations as NAV). Kept out of
// OrgPortal so the app's sidebar doesn't load that whole screen.
export const NAV_GROUPS = [
  ['Network', ['overview', 'stores', 'locations']],
  ['People', ['staff', 'myhr', 'expenses', 'payroll']],
  ['Commerce', ['inventory', 'orders', 'sales', 'tradeins', 'promos']],
  ['Administration', ['reports', 'policies', 'integrations', 'settings']],
]

export const NAV = [
  ['overview', 'Overview', '▤'], ['stores', 'Stores', '🏬'], ['locations', 'Locations', '📍'],
  ['staff', 'Staff', '👥'], ['expenses', 'Travel & Expenses', '✈'], ['payroll', 'Payroll', '💵'], ['inventory', 'Inventory', '📦'], ['orders', 'Orders', '🧾'],
  ['sales', 'Sales', '💰'], ['tradeins', 'Trade-Ins', '📥'], ['promos', 'Promotions & Events', '🎪'],
  ['reports', 'Reports', '📊'], ['policies', 'Policies', '📋'], ['integrations', 'Integrations', '🔌'],
  ['settings', 'Settings', '⚙'],
]
