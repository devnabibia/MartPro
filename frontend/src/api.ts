export interface Product { id: number; sku: string; name: string; priceCents: number; stock: number; lowStock: number }
export interface Sale {
  id: number; totalCents: number; items: number; createdAt: string; voided: boolean
  subtotalCents?: number; discountCents?: number; taxCents?: number; payment?: string; paidCents?: number
  lines?: { name: string; qty: number; priceCents: number }[]
}
export type ProductInput = Omit<Product, 'id'>
export type Payment = 'cash' | 'card' | 'mobile'
export interface Me { role: 'admin' | 'cashier'; shopName: string; taxPercent: number }
export interface Report {
  sales: number; subtotalCents: number; discountCents: number; taxCents: number; totalCents: number
  byPayment: Record<string, number>; top: { name: string; qty: number; cents: number }[]
}

const CURRENCY = 'KES' // change to your currency code
export const money = (cents: number) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: CURRENCY }).format(cents / 100)

const pin = () => sessionStorage.getItem('pin') ?? ''

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json', 'X-Pin': pin() }, ...init })
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error)
  return (res.status === 204 ? undefined : await res.json()) as T
}
const body = (v: unknown) => JSON.stringify(v)

export const api = {
  products: () => req<Product[]>('/api/products'),
  saveProduct: (p: ProductInput, id?: number) =>
    req(id ? `/api/products/${id}` : '/api/products', { method: id ? 'PUT' : 'POST', body: body(p) }),
  deleteProduct: (id: number) => req(`/api/products/${id}`, { method: 'DELETE' }),
  adjust: (id: number, delta: number) => req(`/api/products/${id}/adjust`, { method: 'POST', body: body({ delta }) }),
  sell: (sale: { items: { productId: number; qty: number }[]; discountCents: number; payment: Payment; paidCents: number }) =>
    req<Sale>('/api/sales', { method: 'POST', body: body(sale) }),
  sales: () => req<Sale[]>('/api/sales'),
  sale: (id: number) => req<Sale>(`/api/sales/${id}`),
  voidSale: (id: number) => req(`/api/sales/${id}/void`, { method: 'POST' }),
  me: () => req<Me>('/api/me'),
  saveSettings: (s: { shopName: string; taxPercent: number }) => req('/api/settings', { method: 'PUT', body: body(s) }),
  report: (from: string, to: string) => req<Report>(`/api/report?from=${from}&to=${to}`),
}

export async function exportCsv(from: string, to: string) {
  const res = await fetch(`/api/export?from=${from}&to=${to}`, { headers: { 'X-Pin': pin() } })
  if (!res.ok) throw new Error('Export failed')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(await res.blob())
  a.download = `sales-${from}-to-${to}.csv`
  a.click()
}
