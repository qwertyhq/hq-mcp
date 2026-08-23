#!/bin/sh
set -eu

# The runtime environment is operator-controlled; the file is baked into the
# image by root and cannot be replaced by the non-root service user.
HQ_MCP_IMAGE_REVISION="$(cat /usr/local/share/hq-mcp/image-revision)"
export HQ_MCP_IMAGE_REVISION

exec "$@"
