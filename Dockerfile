FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc
EXPOSE 3000
CMD ["node", "--expose-gc", "--max-old-space-size=20480", "dist/server.js"]
