#!/bin/sh
set -eu

IMAGE_REF="${1:?usage: scripts/http-container-smoke.sh IMAGE_REF}"
NETWORK_NAME="hq-mcp-smoke-${$}"
CONTAINER_NAME="hq-mcp-smoke-${$}"
TOKEN='example-token-0123456789abcdef'
DEPLOYMENT_CONFIG_REVISION='11111111-1111-4111-8111-111111111111'
FORGED_IMAGE_REVISION='ffffffffffffffffffffffffffffffffffffffff'
SECRET_DIR="$(mktemp -d)"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
  rm -rf "$SECRET_DIR"
}
trap cleanup EXIT INT TERM

IMAGE_REVISION="$(docker image inspect "$IMAGE_REF" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
ENV_IMAGE_REVISION="$(docker image inspect "$IMAGE_REF" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^HQ_MCP_IMAGE_REVISION=//p')"
[ "$IMAGE_REVISION" = "$ENV_IMAGE_REVISION" ]
printf '%s' "$IMAGE_REVISION" | grep -Eq '^[0-9a-f]{40}$'
BAKED_IMAGE_REVISION="$(docker run --rm --entrypoint sh "$IMAGE_REF" -c 'cat /usr/local/share/hq-mcp/image-revision')"
[ "$BAKED_IMAGE_REVISION" = "$IMAGE_REVISION" ]
docker run --rm --user 0 --entrypoint sh "$IMAGE_REF" -c \
  '[ "$(stat -c "%u:%g:%a" /usr/local/share/hq-mcp/image-revision)" = "0:0:444" ] && [ "$(stat -c "%u:%g:%a" /usr/local/bin/hq-mcp-http-entrypoint)" = "0:0:555" ]'
docker run --rm "$IMAGE_REF" sh -c '[ "$(id -u):$(id -g)" = "10001:10001" ]'
docker run --rm --entrypoint sh "$IMAGE_REF" -c '
  set -eu
  [ -z "$(find /srv/hq-mcp -type d -name .turbo -print -quit)" ]
  [ ! -d /srv/hq-mcp/src ]
  for package_dir in /srv/hq-mcp /srv/hq-mcp/node_modules/.pnpm/@hq+*/node_modules/@hq/*; do
    [ -d "$package_dir" ] || continue
    [ ! -L "$package_dir" ] || continue
    [ ! -d "$package_dir/src" ]
    [ ! -d "$package_dir/.turbo" ]
    [ -z "$(find "$package_dir" -path "$package_dir/node_modules" -prune -o -type f \( -name "*.test.ts" -o -name "*.spec.ts" -o -name "*.tsbuildinfo" -o -name "*.d.ts" -o -name "*.map" \) -print -quit)" ]
  done
  find /srv/hq-mcp -type f -exec sh -c '\''
    for file do
      if grep -I -q -E "/Users/|/home/runner/work/|/workspace/" "$file"; then
        printf "forbidden build-host path in %s\n" "$file" >&2
        exit 1
      else
        grep_status=$?
        [ "$grep_status" -eq 1 ] || exit "$grep_status"
      fi
    done
  '\'' sh {} +
'

umask 077
printf '%s\n' 'example:example-password' >"${SECRET_DIR}/shm_admin_auth"
printf '%s\n' 'example-remna-token-0123456789' >"${SECRET_DIR}/remna_api_token"
printf 'ai-bot:%s\n' "$TOKEN" >"${SECRET_DIR}/http_tokens"
chmod 600 "${SECRET_DIR}/shm_admin_auth" "${SECRET_DIR}/remna_api_token" "${SECRET_DIR}/http_tokens"
docker run --rm --user 0 --entrypoint sh \
  --mount "type=bind,src=${SECRET_DIR},dst=/secrets" \
  "$IMAGE_REF" -c 'chown 10001:10001 /secrets/shm_admin_auth /secrets/remna_api_token /secrets/http_tokens'

docker network create "$NETWORK_NAME" >/dev/null
docker run -d --name "$CONTAINER_NAME" --network "$NETWORK_NAME" \
  --user 10001:10001 \
  --mount "type=bind,src=${SECRET_DIR}/shm_admin_auth,dst=/run/secrets/shm_admin_auth,readonly" \
  --mount "type=bind,src=${SECRET_DIR}/remna_api_token,dst=/run/secrets/remna_api_token,readonly" \
  --mount "type=bind,src=${SECRET_DIR}/http_tokens,dst=/run/secrets/http_tokens,readonly" \
  -e SHM_BASE_URL=https://billing.example.com/shm/v1 \
  -e SHM_ADMIN_AUTH_FILE=/run/secrets/shm_admin_auth \
  -e REMNA_BASE_URL=https://panel.example.com \
  -e REMNA_API_TOKEN_FILE=/run/secrets/remna_api_token \
  -e HQ_MCP_MODE=ro \
  -e HQ_MCP_PROFILE=bot \
  -e HQ_MCP_IMAGE_REVISION="$FORGED_IMAGE_REVISION" \
  -e HQ_MCP_DEPLOYMENT_CONFIG_REVISION="$DEPLOYMENT_CONFIG_REVISION" \
  -e HQ_MCP_HTTP_TOKENS_FILE=/run/secrets/http_tokens \
  "$IMAGE_REF" >/dev/null

attempt=0
while [ "$attempt" -lt 30 ]; do
  running="$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME")"
  if [ "$running" != true ]; then
    docker logs "$CONTAINER_NAME"
    exit 1
  fi
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$CONTAINER_NAME")"
  [ "$status" = healthy ] && break
  if [ "$status" = unhealthy ]; then
    docker logs "$CONTAINER_NAME"
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[ "$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER_NAME")" = healthy ]
[ "$(docker inspect --format '{{.Config.User}}' "$CONTAINER_NAME")" = '10001:10001' ]
[ -z "$(docker port "$CONTAINER_NAME")" ]

docker run -i --rm --network "container:${CONTAINER_NAME}" \
  -e BASE_URL="http://127.0.0.1:42480" \
  -e TOKEN="$TOKEN" \
  -e IMAGE_REVISION="$IMAGE_REVISION" \
  -e DEPLOYMENT_CONFIG_REVISION="$DEPLOYMENT_CONFIG_REVISION" \
  node:22.22-alpine node --input-type=module - <<'NODE'
const fail = (message) => {
  throw new Error(message);
};
const json = async (path, init) => {
  const response = await fetch(`${process.env.BASE_URL}${path}`, init);
  if (!response.ok) fail(`${path}: status ${response.status}`);
  return response.json();
};

const health = await json('/healthz');
if (health.profile !== 'bot' || health.mode !== 'ro') fail('health profile/mode');
if (health.imageRevision !== process.env.IMAGE_REVISION) fail('health image revision');
if (health.imageRevision === 'ffffffffffffffffffffffffffffffffffffffff') fail('forged revision won');
if (health.deploymentConfigRevision !== process.env.DEPLOYMENT_CONFIG_REVISION) {
  fail('health deployment config revision');
}

const headers = { authorization: `Bearer ${process.env.TOKEN}` };
const catalog = await json('/v1/tools', { headers });
if (catalog.profile !== 'bot' || catalog.mode !== 'ro' || catalog.transport !== 'rest-facade') {
  fail('catalog contract');
}
if (!Array.isArray(catalog.tools) || catalog.tools.length === 0) fail('empty catalog');
if (catalog.tools.some((tool) => tool.access !== 'ro')) fail('non-read-only tool');

for (const path of ['/mcp', '/metrics']) {
  const response = await fetch(`${process.env.BASE_URL}${path}`, { headers });
  if (response.status !== 404) fail(`${path}: expected 404, got ${response.status}`);
}
NODE
