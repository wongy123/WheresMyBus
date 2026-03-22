# Where's My Bus — Deployment Guide

## Architecture

```
Internet
   │
   ▼
<YOUR_DOMAIN>  (reverse proxy)
   ├── /wheresmybus          → client:80   (nginx → Flask/gunicorn)
   └── /wheresmybus-api/     → api:3000    (Node.js/Express, strips prefix)
                                  └── redis:6379
```

This guide uses Proxmox LXCs, but any Linux VM or container setup works. Adjust IPs and service management commands to match your environment.

### Service summary

| Service    | Role             | Suggested RAM |
|------------|------------------|---------------|
| Redis      | RT data cache    | 256 MB        |
| API        | Node.js/Express  | 512 MB        |
| Client     | Flask/gunicorn   | 256 MB        |
| Proxy      | Nginx Proxy Mgr  | —             |

---

## 1. Redis

Install Redis 7 on a Linux host. Bind it to loopback and the host's LAN IP rather than `0.0.0.0`:

```
bind 127.0.0.1 <REDIS_HOST_IP>
```

Optionally add a password:

```
requirepass <REDIS_PASSWORD>
```

Restart and enable Redis, then test from the API host:

```bash
redis-cli -h <REDIS_HOST_IP> ping   # → PONG
```

---

## 2. API

### Install Node.js 24 LTS

```bash
apt update && apt install -y curl ca-certificates git
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
```

### Install PM2

```bash
npm install -g pm2
```

### Deploy

```bash
git clone -b main https://github.com/wongy123/WheresMyBus /opt/wheresmybus
cd /opt/wheresmybus/server
npm install
```

### GTFS static data

Import GTFS data before starting the API:

```bash
cd /opt/wheresmybus/server
node --input-type=module --eval "
import { importGtfs } from 'gtfs';
import config from './config.json' with { type: 'json' };
await importGtfs(config);
console.log('GTFS import complete');
"
```

Then create the custom SQLite views the timetable queries depend on:

```bash
node sqlite/db.js
```

Both steps only need to be re-run when the GTFS feed is updated.

### Environment file

```bash
cat > /opt/wheresmybus/server/.env <<'EOF'
# Redis
REDIS_URL=redis://<REDIS_HOST_IP>:6379

# GTFS-RT feeds (Translink SEQ)
GTFS_RT_TRIP_UPDATES_URL=https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates
GTFS_RT_VEHICLE_POSITIONS_URL=https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions

# Server
PORT=3000
EOF
```

### Start with PM2

```bash
cd /opt/wheresmybus/server
pm2 start server.js --name wheresmybus-api
pm2 save
pm2 startup   # follow the printed command to enable on boot
```

Test: `curl http://<API_HOST_IP>:3000/api/stops/search?q=central`

---

## 3. Client

```bash
apt update && apt install -y ca-certificates git nginx python3 python3-venv
```

### Clone and install dependencies

```bash
git clone -b main https://github.com/wongy123/WheresMyBus /opt/wheresmybus
cd /opt/wheresmybus/client
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt gunicorn
```

### Environment file

```bash
cat > /opt/wheresmybus/client/.env <<'EOF'
API_BASE_URL=http://<API_HOST_IP>:3000/api
BASE_PATH=/wheresmybus
FLASK_SECRET_KEY=<long-random-string>
EOF
```

### systemd service

```bash
cat > /etc/systemd/system/wheresmybus-client.service <<'EOF'
[Unit]
Description=Where's My Bus Flask client
After=network.target

[Service]
WorkingDirectory=/opt/wheresmybus/client
EnvironmentFile=/opt/wheresmybus/client/.env
ExecStart=/opt/wheresmybus/client/.venv/bin/gunicorn \
    --workers 2 \
    --bind 127.0.0.1:5000 \
    "app:create_app()"
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now wheresmybus-client
```

Test: `curl http://127.0.0.1:5000/wheresmybus/` should return HTML.

### nginx configuration

```bash
cat > /etc/nginx/sites-available/wheresmybus <<'EOF'
server {
    listen 80;

    location /wheresmybus {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

ln -s /etc/nginx/sites-available/wheresmybus /etc/nginx/sites-enabled/
rm /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

---

## 4. Reverse proxy (Nginx Proxy Manager)

In NPM, add two custom locations to your proxy host for `<YOUR_DOMAIN>`:

### Location 1 — Flask frontend

| Field | Value |
|---|---|
| Location | `/wheresmybus` |
| Scheme | `http` |
| Forward Hostname/IP | `<CLIENT_HOST_IP>` |
| Forward Port | `80` |

### Location 2 — Node.js API

| Field | Value |
|---|---|
| Location | `/wheresmybus-api/` |
| Scheme | `http` |
| Forward Hostname/IP | `<API_HOST_IP>` |
| Forward Port | `3000` |

Add this in the **Advanced** nginx config block for the API location:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

Express is mounted at both `/api` (local dev) and `/wheresmybus-api/api` (production), so no path rewriting is needed.

---

## 5. Deploying at the root path (optional)

By default the app is served under `/wheresmybus` and `/wheresmybus-api/`. If you want it at the root of your domain instead, three things need to change.

**Client environment file** — clear `BASE_PATH` and point `API_BASE_URL` at `/api`:

```
API_BASE_URL=https://<YOUR_DOMAIN>/api
BASE_PATH=
```

**nginx on the client host** — change the location block from `/wheresmybus` to `/`:

```nginx
location / {
    proxy_pass http://127.0.0.1:5000;
    ...
}
```

**Nginx Proxy Manager** — update both custom locations:

| Location (before) | Location (after) |
|---|---|
| `/wheresmybus` | `/` |
| `/wheresmybus-api/` | `/api/` |

The API already responds at `/api/...` natively, so no other changes are needed.

---

## 6. Redeployment

When you update the API:

```bash
cd /opt/wheresmybus
git pull origin main
cd server && npm install   # if dependencies changed
pm2 restart wheresmybus-api
```

When you update the client:

```bash
cd /opt/wheresmybus
git pull origin main
client/.venv/bin/pip install -r client/requirements.txt  # if deps changed
systemctl restart wheresmybus-client
```
