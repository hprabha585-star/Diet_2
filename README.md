# Fasting Coach — Professional Coach-Led Fasting & Accountability Platform

A production-oriented starter monorepo for a 55-day coach-led fasting, diet and accountability application.

## Stack
- Frontend: React + Vite + TypeScript + Tailwind CSS
- Backend: Node.js + Express + TypeScript
- Database: MongoDB / MongoDB Atlas
- Auth: JWT + bcrypt
- Deployment target: Render
- Payments: manual UPI proof + UTR workflow (no gateway dependency)

## Important
This starter intentionally does **not** provide medical diagnosis, unsafe fasting recommendations, or automated clinical decisions. Admin-assigned plans should be reviewed by appropriately qualified professionals when the program is presented as clinical care.

## Project structure
```
fasting-coach-app/
  client/
  server/
  render.yaml
  README.md
```

## Local development

### 1. Server
```
cd server
npm install
cp .env.example .env
npm run dev
```

### 2. Client
```
cd client
npm install
npm run dev
```

Set `VITE_API_URL=http://localhost:5000/api` in `client/.env`.

## MongoDB
Use MongoDB Atlas free tier. Create a database user and IP/network rule, then put the connection string in:
`server/.env` as `MONGODB_URI`.

## Render
The included `render.yaml` defines:
- `fasting-coach-api` as a Node web service
- `fasting-coach-web` as a static site

Set these environment variables in Render:
- Server: `MONGODB_URI`, `JWT_SECRET`, `CLIENT_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`
- Client: `VITE_API_URL`

## Core implemented flows
- Admin/client RBAC
- JWT authentication
- 55-day challenge activation
- Manual payment proof + UTR submission and admin approval
- Admin client monitoring
- Admin routine assignment
- Fasting state calculation
- Daily checklist and water logging
- Streak / points
- Leaderboard
- Referral wallet + payout request
- Weight history
- Responsive professional dashboard UI

## Suggested production hardening
- Put uploaded payment proofs in object storage rather than local disk.
- Add rate limiting, audit logs, refresh-token rotation and stronger password policies.
- Add signed upload URLs and virus/content validation.
- Add notification infrastructure.
- Add automated tests and CI.
- Review legal/privacy/health compliance for the launch jurisdiction.
