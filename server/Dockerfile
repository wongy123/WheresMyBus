# Use latest Node LTS
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package files first for better build cache
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the app
COPY . .

# Expose the app port
EXPOSE 3000

# Start the API
CMD ["node", "src/index.js"]
