import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  ArrowDownLeft, ArrowLeftRight, ArrowUpRight, BadgeCheck, Bell, ChevronDown, ChevronLeft,
  ChevronRight, CircleHelp, CreditCard, Download, Ellipsis, Eye, EyeOff, FileChartColumnIncreasing,
  Home, Landmark, LogOut, Menu, Plus, Search, Send, Settings2, ShieldCheck,
  Sparkles, Target, TrendingDown, TrendingUp, Wallet, X,
} from 'lucide-react'
import {
  Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { api, exportTransactions, getToken, type Budget, type Config, type Goal, type Payment, type Summary, type Transaction, type User } from './api'

type Page = 'Overview' | 'Transactions' | 'AI assistant' | 'Payments' | 'Budgets' | 'Savings goals' | 'Analytics' | 'Notifications' | 'Settings'
type Toast = { text: string; tone: 'success' | 'error' } | null
type PreparedPayment = { id: number; recipient: string; amount: number; currency: string; status: string }
type ChatMessage = { role: 'user' | 'assistant'; text: string }
type PaypalButtonOptions = {
  createOrder: () => Promise<string>
  onApprove: (data: { orderID: string }) => Promise<void>
  onError: (error: unknown) => void
}

declare global {
  interface Window {
    paypal?: { Buttons: (options: PaypalButtonOptions) => { render: (target: HTMLElement) => Promise<void>; close?: () => void } }
  }
}

const navItems: Array<{ label: Page; icon: typeof Home; section: string }> = [
  { label: 'Overview', icon: Home, section: 'WORKSPACE' },
  { label: 'Transactions', icon: ArrowLeftRight, section: 'WORKSPACE' },
  { label: 'AI assistant', icon: Sparkles, section: 'WORKSPACE' },
  { label: 'Payments', icon: CreditCard, section: 'WORKSPACE' },
  { label: 'Budgets', icon: Wallet, section: 'MANAGE' },
  { label: 'Savings goals', icon: Target, section: 'MANAGE' },
  { label: 'Analytics', icon: FileChartColumnIncreasing, section: 'MANAGE' },
  { label: 'Notifications', icon: Bell, section: 'MANAGE' },
  { label: 'Settings', icon: Settings2, section: 'PREFERENCES' },
]
const chartColors = ['#3157D5', '#55A9D7', '#16845B', '#C58A2A', '#8A73CC', '#E9876C']
const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
const dateLabel = (value: string) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

function PayPalCheckout({ payment, onComplete, onError }: { payment: PreparedPayment; onComplete: () => void; onError: (message: string) => void }) {
  const target = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [sdkError, setSdkError] = useState('')

  useEffect(() => {
    let active = true
    let buttons: ReturnType<NonNullable<Window['paypal']>['Buttons']> | undefined
    const setup = async () => {
      try {
        const config = await api<Config>('/config')
        if (!config.paypalConfigured || !config.paypalClientId) {
          if (active) {
            setStatus('unavailable')
            setSdkError('PayPal Sandbox is not configured. Add the Sandbox client ID and secret to the server environment to enable checkout.')
          }
          return
        }
        if (!window.paypal) {
          const existing = document.getElementById('paypal-sdk') as HTMLScriptElement | null
          if (existing) {
            await new Promise<void>((resolve, reject) => {
              existing.addEventListener('load', () => resolve(), { once: true })
              existing.addEventListener('error', () => reject(new Error('PayPal SDK failed to load.')), { once: true })
            })
          } else {
            await new Promise<void>((resolve, reject) => {
              const script = document.createElement('script')
              script.id = 'paypal-sdk'
              script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.paypalClientId!)}&currency=USD&intent=capture&components=buttons`
              script.onload = () => resolve()
              script.onerror = () => reject(new Error('PayPal SDK failed to load.'))
              document.body.appendChild(script)
            })
          }
        }
        if (!active || !target.current || !window.paypal) return
        buttons = window.paypal.Buttons({
          createOrder: async () => {
            const result = await api<{ orderID: string }>(`/payments/${payment.id}/order`, { method: 'POST', body: '{}' })
            return result.orderID
          },
          onApprove: async () => {
            await api<{ status: string; captureId: string }>(`/payments/${payment.id}/capture`, { method: 'POST', body: '{}' })
            onComplete()
          },
          onError: error => {
            const message = error instanceof Error ? error.message : 'PayPal checkout could not be completed.'
            setSdkError(message)
            onError(message)
          },
        })
        await buttons.render(target.current)
        if (active) setStatus('ready')
      } catch (error) {
        const message = error instanceof Error ? error.message : 'PayPal checkout could not be loaded.'
        if (active) {
          setStatus('unavailable')
          setSdkError(message)
        }
      }
    }
    void setup()
    return () => {
      active = false
      void buttons?.close?.()
    }
  }, [payment.id, onComplete, onError])

  return (
    <div className="paypal-wrap">
      {status === 'loading' && <span className="muted small">Connecting to PayPal Sandbox…</span>}
      <div ref={target} className={status === 'unavailable' ? 'hidden' : ''} />
      {status === 'unavailable' && <p className="inline-error">{sdkError}</p>}
      {status === 'ready' && <p className="paypal-note"><ShieldCheck size={14} /> PayPal verifies the capture before this appears in your transactions.</p>}
    </div>
  )
}

function AuthScreen({ onAuth }: { onAuth: (token: string, user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const result = await api<{ token: string; user: User }>(`/auth/${mode}`, {
        method: 'POST', body: JSON.stringify({ ...(mode === 'register' ? { name } : {}), email, password }),
      })
      onAuth(result.token, result.user)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not sign in.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-brand">
        <div className="brand-lockup"><span className="brand-mark"><Landmark size={19} /></span><span>paypilot<span className="brand-ai">AI</span></span></div>
        <div className="auth-copy">
          <div className="eyebrow"><span className="eyebrow-dot" /> FINANCIAL CLARITY, BUILT AROUND YOU</div>
          <h1>Make every<br />money move <span>count.</span></h1>
          <p>One calm place to understand your money, plan what’s next, and make payments with confidence.</p>
        </div>
        <div className="auth-foot"><ShieldCheck size={16} /> Private by design. Payments always stay in your hands.</div>
      </section>
      <section className="auth-panel">
        <div className="auth-form-wrap">
          <div className="mobile-brand brand-lockup"><span className="brand-mark"><Landmark size={18} /></span><span>paypilot<span className="brand-ai">AI</span></span></div>
          <p className="auth-kicker">{mode === 'login' ? 'WELCOME BACK' : 'GET STARTED'}</p>
          <h2>{mode === 'login' ? 'Sign in to PayPilot' : 'Create your account'}</h2>
          <p className="auth-subtitle">{mode === 'login' ? 'Your financial command center, ready when you are.' : 'A clearer view of your finances starts here.'}</p>
          <form onSubmit={submit} className="stack-form">
            {mode === 'register' && <label>Full name<input autoComplete="name" required minLength={2} maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="Alex Morgan" /></label>}
            <label>Email address<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" /></label>
            <label>Password<div className="password-field"><input type={showPassword ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 8 : 1} value={password} onChange={event => setPassword(event.target.value)} placeholder={mode === 'register' ? 'At least 8 characters' : 'Enter your password'} /><button className="icon-btn password-toggle" type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
            {error && <div className="form-error">{error}</div>}
            <button type="submit" className="primary-btn full-btn" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}<ChevronRight size={17} /></button>
          </form>
          <p className="switch-auth">{mode === 'login' ? 'New to PayPilot?' : 'Already have an account?'} <button onClick={() => { setError(''); setMode(mode === 'login' ? 'register' : 'login') }}>{mode === 'login' ? 'Create an account' : 'Sign in'}</button></p>
          <div className="auth-trust"><ShieldCheck size={15} /> Your financial data is private and encrypted.</div>
        </div>
      </section>
    </main>
  )
}

function App() {
  const [token, setToken] = useState<string | null>(() => getToken())
  const [user, setUser] = useState<User | null>(() => {
    const stored = localStorage.getItem('paypilot-user')
    return stored ? JSON.parse(stored) as User : null
  })
  const [authLoading, setAuthLoading] = useState(Boolean(getToken()))
  const [page, setPage] = useState<Page>('Overview')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [config, setConfig] = useState<Config>({ paypalClientId: null, paypalConfigured: false, aiConfigured: false })
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [toast, setToast] = useState<Toast>(null)
  const [mobileNav, setMobileNav] = useState(false)
  const [showTransactionForm, setShowTransactionForm] = useState(false)
  const [chat, setChat] = useState<ChatMessage[]>([{ role: 'assistant', text: 'Hi! I’m your PayPilot assistant. Ask me about spending, budgets, or a savings goal. I’ll use your recorded financial data and never send a payment without your approval.' }])
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [preparedPayment, setPreparedPayment] = useState<PreparedPayment | null>(null)
  const [approvedPayment, setApprovedPayment] = useState<PreparedPayment | null>(null)

  const notify = useCallback((text: string, tone: 'success' | 'error' = 'success') => setToast({ text, tone }), [])
  const logout = useCallback(() => {
    localStorage.removeItem('paypilot-token')
    localStorage.removeItem('paypilot-user')
    setToken(null)
    setUser(null)
    setSummary(null)
    setTransactions([])
  }, [])

  useEffect(() => {
    const handleUnauthorized = () => logout()
    window.addEventListener('paypilot:unauthorized', handleUnauthorized)
    return () => window.removeEventListener('paypilot:unauthorized', handleUnauthorized)
  }, [logout])

  useEffect(() => {
    if (toast) {
      const timer = window.setTimeout(() => setToast(null), 4200)
      return () => window.clearTimeout(timer)
    }
  }, [toast])

  const refresh = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setLoadError('')
    try {
      const [nextSummary, nextTransactions, nextBudgets, nextGoals, nextPayments] = await Promise.all([
        api<Summary>('/summary'), api<Transaction[]>('/transactions'), api<Budget[]>('/budgets'),
        api<Goal[]>('/goals'), api<Payment[]>('/payments'),
      ])
      setSummary(nextSummary)
      setTransactions(nextTransactions)
      setBudgets(nextBudgets)
      setGoals(nextGoals)
      setPayments(nextPayments)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load your financial data.')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (!token) {
      setAuthLoading(false)
      return
    }
    let active = true
    Promise.all([api<User>('/me'), api<Config>('/config')])
      .then(([nextUser, nextConfig]) => {
        if (!active) return
        setUser(nextUser)
        localStorage.setItem('paypilot-user', JSON.stringify(nextUser))
        setConfig(nextConfig)
      })
      .catch(() => {
        if (active) logout()
      })
      .finally(() => { if (active) setAuthLoading(false) })
    return () => { active = false }
  }, [token, logout])

  useEffect(() => { void refresh() }, [refresh])

  function onAuth(nextToken: string, nextUser: User) {
    localStorage.setItem('paypilot-token', nextToken)
    localStorage.setItem('paypilot-user', JSON.stringify(nextUser))
    setToken(nextToken)
    setUser(nextUser)
  }

  async function addTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      await api('/transactions', { method: 'POST', body: JSON.stringify({ description: data.get('description'), category: data.get('category'), type: data.get('type'), amount: Number(data.get('amount')) }) })
      setShowTransactionForm(false)
      notify('Transaction added.')
      await refresh()
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not add transaction.', 'error') }
  }

  async function addBudget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      await api('/budgets', { method: 'POST', body: JSON.stringify({ category: data.get('category'), amount: Number(data.get('amount')) }) })
      notify('Budget saved.')
      await refresh()
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not save budget.', 'error') }
  }

  async function addGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      await api('/goals', { method: 'POST', body: JSON.stringify({ name: data.get('name'), target: Number(data.get('target')), targetDate: data.get('targetDate') || undefined }) })
      notify('Savings goal created.')
      await refresh()
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not create goal.', 'error') }
  }

  async function prepareManualPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      const payment = await api<PreparedPayment>('/payments/prepare', { method: 'POST', body: JSON.stringify({ recipient: data.get('recipient'), amount: Number(data.get('amount')) }) })
      setPreparedPayment(payment)
      setApprovedPayment(null)
      notify('Payment prepared. Review the details before checkout.')
      await refresh()
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not prepare payment.', 'error') }
  }

  async function askAssistant(event: FormEvent) {
    event.preventDefault()
    const message = chatInput.trim()
    if (!message || chatBusy) return
    setChatInput('')
    setChat(current => [...current, { role: 'user', text: message }])
    setChatBusy(true)
    try {
      const result = await api<{ answer: string; mode: string; preparedPayment?: PreparedPayment }>('/assistant/ask', { method: 'POST', body: JSON.stringify({ message }) })
      setChat(current => [...current, { role: 'assistant', text: result.answer }])
      if (result.preparedPayment) {
        setPreparedPayment(result.preparedPayment)
        setApprovedPayment(null)
        await refresh()
      }
    } catch (error) {
      setChat(current => [...current, { role: 'assistant', text: error instanceof Error ? error.message : 'I could not answer right now.' }])
    } finally { setChatBusy(false) }
  }

  function onPaymentComplete() {
    setApprovedPayment(null)
    setPreparedPayment(null)
    notify('Payment verified by PayPal and recorded.')
    void refresh()
  }

  const paymentCompleted = useCallback(() => onPaymentComplete(), [])
  const paymentError = useCallback((message: string) => notify(message, 'error'), [notify])
  const currentMonthBudgets = useMemo(() => budgets.filter(budget => budget.month === new Date().toISOString().slice(0, 7)), [budgets])

  if (authLoading) return <div className="screen-loading"><div className="spinner" /><span>Loading your workspace…</span></div>
  if (!token || !user) return <AuthScreen onAuth={onAuth} />
  const activeUser = user

  function navigate(nextPage: Page) {
    setPage(nextPage)
    setMobileNav(false)
  }

  function renderDashboard() {
    if (!summary) return <div className="empty-panel">{loading ? 'Loading your financial overview…' : loadError || 'Your financial data is not available.'}</div>
    const totalSpent = summary.categories.reduce((total, item) => total + item.amount, 0)
    return <>
      <section className="welcome-row">
        <div><p className="eyebrow-label">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase()}</p><h1>Good morning, {activeUser.name.split(' ')[0]}</h1><p className="subtitle">Here’s your financial snapshot for this month.</p></div>
        <button className="primary-btn" onClick={() => setShowTransactionForm(true)}><Plus size={17} /> Add transaction</button>
      </section>
      <section className="stats-grid">
        <StatCard title="Available balance" value={money(summary.balance)} note="Income minus expenses this month" icon={<Wallet size={17} />} trend={summary.balance >= 0 ? 'positive' : 'negative'} />
        <StatCard title="Total income" value={money(summary.income)} note="Recorded this month" icon={<ArrowDownLeft size={17} />} trend="positive" />
        <StatCard title="Total expenses" value={money(summary.expenses)} note="Recorded this month" icon={<ArrowUpRight size={17} />} trend="neutral" />
        <StatCard title="Savings rate" value={`${summary.savingsRate.toFixed(1)}%`} note="Of monthly income retained" icon={<TrendingUp size={17} />} trend={summary.savingsRate >= 20 ? 'positive' : 'neutral'} />
      </section>
      <section className="dashboard-grid">
        <div className="panel cashflow-panel">
          <div className="panel-heading"><div><h2>Cash flow</h2><p>Income and spending over the last 6 months</p></div><span className="select-pill">Last 6 months <ChevronDown size={14} /></span></div>
          {summary.trend.length > 0 ? <div className="chart-area"><ResponsiveContainer width="100%" height="100%"><AreaChart data={summary.trend} margin={{ top: 12, right: 6, left: -18, bottom: 0 }}><defs><linearGradient id="incomeFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3157D5" stopOpacity={0.14} /><stop offset="100%" stopColor="#3157D5" stopOpacity={0} /></linearGradient><linearGradient id="expenseFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#85A0E9" stopOpacity={0.14} /><stop offset="100%" stopColor="#85A0E9" stopOpacity={0} /></linearGradient></defs><CartesianGrid vertical={false} stroke="#EEF0F4" /><XAxis dataKey="month" tickFormatter={value => new Date(`${value}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short' })} tickLine={false} axisLine={false} tick={{ fill: '#8A93A3', fontSize: 12 }} dy={10} /><YAxis tickFormatter={value => `$${value / 1000}k`} tickLine={false} axisLine={false} tick={{ fill: '#8A93A3', fontSize: 12 }} /><Tooltip formatter={(value: number) => money(value)} labelFormatter={value => new Date(`${value}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} contentStyle={{ border: '1px solid #E5E7EB', borderRadius: 10, boxShadow: '0 8px 24px #17203312' }} /><Area type="monotone" dataKey="income" name="Income" stroke="#3157D5" strokeWidth={2.2} fill="url(#incomeFill)" /><Area type="monotone" dataKey="expenses" name="Expenses" stroke="#8CA2E3" strokeWidth={2} fill="url(#expenseFill)" /></AreaChart></ResponsiveContainer></div> : <EmptyState title="Not enough history yet" text="Add transactions to see your cash flow trend." />}
          <div className="chart-legend"><span><i className="legend-dot income-dot" /> Income</span><span><i className="legend-dot expense-dot" /> Expenses</span></div>
        </div>
        <div className="panel category-panel">
          <div className="panel-heading"><div><h2>Spending by category</h2><p>This month · {money(totalSpent)} total</p></div><button className="icon-btn" aria-label="View analytics" onClick={() => navigate('Analytics')}><Ellipsis size={19} /></button></div>
          {summary.categories.length ? <>
            <div className="donut-wrap"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={summary.categories} dataKey="amount" nameKey="category" innerRadius={61} outerRadius={83} paddingAngle={3} stroke="none">{summary.categories.map((entry, index) => <Cell key={entry.category} fill={chartColors[index % chartColors.length]} />)}</Pie><Tooltip formatter={(value: number) => money(value)} /></PieChart></ResponsiveContainer><div className="donut-center"><strong>{summary.categories.length}</strong><span>categories</span></div></div>
            <div className="category-list">{summary.categories.slice(0, 4).map((item, index) => <div className="category-line" key={item.category}><span><i className="legend-dot" style={{ backgroundColor: chartColors[index % chartColors.length] }} />{item.category}</span><strong>{money(item.amount)}</strong></div>)}</div>
          </> : <EmptyState title="No spending recorded" text="Your category breakdown will appear here." />}
        </div>
      </section>
      <section className="dashboard-grid lower-grid">
        <div className="panel recent-panel">
          <div className="panel-heading"><div><h2>Recent transactions</h2><p>Your latest account activity</p></div><button className="text-btn" onClick={() => navigate('Transactions')}>View all <ChevronRight size={15} /></button></div>
          {summary.recent.length ? <TransactionList transactions={summary.recent} /> : <EmptyState title="A fresh start" text="Add your first transaction to see activity." action={<button className="text-btn" onClick={() => setShowTransactionForm(true)}>Add a transaction <ChevronRight size={15} /></button>} />}
        </div>
        <div className="panel side-stack">
          <div className="panel-heading"><div><h2>Budget pulse</h2><p>Monthly category limits</p></div><button className="text-btn" onClick={() => navigate('Budgets')}>Manage <ChevronRight size={15} /></button></div>
          {summary.budgets.length ? summary.budgets.slice(0, 3).map(item => <BudgetMeter key={item.category} category={item.category} spent={item.spent} budget={item.budget} />) : <EmptyState title="Set your first budget" text="Create a monthly limit to keep spending on track." action={<button className="text-btn" onClick={() => navigate('Budgets')}>Create budget <ChevronRight size={15} /></button>} />}
          <div className="insight-card"><div className="insight-icon"><Sparkles size={16} /></div><div><span className="insight-label">PILOT INSIGHT</span><p>{summary.income ? `You’ve retained ${summary.savingsRate.toFixed(0)}% of this month’s recorded income so far.` : 'Add income and expenses to unlock personalized insights.'}</p><button className="text-btn" onClick={() => navigate('AI assistant')}>Ask PayPilot <ChevronRight size={14} /></button></div></div>
        </div>
      </section>
    </>
  }

  function renderTransactions() {
    return <TransactionsView transactions={transactions} onAdd={() => setShowTransactionForm(true)} onExport={() => exportTransactions().then(() => notify('CSV report downloaded.')).catch(error => notify(error.message, 'error'))} />
  }

  function renderBudgets() {
    return <><PageIntro eyebrow="SPENDING PLAN" title="Budgets" description="Set practical monthly limits and see how your spending tracks against them." action={<button className="primary-btn" onClick={() => document.getElementById('budget-category')?.focus()}><Plus size={17} /> Add budget</button>} />
      <div className="content-grid"><section className="panel"><div className="panel-heading"><div><h2>This month</h2><p>Category-level budget progress</p></div><span className="select-pill">{new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span></div>{currentMonthBudgets.length ? <div className="meter-list">{currentMonthBudgets.map(item => <BudgetMeter key={item.id ?? item.category} category={item.category} spent={item.spent} budget={item.budget} expanded />)}</div> : <EmptyState title="No budgets yet" text="Add a category limit to begin tracking your spending plan." />}</section>
        <form className="panel form-panel" onSubmit={addBudget}><div className="panel-heading"><div><h2>Create a budget</h2><p>Limits apply to the current month.</p></div><div className="form-icon"><Wallet size={17} /></div></div><label>Category<select id="budget-category" name="category" required defaultValue=""><option value="" disabled>Select a category</option>{['Housing', 'Groceries', 'Dining', 'Transport', 'Utilities', 'Health', 'Shopping', 'Subscriptions', 'Travel', 'Other'].map(category => <option key={category}>{category}</option>)}</select></label><label>Monthly limit<input name="amount" type="number" min="0.01" step="0.01" required placeholder="e.g. 400" /></label><button className="primary-btn full-btn" type="submit"><Plus size={16} /> Save budget</button><p className="form-footnote">Your budget progress is calculated from recorded expenses in the selected category.</p></form></div>
    </>
  }

  function renderGoals() {
    const totalTarget = goals.reduce((sum, goal) => sum + goal.target, 0)
    const totalSaved = goals.reduce((sum, goal) => sum + goal.saved, 0)
    return <><PageIntro eyebrow="YOUR FUTURE, ON TRACK" title="Savings goals" description="Turn the things you care about into a clear, measurable plan." /><div className="goal-summary"><div><span>Total saved</span><strong>{money(totalSaved)}</strong></div><div><span>Across {goals.length} goals</span><strong>{money(totalTarget)} target</strong></div><div><span>Overall progress</span><strong>{totalTarget ? `${Math.min(100, totalSaved / totalTarget * 100).toFixed(0)}%` : '—'}</strong></div></div>
      <div className="content-grid"><section className="panel"><div className="panel-heading"><div><h2>Your goals</h2><p>Small steps add up.</p></div><Target size={18} className="muted" /></div>{goals.length ? <div className="goal-list">{goals.map(goal => <div className="goal-card" key={goal.id}><div className="goal-top"><div className="goal-icon"><Target size={17} /></div><div className="goal-main"><strong>{goal.name}</strong><span>{goal.targetDate ? `Target date ${new Date(`${goal.targetDate}T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : 'No target date set'}</span></div><div className="goal-money"><strong>{money(goal.saved)}</strong><span>of {money(goal.target)}</span></div></div><div className="progress-track"><div className="progress-fill" style={{ width: `${Math.min(100, goal.saved / goal.target * 100)}%` }} /></div><div className="goal-progress-label"><span>{Math.min(100, goal.saved / goal.target * 100).toFixed(0)}% complete</span><span>{money(Math.max(0, goal.target - goal.saved))} to go</span></div></div>)}</div> : <EmptyState title="Start with a goal" text="Create a goal like an emergency fund, a trip, or your next big purchase." />}</section>
        <form className="panel form-panel" onSubmit={addGoal}><div className="panel-heading"><div><h2>Set a new goal</h2><p>Give your next milestone a name.</p></div><div className="form-icon"><Target size={17} /></div></div><label>Goal name<input name="name" required maxLength={80} placeholder="e.g. Emergency fund" /></label><label>Target amount<input name="target" type="number" min="0.01" step="0.01" required placeholder="e.g. 5,000" /></label><label>Target date <span className="optional">(optional)</span><input name="targetDate" type="date" min={new Date().toISOString().slice(0, 10)} /></label><button className="primary-btn full-btn" type="submit"><Plus size={16} /> Create goal</button><p className="form-footnote">Goal balances are manually tracked. Connect a savings account to automate contributions.</p></form></div>
    </>
  }

  function renderPayments() {
    return <><PageIntro eyebrow="PAYMENTS, WITH YOU IN CONTROL" title="Payments" description="Prepare a payment, review every detail, then approve it securely with PayPal." action={<span className={`status-chip ${config.paypalConfigured ? 'status-connected' : 'status-pending'}`}><span />{config.paypalConfigured ? 'Sandbox connected' : 'Sandbox not configured'}</span>} />
      <div className="content-grid payment-layout"><section className="panel payment-form-panel"><div className="panel-heading"><div><h2>Prepare a payment</h2><p>Checkout only starts after you approve.</p></div><div className="form-icon"><CreditCard size={17} /></div></div><form className="stack-form" onSubmit={prepareManualPayment}><label>Recipient<input name="recipient" required minLength={2} maxLength={120} placeholder="Person or business name" /></label><label>Amount (USD)<div className="amount-input"><span>$</span><input name="amount" type="number" min="0.01" max="10000" step="0.01" required placeholder="0.00" /></div></label><div className="secure-note"><ShieldCheck size={16} /><span>Your approval is required before PayPal checkout. PayPilot never sends payments automatically.</span></div><button type="submit" className="primary-btn full-btn"><Plus size={16} /> Review payment</button></form></section>
        <section className="panel"><div className="panel-heading"><div><h2>Payment activity</h2><p>Your prepared and completed payments</p></div><CreditCard size={18} className="muted" /></div>{payments.length ? <div className="payment-history">{payments.map(payment => <div className="payment-row" key={payment.id}><div className="payment-mark"><ArrowUpRight size={17} /></div><div className="payment-detail"><strong>{payment.recipient}</strong><span>{dateLabel(payment.date)} · PayPal</span></div><div className="payment-amount"><strong>{money(payment.amount)}</strong><span className={`payment-status status-${payment.status}`}>{payment.status}</span></div></div>)}</div> : <EmptyState title="No payment activity yet" text="Prepared payments and verified PayPal captures will appear here." />}</section>
      </div>
      {preparedPayment && <PaymentReview payment={preparedPayment} approved={approvedPayment?.id === preparedPayment.id} onApprove={() => setApprovedPayment(preparedPayment)} onCancel={() => { setPreparedPayment(null); setApprovedPayment(null) }} onComplete={paymentCompleted} onError={paymentError} configured={config.paypalConfigured} />}
    </>
  }

  function renderAnalytics() {
    const data = summary?.trend ?? []
    const monthlyExpense = data.reduce((sum, item) => sum + item.expenses, 0)
    const monthlyIncome = data.reduce((sum, item) => sum + item.income, 0)
    const categories = summary?.categories ?? []
    return <><PageIntro eyebrow="DATA, MADE USEFUL" title="Analytics & reports" description="Understand your money patterns with a clear view of income, spending, and payment activity." action={<button className="secondary-btn" onClick={() => exportTransactions().then(() => notify('CSV report downloaded.')).catch(error => notify(error.message, 'error'))}><Download size={16} /> Export CSV</button>} />
      <div className="analytics-stats"><StatCard title="Income · 6 months" value={money(monthlyIncome)} note="Based on recorded transactions" icon={<TrendingUp size={17} />} trend="positive" /><StatCard title="Expenses · 6 months" value={money(monthlyExpense)} note="Based on recorded transactions" icon={<TrendingDown size={17} />} trend="neutral" /><StatCard title="Payment success rate" value={`${(summary?.paymentSuccessRate ?? 0).toFixed(0)}%`} note={`${payments.filter(item => item.status === 'completed').length} verified captures`} icon={<BadgeCheck size={17} />} trend="positive" /></div>
      <div className="dashboard-grid"><section className="panel cashflow-panel"><div className="panel-heading"><div><h2>Income vs. expenses</h2><p>Monthly totals · last 6 months</p></div></div>{data.length ? <div className="chart-area tall-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data} margin={{ top: 14, right: 10, left: -14, bottom: 0 }}><CartesianGrid vertical={false} stroke="#EEF0F4" /><XAxis dataKey="month" tickFormatter={value => new Date(`${value}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short' })} tickLine={false} axisLine={false} tick={{ fill: '#8A93A3', fontSize: 12 }} dy={10} /><YAxis tickFormatter={value => `$${value / 1000}k`} tickLine={false} axisLine={false} tick={{ fill: '#8A93A3', fontSize: 12 }} /><Tooltip formatter={(value: number) => money(value)} /><Area type="monotone" dataKey="income" name="Income" stroke="#3157D5" strokeWidth={2.2} fill="#3157D516" /><Area type="monotone" dataKey="expenses" name="Expenses" stroke="#C58A2A" strokeWidth={2} fill="#C58A2A16" /></AreaChart></ResponsiveContainer></div> : <EmptyState title="No data to chart" text="Add transactions to see monthly trends." />}</section>
        <section className="panel"><div className="panel-heading"><div><h2>Category breakdown</h2><p>Current month spending</p></div></div>{categories.length ? <div className="analytics-category-list">{categories.map((item, index) => <div key={item.category} className="analytics-category"><div className="category-line"><span><i className="legend-dot" style={{ background: chartColors[index % chartColors.length] }} />{item.category}</span><strong>{money(item.amount)}</strong></div><div className="progress-track"><div className="progress-fill" style={{ width: `${totalCategoryPercentage(item.amount, categories)}%`, background: chartColors[index % chartColors.length] }} /></div></div>)}</div> : <EmptyState title="No category data yet" text="Recorded expenses appear here, grouped by category." />}</section></div>
      <section className="panel report-note"><div className="insight-icon"><FileChartColumnIncreasing size={17} /></div><div><strong>Reporting based on your records</strong><p>Income, expenses, trends and category totals are calculated from your account’s transactions. CSV export includes transaction details for your own analysis.</p></div></section>
    </>
  }

  function renderAssistant() {
    return <><PageIntro eyebrow="YOUR FINANCIAL CO-PILOT" title="AI assistant" description="Ask a question about your finances or turn your next payment into a reviewable draft." action={<span className={`status-chip ${config.aiConfigured ? 'status-connected' : 'status-pending'}`}><span />{config.aiConfigured ? 'AI provider connected' : 'Data summary mode'}</span>} />
      <div className="assistant-layout"><section className="panel assistant-panel"><div className="assistant-title"><div className="assistant-avatar"><Sparkles size={19} /></div><div><strong>PayPilot assistant</strong><span>{config.aiConfigured ? 'Your AI, grounded in your data' : 'Using your data · AI provider not configured'}</span></div><button className="icon-btn" aria-label="Clear conversation" onClick={() => { setChat([{ role: 'assistant', text: 'Conversation cleared. Ask me about spending, budgets, or a savings goal.' }]); setPreparedPayment(null); setApprovedPayment(null) }}><Ellipsis size={19} /></button></div><div className="chat-log">{chat.map((message, index) => <div key={`${index}-${message.role}`} className={`chat-message ${message.role}`}><div className="chat-avatar">{message.role === 'assistant' ? <Sparkles size={15} /> : activeUser.name.charAt(0).toUpperCase()}</div><div className="chat-bubble">{message.text}</div></div>)}{chatBusy && <div className="chat-message assistant"><div className="chat-avatar"><Sparkles size={15} /></div><div className="chat-bubble typing"><i /><i /><i /></div></div>}</div><div className="prompt-suggestions">{['Analyze my spending this month', 'Where am I spending the most?', 'Help me save $200'].map(prompt => <button key={prompt} onClick={() => setChatInput(prompt)}>{prompt}</button>)}</div><form className="chat-composer" onSubmit={askAssistant}><input aria-label="Ask the assistant" value={chatInput} onChange={event => setChatInput(event.target.value)} placeholder="Ask anything about your finances…" maxLength={2000} /><button className="send-btn" aria-label="Send message" type="submit" disabled={!chatInput.trim() || chatBusy}><Send size={17} /></button></form><p className="assistant-disclaimer"><ShieldCheck size={13} /> Insights use your account data. Always review important financial decisions.</p></section>
        <aside className="assistant-side"><div className="panel"><div className="panel-heading"><div><h2>What I can help with</h2><p>Grounded in your recorded data.</p></div></div><div className="capability-list"><Capability icon={<FileChartColumnIncreasing size={16} />} title="Understand spending" description="Find patterns and category totals." /><Capability icon={<Wallet size={16} />} title="Plan a budget" description="Build a monthly plan from your numbers." /><Capability icon={<Target size={16} />} title="Save with a plan" description="Break a goal into manageable steps." /><Capability icon={<CreditCard size={16} />} title="Prepare a payment" description="Review details before PayPal checkout." /></div></div><div className="security-callout"><ShieldCheck size={18} /><div><strong>You’re always in control</strong><p>AI can prepare a payment, never approve or send it. Every checkout needs your explicit action.</p></div></div></aside></div>
      {preparedPayment && <PaymentReview payment={preparedPayment} approved={approvedPayment?.id === preparedPayment.id} onApprove={() => setApprovedPayment(preparedPayment)} onCancel={() => { setPreparedPayment(null); setApprovedPayment(null) }} onComplete={paymentCompleted} onError={paymentError} configured={config.paypalConfigured} />}
    </>
  }

  function renderNotifications() {
    const alerts = currentMonthBudgets.filter(item => item.budget > 0 && item.spent / item.budget >= 0.8)
    const recentPayments = payments.slice(0, 5)
    return <><PageIntro eyebrow="STAY IN THE LOOP" title="Notifications" description="Important activity and nudges from your PayPilot workspace." /><section className="panel notifications-panel"><div className="panel-heading"><div><h2>Recent updates</h2><p>Based on your account activity</p></div><Bell size={18} className="muted" /></div>{alerts.length || recentPayments.length ? <div className="notification-list">{alerts.map(item => <div className="notification-item" key={`budget-${item.category}`}><div className="notification-icon warning-icon"><Wallet size={16} /></div><div><strong>{item.category} budget is {Math.round(item.spent / item.budget * 100)}% used</strong><p>You’ve spent {money(item.spent)} of your {money(item.budget)} limit this month.</p></div><span className="notification-date">Today</span></div>)}{recentPayments.map(item => <div className="notification-item" key={`payment-${item.id}`}><div className="notification-icon"><CreditCard size={16} /></div><div><strong>Payment {item.status}: {item.recipient}</strong><p>{money(item.amount)} · {item.status === 'completed' ? 'verified by PayPal' : 'awaiting your approval'}</p></div><span className="notification-date">{dateLabel(item.date)}</span></div>)}</div> : <EmptyState title="You’re all caught up" text="Budget alerts and payment updates will appear here when there’s activity." />}</section></>
  }

  function renderSettings() {
    return <><PageIntro eyebrow="YOUR ACCOUNT" title="Settings" description="Manage your profile and review which integrations are active." /><div className="content-grid"><section className="panel settings-panel"><div className="panel-heading"><div><h2>Profile</h2><p>Your PayPilot account details</p></div><div className="user-avatar large-avatar">{activeUser.name.split(' ').map(part => part[0]).join('').slice(0, 2)}</div></div><div className="settings-line"><span>Full name</span><strong>{activeUser.name}</strong></div><div className="settings-line"><span>Email address</span><strong>{activeUser.email}</strong></div><div className="settings-line"><span>Account</span><strong className="verified-label"><ShieldCheck size={15} /> Password protected</strong></div><div className="settings-actions"><button className="secondary-btn danger-btn" onClick={logout}><LogOut size={16} /> Sign out</button></div></section><section className="panel settings-panel"><div className="panel-heading"><div><h2>Connected services</h2><p>Integration status for this workspace</p></div><Settings2 size={18} className="muted" /></div><div className="integration-line"><div className="integration-logo paypal-logo">P</div><div><strong>PayPal Sandbox</strong><span>{config.paypalConfigured ? 'Configured for test transactions' : 'Not configured on the server'}</span></div><span className={`status-chip ${config.paypalConfigured ? 'status-connected' : 'status-pending'}`}><span />{config.paypalConfigured ? 'Ready' : 'Setup needed'}</span></div><div className="integration-line"><div className="integration-logo ai-logo"><Sparkles size={16} /></div><div><strong>AI assistant</strong><span>{config.aiConfigured ? 'Provider configured server-side' : 'Data summary mode available'}</span></div><span className={`status-chip ${config.aiConfigured ? 'status-connected' : 'status-pending'}`}><span />{config.aiConfigured ? 'Ready' : 'Setup needed'}</span></div><div className="settings-note"><CircleHelp size={15} /><span>Integration keys are server-side only. See README.md for configuration steps.</span></div></section></div></>
  }

  const content = page === 'Overview' ? renderDashboard()
    : page === 'Transactions' ? renderTransactions()
      : page === 'Budgets' ? renderBudgets()
        : page === 'Savings goals' ? renderGoals()
          : page === 'Payments' ? renderPayments()
            : page === 'Analytics' ? renderAnalytics()
              : page === 'AI assistant' ? renderAssistant()
                : page === 'Notifications' ? renderNotifications()
                  : renderSettings()

  return (
    <div className="app-shell">
      {mobileNav && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
      <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand"><div className="brand-lockup"><span className="brand-mark"><Landmark size={17} /></span><span>paypilot<span className="brand-ai">AI</span></span></div><button className="sidebar-collapse" aria-label="Close navigation" onClick={() => setMobileNav(false)}><ChevronLeft size={17} /></button></div>
        <button className="workspace-switch"><span className="workspace-icon">P</span><span className="workspace-name"><strong>Personal workspace</strong><small>Free plan</small></span><ChevronDown size={14} /></button>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {['WORKSPACE', 'MANAGE', 'PREFERENCES'].map(section => <div className="nav-section" key={section}><span className="nav-section-title">{section}</span>{navItems.filter(item => item.section === section).map(item => { const Icon = item.icon; return <button key={item.label} className={`nav-item ${page === item.label ? 'nav-active' : ''}`} onClick={() => navigate(item.label)}><Icon size={17} strokeWidth={1.8} /><span>{item.label}</span>{item.label === 'Notifications' && currentMonthBudgets.some(budget => budget.budget > 0 && budget.spent / budget.budget >= .8) && <i className="nav-indicator" />}</button> })}</div>)}
        </nav>
        <div className="sidebar-bottom"><div className="support-card"><div className="support-icon"><CircleHelp size={17} /></div><div><strong>Need a hand?</strong><span>We’re here to help.</span></div><ChevronRight size={15} /></div><button className="sidebar-user" onClick={() => navigate('Settings')}><div className="user-avatar">{activeUser.name.split(' ').map(part => part[0]).join('').slice(0, 2)}</div><span><strong>{activeUser.name}</strong><small>{activeUser.email}</small></span><Ellipsis size={17} /></button></div>
      </aside>
      <main className="main-shell">
        <header className="topbar"><div className="topbar-left"><button className="mobile-menu icon-btn" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={19} /></button><div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><strong>{page}</strong></div></div><div className="topbar-right"><button className="top-search" onClick={() => navigate('Transactions')}><Search size={16} /><span>Search transactions</span><kbd>⌘ K</kbd></button><button className="top-icon-btn" aria-label="Notifications" onClick={() => navigate('Notifications')}><Bell size={18} />{currentMonthBudgets.some(budget => budget.budget > 0 && budget.spent / budget.budget >= .8) && <i />}</button><div className="top-divider" /><button className="top-profile" onClick={() => navigate('Settings')}><div className="user-avatar small-avatar">{activeUser.name.split(' ').map(part => part[0]).join('').slice(0, 2)}</div><ChevronDown size={13} /></button></div></header>
        {loadError && <div className="load-error"><span>{loadError}</span><button onClick={() => void refresh()}>Retry</button></div>}
        <div className="page-content">{content}</div>
        <footer className="app-footer"><span>© 2026 PayPilot AI</span><span><ShieldCheck size={13} /> Your money. Your call.</span></footer>
      </main>
      {showTransactionForm && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setShowTransactionForm(false) }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="transaction-modal-title"><div className="modal-head"><div><span className="eyebrow-label">ACCOUNT ACTIVITY</span><h2 id="transaction-modal-title">Add a transaction</h2></div><button className="icon-btn" onClick={() => setShowTransactionForm(false)} aria-label="Close"><X size={19} /></button></div><form className="stack-form" onSubmit={addTransaction}><label>Description<input name="description" required maxLength={120} placeholder="e.g. Weekly groceries" /></label><div className="form-row"><label>Type<select name="type"><option value="expense">Expense</option><option value="income">Income</option></select></label><label>Category<select name="category" required>{['Groceries', 'Housing', 'Dining', 'Transport', 'Utilities', 'Health', 'Shopping', 'Subscriptions', 'Income', 'Other'].map(category => <option key={category}>{category}</option>)}</select></label></div><label>Amount (USD)<div className="amount-input"><span>$</span><input name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00" /></div></label><div className="modal-actions"><button type="button" className="secondary-btn" onClick={() => setShowTransactionForm(false)}>Cancel</button><button type="submit" className="primary-btn">Save transaction</button></div></form></section></div>}
      {toast && <div className={`toast toast-${toast.tone}`} role="status">{toast.tone === 'success' ? <BadgeCheck size={17} /> : <CircleHelp size={17} />}{toast.text}<button className="icon-btn" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={15} /></button></div>}
    </div>
  )
}

function StatCard({ title, value, note, icon, trend }: { title: string; value: string; note: string; icon: React.ReactNode; trend: 'positive' | 'negative' | 'neutral' }) {
  return <article className="stat-card"><div className="stat-top"><span>{title}</span><span className="stat-icon">{icon}</span></div><strong className="stat-value">{value}</strong><div className={`stat-note note-${trend}`}>{trend === 'positive' ? <TrendingUp size={13} /> : trend === 'negative' ? <TrendingDown size={13} /> : <span className="note-dot" />}{note}</div></article>
}

function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <section className="welcome-row page-intro"><div><p className="eyebrow-label">{eyebrow}</p><h1>{title}</h1><p className="subtitle">{description}</p></div>{action && <div className="intro-action">{action}</div>}</section>
}

function EmptyState({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><FileChartColumnIncreasing size={19} /></div><strong>{title}</strong><p>{text}</p>{action}</div>
}

function TransactionList({ transactions }: { transactions: Transaction[] }) {
  return <div className="transaction-list">{transactions.map(item => <div className="transaction-row" key={item.id}><div className={`transaction-icon ${item.type === 'income' ? 'transaction-income' : ''}`}>{item.type === 'income' ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}</div><div className="transaction-name"><strong>{item.description}</strong><span>{item.category} · {dateLabel(item.date)}</span></div><strong className={`transaction-value ${item.type === 'income' ? 'amount-income' : ''}`}>{item.type === 'income' ? '+' : '−'}{money(item.amount)}</strong></div>)}</div>
}

function BudgetMeter({ category, spent, budget, expanded = false }: { category: string; spent: number; budget: number; expanded?: boolean }) {
  const percent = budget > 0 ? (spent / budget) * 100 : 0
  const tone = percent >= 100 ? 'over' : percent >= 80 ? 'near' : ''
  return <div className={`budget-meter ${expanded ? 'meter-expanded' : ''}`}><div className="meter-heading"><span>{category}</span><strong>{money(spent)} <small>of {money(budget)}</small></strong></div><div className="progress-track"><div className={`progress-fill ${tone}`} style={{ width: `${Math.min(percent, 100)}%` }} /></div><div className="meter-bottom"><span>{percent >= 100 ? 'Limit reached' : `${money(Math.max(0, budget - spent))} remaining`}</span><span className={tone ? `text-${tone}` : ''}>{percent.toFixed(0)}%</span></div></div>
}

function Capability({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return <div className="capability"><div className="capability-icon">{icon}</div><div><strong>{title}</strong><span>{description}</span></div></div>
}

function PaymentReview({ payment, approved, onApprove, onCancel, onComplete, onError, configured }: { payment: PreparedPayment; approved: boolean; onApprove: () => void; onCancel: () => void; onComplete: () => void; onError: (message: string) => void; configured: boolean }) {
  return <section className="payment-review panel"><div className="review-title"><div className="review-mark"><ShieldCheck size={18} /></div><div><span className="eyebrow-label">PAYMENT REVIEW</span><h2>Confirm before checkout</h2><p>Nothing is sent until you approve the PayPal Sandbox checkout.</p></div><button className="icon-btn review-close" onClick={onCancel} aria-label="Cancel payment"><X size={18} /></button></div><div className="review-details"><div><span>Paying</span><strong>{payment.recipient}</strong></div><div><span>Amount</span><strong>{money(payment.amount)} <small>USD</small></strong></div><div><span>Status</span><strong className="review-pending">Prepared · not sent</strong></div></div>{approved ? <div className="approved-checkout"><p><ShieldCheck size={15} /> You approved this payment draft. Complete it securely with PayPal.</p><PayPalCheckout payment={payment} onComplete={onComplete} onError={onError} /></div> : <div className="review-actions"><p>{configured ? 'Continue to PayPal Sandbox to review and authorize the payment.' : 'Sandbox credentials are required to enable checkout. This draft will not be marked paid.'}</p><div><button className="secondary-btn" onClick={onCancel}>Cancel draft</button><button className="primary-btn" onClick={onApprove} disabled={!configured}><ShieldCheck size={16} /> I approve — continue to PayPal</button></div></div>}</section>
}

function TransactionsView({ transactions, onAdd, onExport }: { transactions: Transaction[]; onAdd: () => void; onExport: () => void }) {
  const [query, setQuery] = useState('')
  const [type, setType] = useState('all')
  const filtered = transactions.filter(item => `${item.description} ${item.category}`.toLowerCase().includes(query.toLowerCase()) && (type === 'all' || item.type === type))
  const total = filtered.reduce((sum, item) => sum + (item.type === 'income' ? item.amount : -item.amount), 0)
  return <><PageIntro eyebrow="YOUR ACCOUNT ACTIVITY" title="Transactions" description="Review the income and expenses recorded in your PayPilot account." action={<button className="primary-btn" onClick={onAdd}><Plus size={17} /> Add transaction</button>} /><section className="panel transactions-panel"><div className="transactions-toolbar"><div className="search-field"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search transactions" aria-label="Search transactions" /></div><select aria-label="Filter by transaction type" value={type} onChange={event => setType(event.target.value)}><option value="all">All activity</option><option value="income">Income</option><option value="expense">Expenses</option></select><button className="secondary-btn export-btn" onClick={onExport}><Download size={15} /> Export CSV</button></div><div className="table-scroll"><table><thead><tr><th>TRANSACTION</th><th>CATEGORY</th><th>DATE</th><th>SOURCE</th><th className="align-right">AMOUNT</th></tr></thead><tbody>{filtered.map(item => <tr key={item.id}><td><div className="table-transaction"><span className={`transaction-icon ${item.type === 'income' ? 'transaction-income' : ''}`}>{item.type === 'income' ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}</span><strong>{item.description}</strong></div></td><td><span className="category-tag">{item.category}</span></td><td>{dateLabel(item.date)}</td><td><span className="source-label">{item.source === 'paypal' ? 'PayPal' : 'Manual'}</span></td><td className={`align-right table-amount ${item.type === 'income' ? 'amount-income' : ''}`}>{item.type === 'income' ? '+' : '−'}{money(item.amount)}</td></tr>)}</tbody></table></div>{!filtered.length && <EmptyState title={query ? 'No matching transactions' : 'No transactions yet'} text={query ? 'Try another search or filter.' : 'Add a transaction to start understanding your money.'} action={!query ? <button className="text-btn" onClick={onAdd}>Add transaction <ChevronRight size={15} /></button> : undefined} />}<div className="table-footer"><span>Showing {filtered.length} of {transactions.length} transactions</span><strong>Net total <b className={total >= 0 ? 'amount-income' : ''}>{money(total)}</b></strong></div></section></>
}

function totalCategoryPercentage(amount: number, categories: Array<{ amount: number }>) {
  const total = categories.reduce((sum, item) => sum + item.amount, 0)
  return total ? Math.max(3, (amount / total) * 100) : 0
}

export default App
