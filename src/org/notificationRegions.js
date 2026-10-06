export const CANADA_NOTIFICATION_REGIONS = [
  { id: 'ca-ns', name: 'Nova Scotia', country: 'canada', provinceCodes: ['NS'], tone: 'green' },
  { id: 'ca-pei', name: 'Prince Edward Island', country: 'canada', provinceCodes: ['PE'], tone: 'blue' },
  { id: 'ca-nb', name: 'New Brunswick', country: 'canada', provinceCodes: ['NB'], tone: 'blue' },
  { id: 'ca-nl-island', name: 'Newfoundland', country: 'canada', provinceCodes: ['NL'], clipBbox: [-60.8, 46.2, -52.2, 51.8], tone: 'blue' },
  { id: 'ca-nl-labrador', name: 'Labrador', country: 'canada', provinceCodes: ['NL'], clipBbox: [-67.2, 51.0, -52.0, 61.0], tone: 'green' },
  { id: 'ca-qc-northern', name: 'Northern Quebec', country: 'canada', provinceCodes: ['QC'], clipBbox: [-80.2, 53.0, -56.0, 63.2], tone: 'gold' },
  { id: 'ca-qc-quebec-city', name: 'Quebec City', country: 'canada', provinceCodes: ['QC'], clipBbox: [-72.6, 46.5, -69.0, 48.9], tone: 'green' },
  { id: 'ca-qc-middle', name: 'Central Quebec', country: 'canada', provinceCodes: ['QC'], clipBbox: [-80.2, 46.5, -68.0, 53.0], tone: 'blue' },
  { id: 'ca-qc-montreal', name: 'Montreal', country: 'canada', provinceCodes: ['QC'], clipBbox: [-75.9, 44.8, -72.6, 46.6], tone: 'gold' },
  { id: 'ca-qc-east', name: 'Eastern Quebec', country: 'canada', provinceCodes: ['QC'], clipBbox: [-68.0, 48.4, -56.0, 53.2], tone: 'red' },
  { id: 'ca-on-toronto', name: 'Greater Toronto', country: 'canada', provinceCodes: ['ON'], clipBbox: [-80.1, 43.1, -78.5, 44.4], tone: 'blue' },
  { id: 'ca-on-southern', name: 'Southwestern Ontario', country: 'canada', provinceCodes: ['ON'], clipBbox: [-84.4, 41.4, -79.4, 44.4], tone: 'green' },
  { id: 'ca-on-capital', name: 'Capital Region', country: 'canada', provinceCodes: ['ON'], clipBbox: [-76.9, 44.5, -74.4, 46.2], tone: 'red' },
  { id: 'ca-on-north', name: 'Northern Ontario', country: 'canada', provinceCodes: ['ON'], clipBbox: [-95.5, 50.0, -74.0, 57.5], tone: 'purple' },
  { id: 'ca-on-east', name: 'Eastern Ontario', country: 'canada', provinceCodes: ['ON'], clipBbox: [-78.6, 44.0, -74.0, 50.0], tone: 'cyan' },
  { id: 'ca-on-middle', name: 'Central Ontario', country: 'canada', provinceCodes: ['ON'], clipBbox: [-84.0, 44.4, -78.6, 50.0], tone: 'gold' },
  { id: 'ca-on-great-lakes', name: 'Northwestern Ontario', country: 'canada', provinceCodes: ['ON'], clipBbox: [-95.5, 46.0, -84.0, 50.0], tone: 'blue' },
  { id: 'ca-bc', name: 'Southern British Columbia', country: 'canada', provinceCodes: ['BC'], clipBbox: [-140.0, 48.0, -114.0, 56.5], tone: 'green' },
  { id: 'ca-ab', name: 'Southern Alberta', country: 'canada', provinceCodes: ['AB'], clipBbox: [-121.0, 49.0, -110.0, 56.2], tone: 'blue' },
  { id: 'ca-sk', name: 'Southern Saskatchewan', country: 'canada', provinceCodes: ['SK'], clipBbox: [-110.2, 49.0, -101.0, 55.5], tone: 'gold' },
  { id: 'ca-mb', name: 'Southern Manitoba', country: 'canada', provinceCodes: ['MB'], clipBbox: [-102.2, 49.0, -88.8, 55.0], tone: 'blue' },
  { id: 'ca-bc-north', name: 'Northern British Columbia', country: 'canada', provinceCodes: ['BC'], clipBbox: [-140.0, 56.5, -114.0, 61.1], tone: 'red' },
  { id: 'ca-vancouver-island', name: 'Vancouver Island', country: 'canada', provinceCodes: ['BC'], tone: 'magenta' },
  { id: 'ca-vancouver', name: 'Vancouver', country: 'canada', provinceCodes: ['BC'], tone: 'orange' },
  { id: 'ca-calgary', name: 'Calgary', country: 'canada', provinceCodes: ['AB'], tone: 'red' },
  { id: 'ca-edmonton', name: 'Edmonton', country: 'canada', provinceCodes: ['AB'], tone: 'magenta' },
  { id: 'ca-winnipeg', name: 'Winnipeg', country: 'canada', provinceCodes: ['MB'], tone: 'orange' },
  { id: 'ca-ab-north', name: 'Northern Alberta', country: 'canada', provinceCodes: ['AB'], clipBbox: [-121.0, 56.2, -110.0, 60.3], tone: 'gold' },
  { id: 'ca-sk-north', name: 'Northern Saskatchewan', country: 'canada', provinceCodes: ['SK'], clipBbox: [-110.2, 55.5, -101.0, 60.3], tone: 'green' },
  { id: 'ca-mb-north', name: 'Northern Manitoba', country: 'canada', provinceCodes: ['MB'], clipBbox: [-102.2, 55.0, -88.8, 60.3], tone: 'gold' },
  { id: 'ca-northern-canada', name: 'Northern Canada', country: 'canada', provinceCodes: ['YT', 'NT', 'NU'], tone: 'blue' },
]

export const USA_NOTIFICATION_REGIONS = [
  { id: 'us-pnw', name: 'Pacific Northwest', country: 'usa', x: 5, y: 23, w: 13, h: 18, tone: 'green' },
  { id: 'us-norcal', name: 'Northern California', country: 'usa', x: 7, y: 43, w: 12, h: 18, tone: 'blue' },
  { id: 'us-socal', name: 'Southern California', country: 'usa', x: 10, y: 62, w: 12, h: 18, tone: 'orange' },
  { id: 'us-mountain', name: 'Mountain West', country: 'usa', x: 20, y: 26, w: 19, h: 27, tone: 'purple' },
  { id: 'us-southwest', name: 'Southwest', country: 'usa', x: 23, y: 55, w: 20, h: 21, tone: 'gold' },
  { id: 'us-texas-north', name: 'North Texas', country: 'usa', x: 45, y: 57, w: 12, h: 12, tone: 'red' },
  { id: 'us-texas-south', name: 'South Texas', country: 'usa', x: 46, y: 70, w: 13, h: 16, tone: 'orange' },
  { id: 'us-plains', name: 'Great Plains', country: 'usa', x: 41, y: 29, w: 15, h: 25, tone: 'gold' },
  { id: 'us-midwest', name: 'Midwest', country: 'usa', x: 57, y: 31, w: 14, h: 22, tone: 'cyan' },
  { id: 'us-great-lakes', name: 'Great Lakes', country: 'usa', x: 69, y: 25, w: 13, h: 19, tone: 'blue' },
  { id: 'us-northeast', name: 'Northeast', country: 'usa', x: 83, y: 24, w: 12, h: 17, tone: 'purple' },
  { id: 'us-mid-atlantic', name: 'Mid-Atlantic', country: 'usa', x: 80, y: 43, w: 12, h: 15, tone: 'magenta' },
  { id: 'us-southeast', name: 'Southeast', country: 'usa', x: 66, y: 58, w: 18, h: 20, tone: 'green' },
  { id: 'us-florida', name: 'Florida', country: 'usa', x: 80, y: 78, w: 11, h: 13, tone: 'blue' },
  { id: 'us-alaska', name: 'Alaska', country: 'usa', x: 5, y: 82, w: 15, h: 9, tone: 'cyan' },
  { id: 'us-hawaii', name: 'Hawaii', country: 'usa', x: 27, y: 86, w: 9, h: 6, tone: 'magenta' },
]

export const NOTIFICATION_REGIONS = [...CANADA_NOTIFICATION_REGIONS, ...USA_NOTIFICATION_REGIONS]

export const CANADA_PROVINCE_CODES_BY_NAME = {
  Alberta: 'AB',
  'British Columbia': 'BC',
  Manitoba: 'MB',
  'New Brunswick': 'NB',
  'Newfoundland and Labrador': 'NL',
  'Northwest Territories': 'NT',
  'Nova Scotia': 'NS',
  Nunavut: 'NU',
  Ontario: 'ON',
  'Prince Edward Island': 'PE',
  Quebec: 'QC',
  Saskatchewan: 'SK',
  Yukon: 'YT',
}

// Notification regions covering a province code (e.g. 'NS' → [Nova Scotia];
// 'ON' → the several Ontario regions). Used to tie a store to the same regions
// collectors use, auto-derived from its address province.
export function regionsForProvince(province) {
  const p = String(province || '').toUpperCase()
  if (!p) return []
  return NOTIFICATION_REGIONS.filter(r => Array.isArray(r.provinceCodes) && r.provinceCodes.includes(p))
}
// The single unambiguous region for a province (null when a province has several).
export function defaultRegionIdForProvince(province) {
  const rs = regionsForProvince(province)
  return rs.length === 1 ? rs[0].id : null
}
export function regionNameById(id) {
  return (NOTIFICATION_REGIONS.find(r => r.id === id) || {}).name || null
}
