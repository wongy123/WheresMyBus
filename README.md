# Where's My Bus

A Brisbane public transit tracker built on the Translink GTFS and GTFS-RT feeds. Shows real-time arrivals, delays, and live vehicle positions for buses, trains, ferries, and the G:link tram across South East Queensland.

## Stack

- **API**: Node.js / Express (ESM), SQLite (GTFS static), Redis (real-time cache)
- **Client**: Python / Flask, Jinja2, HTMX, Leaflet, Bootstrap 5

## Local development

### Prerequisites

- Node.js 24+
- Python 3.11+
- Redis (or Docker — see below)

### 1. Start Redis

The quickest way is Docker:

```bash
docker run -d -p 6379:6379 redis:7-alpine
```

Or use the provided Compose file from the `server/` directory:

```bash
cd server
docker compose up redis -d
```

### 2. API

```bash
cd server
npm install
```

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

`.env` variables:

| Variable | Description |
|---|---|
| `REDIS_URL` | Redis connection URL, e.g. `redis://localhost:6379` |
| `GTFS_RT_TRIP_UPDATES_URL` | Translink SEQ TripUpdates GTFS-RT feed URL |
| `GTFS_RT_VEHICLE_POSITIONS_URL` | Translink SEQ VehiclePositions GTFS-RT feed URL |
| `PORT` | Port to listen on (default: `3000`) |

Import the GTFS static data (only needed once, or when the feed is updated):

```bash
npm run import
npm run buildviews
```

Start the API:

```bash
npm start
```

The API will be available at `http://localhost:3000`.

### 3. Client

```bash
cd client
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Create a `.env` file:

```
API_BASE_URL=http://localhost:3000/api
BASE_PATH=
FLASK_SECRET_KEY=dev-secret
```

Run the development server:

```bash
flask --app "app:create_app()" run
```

The client will be available at `http://localhost:5000`.

## Production deployment

See [DEPLOY.md](DEPLOY.md).
