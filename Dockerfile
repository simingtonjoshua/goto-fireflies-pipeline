FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
# Names live in config/team-roster.json, not under src. An image without this
# file has an empty roster: inbound "This is Josh speaking" stays Team Member(s) unknown.
COPY config ./config
EXPOSE 3001
CMD ["node", "src/server.js"]
