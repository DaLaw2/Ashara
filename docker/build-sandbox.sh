#!/usr/bin/env bash
# Build the agent sandbox image.
# Called by: just build-sandbox
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="ashara-sandbox"
IMAGE_TAG="0.1.0"

podman build \
  -f "${SCRIPT_DIR}/sandbox.Containerfile" \
  -t "${IMAGE_NAME}:${IMAGE_TAG}" \
  "${SCRIPT_DIR}"

echo ""
echo "Built ${IMAGE_NAME}:${IMAGE_TAG}"
podman images --format "table {{.Repository}}  {{.Tag}}  {{.Size}}  {{.ID}}" \
  | grep -E "^REPO|${IMAGE_NAME}"
