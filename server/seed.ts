import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { db } from './db.js'

const email = 'demo@paypilot.ai'
const password = 'PayPilotDemo2026!'
const found = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number } | undefined
const userId = found?.id ?? Number(db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run('Alex Morgan', email, await bcrypt.hash(password, 12)).lastInsertRowid)

if (!found) {
  const addTransaction = db.prepare('INSERT INTO transactions (user_id, description, category, type, amount, occurred_at) VALUES (?, ?, ?, ?, ?, ?)')
  const daysAgo = (days: number, hour: number) => {
    const date = new Date()
    date.setDate(date.getDate() - days)
    date.setHours(hour, 0, 0, 0)
    return date.toISOString().slice(0, 19).replace('T', ' ')
  }
  const previousMonth = new Date()
  previousMonth.setMonth(previousMonth.getMonth() - 1, 12)
  previousMonth.setHours(10, 0, 0, 0)
  const previousMonthDate = previousMonth.toISOString().slice(0, 19).replace('T', ' ')
  const sample = [
    ['Freelance project', 'Income', 'income', 3200, daysAgo(5, 10)],
    ['Apartment rent', 'Housing', 'expense', 1250, daysAgo(7, 9)],
    ['Client retainer', 'Income', 'income', 850, daysAgo(8, 11)],
    ['Weekly groceries', 'Groceries', 'expense', 96.4, daysAgo(2, 17)],
    ['Design software', 'Subscriptions', 'expense', 32, daysAgo(3, 8)],
    ['Coffee & lunch', 'Dining', 'expense', 28.5, daysAgo(1, 13)],
    ['Train pass', 'Transport', 'expense', 74, daysAgo(6, 8)],
    ['Electric bill', 'Utilities', 'expense', 88.25, daysAgo(4, 15)],
    ['Groceries', 'Groceries', 'expense', 61.2, previousMonthDate],
    ['Freelance project', 'Income', 'income', 2950, daysAgo(39, 10)],
    ['Apartment rent', 'Housing', 'expense', 1250, daysAgo(38, 9)],
  ] as const
  const seedTransactions = db.transaction(() => {
    for (const [description, category, type, amount, date] of sample) addTransaction.run(userId, description, category, type, amount, date)
    const month = new Date().toISOString().slice(0, 7)
    db.prepare('INSERT INTO budgets (user_id, category, amount, month) VALUES (?, ?, ?, ?)').run(userId, 'Groceries', 400, month)
    db.prepare('INSERT INTO budgets (user_id, category, amount, month) VALUES (?, ?, ?, ?)').run(userId, 'Dining', 250, month)
    db.prepare('INSERT INTO budgets (user_id, category, amount, month) VALUES (?, ?, ?, ?)').run(userId, 'Transport', 180, month)
    db.prepare('INSERT INTO savings_goals (user_id, name, target, saved, target_date) VALUES (?, ?, ?, ?, ?)').run(userId, 'Emergency fund', 5000, 2150, '2027-06-30')
    db.prepare('INSERT INTO savings_goals (user_id, name, target, saved, target_date) VALUES (?, ?, ?, ?, ?)').run(userId, 'New laptop', 1800, 720, '2027-03-01')
  })
  seedTransactions()
  console.log('Demo data created.')
}

console.log(`Demo login: ${email} / ${password}`)
