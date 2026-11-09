const API_URL = import.meta.env.VITE_API_URL ?? ''

export type User = { id: number; name: string; email: string }
export type Transaction = {
  id: number
  description: string
  category: string
  type: 'income' | 'expense'
  amount: number
  date: string
  source: string
}
export type Budget = { id?: number; category: string; budget: number; spent: number; month: string }
export type Goal = { id: number; name: string; target: number; saved: number; targetDate?: string }
export type Payment = { id: number; recipient: string; amount: number; currency: string; status: string; date: string }
export type Summary = {
  income: number
  expenses: number
  balance: number
  savingsRate: number
  categories: Array<{ category: string; amount: number }>
  trend: Array<{ month: string; income: number; expenses: number }>
  recent: Transaction[]
  budgets: Array<{ category: string; budget: number; spent: number }>
  paymentSuccessRate: number
}
export type Config = { paypalClientId: string | null; paypalConfigured: boolean; aiConfigured: boolean }

export function getToken() {
  return localStorage.getItem('paypilot-token')
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json')
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${API_URL}/api${path}`, { ...init, headers })
  const result = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) {
    if (response.status === 401 && token) {
      localStorage.removeItem('paypilot-token')
      localStorage.removeItem('paypilot-user')
      window.dispatchEvent(new Event('paypilot:unauthorized'))
    }
    throw new Error(result.error ?? `Request failed (${response.status}).`)
  }
  return result
}

export async function exportTransactions() {
  const response = await fetch(`${API_URL}/api/reports/export.csv`, {
    headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
  })
  if (!response.ok) throw new Error('Could not export your report.')
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'paypilot-transactions.csv'
  link.click()
  URL.revokeObjectURL(url)
}
