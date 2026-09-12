#!/bin/zsh
set -euo pipefail

repo_root=${0:A:h:h}
runtime_root="${HOME}/Library/Application Support/Portanahung/runtime"

/bin/mkdir -p "${runtime_root}/collector"
/usr/bin/rsync -a \
  --exclude '.env' \
  --exclude '__pycache__' \
  "${repo_root}/collector/" \
  "${runtime_root}/collector/"

/opt/homebrew/bin/python3 -m venv --clear "${runtime_root}/.venv"
"${runtime_root}/.venv/bin/pip" install --disable-pip-version-check \
  -r "${runtime_root}/collector/requirements.txt"

echo "Collector runtime installed at ${runtime_root}"
