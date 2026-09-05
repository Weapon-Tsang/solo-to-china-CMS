#!/usr/bin/env bash
# GCE startup script. It retrieves runtime credentials only from Secret Manager;
# no secret is embedded in this file or in instance metadata.
set -euo pipefail

PROJECT_ID="project-4bcb9146-c37b-43b0-b11"
IMAGE="asia-east1-docker.pkg.dev/${PROJECT_ID}/solo-to-china/engine:1.13.2"
APP_DIR="/opt/solo-to-china"
METADATA_URL="http://metadata.google.internal/computeMetadata/v1"

log() {
  printf '[solo-to-china] %s\n' "$*"
}

metadata_token() {
  curl --fail --silent --show-error \
    --header 'Metadata-Flavor: Google' \
    "${METADATA_URL}/instance/service-accounts/default/token" \
    | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

secret_value() {
  local secret_name="$1"
  local access_token
  access_token="$(metadata_token)"
  curl --fail --silent --show-error \
    --header "Authorization: Bearer ${access_token}" \
    "https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/${secret_name}/versions/latest:access" \
    | sed -n 's/.*"data"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | base64 --decode
}

log 'Installing the container runtime.'
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends ca-certificates curl docker.io
systemctl enable --now docker

log 'Fetching runtime configuration from Secret Manager.'
KIMI_API_KEY="$(secret_value solo-to-china-kimi-api-key)"
CAPTURE_TOKEN="$(secret_value solo-to-china-capture-token)"
ADMIN_TOKEN="$(secret_value solo-to-china-admin-token)"
ADMIN_PASSWORD="$(secret_value solo-to-china-admin-password)"
SESSION_SECRET="$(secret_value solo-to-china-session-secret)"
CLOUDFLARE_TUNNEL_TOKEN="$(secret_value solo-to-china-cloudflare-tunnel-token)"

install -d -m 0700 "$APP_DIR"
umask 077
cat > "${APP_DIR}/.env.production" <<EOF
ENGINE_IMAGE=${IMAGE}
CLOUDFLARE_TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}

HOST=0.0.0.0
PORT=8080
CAPTURE_TOKEN=${CAPTURE_TOKEN}
ADMIN_TOKEN=${ADMIN_TOKEN}
ADMIN_USERNAME=admin
ADMIN_PASSWORD=${ADMIN_PASSWORD}
SESSION_SECRET=${SESSION_SECRET}
CAPTURE_HOST=capture.solotochina.com

KIMI_API_KEY=${KIMI_API_KEY}
AI_MODEL=vertex-gemini-3.8-flash
KIMI_MODEL=kimi-k3
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MAX_IMAGES=8
KIMI_MAX_COMPLETION_TOKENS=16000
KIMI_REQUEST_TIMEOUT_MS=360000
KIMI_IMAGE_TIMEOUT_MS=20000

PUBLIC_CONTENT_SITE_URL=https://solotochina.com
CONTENT_PUBLISHER_NAME=SoloToChina
CONTENT_PUBLISHER_LOGO_URL=

IMAGE_ENABLED=true
IMAGE_PROVIDER=vertex_gemini
VISUAL_MODEL=vertex-gemini-3.1-flash-image
IMAGE_MODEL=gemini-3.1-flash-image
IMAGE_COVER_QUALITY=1K
IMAGE_INLINE_QUALITY=1K
GOOGLE_CLOUD_PROJECT=${PROJECT_ID}
VERTEX_AI_LOCATION=global
VERTEX_IMAGEN_MODEL=imagen-4.0-generate-001
PUBLIC_BASE_URL=https://engine.solotochina.com
VERTEX_IMAGE_TIMEOUT_MS=120000
VERTEX_AI_REQUEST_TIMEOUT_MS=360000
VERTEX_AI_MAX_COMPLETION_TOKENS=16000
MANUAL_SOURCE_MAX_VIDEO_BYTES=104857600
MANUAL_SOURCE_MAX_TOTAL_BYTES=115343360
MANUAL_SOURCE_GCS_BUCKET=solo-to-china-video-463584560230

WORDPRESS_SITE_URL=
WORDPRESS_USERNAME=
WORDPRESS_APPLICATION_PASSWORD=
WORDPRESS_CONTENT_FORMAT=blocks
WORDPRESS_SEO_TITLE_META_KEY=
WORDPRESS_SEO_DESCRIPTION_META_KEY=
WORDPRESS_SCHEMA_JSONLD_META_KEY=
WORDPRESS_STRATEGY_VERSION_META_KEY=
EOF
chmod 0600 "${APP_DIR}/.env.production"

cat > "${APP_DIR}/docker-compose.yml" <<'EOF'
services:
  engine:
    image: ${ENGINE_IMAGE}
    restart: unless-stopped
    env_file: .env.production
    environment:
      HOST: 0.0.0.0
      PORT: 8080
      DATABASE_PATH: /var/lib/solo-to-china/solo-to-china.sqlite
      BACKUP_DIR: /var/lib/solo-to-china/backups
      GENERATED_MEDIA_DIR: /var/lib/solo-to-china/generated-media
      SOURCE_UPLOADS_DIR: /var/lib/solo-to-china/source-uploads
    volumes:
      - solo_to_china_data:/var/lib/solo-to-china
    expose:
      - "8080"

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    depends_on:
      - engine
    command: tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}

volumes:
  solo_to_china_data:
EOF

log 'Authenticating to Artifact Registry and starting services.'
REGISTRY_TOKEN="$(metadata_token)"
printf '%s' "$REGISTRY_TOKEN" | docker login --username oauth2accesstoken --password-stdin asia-east1-docker.pkg.dev
docker pull "$IMAGE"
docker pull cloudflare/cloudflared:latest
docker network inspect solo-to-china >/dev/null 2>&1 || docker network create solo-to-china >/dev/null
docker volume inspect solo_to_china_data >/dev/null 2>&1 || docker volume create solo_to_china_data >/dev/null
if docker inspect engine >/dev/null 2>&1; then
  log 'Creating a verified SQLite backup in the persistent volume before replacing the engine container.'
  docker exec engine node src/backup.mjs \
    /var/lib/solo-to-china/solo-to-china.sqlite \
    /var/lib/solo-to-china/backups >/dev/null
fi
docker rm --force engine cloudflared >/dev/null 2>&1 || true
docker run --detach --name engine --restart unless-stopped \
  --network solo-to-china \
  --env-file "${APP_DIR}/.env.production" \
  --env HOST=0.0.0.0 \
  --env PORT=8080 \
  --env DATABASE_PATH=/var/lib/solo-to-china/solo-to-china.sqlite \
  --env BACKUP_DIR=/var/lib/solo-to-china/backups \
  --env GENERATED_MEDIA_DIR=/var/lib/solo-to-china/generated-media \
  --env SOURCE_UPLOADS_DIR=/var/lib/solo-to-china/source-uploads \
  --volume solo_to_china_data:/var/lib/solo-to-china \
  "$IMAGE" >/dev/null
docker run --detach --name cloudflared --restart unless-stopped \
  --network solo-to-china \
  cloudflare/cloudflared:latest \
  tunnel --no-autoupdate run --token "$CLOUDFLARE_TUNNEL_TOKEN" >/dev/null
sleep 8
log 'Container status:'
docker ps --format 'table {{.Names}}\t{{.Status}}'
ENGINE_STATE="$(docker inspect --format '{{.State.Status}}' engine)"
if [[ "$ENGINE_STATE" != 'running' ]]; then
  log 'Engine did not remain running. Recent diagnostic output follows:'
  docker logs --tail 100 engine >&2 || true
  exit 1
fi
CLOUDFLARED_STATE="$(docker inspect --format '{{.State.Status}}' cloudflared)"
if [[ "$CLOUDFLARED_STATE" != 'running' ]]; then
  log 'Cloudflared did not remain running. Recent diagnostic output follows:'
  docker logs --tail 100 cloudflared >&2 || true
  exit 1
fi
log 'Deployment completed successfully.'
