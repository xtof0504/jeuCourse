#!/usr/bin/env bash
# Installe (ou met à jour) le serveur jeuCourse comme service systemd.
# À lancer sur le serveur Linux, depuis le dossier du dépôt :
#     bash deploy/install-service.sh
# Le service tourne avec l'utilisateur qui lance ce script (pas root).
set -euo pipefail

SERVICE_NAME=jeucourse
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
    echo "Erreur : Node.js n'est pas installé (commande 'node' introuvable)." >&2
    exit 1
fi
if [ "$RUN_USER" = "root" ]; then
    echo "Erreur : lancez ce script avec votre utilisateur normal (il utilisera sudo lui-même)." >&2
    exit 1
fi
if [ ! -f "$DIR/server.js" ]; then
    echo "Erreur : server.js introuvable dans $DIR." >&2
    exit 1
fi

echo "Dossier du jeu : $DIR"
echo "Utilisateur    : $RUN_USER"
echo "Node.js        : $NODE_BIN ($("$NODE_BIN" --version))"

# Dépendances du serveur
(cd "$DIR" && npm install --omit=dev --no-audit --no-fund)

# Fichier de service avec les bonnes valeurs
TMP="$(mktemp)"
sed -e "s#__USER__#$RUN_USER#g" -e "s#__DIR__#$DIR#g" -e "s#__NODE__#$NODE_BIN#g" \
    "$DIR/deploy/jeucourse.service" > "$TMP"
sudo install -m 644 "$TMP" "/etc/systemd/system/$SERVICE_NAME.service"
rm -f "$TMP"

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

sleep 2
sudo systemctl --no-pager status "$SERVICE_NAME" | head -n 12
echo
echo "Service '$SERVICE_NAME' installé : il démarre avec la machine et redémarre s'il plante."
echo "  État        : sudo systemctl status $SERVICE_NAME"
echo "  Redémarrer  : sudo systemctl restart $SERVICE_NAME"
echo "  Arrêter     : sudo systemctl stop $SERVICE_NAME"
echo "  Messages    : journalctl -u $SERVICE_NAME -f"
