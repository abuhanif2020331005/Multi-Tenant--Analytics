FROM node:20-alpine

WORKDIR /app

COPY services/event-processor-service/package*.json ./
RUN npm ci --omit=dev

COPY services/event-processor-service ./
COPY shared /shared

EXPOSE 8007

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8007/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["npm", "start"]

