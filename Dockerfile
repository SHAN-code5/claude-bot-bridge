FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY LICENSE README.md ./

USER node

EXPOSE 8080

ENTRYPOINT ["node", "bin/claude-bot-bridge.js"]
CMD ["http", "--host", "0.0.0.0", "--port", "8080"]
