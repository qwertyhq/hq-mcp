FROM node:22.22-alpine AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json tsconfig.test-base.json ./
COPY apps ./apps
COPY packages ./packages
COPY tools ./tools
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @hq/http... build
RUN pnpm --filter @hq/http deploy --prod --legacy /out
RUN set -eu; \
    for package_dir in /out /out/node_modules/.pnpm/@hq+*/node_modules/@hq/*; do \
      [ -d "$package_dir" ] || continue; \
      rm -rf "$package_dir/.turbo" "$package_dir/src"; \
      rm -f "$package_dir"/tsconfig*.json; \
      if [ -d "$package_dir/dist" ]; then \
        find "$package_dir/dist" -type f \
          \( -name '*.tsbuildinfo' -o -name '*.d.ts' -o -name '*.map' \) -delete; \
      fi; \
    done

FROM node:22.22-alpine AS runtime
ARG HQ_MCP_DEPLOYMENT_REVISION
RUN printf '%s' "$HQ_MCP_DEPLOYMENT_REVISION" | grep -Eq '^[0-9a-f]{40}$' && \
    install -d -m 0755 /usr/local/share/hq-mcp && \
    printf '%s\n' "$HQ_MCP_DEPLOYMENT_REVISION" > /usr/local/share/hq-mcp/image-revision && \
    chmod 0444 /usr/local/share/hq-mcp/image-revision
ENV HQ_MCP_IMAGE_REVISION=$HQ_MCP_DEPLOYMENT_REVISION
LABEL org.opencontainers.image.revision=$HQ_MCP_DEPLOYMENT_REVISION
ENV NODE_ENV=production \
    HQ_MCP_HTTP_HOST=0.0.0.0 \
    HQ_MCP_HTTP_PORT=42480
RUN addgroup -S -g 10001 hq && adduser -S -D -u 10001 -G hq -h /srv/hq-mcp hq
COPY --chown=root:root scripts/http-container-entrypoint.sh /usr/local/bin/hq-mcp-http-entrypoint
RUN chmod 0555 /usr/local/bin/hq-mcp-http-entrypoint
WORKDIR /srv/hq-mcp
COPY --from=build --chown=hq:hq /out ./
USER hq
EXPOSE 42480
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:42480/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/hq-mcp-http-entrypoint"]
CMD ["node", "dist/index.js"]
