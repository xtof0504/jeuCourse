#!/usr/bin/env bash
# Met à jour le serveur jeuCourse depuis GitHub puis redémarre le service.
# À lancer sur le serveur Linux, depuis le dossier du dépôt :
#     bash deploy/update.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

git pull --ff-only
npm install --omit=dev --no-audit --no-fund
sudo systemctl restart jeucourse

sleep 2
sudo systemctl --no-pager status jeucourse | head -n 8
