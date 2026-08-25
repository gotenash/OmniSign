#!/bin/bash
# Assistant d'installation interactif pour Client Linux Desktop (Ubuntu/Mint/Debian) OmniSign

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

clear
echo -e "${BLUE}============================================================${NC}"
echo -e "${GREEN}    ASSISTANT D'INSTALLATION CLIENT LINUX OMNISIGN        ${NC}"
echo -e "${BLUE}============================================================${NC}"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_SETUP_FILE="$SCRIPT_DIR/setup.txt"

echo -e "${YELLOW}--- Etape 1/3 : Configuration du Serveur & Cle Ecran ---${NC}"
echo ""
echo "Le serveur OmniSign est-il sur votre reseau local (IP) ou un nom de domaine distant ?"
echo "  1) Serveur local (IP locale ex: 192.168.1.50)"
echo "  2) Serveur distant / Nom de domaine (ex: http://mon-serveur.local:3000)"
read -p "Votre choix (1 ou 2, defaut: 1) : " TYPE_SERVEUR
TYPE_SERVEUR=${TYPE_SERVEUR:-1}

if [ "$TYPE_SERVEUR" = "2" ]; then
    read -p "Entrez l'URL complete du serveur (ex: http://omnisign.local:3000) : " SERVER_URL
else
    read -p "Entrez l'adresse IP du serveur local (ex: 192.168.1.50) : " IP_SERVEUR
    read -p "Entrez le port du serveur (defaut: 3000) : " PORT_SERVEUR
    PORT_SERVEUR=${PORT_SERVEUR:-3000}
    SERVER_URL="http://${IP_SERVEUR}:${PORT_SERVEUR}"
fi

SERVER_URL=${SERVER_URL:-"http://localhost:3000"}

echo ""
read -p "Entrez la cle API de l'ecran (generee sur le serveur) : " API_KEY
API_KEY=${API_KEY:-"ma_cle_secrete_123"}

DEFAULT_DEV_ID="linux-$(hostname)"
echo ""
read -p "Entrez l'identifiant de cet ecran (defaut: ${DEFAULT_DEV_ID}) : " DEVICE_ID
DEVICE_ID=${DEVICE_ID:-$DEFAULT_DEV_ID}

echo ""
echo -e "${GREEN}[OK] Configuration enregistree :${NC}"
echo "     - Serveur : $SERVER_URL"
echo "     - Cle API : ********"
echo "     - ID Ecran: $DEVICE_ID"

# Generation du fichier setup.txt
cat <<EOF > "$LOCAL_SETUP_FILE"
SERVER_URL=$SERVER_URL
API_KEY=$API_KEY
DEVICE_ID=$DEVICE_ID
EOF

echo ""
echo -e "${YELLOW}--- Etape 2/3 : Lancement de l'installation systeme ---${NC}"
echo ""

# Lancement du script setup_linux.sh original
chmod +x "$SCRIPT_DIR/setup_linux.sh"
"$SCRIPT_DIR/setup_linux.sh"

echo ""
echo -e "${BLUE}============================================================${NC}"
echo -e "${GREEN}        INSTALLATION CLIENT LINUX TERMINÉE !             ${NC}"
echo -e "${BLUE}============================================================${NC}"
echo ""
read -p "Voulez-vous lancer le client d'affichage maintenant ? (O/N) : " START_NOW
if [[ "$START_NOW" =~ ^[Oo]$ ]]; then
    cd "$SCRIPT_DIR"
    ./start_sync.sh &
    ./start_player.sh
fi
