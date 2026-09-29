FROM node:22-alpine

WORKDIR /app

# Install dependencies first: this layer is cached until package*.json
# changes, so code-only changes rebuild in seconds instead of minutes.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Don't run the app as root inside the container.
USER node

EXPOSE 8080
CMD ["node", "app.js"]
