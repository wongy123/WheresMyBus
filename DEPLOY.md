# Where's My Bus — Deployment Guide

## Architecture

```
Internet
   │
   ▼
duanduanshome.ddns.net  (Nginx Proxy Manager LXC)
   ├── /wheresmybus          → client-lxc:80   (nginx → Flask/gunicorn  OR  nginx static)
   └── /wheresmybus-api/     → api-lxc:3000    (Node.js/Express, strips prefix)
                                  ├── postgres-lxc:5432
                                  └── redis-lxc:6379
```

### LXC Summary

| Container    | Role             | CPU | RAM   | Disk |
|-------------|------------------|-----|-------|------|
| postgres-lxc | PostgreSQL 18   | 1   | 512 MB | 8 GB |
| redis-lxc    | Redis 7         | 1   | 256 MB | 2 GB |
| api-lxc      | Node.js/PM2     | 1   | 512 MB | 4 GB |
| client-lxc   | Flask or React  | 1   | 256 MB | 2 GB |
| npm-lxc      | Nginx Proxy Mgr | —   | —     | —    |

All LXCs are on the `192.168.3.0/24` bridge network.

---

## 1. Create LXCs

All LXCs are deployed using [Proxmox Community Scripts](https://community-scripts.github.io/ProxmoxVE/). Run these from the Proxmox host shell:

```bash
# PostgreSQL
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/postgresql.sh)"

# Redis
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/redis.sh)"

# API (no Node.js-specific script exists — use the base Debian script)
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/debian.sh)"

# Client (no Python-specific script exists — use the base Debian script)
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/debian.sh)"
```

After creating the api-lxc and client-lxc, install Node.js on the api-lxc:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
npm install -g pm2
```

---

## 2. PostgreSQL LXC

The community script installs PostgreSQL and starts the service. You only need to configure network access and create the app database.

### Allow LAN connections

```bash
# Find the installed version
pg_lsclusters

# Edit postgresql.conf — set listen_addresses
nano /etc/postgresql/<version>/main/postgresql.conf
# listen_addresses = '192.168.3.6'   ← postgres-lxc IP

# Edit pg_hba.conf — add a line for the app user
nano /etc/postgresql/<version>/main/pg_hba.conf
# host    wheresmybus     wmbuser     192.168.3.0/24    scram-sha-256
```

### Create database and user

```bash
sudo -u postgres psql <<'SQL'
CREATE USER wmbuser WITH PASSWORD 'changeme';
CREATE DATABASE wheresmybus OWNER wmbuser;
SQL
```

```bash
systemctl restart postgresql
```

### Schema

The Express app creates the `stop_reviews` table on first startup — no manual schema migration needed.

---

## 3. Redis LXC

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

Clone the repo directly on the LXC and install dependencies:

```bash
git clone -b local https://github.com/wongy123/WheresMyBus /opt/wheresmybus
cd /opt/wheresmybus/server
npm install
```

### GTFS Static Data

The API uses a SQLite GTFS database. Import it on the API LXC before starting:

```bash
cd /opt/wheresmybus/server
npm install
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
# PostgreSQL
PGHOST=192.168.3.6
PGPORT=5432
PGUSER=wmbuser
PGPASSWORD=changeme
PGDATABASE=wheresmybus

# Redis
REDIS_URL=redis://192.168.3.5:6379

# GTFS-RT feeds (Translink)
GTFS_RT_TRIP_UPDATES_URL=https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates
GTFS_RT_VEHICLE_POSITIONS_URL=https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions

# Auth
JWT_SECRET=change-this-to-a-long-random-string

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

Choose **Option A** (Flask/HTMX) or **Option B** (React SPA). Both use the same Debian base LXC.

### Initial setup (both options)

```bash
apt update && apt install -y ca-certificates git nginx
```

---

### Option A — Flask/HTMX

#### Install Python

```bash
apt install -y python3 python3-venv
```

#### Clone and install dependencies

```bash
git clone -b local https://github.com/wongy123/WheresMyBus /opt/wheresmybus
cd /opt/wheresmybus/client
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt gunicorn
```

#### Environment file

```bash
cat > /opt/wheresmybus/client/.env <<'EOF'
API_BASE_URL=http://192.168.3.7:3000/api
BASE_PATH=/wheresmybus
FLASK_SECRET_KEY=change-this-to-a-long-random-string
EOF
```

#### systemd service

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

#### nginx configuration

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

### Option B — React SPA (static nginx)

No Python needed — nginx serves the pre-built static files directly.

#### Build on dev machine

```bash
cd /d/Users/AngusWong/WheresMyBus/client-react

cat > .env.production <<'EOF'
VITE_API_BASE_URL=https://duanduanshome.ddns.net/wheresmybus-api/api
VITE_BASE_PATH=/wheresmybus
EOF

npm run build
```

#### Copy dist/ to the LXC

```bash
# From Git Bash / WSL on dev machine:
scp -r /d/Users/AngusWong/WheresMyBus/client-react/dist/* root@192.168.3.8:/var/www/wheresmybus/
```

#### nginx configuration

```bash
mkdir -p /var/www/wheresmybus

cat > /etc/nginx/sites-available/wheresmybus <<'EOF'
server {
    listen 80;

    root /var/www;
    index index.html;

    location /wheresmybus {
        try_files $uri $uri/ @spa;
    }

    location @spa {
        rewrite .* /wheresmybus/index.html break;
    }
}
EOF

ln -s /etc/nginx/sites-available/wheresmybus /etc/nginx/sites-enabled/
rm /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

Test: `curl http://192.168.3.8/wheresmybus/` should return `index.html`.

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
pm2 restart wheresmybus-api
```

When you update the Flask client (Option A):

```bash
# On client-lxc
cd /opt/wheresmybus
git pull origin local
client/.venv/bin/pip install -r client/requirements.txt  # if deps changed
systemctl restart wheresmybus-client
```

When you update the React app (Option B):

```bash
# On dev machine
cd client-react
npm run build     # uses .env.production
scp -r dist/* root@192.168.3.8:/var/www/wheresmybus/
```

---

## 8. IP Reference

| LXC | IP |
|---|---|
| npm-lxc | 192.168.3.4 |
| redis-lxc | 192.168.3.5 |
| postgres-lxc | 192.168.3.6 |
| api-lxc | 192.168.3.7 |
| client-lxc | 192.168.3.8 |
