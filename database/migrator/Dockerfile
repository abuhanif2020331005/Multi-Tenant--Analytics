FROM node:20-alpine

WORKDIR /app

COPY database/migrator/package*.json ./
RUN npm ci --omit=dev

COPY database/migrator ./
COPY database/migrations /migrations

CMD ["npm", "start"]
