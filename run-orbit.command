#!/bin/bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js LTS, then run this file again."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing ORBIT dependencies..."
  npm install
fi
npm start
