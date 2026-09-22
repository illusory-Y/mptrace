FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY signaling.mjs ./

EXPOSE 8787

# node 镜像内置非特权用户
USER node

CMD ["node", "signaling.mjs"]
