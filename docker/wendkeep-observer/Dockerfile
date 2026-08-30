FROM node:22-alpine

WORKDIR /app

# The image contains only the WendKeep runtime. Project vaults are deliberately
# not copied or mounted; /data is the disposable/rebuildable Observer projection.
COPY package.json package-lock.json ./
COPY bin ./bin
COPY src ./src
COPY packages ./packages
COPY hooks ./hooks
COPY schema ./schema
COPY web ./web

ENV NODE_ENV=production
ENV WENDKEEP_OBSERVER_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

ENTRYPOINT ["node", "bin/wendkeep.mjs", "observer", "serve"]
CMD ["--host", "0.0.0.0", "--allow-non-loopback", "--require-loopback-auth", "--require-encryption", "--port", "8787", "--data-dir", "/data"]
