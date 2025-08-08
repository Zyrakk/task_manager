FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production || npm i --only=production

COPY server.js ./
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_FILE=/data/tasks.json

EXPOSE 3000
CMD ["node", "server.js"]