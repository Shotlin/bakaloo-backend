# Grocery App — Fastify Backend

## Prerequisites

- Node.js >= 18
- Docker & Docker Compose (for PostgreSQL + Redis)

## Quick Start

```bash
npm install
npm run infra:up
npm run db:migrate
npm run db:seed
npm run dev
```

Server starts at **http://localhost:3000**

If you have not created an env file yet:

```bash
cp .env.example .env
```

Use `npm run setup:local` to run infra + migrate + seed in one command.

- Health check: `GET /health`
- Swagger docs: `GET /documentation`

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start with nodemon (auto-reload) |
| `npm start` | Start production server |
| `npm run start:pm2` | Start with PM2 cluster mode |
| `npm run db:migrate` | Run SQL migrations |
| `npm run db:seed` | Seed sample data |
| `npm test` | Run tests (vitest) |
| `npm run lint` | ESLint check |
| `npm run format` | Prettier format |

## Architecture

```
Route → preHandler (auth/role) → JSON Schema Validation → Controller → Service → Repository → PostgreSQL
                                                                         ↕
                                                                     Redis Cache
```

See `Backend system design/ARCHITECTURE.md` for full details.
