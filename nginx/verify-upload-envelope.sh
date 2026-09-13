#!/usr/bin/env bash
set -euo pipefail

readonly FILE_AGGREGATE_BYTES=$((80 * 1024 * 1024))
readonly PROXY_ENVELOPE_BYTES=$((81 * 1024 * 1024))
readonly OBJECT_BYTES=$((5 * 1024 * 1024))
readonly FIELD_BYTES=$((64 * 1024))
readonly SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

probe_id="$$"
network="finsight-upload-envelope-${probe_id}"
backend_container="finsight-upload-backend-${probe_id}"
proxy_container="finsight-upload-nginx-${probe_id}"
scratch=$(mktemp -d)

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker logs "$proxy_container" 2>&1 || true
    docker logs "$backend_container" 2>&1 || true
  fi
  docker rm -f "$proxy_container" "$backend_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf -- "$scratch"
}
trap cleanup EXIT

truncate -s "$OBJECT_BYTES" "$scratch/object.bin"
truncate -s "$((OBJECT_BYTES + 1))" "$scratch/object-plus-one.bin"
truncate -s "$FIELD_BYTES" "$scratch/field.bin"
truncate -s "$((PROXY_ENVELOPE_BYTES + 1))" "$scratch/proxy-over.bin"

docker network create "$network" >/dev/null
docker run -d --rm \
  --name "$backend_container" \
  --network "$network" \
  --network-alias backend \
  -v "$SCRIPT_DIR/upload-envelope-backend.py:/probe/backend.py:ro" \
  python:3.13-alpine python /probe/backend.py >/dev/null
docker run -d --rm \
  --name "$proxy_container" \
  --network "$network" \
  -p 127.0.0.1::80 \
  -v "$SCRIPT_DIR/nginx.conf:/etc/nginx/nginx.conf:ro" \
  nginx:1.27-alpine >/dev/null

port=$(docker inspect --format '{{(index (index .NetworkSettings.Ports "80/tcp") 0).HostPort}}' "$proxy_container")
ready=0
for _ in $(seq 1 30); do
  if curl -sf --max-time 1 "http://127.0.0.1:${port}/" >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ]

multipart_args=()
for page in $(seq 1 8); do
  multipart_args+=(
    -F "files=@$scratch/object.bin;type=image/jpeg;filename=processed-${page}.jpg"
    -F "originalFiles=@$scratch/object.bin;type=image/jpeg;filename=original-${page}.jpg"
  )
done
for field in $(seq 1 8); do
  multipart_args+=(-F "field${field}=<$scratch/field.bin")
done

headers="$scratch/headers"
exact_result=$(curl -sS --max-time 120 -H 'Expect:' -D "$headers" -o /dev/null \
  -w '%{http_code} %{size_upload}' "${multipart_args[@]}" "http://127.0.0.1:${port}/api/v1/receipts")
read -r exact_status exact_body_bytes <<< "$exact_result"
grep -qi '^X-FinSight-Envelope-Probe: reached-backend' "$headers"
[ "$exact_status" = 204 ]
[ "$exact_body_bytes" -le "$PROXY_ENVELOPE_BYTES" ]

multipart_args[3]="originalFiles=@$scratch/object-plus-one.bin;type=image/jpeg;filename=original-1.jpg"
app_over_status=$(curl -sS --max-time 120 -H 'Expect:' -o /dev/null -w '%{http_code}' \
  "${multipart_args[@]}" "http://127.0.0.1:${port}/api/v1/receipts")
[ "$app_over_status" = 204 ]

proxy_over_status=$(curl -sS --max-time 30 -H 'Expect:' -H 'Content-Type: application/octet-stream' \
  --data-binary "@$scratch/proxy-over.bin" -o /dev/null -w '%{http_code}' \
  "http://127.0.0.1:${port}/api/v1/receipts")
[ "$proxy_over_status" = 413 ]

overhead_bytes=$((exact_body_bytes - FILE_AGGREGATE_BYTES))
headroom_bytes=$((PROXY_ENVELOPE_BYTES - exact_body_bytes))
printf '%s\n' \
  "receipt_upload_proxy_probe exact_file_bytes=$FILE_AGGREGATE_BYTES multipart_body_bytes=$exact_body_bytes overhead_bytes=$overhead_bytes envelope_bytes=$PROXY_ENVELOPE_BYTES headroom_bytes=$headroom_bytes app_over_reached_backend=true proxy_over_status=413"
