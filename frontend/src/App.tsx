import { useCallback, useEffect, useRef, useState } from 'react'
import { api, exportCsv, money, Me, Payment, Product, ProductInput, Report, Sale } from './api'

type Tab = 'register' | 'inventory' | 'sales' | 'reports' | 'settings'
type Cart = Record<number, number>
type Run = (f: () => Promise<unknown>) => Promise<void>
type Receipt = { sale: Sale; paid: number; lines: { name: string; qty: number; cents: number }[] }
const LABELS: Record<Tab, string> = { register: 'Register', inventory: 'Inventory', sales: 'Sales', reports: 'Reports', settings: 'Settings' }
const PAYMENTS: [Payment, string][] = [['cash', 'Cash'], ['card', 'Card'], ['mobile', 'Mobile money']]

export default function App() {
  const [tab, setTab] = useState<Tab>('register')
  const [products, setProducts] = useState<Product[]>([])
  const [me, setMe] = useState<Me>({ role: 'admin', shopName: 'Counter', taxPercent: 0 })
  const [error, setError] = useState('')
  const [locked, setLocked] = useState(false)
  const load = useCallback(() => Promise.all([api.products(), api.me()])
    .then(([p, m]) => { setProducts(p); setMe(m) })
    .catch(e => (e.message.includes('PIN') ? setLocked(true) : setError(e.message))), [])
  useEffect(() => { load() }, [load])
  const run: Run = async fn => {
    try { setError(''); await fn(); await load() } catch (e) { setError((e as Error).message) }
  }
  const low = products.filter(p => p.stock <= p.lowStock).length
  const tabs: Tab[] = me.role === 'admin' ? ['register', 'inventory', 'sales', 'reports', 'settings'] : ['register', 'sales']

  if (locked) return <Lock onOk={() => { setLocked(false); load() }} />
  return (
    <div className="shell">
      <header>
        <h1>{me.shopName}</h1>
        <nav>
          {tabs.map(t => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'inventory' && low > 0 ? `Inventory (${low} low)` : LABELS[t]}
            </button>
          ))}
        </nav>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {tab === 'register' && <Register products={products} me={me} run={run} />}
      {tab === 'inventory' && <Inventory products={products} run={run} />}
      {tab === 'sales' && <SalesList reload={load} canVoid={me.role === 'admin'} />}
      {tab === 'reports' && <Reports />}
      {tab === 'settings' && <Settings me={me} run={run} />}
    </div>
  )
}

function Register({ products, me, run }: { products: Product[]; me: Me; run: Run }) {
  const [q, setQ] = useState('')
  const [cart, setCart] = useState<Cart>({})
  const [cash, setCash] = useState('')
  const [disc, setDisc] = useState('')
  const [pay, setPay] = useState<Payment>('cash')
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => { if (!receipt) search.current?.focus() }, [receipt])

  const byId = new Map(products.map(p => [p.id, p]))
  const lines = Object.entries(cart).map(([id, qty]) => ({ p: byId.get(+id)!, qty })).filter(l => l.p)
  const subtotal = lines.reduce((s, l) => s + l.p.priceCents * l.qty, 0)
  const discount = Math.min(subtotal, Math.round((+disc || 0) * 100))
  const tax = Math.round((subtotal - discount) * me.taxPercent / 100)
  const total = subtotal - discount + tax
  const paid = Math.round((+cash || 0) * 100)
  const short = pay === 'cash' && paid > 0 && paid < total
  const shown = products.filter(p => (p.name + p.sku).toLowerCase().includes(q.toLowerCase()))

  const add = (p: Product, d: number) => setCart(c => {
    const n = Math.min(p.stock, (c[p.id] ?? 0) + d)
    const { [p.id]: _, ...rest } = c
    return n > 0 ? { ...rest, [p.id]: n } : rest
  })
  // A barcode scanner types the SKU and presses Enter, so this adds the item straight to the cart.
  const scan = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || !q.trim()) return
    const hit = products.find(p => p.sku.toLowerCase() === q.trim().toLowerCase()) ?? (shown.length === 1 ? shown[0] : undefined)
    if (hit) { if (hit.stock > 0) add(hit, 1); setQ('') }
  }
  const charge = () => run(async () => {
    const sale = await api.sell({ items: lines.map(l => ({ productId: l.p.id, qty: l.qty })), discountCents: discount, payment: pay, paidCents: pay === 'cash' ? paid : 0 })
    setReceipt({ sale, paid: sale.paidCents ?? sale.totalCents, lines: lines.map(l => ({ name: l.p.name, qty: l.qty, cents: l.p.priceCents * l.qty })) })
    setCart({}); setCash(''); setDisc('')
  })

  return (
    <main className="register">
      <section>
        <input ref={search} type="search" placeholder="Search, or scan a barcode / SKU" value={q}
          onChange={e => setQ(e.target.value)} onKeyDown={scan} aria-label="Search products or scan barcode" />
        <div className="grid">
          {shown.map(p => (
            <button key={p.id} className="tile" disabled={p.stock === 0} onClick={() => add(p, 1)}>
              <strong>{p.name}</strong>
              <span>{money(p.priceCents)}</span>
              <small className={p.stock <= p.lowStock ? 'warn' : ''}>{p.stock === 0 ? 'Out of stock' : `${p.stock} left`}</small>
            </button>
          ))}
          {shown.length === 0 && <p className="empty">No products match.</p>}
        </div>
      </section>
      <aside className="cart">
        {receipt ? <ReceiptView r={receipt} shop={me.shopName} onDone={() => setReceipt(null)} /> : <>
          <h2>Current sale</h2>
          {lines.length === 0 && <p className="empty">Tap a product or scan an item to start.</p>}
          {lines.map(({ p, qty }) => (
            <div className="line" key={p.id}>
              <span>{p.name}</span>
              <span className="qty">
                <button onClick={() => add(p, -1)} aria-label={`Remove one ${p.name}`}>−</button>{qty}
                <button onClick={() => add(p, 1)} disabled={qty >= p.stock} aria-label={`Add one ${p.name}`}>+</button>
              </span>
              <span className="num">{money(p.priceCents * qty)}</span>
            </div>
          ))}
          <label>Discount (amount)<input type="number" min="0" step="0.01" value={disc} onChange={e => setDisc(e.target.value)} /></label>
          <div className="sumrow"><span>Subtotal</span><span className="num">{money(subtotal)}</span></div>
          {discount > 0 && <div className="sumrow"><span>Discount</span><span className="num">−{money(discount)}</span></div>}
          {me.taxPercent > 0 && <div className="sumrow"><span>Tax {me.taxPercent}%</span><span className="num">{money(tax)}</span></div>}
          <div className="total"><span>Total</span><span className="num">{money(total)}</span></div>
          <div className="seg" role="group" aria-label="Payment method">
            {PAYMENTS.map(([k, label]) => <button key={k} className={pay === k ? 'on' : ''} aria-pressed={pay === k} onClick={() => setPay(k)}>{label}</button>)}
          </div>
          {pay === 'cash' && <>
            <label>Cash received (optional)<input type="number" min="0" step="0.01" value={cash} onChange={e => setCash(e.target.value)} /></label>
            {paid > 0 && <p className="num">{short ? `Short by ${money(total - paid)}` : `Change ${money(paid - total)}`}</p>}
          </>}
          <button className="charge" disabled={!lines.length || short} onClick={charge}>Charge {money(total)}</button>
        </>}
      </aside>
    </main>
  )
}

const blank: ProductInput = { sku: '', name: '', priceCents: 0, stock: 0, lowStock: 5 }

function Inventory({ products, run }: { products: Product[]; run: (f: () => Promise<unknown>) => Promise<void> }) {
  const [form, setForm] = useState<ProductInput>(blank)
  const [editing, setEditing] = useState<number | undefined>()
  const set = (k: keyof ProductInput, v: string) =>
    setForm(f => ({ ...f, [k]: k === 'sku' || k === 'name' ? v : Math.max(0, Math.round(+v || 0)) }))
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    run(async () => { await api.saveProduct(form, editing); setForm(blank); setEditing(undefined) })
  }

  return (
    <main className="inventory">
      <form onSubmit={submit}>
        <h2>{editing ? 'Edit product' : 'Add product'}</h2>
        <label>SKU<input value={form.sku} onChange={e => set('sku', e.target.value)} required /></label>
        <label>Name<input value={form.name} onChange={e => set('name', e.target.value)} required /></label>
        <label>Price<input type="number" min="0" step="0.01" value={form.priceCents / 100}
          onChange={e => setForm(f => ({ ...f, priceCents: Math.max(0, Math.round(+e.target.value * 100)) }))} /></label>
        <label>Stock<input type="number" min="0" value={form.stock} onChange={e => set('stock', e.target.value)} /></label>
        <label>Low-stock alert at<input type="number" min="0" value={form.lowStock} onChange={e => set('lowStock', e.target.value)} /></label>
        <div className="row">
          <button className="primary">{editing ? 'Save changes' : 'Add product'}</button>
          {editing && <button type="button" onClick={() => { setForm(blank); setEditing(undefined) }}>Cancel</button>}
        </div>
      </form>
      <table>
        <thead><tr><th>Product</th><th>SKU</th><th className="num">Price</th><th className="num">Stock</th><th></th></tr></thead>
        <tbody>
          {products.map(p => (
            <tr key={p.id} className={p.stock <= p.lowStock ? 'low' : ''}>
              <td>{p.name}</td><td>{p.sku}</td><td className="num">{money(p.priceCents)}</td>
              <td className="num">
                <button onClick={() => run(() => api.adjust(p.id, -1))} disabled={p.stock === 0} aria-label={`Remove one ${p.name}`}>−</button>
                {p.stock}
                <button onClick={() => run(() => api.adjust(p.id, 1))} aria-label={`Add one ${p.name}`}>+</button>
              </td>
              <td className="row">
                <button onClick={() => { setEditing(p.id); const { id, ...rest } = p; setForm(rest) }}>Edit</button>
                <button onClick={() => confirm(`Delete ${p.name}?`) && run(() => api.deleteProduct(p.id))}>Delete</button>
              </td>
            </tr>
          ))}
          {products.length === 0 && <tr><td colSpan={5} className="empty">No products yet. Add your first one on the left.</td></tr>}
        </tbody>
      </table>
    </main>
  )
}


function ReceiptView({ r, shop, onDone }: { r: Receipt; shop: string; onDone: () => void }) {
  const s = r.sale
  return (
    <div className="receipt">
      <h2>{shop}</h2>
      <p>Receipt #{s.id} · {s.createdAt}</p>
      {r.lines.map((l, i) => (
        <div className="line rcpt" key={i}><span>{l.qty} × {l.name}</span><span className="num">{money(l.cents)}</span></div>
      ))}
      <div className="sumrow"><span>Subtotal</span><span className="num">{money(s.subtotalCents ?? s.totalCents)}</span></div>
      {!!s.discountCents && <div className="sumrow"><span>Discount</span><span className="num">−{money(s.discountCents)}</span></div>}
      {!!s.taxCents && <div className="sumrow"><span>Tax</span><span className="num">{money(s.taxCents)}</span></div>}
      <div className="total"><span>Total</span><span className="num">{money(s.totalCents)}</span></div>
      <p className="cap">Paid by {s.payment === 'mobile' ? 'mobile money' : s.payment}{s.payment === 'cash' ? `: ${money(r.paid)}, change ${money(r.paid - s.totalCents)}` : ''}</p>
      <p>Thank you!</p>
      <div className="row noprint">
        <button className="primary" onClick={onDone}>New sale</button>
        <button onClick={() => window.print()}>Print receipt</button>
      </div>
    </div>
  )
}

function Lock({ onOk }: { onOk: () => void }) {
  const [pin, setPin] = useState('')
  const bad = !!sessionStorage.getItem('pin')
  return (
    <form className="lock" onSubmit={e => { e.preventDefault(); sessionStorage.setItem('pin', pin); onOk() }}>
      <h1>Counter</h1>
      {bad && <p className="bad" role="alert">That PIN did not work. Try again.</p>}
      <label>Shop PIN<input type="password" value={pin} onChange={e => setPin(e.target.value)} autoFocus /></label>
      <button className="primary">Unlock</button>
    </form>
  )
}

function Settings({ me, run }: { me: Me; run: Run }) {
  const [name, setName] = useState(me.shopName)
  const [tax, setTax] = useState(String(me.taxPercent))
  return (
    <main>
      <form className="detail" onSubmit={e => { e.preventDefault(); run(() => api.saveSettings({ shopName: name, taxPercent: Math.max(0, +tax || 0) })) }}>
        <h2>Shop settings</h2>
        <label>Shop name (shown on receipts)<input value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Sales tax % (added at checkout; enter prices without tax)<input type="number" min="0" max="100" step="0.01" value={tax} onChange={e => setTax(e.target.value)} /></label>
        <button className="primary">Save settings</button>
      </form>
    </main>
  )
}

function Reports() {
  const today = new Date().toLocaleDateString('en-CA')
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const [rep, setRep] = useState<Report | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { api.report(from, to).then(setRep).catch(e => setErr(e.message)) }, [from, to])
  return (
    <main>
      <div className="filters">
        <label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
        <button onClick={() => exportCsv(from, to).catch(e => setErr(e.message))}>Download CSV</button>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {rep && <>
        <div className="stats">
          <div className="stat">Sales<b>{rep.sales}</b></div>
          <div className="stat">Gross<b>{money(rep.subtotalCents)}</b></div>
          <div className="stat">Discounts<b>{money(rep.discountCents)}</b></div>
          <div className="stat">Tax<b>{money(rep.taxCents)}</b></div>
          <div className="stat">Total taken<b>{money(rep.totalCents)}</b></div>
        </div>
        <div className="stats">
          {Object.entries(rep.byPayment).map(([k, v]) => <div className="stat cap" key={k}>{k === 'mobile' ? 'Mobile money' : k}<b>{money(v)}</b></div>)}
        </div>
        <table>
          <thead><tr><th>Top products</th><th className="num">Sold</th><th className="num">Revenue</th></tr></thead>
          <tbody>
            {rep.top.map(t => <tr key={t.name}><td>{t.name}</td><td className="num">{t.qty}</td><td className="num">{money(t.cents)}</td></tr>)}
            {rep.top.length === 0 && <tr><td colSpan={3} className="empty">No sales in this period.</td></tr>}
          </tbody>
        </table>
      </>}
    </main>
  )
}

function SalesList({ reload, canVoid }: { reload: () => void; canVoid: boolean }) {
  const [sales, setSales] = useState<Sale[]>([])
  const [open, setOpen] = useState<Sale | null>(null)
  const [err, setErr] = useState('')
  const load = () => api.sales().then(setSales).catch(e => setErr(e.message))
  useEffect(() => { load() }, [])
  const live = sales.filter(s => !s.voided)
  const voidIt = async (id: number) => {
    try { await api.voidSale(id); setOpen(null); await load(); reload() } catch (e) { setErr((e as Error).message) }
  }
  return (
    <main className="sales">
      <h2>Recent sales: {money(live.reduce((n, s) => n + s.totalCents, 0))} from {live.length} sales</h2>
      {err && <p className="error" role="alert">{err}</p>}
      {open && (
        <div className="detail">
          <h2>Sale #{open.id}{open.voided ? ' (voided)' : ''}</h2>
          {open.lines?.map((l, i) => <div className="line rcpt" key={i}><span>{l.qty} × {l.name}</span><span className="num">{money(l.priceCents * l.qty)}</span></div>)}
          {!!open.discountCents && <div className="sumrow"><span>Discount</span><span className="num">−{money(open.discountCents)}</span></div>}
          {!!open.taxCents && <div className="sumrow"><span>Tax</span><span className="num">{money(open.taxCents)}</span></div>}
          <div className="total"><span>Total</span><span className="num">{money(open.totalCents)}</span></div>
          <div className="row">
            {canVoid && !open.voided && <button onClick={() => confirm(`Void sale #${open.id} and return its items to stock?`) && voidIt(open.id)}>Void sale</button>}
            <button onClick={() => setOpen(null)}>Close</button>
          </div>
        </div>
      )}
      <table>
        <thead><tr><th>Sale</th><th>Time</th><th>Payment</th><th className="num">Items</th><th className="num">Total</th></tr></thead>
        <tbody>
          {sales.map(s => (
            <tr key={s.id} className={s.voided ? 'void' : ''}>
              <td><button onClick={() => api.sale(s.id).then(setOpen).catch(e => setErr(e.message))}>#{s.id}</button></td>
              <td>{s.createdAt}{s.voided ? ' · voided' : ''}</td><td className="cap">{s.payment || 'cash'}</td>
              <td className="num">{s.items}</td><td className="num">{money(s.totalCents)}</td>
            </tr>
          ))}
          {sales.length === 0 && <tr><td colSpan={5} className="empty">No sales yet.</td></tr>}
        </tbody>
      </table>
    </main>
  )
}
