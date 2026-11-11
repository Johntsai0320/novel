FROM node:20-alpine

WORKDIR /app

# Copy package manifests and install production dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy application source
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY novels ./novels

# Default environment variables for NAS deployment
ENV NODE_ENV=production
ENV PORT=3000
ENV NOVELS_DIR=/novels
ENV DATA_DIR=/data

# Create mount points for NAS novels folder and sync data folder
RUN mkdir -p /novels /data

EXPOSE 3000

CMD ["node", "server/index.js"]
