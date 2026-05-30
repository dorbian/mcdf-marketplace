#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 /path/to/test.mcdf [server-port]" >&2
  exit 2
fi

MCDF_PATH="$1"
PORT="${2:-8080}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${ROOT_DIR}/.local-mcdf-registry-test"
SERVER_BIN="${ROOT_DIR}/src-tauri/target/release/mcdf-registry-server"

cd "${ROOT_DIR}/src-tauri"
cargo build --release --bin mcdf-registry-server

rm -rf "${DATA_DIR}"
mkdir -p "${DATA_DIR}"

"${SERVER_BIN}" \
  --bind "127.0.0.1:${PORT}" \
  --public-url "http://127.0.0.1:${PORT}" \
  --data-dir "${DATA_DIR}" \
  --storage-mode local &
SERVER_PID=$!
trap 'kill ${SERVER_PID} >/dev/null 2>&1 || true' EXIT

for _ in {1..40}; do
  if curl -fsS "http://127.0.0.1:${PORT}/v1/health" >/dev/null; then
    break
  fi
  sleep 0.25
done

UPLOAD_JSON="${DATA_DIR}/upload.json"
curl -fsS \
  -X POST \
  -H 'content-type: application/octet-stream' \
  -H "x-mcdf-filename: $(basename "${MCDF_PATH}")" \
  --data-binary "@${MCDF_PATH}" \
  "http://127.0.0.1:${PORT}/v1/packages/upload" | tee "${UPLOAD_JSON}"

PACKAGE_HASH="$(python3 - <<PY
import json
print(json.load(open('${UPLOAD_JSON}'))['package_hash_blake3'])
PY
)"

curl -fsS "http://127.0.0.1:${PORT}/v1/packages/${PACKAGE_HASH}/manifest" > "${DATA_DIR}/manifest.json"
curl -fsS "http://127.0.0.1:${PORT}/v1/packages/${PACKAGE_HASH}/download" > "${DATA_DIR}/rebuilt.mcdf"

python3 - <<PY
import hashlib, pathlib, sys
try:
    import blake3
except Exception:
    print('Python blake3 module is not installed; downloaded rebuilt.mcdf but skipping hash comparison.')
    sys.exit(0)
original = pathlib.Path('${MCDF_PATH}').read_bytes()
rebuilt = pathlib.Path('${DATA_DIR}/rebuilt.mcdf').read_bytes()
print('original', blake3.blake3(original).hexdigest(), len(original))
print('rebuilt ', blake3.blake3(rebuilt).hexdigest(), len(rebuilt))
if blake3.blake3(original).hexdigest() != blake3.blake3(rebuilt).hexdigest():
    raise SystemExit('rebuilt MCDF does not match original')
PY

echo "E2E local registry test finished. Artifacts are in ${DATA_DIR}"
