FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
WORKDIR /app

# Sharp/libvips renders deterministic editorial-card text through Pango. The
# slim runtime has no fonts, which turns otherwise valid English into tofu
# squares and correctly fails the downstream visual QA.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
# Server media validation and upload scheduling share these browser-safe modules.
COPY --from=build /app/extension ./extension
COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
COPY --from=build /app/vendor ./vendor
COPY --from=build /app/docs ./docs
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json ./package.json

EXPOSE 8080
CMD ["node", "src/server.mjs"]
