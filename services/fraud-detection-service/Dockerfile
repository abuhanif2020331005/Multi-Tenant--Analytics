FROM node:20-alpine

WORKDIR /app

COPY services/fraud-detection-service/package*.json ./
RUN npm ci --omit=dev

COPY services/fraud-detection-service ./
COPY shared /shared

EXPOSE 8006

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8006/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["npm", "start"]

