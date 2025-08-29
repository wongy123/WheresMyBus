# Node LTS on Alpine (tiny image; will compile native addons)
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install the tzdata package using apk
RUN apk add --no-cache tzdata

# Set the timezone
ENV TZ=Australia/Brisbane

# Build deps for native modules (bcrypt, sqlite/better-sqlite3, etc.)
RUN apk add --no-cache python3 make g++

# Install prod deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the app (scripts/config included)
COPY . .

# Run your data-prep scripts at build time (optional; bakes data into image)
# Ensure these scripts exist in package.json and can run without external services
RUN npm run import && npm run buildviews && npm run fetchrealtime

# Drop build deps to slim the image (native modules are already compiled)
RUN apk del --no-cache python3 make g++

# Ensure uploads dir exists and is writable
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "server.js"]
