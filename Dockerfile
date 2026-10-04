FROM mcr.microsoft.com/playwright:v1.55.0-noble AS build
WORKDIR /app
COPY package*.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.55.0-noble AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY package*.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/migrations apps/server/migrations
COPY --from=build /app/apps/web/dist apps/web/dist
RUN chown -R pwuser:pwuser /app
USER pwuser
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "apps/server/dist/index.js"]
