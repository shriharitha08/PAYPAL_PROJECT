# PayPilot AI

PayPilot AI is a personal-finance command center for tracking transactions, setting budgets and savings goals, understanding spending, and preparing user-approved PayPal payments. It is designed to be useful without external credentials: the app has a data-grounded assistant fallback and clearly identifies when PayPal Sandbox is not configured.

## Architecture

- **Frontend:** React 18, TypeScript, Vite, Recharts, Lucide React, and responsive CSS.
- **Backend:** Express, TypeScript, Zod request validation, and JWT authentication.
- **Database:** SQLite via `better-sqlite3`; the database is created on first server start and retains its data across restarts.
- **AI:** Optional server-side OpenAI or Gemini provider. Prompts are grounded in the signed-in user's transaction, budget, and savings-goal records.
- **Payments:** Optional PayPal JavaScript SDK and official PayPal Orders v2 Sandbox API. PayPal secrets are only used by the backend.

The Vite development server proxies `/api` requests to the API server on port 3001. Financial API routes require a valid bearer token. Database queries are scoped to the authenticated user.

## Requirements

- Node.js 20 or newer
- npm
- PayPal Sandbox and AI credentials are optional; add them only to enable their corresponding integrations.

## Installation

```powershell
npm install
Copy-Item .env.example .env
```

Set a long, unique `JWT_SECRET` in `.env` before starting the API. Keep `.env` private; it is excluded from Git. Do not put AI or PayPal secrets in `VITE_*` variables or frontend code.

## Environment configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | API port (default `3001`) |
| `JWT_SECRET` | Yes | Signs authentication tokens; use a long random secret |
| `DATABASE_PATH` | No | SQLite file path (default `./data/paypilot.db`) |
| `CLIENT_ORIGIN` | No | Allowed browser origin (default `http://localhost:5173`) |
| `OPENAI_API_KEY` | No | Enables OpenAI assistant responses |
| `OPENAI_MODEL` | No | OpenAI model (default `gpt-4o-mini`) |
| `GEMINI_API_KEY` | No | Enables Gemini responses when no OpenAI key is set |
| `GEMINI_MODEL` | No | Gemini model (default `gemini-2.0-flash`) |
| `PAYPAL_CLIENT_ID` | No | PayPal Sandbox app client ID; also used to load the browser SDK |
| `PAYPAL_CLIENT_SECRET` | No | PayPal Sandbox app secret; backend only |
| `PAYPAL_BASE_URL` | No | PayPal API URL (default `https://api-m.sandbox.paypal.com`) |

When neither AI key is configured, the assistant can still report totals from actual saved data and tells the user that provider-backed natural-language analysis is unavailable. When PayPal credentials are absent, payment drafts are available for review but checkout is disabled; the application does not claim that a payment was made.

## Database setup

The server creates the SQLite database and tables automatically on first start. The default database is `data/paypilot.db`. Keep this file and its backups private: it contains personal financial records. To create or print the demo login:

```powershell
npm run seed
```

Seeding is idempotent and only creates the sample data when the demo account does not already exist. Existing database records are not overwritten.

## AI setup

Add **either** `OPENAI_API_KEY` or `GEMINI_API_KEY` to the server's `.env`, then restart the development server. OpenAI is preferred if both keys are present. The assistant receives only the signed-in user's recent transactions, budgets, goals, and current-month totals. It can prepare an explicit payment draft, but cannot approve or capture it.

## PayPal Sandbox setup

1. Create a Sandbox REST app in the PayPal Developer Dashboard.
2. Set its Sandbox client ID as `PAYPAL_CLIENT_ID` and its Sandbox secret as `PAYPAL_CLIENT_SECRET` in `.env`.
3. Keep `PAYPAL_BASE_URL` set to `https://api-m.sandbox.paypal.com`.
4. Restart the app and confirm that the Payments or Settings page reports **Sandbox connected**.
5. Use a PayPal Sandbox personal test account to approve checkout.

The frontend loads the official PayPal JavaScript SDK with the public Sandbox client ID. The backend obtains OAuth tokens, creates CAPTURE orders, and captures them after the user approves checkout. A transaction is recorded only when the server verifies both the order and capture status are `COMPLETED` and a capture ID is present. If API credentials are unavailable, checkout is explicitly unavailable rather than simulated.

## Running locally

In the project directory:

```powershell
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). To load the prepared demo account and sample financial data, run `npm run seed` in a separate terminal first.

For a production bundle and API build:

```powershell
npm run build
```

The current `start` script starts the compiled API server. Serve the built `dist` frontend with a static web server configured to route API requests to the API process. Configure `CLIENT_ORIGIN` to match the deployed frontend origin.

## Demo account

Run `npm run seed` to create the account if it does not exist:

- **Email:** `demo@paypilot.ai`
- **Password:** `PayPilotDemo2026!`

The demo data includes income and expense transactions, recent transaction history, three monthly budgets, and two savings goals. These records are sample data for demonstration, not linked to a bank or live account. Change demo credentials before exposing a deployment to anyone else.

## Hackathon demonstration workflow

1. Sign in with the demo account and review the data-driven overview, category chart, cash-flow trend, budgets, and transactions.
2. Open **Analytics & reports** to explore the transaction-backed summaries and download a CSV.
3. Ask the assistant where the user spends most or request a payment draft such as “Prepare a payment of $25 to my supplier.”
4. Review the recipient and amount in the payment confirmation card. No checkout occurs until the user explicitly approves.
5. With Sandbox credentials configured, approve the official PayPal Sandbox checkout. The verified capture is then saved and refreshes the dashboard. Without credentials, demonstrate the clearly labelled unconfigured state; no payment is simulated or falsely shown as completed.
6. Create a budget and savings goal, then show the updated records and mobile-responsive layout.

## Current scope

This project tracks user-entered transactions and payment captures; it does not connect to banks, import account statements, or automate savings transfers. Savings-goal progress is manually tracked. AI provider replies are generated from the user's saved data, and the no-key fallback is limited to factual summaries from that data.
