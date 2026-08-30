# Deployment

Production runs bare-metal on a single EC2 instance — **not Docker**.
`docker` isn't even installed on the host. The app is managed by `pm2`,
with PostgreSQL, Redis, and nginx installed natively.

Verified live on 2026-08-30 (this file previously described a Docker
Compose setup that was never actually deployed — see "Stale assets"
below).

SSH in with:

```bash
ssh -i "bakaloo.pem" ubuntu@ec2-13-127-132-74.ap-south-1.compute.amazonaws.com
```

`bakaloo.pem` lives at the root of the `Bakaloo X Shotlin` workspace
(sibling to this repo), not inside `bakaloo-backend` itself.

## Architecture on the host

- App code: `/var/www/bakaloo-backend` (git checkout of this repo, `main`).
- Process manager: `pm2`, running two apps against `src/server.js` /
  `src/worker.js`:
  - `bakaloo-api` — cluster mode, 2 instances, listens on `PORT` from
    `.env` (currently `4500`).
  - `bakaloo-worker` — fork mode, 1 instance (background jobs — cart
    milestones, delivery calendar, payment expiry, etc.).
- PostgreSQL — native install, listening on `127.0.0.1:5432`.
- Redis — native install, listening on `127.0.0.1:6379`.
- nginx — native install, terminates TLS (Let's Encrypt via `certbot`,
  `/etc/letsencrypt/live/api.bakaloo.in`) and reverse-proxies
  `api.bakaloo.in` (ports 80/443) to `127.0.0.1:4500`. Config:
  `/etc/nginx/sites-available/api.bakaloo.in.conf`.
- Boot persistence: `pm2-ubuntu.service` (systemd, enabled) runs `pm2
  resurrect` on boot, reviving whatever was last saved to
  `~/.pm2/dump.pm2` via `pm2 save`. If you ever change which processes
  run under pm2 (names, instance count, script paths), run `pm2 save`
  afterward or the change won't survive a reboot.
- Env config: `/var/www/bakaloo-backend/.env` (plain dotenv file on the
  host, not rendered from AWS SSM).

## Routine deploy (code + migration, no infra changes)

```bash
ssh -i "bakaloo.pem" ubuntu@ec2-13-127-132-74.ap-south-1.compute.amazonaws.com

cd /var/www/bakaloo-backend
git pull origin main

# Only if package.json/package-lock.json changed:
npm install

# Always safe to run — no-ops on migrations already applied:
npm run db:migrate

# Zero-downtime reload of the API cluster; worker gets a plain restart
# since it doesn't serve HTTP traffic:
pm2 reload bakaloo-api
pm2 restart bakaloo-worker
```

Verify:

```bash
curl -fsS http://127.0.0.1:4500/health/ready
pm2 status
pm2 logs bakaloo-api --lines 30 --nostream
```

`/health/ready` should report `postgres` and `redis` both `up`. Check the
`pm2 logs` tail for startup errors before considering the deploy done.

## Stale assets (do not use)

- `docker-compose.prod.yml` and everything under `deploy/production/`
  (`deploy.sh`, `bootstrap-ec2.sh`, `smoke-test.sh`, `verify-db.sh`,
  `load-ssm-env.sh`, `cloudflared/`, `bakaloo-compose.service`, etc.)
  describe a Docker + Cloudflare Tunnel deployment that was designed but
  never actually put into production. The real host has no Docker and no
  `cloudflared` — don't run these scripts against the live server; they
  assume containers and an SSM-rendered env file that don't exist there.
- The checked-in `ecosystem.config.js` (app name `grocery-api`, single
  instance, `PORT: 3000`) is also out of sync with what's actually
  running (`bakaloo-api` + `bakaloo-worker`, port from `.env`, per
  `~/.pm2/dump.pm2` on the host). Don't `pm2 start ecosystem.config.js`
  on the live host — it would start a second, conflicting app instead of
  managing the real one. Use `pm2 reload <name>` / `pm2 restart <name>`
  against the already-running processes instead.

If you want the Docker path to become real, or want `ecosystem.config.js`
reconciled with the live pm2 config, that's a separate task — don't
assume either mid-deploy.

## Working agreement

Only `bakaloo-backend` gets pushed to its GitHub remote automatically;
other repos in the workspace are pushed by the user. Deploys and DB
migrations against production are only run when explicitly requested in
the conversation, not proactively.
