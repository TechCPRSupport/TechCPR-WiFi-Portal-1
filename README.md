# TechCPR WiFi Portal RC3

A Stripe-powered WiFi purchase portal that stores purchases in SQLite and provisions MikroTik HotSpot users.

## Core flow

Customer selects a plan → Stripe Checkout → verified webhook → SQLite record → MikroTik HotSpot user → session-specific success page.

## Pages

- `/plans.html` – customer purchase page
- `/success.html` – payment completion and credentials
- `/status.html` – service health
- `/admin.html` – protected customer administration

## Start

```powershell
npm install
npm start
```

For local Stripe webhook testing:

```powershell
stripe listen --forward-to localhost:3000/webhook
```
