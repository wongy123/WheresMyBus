# Where's My Bus — Deployment Guide

## Architecture

```
Internet
   │
   ▼
duanduanshome.ddns.net  (Nginx Proxy Manager LXC)
   ├── /wheresmybus          → client-lxc:80   (nginx → Flask/gunicorn)
   └── /wheresmybus-api/     → api-lxc:3000    (Node.js/Express, strips prefix)
                                  └── redis-lxc:6379
```

### LXC Summary

| Container  | Role             | CPU | RAM    | Disk |
|-----------|------------------|-----|--------|------|
| redis-lxc  | Redis 7         | 1   | 256 MB | 2 GB |
| api-lxc    | Node.js/PM2     | 1   | 512 MB | 4 GB |
| client-lxc | Flask/gunicorn  | 1   | 256 MB | 2 GB |
| npm-lxc    | Nginx Proxy Mgr | —   | —      | —    |

All LXCs are on the `192.168.3.0/24` bridge network.

---

## 1. Create LXCs

All LXCs are deployed using [Proxmox Community Scripts](https://community-scripts.github.io/ProxmoxVE/). Run these from the Proxmox host shell:

```bash
# Redis
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/redis.sh)"

# API (no Node.js-specific script exists — use the base Debian script)
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/debian.sh)"

# Client (no Python-specific script exists — use the base Debian script)
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/debian.sh)"
```

After creating the api-lxc, install Node.js:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
npm install -g pm2
```

---

## 2. Redis LXC

The community script uses an Alpine container with OpenRC (not systemd). Config is at `/etc/redis.conf`.

In `/etc/redis.conf`, replace the default `bind 0.0.0.0` line with an explicit bind to loopback and the LXC IP:

```
bind 127.0.0.1 192.168.3.5
```

The Alpine Redis config uses `bind 0.0.0.0` as its active line — commenting it out removes all bind constraints and exposes Redis on every interface. Replacing it with specific addresses is the correct approach.

Optionally add a password:

```
requirepass changeme
```

Restart with OpenRC:

```bash
rc-service redis restart
rc-update add redis default   # enable on boot (if not already)
```

Test from another LXC: `redis-cli -h 192.168.3.5 ping` → `PONG`

---

## 4. API LXC

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

### Deploy the API

```bash
git clone -b local https://github.com/wongy123/WheresMyBus /opt/wheresmybus
cd /opt/wheresmybus/server
npm install
```

### GTFS Static Data

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

This may take a few minutes.

After the import, create the custom SQLite views the timetable queries depend on:

```bash
node sqlite/db.js
```

Both steps only need to be re-run when the GTFS feed is updated.

### Environment File

```bash
cat > /opt/wheresmybus/server/.env <<'EOF'
# Redis
REDIS_URL=redis://192.168.3.5:6379

# GTFS-RT feeds (Translink)
GTFS_RT_TRIP_UPDATES_URL=https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates
GTFS_RT_VEHICLE_POSITIONS_URL=https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions
GTFS_RT_ALERTS_URL=https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts

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

Test: `curl http://192.168.3.7:3000/api/stops/search?q=central`

---

## 5. Client LXC (192.168.3.8)

```bash
apt update && apt install -y ca-certificates git nginx python3 python3-venv
```

### Clone and install dependencies

```bash
git clone -b local https://github.com/wongy123/WheresMyBus /opt/wheresmybus
cd /opt/wheresmybus/client
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt gunicorn
```

### Environment file

```bash
cat > /opt/wheresmybus/client/.env <<'EOF'
API_BASE_URL=http://192.168.3.7:3000/api
API_BASE_URL_PUBLIC=https://duanduanshome.ddns.net/wheresmybus-api/api
BASE_PATH=/wheresmybus
FLASK_SECRET_KEY=change-this-to-a-long-random-string
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

Test: `curl http://192.168.3.8/wheresmybus/` should return HTML.

---

## 6. Nginx Proxy Manager

In the NPM web UI, open your existing proxy host for `duanduanshome.ddns.net` and add two **Custom Locations**:

### Location 1 — Flask frontend

| Field | Value |
|---|---|
| Location | `/wheresmybus` |
| Scheme | `http` |
| Forward Hostname/IP | `192.168.3.8` |
| Forward Port | `80` |

No additional nginx config needed.

### Location 2 — Node.js API

| Field | Value |
|---|---|
| Location | `/wheresmybus-api/` |
| Scheme | `http` |
| Forward Hostname/IP | `192.168.3.7` |
| Forward Port | `3000` |

Add this in the **Advanced** nginx config block for that location:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

Express is mounted at both `/api` (local dev) and `/wheresmybus-api/api` (production), so no path rewriting in NPM is needed.

Save and test:
- `https://duanduanshome.ddns.net/wheresmybus/` — Flask app loads
- `https://duanduanshome.ddns.net/wheresmybus-api/api/stops/search?q=central` — JSON response

---

## 7. Redeployment

When you update the API:

```bash
# On api-lxc
cd /opt/wheresmybus
git pull origin local
cd server && npm install   # if dependencies changed
npm run buildviews
pm2 restart wheresmybus-api
```

`npm run buildviews` recreates the SQLite views and any pre-computed tables (e.g. `stop_route_type`). It is safe to re-run at any time — all statements use `DROP … IF EXISTS` / `CREATE`. You do **not** need to re-run the full GTFS import.

When you update the client:

```bash
# On client-lxc
cd /opt/wheresmybus
git pull origin local
client/.venv/bin/pip install -r client/requirements.txt  # if deps changed
systemctl restart wheresmybus-client
```

---

## 8. IP Reference

| LXC | IP |
|---|---|
| npm-lxc | 192.168.3.4 |
| redis-lxc | 192.168.3.5 |
| api-lxc | 192.168.3.7 |
| client-lxc | 192.168.3.8 |
