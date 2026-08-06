# Deployment

Production runs on a single EC2 instance via Docker Compose
(`docker-compose.prod.yml`, bootstrap script in `deploy/production/`).

SSH in with:

```bash
ssh -i "bakaloo.pem" ubuntu@ec2-13-127-132-74.ap-south-1.compute.amazonaws.com
```

`bakaloo.pem` lives at the root of the `Bakaloo X Shotlin` workspace
(sibling to this repo), not inside `bakaloo-backend` itself.

Typical deploy: SSH in, pull `main`, `docker compose -f docker-compose.prod.yml up --build -d`.
Migrations run via `npm run db:migrate` (either inside the app container or
directly on the host, whichever the running compose setup expects).

Per this project's working agreement: only `bakaloo-backend` gets pushed to
its GitHub remote automatically; other repos in the workspace are pushed by
the user. Deploys and DB migrations against production are only run when
explicitly requested in the conversation, not proactively.
