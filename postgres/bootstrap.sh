#!/usr/bin/env bash
set -euo pipefail

# --- Config ---
GTFS_URL="${GTFS_URL:-https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip}"
GTFS_ZIP="SEQ_GTFS.zip"
GTFS_DIR="./gtfs"
DATA_DIR="./data"
COMPOSE_CMD="${COMPOSE_CMD:-docker compose}"  # can be overridden by env

# Keep docker + compose in sync (with/without sudo)
if [[ "${COMPOSE_CMD}" == "sudo docker compose" ]]; then
  DOCKER_CMD="sudo docker"
else
  DOCKER_CMD="docker"
fi


echo "==> Preparing folders"
mkdir -p "${GTFS_DIR}" "${DATA_DIR}"

echo "==> Checking dependencies"
command -v curl >/dev/null 2>&1 || { echo "curl not found"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker not found"; exit 1; }

# unzip: use if available; otherwise install it once (Ubuntu)
if ! command -v unzip >/dev/null 2>&1; then
  echo "==> Installing unzip (sudo required)"
  sudo apt update -y
  sudo apt install -y unzip
fi

# Detect if current user can access the Docker daemon; if not, fall back to sudo
if ! docker ps >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1; then
    echo "==> Docker requires elevated privileges; using sudo for compose commands"
    COMPOSE_CMD="sudo docker compose"
  else
    echo "Error: cannot access Docker daemon and sudo is not available."
    echo "Hint: add your user to the docker group and re-open your shell:"
    echo "  sudo usermod -aG docker \$USER && newgrp docker"
    exit 1
  fi
fi

echo "==> Downloading GTFS dataset"
rm -f "${GTFS_ZIP}"
curl -fL "${GTFS_URL}" -o "${GTFS_ZIP}"

echo "==> Unzipping into ${GTFS_DIR}"
# Clean out old files to avoid stale leftovers
rm -f "${GTFS_DIR}"/* || true
unzip -o "${GTFS_ZIP}" -d "${GTFS_DIR}" >/dev/null
rm -f "${GTFS_ZIP}"

echo "==> Stopping any existing stack"
${COMPOSE_CMD} down || true

echo "==> Clearing database files to trigger /init scripts (fresh load)"
# WARNING: this wipes your local Postgres data directory.
rm -rf "${DATA_DIR:?}/"* 2>/dev/null || true

echo "==> Starting containers (will pull/build as needed)"
${COMPOSE_CMD} up -d --pull always

echo "==> Waiting for Postgres healthcheck to pass"
for i in {1..30}; do
  if ${DOCKER_CMD} exec wheresmybus-db pg_isready -U postgres -d wheresmybus >/dev/null 2>&1; then
    echo "Postgres is healthy ✅"
    break
  fi
  sleep 2
  if [[ $i -eq 30 ]]; then
    echo "Timed out waiting for Postgres. Check logs:"
    echo "  ${DOCKER_CMD} logs wheresmybus-db"
    exit 1
  fi
done

echo "==> Cleaning up GTFS directory"
rm -rf "${GTFS_DIR:?}"

echo "==> Done. Data loaded via /init scripts."
echo "Adminer: http://localhost:8080  (server: db, user: postgres, pass: postgres, db: wheresmybus)"
