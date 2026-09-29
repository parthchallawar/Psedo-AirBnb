FROM node:22-alpine

WORKDIR /app

# Install dependencies first for layer caching
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Run as non-root user
USER node

CMD ["node", "worker.js"]
