FROM node:20-alpine

WORKDIR /app

COPY services/catalog-service/package*.json ./
RUN npm ci --omit=dev

COPY services/catalog-service ./
COPY shared /shared

EXPOSE 8008

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8008/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["npm", "start"]

