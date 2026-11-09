import 'dotenv/config'
import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { db } from './db.js'

const app = express()
const port = Number(process.env.PORT ?? 3001)
const jwtSecret = process.env.JWT_SECRET

if (!jwtSecret) throw new Error('JWT_SECRET is required. Set it in your environment before starting the server.')

app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173' }))
app.use(express.json({ limit: '1mb' }))

type AuthRequest = Request & { userId?: number }
type UserRow = { id: number; name: string; email: string }

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
})
const loginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1) })
const transactionSchema = z.object({
  description: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(40),
  type: z.enum(['income', 'expense']),
  amount: z.number().positive().max(1_000_000),
})
const budgetSchema = z.object({
  category: z.string().trim().min(1).max(40),
  amount: z.number().positive().max(1_000_000),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
})
const goalSchema = z.object({
  name: z.string().trim().min(1).max(80),
  target: z.number().positive().max(10_000_000),
  targetDate: z.string().date().optional(),
})
const prepareSchema = z.object({
  recipient: z.string().trim().min(2).max(120),
  amount: z.number().positive().max(10_000),
})

function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' })
  try {
    const payload = jwt.verify(token, jwtSecret!) as jwt.JwtPayload
    if (typeof payload.sub !== 'string' || !/^\d+$/.test(payload.sub)) throw new Error('Invalid token subject')
    ;(req as AuthRequest).userId = Number(payload.sub)
    next()
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' })
  }
}

function userId(req: Request) {
  const id = (req as AuthRequest).userId
  if (!id) throw new Error('Authenticated user context is missing.')
  return id
}

function issueToken(user: UserRow) {
  return jwt.sign({ name: user.name, email: user.email }, jwtSecret!, { subject: String(user.id), expiresIn: '7d' })
}

function validationError(error: z.ZodError) {
  return error.issues[0]?.message ?? 'Invalid request.'
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))
app.get('/api/config', (_req, res) => res.json({
  paypalClientId: process.env.PAYPAL_CLIENT_ID ?? null,
  paypalConfigured: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
  aiConfigured: Boolean(process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY),
}))

app.post('/api/auth/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: validationError(parsed.error) })
  const { name, email, password } = parsed.data
  try {
    const passwordHash = await bcrypt.hash(password, 12)
    const result = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(name, email, passwordHash)
    const user = { id: Number(result.lastInsertRowid), name, email }
    return res.status(201).json({ token: issueToken(user), user })
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'An account with this email already exists.' })
    }
    console.error('Registration failed:', error)
    return res.status(500).json({ error: 'Could not create your account.' })
  }
})

app.post('/api/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: validationError(parsed.error) })
  const row = db.prepare('SELECT id, name, email, password_hash FROM users WHERE email = ?').get(parsed.data.email) as (UserRow & { password_hash: string }) | undefined
  if (!row || !(await bcrypt.compare(parsed.data.password, row.password_hash))) {
    return res.status(401).json({ error: 'Email or password is incorrect.' })
  }
  const user = { id: row.id, name: row.name, email: row.email }
  return res.json({ token: issueToken(user), user })
})

app.use('/api', authenticate)

app.get('/api/me', (req, res) => {
  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId(req)) as UserRow | undefined
  if (!user) return res.status(404).json({ error: 'Account not found.' })
  return res.json(user)
})

app.get('/api/summary', (req, res) => {
  const id = userId(req)
  const rows = db.prepare(`
    SELECT type, COALESCE(SUM(amount), 0) AS total FROM transactions
    WHERE user_id = ? AND strftime('%Y-%m', occurred_at) = strftime('%Y-%m', 'now') GROUP BY type
  `).all(id) as Array<{ type: string; total: number }>
  const totals = { income: 0, expenses: 0 }
  for (const row of rows) {
    if (row.type === 'income') totals.income = row.total
    else totals.expenses = row.total
  }
  const categories = db.prepare(`
    SELECT category, SUM(amount) AS amount FROM transactions
    WHERE user_id = ? AND type = 'expense' AND strftime('%Y-%m', occurred_at) = strftime('%Y-%m', 'now')
    GROUP BY category ORDER BY amount DESC
  `).all(id)
  const trend = db.prepare(`
    SELECT strftime('%Y-%m', occurred_at) AS month,
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) AS income,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS expenses
    FROM transactions WHERE user_id = ? AND occurred_at >= date('now', 'start of month', '-5 months')
    GROUP BY strftime('%Y-%m', occurred_at) ORDER BY month
  `).all(id)
  const recent = db.prepare('SELECT id, description, category, type, amount, occurred_at AS date FROM transactions WHERE user_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 6').all(id)
  const budgetRows = db.prepare(`
    SELECT b.category, b.amount AS budget,
      COALESCE(SUM(t.amount), 0) AS spent
    FROM budgets b LEFT JOIN transactions t ON t.user_id = b.user_id AND t.category = b.category
      AND t.type = 'expense' AND strftime('%Y-%m', t.occurred_at) = b.month
    WHERE b.user_id = ? AND b.month = strftime('%Y-%m', 'now')
    GROUP BY b.id ORDER BY spent DESC
  `).all(id)
  const payments = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN status = \'completed\' THEN 1 ELSE 0 END) AS completed FROM payments WHERE user_id = ?').get(id) as { total: number; completed: number | null }
  return res.json({
    ...totals,
    balance: totals.income - totals.expenses,
    savingsRate: totals.income > 0 ? Math.max(0, ((totals.income - totals.expenses) / totals.income) * 100) : 0,
    categories, trend, recent, budgets: budgetRows,
    paymentSuccessRate: payments.total ? (Number(payments.completed ?? 0) / payments.total) * 100 : 0,
  })
})

app.get('/api/transactions', (req, res) => {
  const id = userId(req)
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 250)
  const rows = db.prepare('SELECT id, description, category, type, amount, occurred_at AS date, source FROM transactions WHERE user_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?').all(id, limit)
  return res.json(rows)
})

app.post('/api/transactions', (req, res) => {
  const parsed = transactionSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: validationError(parsed.error) })
  const item = parsed.data
  const result = db.prepare('INSERT INTO transactions (user_id, description, category, type, amount) VALUES (?, ?, ?, ?, ?)').run(userId(req), item.description, item.category, item.type, item.amount)
  return res.status(201).json({ id: Number(result.lastInsertRowid), ...item, date: new Date().toISOString(), source: 'manual' })
})

app.get('/api/budgets', (req, res) => {
  const rows = db.prepare(`
    SELECT b.id, b.category, b.amount AS budget, b.month, COALESCE(SUM(t.amount), 0) AS spent
    FROM budgets b LEFT JOIN transactions t ON t.user_id = b.user_id AND t.category = b.category
      AND t.type = 'expense' AND strftime('%Y-%m', t.occurred_at) = b.month
    WHERE b.user_id = ? GROUP BY b.id ORDER BY b.month DESC, b.category
  `).all(userId(req))
  return res.json(rows)
})

app.post('/api/budgets', (req, res) => {
  const parsed = budgetSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: validationError(parsed.error) })
  const item = parsed.data
  const month = item.month ?? new Date().toISOString().slice(0, 7)
  db.prepare(`
    INSERT INTO budgets (user_id, category, amount, month) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, category, month) DO UPDATE SET amount = excluded.amount
  `).run(userId(req), item.category, item.amount, month)
  return res.status(201).json({ message: 'Budget saved.' })
})

app.get('/api/goals', (req, res) => {
  return res.json(db.prepare('SELECT id, name, target, saved, target_date AS targetDate FROM savings_goals WHERE user_id = ? ORDER BY id DESC').all(userId(req)))
})

app.post('/api/goals', (req, res) => {
  const parsed = goalSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: validationError(parsed.error) })
  const item = parsed.data
  const result = db.prepare('INSERT INTO savings_goals (user_id, name, target, target_date) VALUES (?, ?, ?, ?)').run(userId(req), item.name, item.target, item.targetDate ?? null)
  return res.status(201).json({ id: Number(result.lastInsertRowid), ...item, saved: 0 })
})

app.post('/api/payments/prepare', (req, res) => {
  const parsed = prepareSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: validationError(parsed.error) })
  const { recipient, amount } = parsed.data
  const result = db.prepare('INSERT INTO payments (user_id, recipient, amount, status) VALUES (?, ?, ?, \'prepared\')').run(userId(req), recipient, amount)
  return res.status(201).json({ id: Number(result.lastInsertRowid), recipient, amount, currency: 'USD', status: 'prepared' })
})

async function paypalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID
  const secret = process.env.PAYPAL_CLIENT_SECRET
  if (!clientId || !secret) throw new Error('PayPal Sandbox is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET on the server.')
  const response = await fetch(`${process.env.PAYPAL_BASE_URL ?? 'https://api-m.sandbox.paypal.com'}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  })
  if (!response.ok) throw new Error(`PayPal authentication failed (${response.status}).`)
  const data = await response.json() as { access_token: string }
  return data.access_token
}

app.post('/api/payments/:id/order', async (req, res) => {
  const paymentId = Number(req.params.id)
  if (!Number.isSafeInteger(paymentId) || paymentId < 1) return res.status(400).json({ error: 'Invalid payment request.' })
  const payment = db.prepare('SELECT id, recipient, amount, status FROM payments WHERE id = ? AND user_id = ?').get(paymentId, userId(req)) as { id: number; recipient: string; amount: number; status: string } | undefined
  if (!payment || payment.status !== 'prepared') return res.status(409).json({ error: 'This payment is no longer available for checkout.' })
  try {
    const token = await paypalAccessToken()
    const response = await fetch(`${process.env.PAYPAL_BASE_URL ?? 'https://api-m.sandbox.paypal.com'}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: String(payment.id), description: `PayPilot payment to ${payment.recipient}`, amount: { currency_code: 'USD', value: payment.amount.toFixed(2) } }],
      }),
    })
    const data = await response.json() as { id?: string; message?: string }
    if (!response.ok || !data.id) {
      console.error('PayPal order creation failed:', data)
      return res.status(502).json({ error: 'PayPal could not create the order. Please try again.' })
    }
    db.prepare('UPDATE payments SET status = \'created\', paypal_order_id = ? WHERE id = ? AND user_id = ? AND status = \'prepared\'').run(data.id, payment.id, userId(req))
    return res.status(201).json({ orderID: data.id })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PayPal order creation failed.'
    console.error('PayPal order creation error:', error)
    return res.status(503).json({ error: message })
  }
})

app.post('/api/payments/:id/capture', async (req, res) => {
  const paymentId = Number(req.params.id)
  if (!Number.isSafeInteger(paymentId) || paymentId < 1) return res.status(400).json({ error: 'Invalid payment request.' })
  const payment = db.prepare('SELECT id, user_id, recipient, amount, status, paypal_order_id FROM payments WHERE id = ? AND user_id = ?').get(paymentId, userId(req)) as { id: number; user_id: number; recipient: string; amount: number; status: string; paypal_order_id: string | null } | undefined
  if (!payment || payment.status !== 'created' || !payment.paypal_order_id) return res.status(409).json({ error: 'No active PayPal order exists for this payment.' })
  try {
    const token = await paypalAccessToken()
    const response = await fetch(`${process.env.PAYPAL_BASE_URL ?? 'https://api-m.sandbox.paypal.com'}/v2/checkout/orders/${encodeURIComponent(payment.paypal_order_id)}/capture`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })
    const result = await response.json() as { status?: string; purchase_units?: Array<{ payments?: { captures?: Array<{ id?: string; status?: string }> } }> }
    const capture = result.purchase_units?.[0]?.payments?.captures?.[0]
    if (!response.ok || result.status !== 'COMPLETED' || capture?.status !== 'COMPLETED' || !capture.id) {
      console.error('PayPal capture was not verified as completed:', result)
      return res.status(502).json({ error: 'PayPal did not verify a completed capture. No transaction was recorded.' })
    }
    const saveCapture = db.transaction(() => {
      db.prepare('UPDATE payments SET status = \'completed\', paypal_capture_id = ? WHERE id = ? AND user_id = ? AND status = \'created\'').run(capture.id, payment.id, payment.user_id)
      db.prepare('INSERT INTO transactions (user_id, description, category, type, amount, source) VALUES (?, ?, ?, \'expense\', ?, \'paypal\')')
        .run(payment.user_id, `PayPal payment to ${payment.recipient}`, 'Payments', payment.amount)
    })
    saveCapture()
    return res.json({ status: 'completed', captureId: capture.id })
  } catch (error) {
    console.error('PayPal capture error:', error)
    return res.status(503).json({ error: error instanceof Error ? error.message : 'PayPal capture failed.' })
  }
})

app.get('/api/payments', (req, res) => {
  return res.json(db.prepare('SELECT id, recipient, amount, currency, status, created_at AS date FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId(req)))
})

app.post('/api/assistant/ask', async (req, res) => {
  const parsed = z.object({ message: z.string().trim().min(1).max(2000) }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: validationError(parsed.error) })
  const id = userId(req)
  const message = parsed.data.message
  const summary = db.prepare(`
    SELECT type, COALESCE(SUM(amount), 0) AS total FROM transactions
    WHERE user_id = ? AND strftime('%Y-%m', occurred_at) = strftime('%Y-%m', 'now') GROUP BY type
  `).all(id) as Array<{ type: string; total: number }>
  const transactions = db.prepare('SELECT description, category, type, amount, occurred_at FROM transactions WHERE user_id = ? ORDER BY occurred_at DESC LIMIT 40').all(id)
  const budgets = db.prepare('SELECT category, amount, month FROM budgets WHERE user_id = ? ORDER BY month DESC LIMIT 24').all(id)
  const goals = db.prepare('SELECT name, target, saved, target_date FROM savings_goals WHERE user_id = ?').all(id)
  const paymentIntent = /\b(?:prepare|pay|send)\b.*?\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:to|for)\s+(.+)/i.exec(message)
  const preparedPayment = paymentIntent ? { amount: Number(paymentIntent[1]), recipient: paymentIntent[2].trim().replace(/[?.!,]+$/, '') } : null
  const currentIncome = summary.find(row => row.type === 'income')?.total ?? 0
  const currentExpenses = summary.find(row => row.type === 'expense')?.total ?? 0
  const context = JSON.stringify({ currentMonth: { income: currentIncome, expenses: currentExpenses, balance: currentIncome - currentExpenses }, transactions, budgets, goals })

  if (preparedPayment) {
    const validPayment = prepareSchema.safeParse(preparedPayment)
    if (!validPayment.success) return res.status(400).json({ error: 'I could not validate the recipient or amount. Please provide a positive amount and recipient.' })
    const result = db.prepare('INSERT INTO payments (user_id, recipient, amount, status) VALUES (?, ?, ?, \'prepared\')').run(id, validPayment.data.recipient, validPayment.data.amount)
    return res.json({
      answer: `I’ve prepared a $${validPayment.data.amount.toFixed(2)} payment to ${validPayment.data.recipient}. Review the details below. No money will move unless you explicitly approve checkout.`,
      mode: 'payment-prepared',
      preparedPayment: { id: Number(result.lastInsertRowid), ...validPayment.data, currency: 'USD', status: 'prepared' },
    })
  }

  const systemPrompt = `You are PayPilot, a careful personal finance assistant. Use only the authenticated user's data in the JSON context. Never invent transactions, balances, or trends. If asked something the data cannot answer, say so. Explain calculations briefly, use USD, and do not claim a payment was made. You may discuss a payment draft, but users must approve it separately. User context: ${context}`
  try {
    if (process.env.OPENAI_API_KEY) {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }], temperature: 0.2 }),
      })
      if (!response.ok) throw new Error(`OpenAI request failed (${response.status}).`)
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      const answer = body.choices?.[0]?.message?.content?.trim()
      if (!answer) throw new Error('AI provider returned an empty response.')
      return res.json({ answer, mode: 'ai' })
    }
    if (process.env.GEMINI_API_KEY) {
      const model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents: [{ parts: [{ text: message }] }] }),
      })
      if (!response.ok) throw new Error(`Gemini request failed (${response.status}).`)
      const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      const answer = body.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('').trim()
      if (!answer) throw new Error('AI provider returned an empty response.')
      return res.json({ answer, mode: 'ai' })
    }
    const topCategory = db.prepare(`
      SELECT category, SUM(amount) AS amount FROM transactions
      WHERE user_id = ? AND type = 'expense' AND strftime('%Y-%m', occurred_at) = strftime('%Y-%m', 'now')
      GROUP BY category ORDER BY amount DESC LIMIT 1
    `).get(id) as { category: string; amount: number } | undefined
    const answer = message.toLowerCase().includes('spend') && topCategory
      ? `Your recorded spending this month is $${currentExpenses.toFixed(2)}. Your highest-spend category is ${topCategory.category} at $${topCategory.amount.toFixed(2)}. Connect an AI provider in the server environment for natural-language analysis.`
      : `I can use your recorded financial data, but a model provider is not configured yet. This month you have $${currentIncome.toFixed(2)} income and $${currentExpenses.toFixed(2)} in expenses. Add OPENAI_API_KEY or GEMINI_API_KEY to enable full AI responses.`
    return res.json({ answer, mode: 'data-summary' })
  } catch (error) {
    console.error('Assistant provider error:', error)
    return res.status(502).json({ error: 'The AI provider could not answer right now. Your financial data was not changed.' })
  }
})

app.get('/api/reports/export.csv', (req, res) => {
  const rows = db.prepare('SELECT description, category, type, amount, occurred_at, source FROM transactions WHERE user_id = ? ORDER BY occurred_at DESC').all(userId(req)) as Array<Record<string, string | number>>
  const escape = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`
  const csv = ['Description,Category,Type,Amount,Date,Source', ...rows.map(row => [row.description, row.category, row.type, row.amount, row.occurred_at, row.source].map(escape).join(','))].join('\r\n')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="paypilot-transactions.csv"')
  return res.send(csv)
})

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled API error:', error)
  return res.status(500).json({ error: 'Something went wrong. Please try again.' })
})

app.listen(port, () => console.log(`PayPilot API listening on http://localhost:${port}`))
