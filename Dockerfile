# Instagram Grid Maker: the service and its job database, on any host that runs a container.
#
#   docker build -t instagram-grid-maker .
#   docker run -p 8787:8787 -v instagram-grid-maker-jobs:/data -e PAY_TO=G... -e PUBLIC_ORIGIN=https://your.domain instagram-grid-maker
#
# Paid jobs are kept in /data/jobs.sqlite: give /data a persistent volume. The image holds no Stellar secret key.
# ./deploy.sh runs it on an Oracle Cloud Always Free VM, behind Caddy (deploy/docker-compose.yml).

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npx tsc && rm -f dist/*.test.js dist/*.test.d.ts

FROM node:24-slim
ENV NODE_ENV=production JOB_DB_PATH=/data/jobs.sqlite OUTPUT_DIR=/data/outputs
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# A host's new volume may belong to root, as Fly.io's do: started as root, the container only gives /data to the node
# user, then runs the service as node. Started as another user, it runs as that user.
ENTRYPOINT ["sh", "-c", "if [ \"$(id -u)\" = 0 ]; then chown node:node /data 2>/dev/null || true; exec setpriv --reuid=node --regid=node --init-groups -- \"$@\"; fi; exec \"$@\"", "sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.js"]
