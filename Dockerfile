# Build stage: compile TypeScript. Only this stage needs dev dependencies.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Run stage: Wicket has no runtime dependencies, so this image holds only the compiled code.
FROM node:22-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    WICKET_DB=/data/wicket.db
WORKDIR /app
COPY package.json ./
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/src/gateway/main.js"]
