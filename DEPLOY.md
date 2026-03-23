# Where's My Bus — Deployment Guide

## Architecture

```
Internet
   │
   ▼
<YOUR_DOMAIN>  (reverse proxy)
   ├── /             → client:80   (nginx → Flask/gunicorn)
   └── /api/         → api:3000    (Node.js/Express)
                          └── redis:6379
```

By default the app serves at the root (`/`) and the API at `/api/`. If you want to host it under a subpath (e.g. `/wheresmybus`), set these in the client `.env` and update your reverse proxy locations accordingly.

**Client `.env`**:

```
API_BASE_URL=https://<YOUR_DOMAIN>/wheresmybus-api/api
BASE_PATH=/wheresmybus
```

**nginx on the client host** — change `location /` to `location /wheresmybus`.

**Reverse proxy** — use `/wheresmybus` and `/wheresmybus-api/` as the locations instead of `/` and `/api/`.

---

## Option A: Docker Compose

All three services (Redis, API, Flask client) run in containers. A single `docker compose up` starts everything.

### Prerequisites

- Docker with Compose plugin
- A reverse proxy (Nginx Proxy Manager, Caddy, etc.)

### 1. Clone

```bash
git clone -b main https://github.com/wongy123/WheresMyBus /opt/wheresmybus
cd /opt/wheresmybus
```

### 2. Environment files

API (`server/.env`):

```bash
cat > server/.env <<'EOF'
# GTFS-RT feeds (Translink SEQ)
GTFS_RT_TRIP_UPDATES_URL=https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates
GTFS_RT_VEHICLE_POSITIONS_URL=https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions

PORT=3000
EOF
```

Client (`client/.env`):

```bash
cat > client/.env <<'EOF'
API_BASE_URL=http://<HOST_IP>:3000/api
API_BASE_URL_PUBLIC=https://<YOUR_DOMAIN>/api
BASE_PATH=
FLASK_SECRET_KEY=<long-random-string>
EOF
```

- `API_BASE_URL` — used server-side (Flask → API). Can be the internal IP/port.
- `API_BASE_URL_PUBLIC` — used by the **browser** for map fetches. Must be the public HTTPS URL the browser can reach. If unset, falls back to `API_BASE_URL`, which will fail if that's an internal address.

### 3. Build and start

GTFS static data is imported during the API image build, so the first build takes a few minutes.

```bash
docker compose up -d --build
```

Test:
- `curl http://localhost:3000/api/stops/search?q=central` — API
- `curl http://localhost:5000/` — client

### 4. Reverse proxy

Point your reverse proxy at:

| Location | Forward to |
|---|---|
| `/` | `<HOST_IP>:5000` |
| `/api/` | `<HOST_IP>:3000` |

For the API location, add these headers:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

### 5. Redeployment

```bash
cd /opt/wheresmybus
git pull origin main
docker compose up -d --build
```

To update GTFS static data without a code change: `docker compose build --no-cache api && docker compose up -d`.

---

## Option B: Proxmox LXCs

Services run in separate LXCs on a shared bridge network.

### LXC summary

| LXC        | Role            | Suggested RAM | Suggested Disk |
|------------|-----------------|---------------|----------------|
| redis-lxc  | Redis 7         | 256 MB        | 2 GB           |
| api-lxc    | Node.js / PM2   | 512 MB        | 4 GB           |
| client-lxc | Flask / gunicorn| 256 MB        | 2 GB           |
| npm-lxc    | Nginx Proxy Mgr | —             | —              |

### 1. Create LXCs

Use [Proxmox Community Scripts](https://community-scripts.github.io/ProxmoxVE/) from the Proxmox host shell:

```bash
# Redis (Alpine + OpenRC)
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/redis.sh)"

# API and Client (Debian + systemd)
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/debian.sh)"
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/debian.sh)"
```

Note the IP address assigned to each LXC — you'll need them below.

### 2. Redis LXC

The community script installs Redis on Alpine with OpenRC. Edit `/etc/redis.conf` and replace the default `bind 0.0.0.0` with explicit addresses:

```
bind 127.0.0.1 <REDIS_LXC_IP>
```

Optionally add a password:

```
requirepass <REDIS_PASSWORD>
```

Restart:

```bash
rc-service redis restart
rc-update add redis default
```

Test from the API LXC: `redis-cli -h <REDIS_LXC_IP> ping` → `PONG`

### 3. API LXC

Install Node.js 24 and PM2:

```bash
apt update && apt install -y curl ca-certificates git
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
npm install -g pm2
```

Clone and install:

```bash
git clone -b main https://github.com/wongy123/WheresMyBus /opt/wheresmybus
cd /opt/wheresmybus/server
npm install
```

Import GTFS static data (takes a few minutes; only needed again when the feed is updated):

```bash
cd /opt/wheresmybus/server
npm run import
npm run buildviews
```

Environment file:

```bash
cat > /opt/wheresmybus/server/.env <<'EOF'
REDIS_URL=redis://<REDIS_LXC_IP>:6379

GTFS_RT_TRIP_UPDATES_URL=https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates
GTFS_RT_VEHICLE_POSITIONS_URL=https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions

PORT=3000
EOF
```

Start with PM2:

```bash
cd /opt/wheresmybus/server
pm2 start server.js --name wheresmybus-api
pm2 save
pm2 startup   # follow the printed command to enable on boot
```

Test: `curl http://<API_LXC_IP>:3000/api/stops/search?q=central`

### 4. Client LXC

```bash
apt update && apt install -y ca-certificates git nginx python3 python3-venv
git clone -b main https://github.com/wongy123/WheresMyBus /opt/wheresmybus
cd /opt/wheresmybus/client
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt gunicorn
```

Environment file:

```bash
cat > /opt/wheresmybus/client/.env <<'EOF'
API_BASE_URL=http://<API_LXC_IP>:3000/api
API_BASE_URL_PUBLIC=https://<YOUR_DOMAIN>/api
BASE_PATH=
FLASK_SECRET_KEY=<long-random-string>
EOF
```

systemd service:

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

nginx:

```bash
cat > /etc/nginx/sites-available/wheresmybus <<'EOF'
server {
    listen 80;

    location / {
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

Test: `curl http://<CLIENT_LXC_IP>/` should return HTML.

### 5. Nginx Proxy Manager

Add two custom locations to your proxy host for `<YOUR_DOMAIN>`:

**Location 1 — Flask frontend**

| Field | Value |
|---|---|
| Location | `/` |
| Scheme | `http` |
| Forward Hostname/IP | `<CLIENT_LXC_IP>` |
| Forward Port | `80` |

**Location 2 — Node.js API**

| Field | Value |
|---|---|
| Location | `/api/` |
| Scheme | `http` |
| Forward Hostname/IP | `<API_LXC_IP>` |
| Forward Port | `3000` |

Add in the **Advanced** nginx config for the API location:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

### 6. Redeployment

```bash
# API LXC
cd /opt/wheresmybus
git pull origin main
cd server && npm install   # if dependencies changed
pm2 restart wheresmybus-api

# Client LXC
cd /opt/wheresmybus
git pull origin main
client/.venv/bin/pip install -r client/requirements.txt  # if deps changed
systemctl restart wheresmybus-client
```

