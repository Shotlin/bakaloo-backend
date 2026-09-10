# Deployment

Production runs bare-metal on a single Ubuntu server — **not Docker**.
`docker` isn't even installed on the host. The app is managed by `pm2`,
with PostgreSQL, Redis, and nginx installed natively.

Cut over to this server on 2026-09-10 (migrated from a prior EC2 host —
see "Old server (deprecated)" below; this file previously described a
Docker Compose setup that was never actually deployed — see "Stale
assets" further down).

SSH in with:

```bash
ssh root@200.234.44.216
```

No `-i` flag needed for a specific key file — auth is via
`~/.ssh/id_ed25519`, which is **passphrase-protected**. If the agent
doesn't already have it loaded, run `ssh-add ~/.ssh/id_ed25519` first
(interactive — needs the passphrase typed at a real terminal; do not
attempt to script or pipe the passphrase). Check `ssh-add -l` to see if
it's already loaded before assuming you need to re-add it.

Everything on this host runs as **`root`** — there is no separate
`ubuntu`/app user like the old server had.

## Architecture on the host

- App code: `/var/www/bakaloo-backend` (git checkout of this repo,
  `main`, public repo `https://github.com/Shotlin/bakaloo-backend`).
- Process manager: `pm2`, running two apps against `src/server.js` /
  `src/worker.js`:
  - `bakaloo-api` — cluster mode, 2 instances, listens on `PORT` from
    `.env` (currently `4500`).
  - `bakaloo-worker` — fork mode, 1 instance (background jobs — cart
    milestones, delivery calendar, payment expiry, etc.).
  - **Note:** several scheduled jobs (campaign sends, wallet/Razorpay
    reconciliation) run as `setInterval` polling loops *inside the
    `bakaloo-api` process itself*, not only in `bakaloo-worker`. Keep
    this in mind if you're ever running two live copies of this app
    against separate databases at once (e.g. during a future migration)
    — both copies will independently fire these jobs, which can mean
    duplicate customer-facing actions (duplicate push notifications,
    etc.). The row-locking (`SELECT ... FOR UPDATE SKIP LOCKED`) these
    jobs use only protects against duplicates *within one database*, not
    across two separate ones.
- PostgreSQL 18 — native install, listening on `127.0.0.1:5432`. DB
  `grocery_db`, role `grocery_user`.
- Redis 8 — native install, listening on `127.0.0.1:6379`, **no auth
  configured** (`REDIS_PASSWORD` is intentionally blank in `.env` —
  local-only + firewalled, matches the old server's setup).
- nginx — native install, terminates TLS (Let's Encrypt via `certbot`,
  `/etc/letsencrypt/live/api.bakaloo.in`) and reverse-proxies
  `api.bakaloo.in` (ports 80/443) to `127.0.0.1:4500`. Config:
  `/etc/nginx/sites-available/api.bakaloo.in.conf`. Cert auto-renews via
  certbot's systemd timer.
- `ufw` firewall: only 22, 80, 443 open.
- Boot persistence: `pm2 startup systemd` is configured, and `pm2 save`
  has been run. If you ever change which processes run under pm2
  (names, instance count, script paths), run `pm2 save` afterward or the
  change won't survive a reboot.
- Env config: `/var/www/bakaloo-backend/.env` (plain dotenv file on the
  host, not rendered from AWS SSM). Values are identical to what was on
  the old server — DB/Redis host/port values were already `127.0.0.1`,
  so nothing needed changing when this file was copied over.
- DNS: `api.bakaloo.in` is a Cloudflare-proxied (orange-cloud) A record
  pointing at this host's IP (`200.234.44.216`). **Changing that DNS
  record is a live production cutover, not a soft/gradual switch** —
  Cloudflare proxies it immediately once saved, regardless of any
  "slowly" intention. Before that record is ever repointed again (e.g.
  to a future new host), the target host's app must already be running
  *and* already have its SSL certificate issued — this exact sequencing
  mistake caused a real outage (522 errors) during the 2026-09-10
  migration, because DNS was switched before the new host was ready.

## Routine deploy (code + migration, no infra changes)

```bash
ssh root@200.234.44.216

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

## Old server (deprecated — do not deploy here anymore)

```bash
ssh -i "bakaloo.pem" ubuntu@ec2-13-127-132-74.ap-south-1.compute.amazonaws.com
```

This EC2 host was production until 2026-09-10. Its full database and app
code were migrated to the new server above (verified byte-for-byte
identical at migration time — every table's actual content checksummed,
not just row counts). DNS now points to the new server exclusively.

The user is keeping this old server **running, on purpose, as a manual
fallback** for now — do not stop, modify, or deploy to it unless
explicitly asked. The user will terminate it manually when ready; that
is their action to take, not something to do proactively. Be aware it is
still running its own copy of the same background jobs described above
(campaign sends, Razorpay reconciliation) against its own now-stale
database — if the new server is ever unavailable, don't fail over to
this one without first considering that both would then be running those
jobs against divergent data.

`bakaloo.pem` lives at the root of the `Bakaloo X Shotlin` workspace
(sibling to this repo), not inside `bakaloo-backend` itself.

## Stale assets (do not use)

- `docker-compose.prod.yml` and everything under `deploy/production/`
  (`deploy.sh`, `bootstrap-ec2.sh`, `smoke-test.sh`, `verify-db.sh`,
  `load-ssm-env.sh`, `cloudflared/`, `bakaloo-compose.service`, etc.)
  describe a Docker + Cloudflare Tunnel deployment that was designed but
  never actually put into production. Neither the old nor the new host
  has Docker or `cloudflared` — don't run these scripts against the live
  server; they assume containers and an SSM-rendered env file that don't
  exist there.
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
the conversation, not proactively. Any action against production
infrastructure that's hard to reverse or affects live customer-facing
behavior (stopping the app, DNS changes, SSL/certificate issuance,
firewall changes) should be confirmed with the user first, even if the
underlying task was already approved in general terms.
