import { createClient } from '@supabase/supabase-js'

const FALLBACK_URL = 'https://somsquxikodnghjoatar.supabase.co'
const FALLBACK_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNvbXNxdXhpa29kbmdoam9hdGFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3NTAyMTIsImV4cCI6MjA5NTMyNjIxMn0.4gUiHWqgkQS0TSpswEr1Q4YkxXQcFb435EQ-ldPX_WA'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || FALLBACK_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || FALLBACK_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase configuration.')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
})
