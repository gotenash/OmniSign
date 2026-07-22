#!/bin/bash
# Script d'installation du Serveur OmniSign pour Linux

# Couleurs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;36m'
NC='\033[0m' # Pas de couleur

clear
echo "============================================================"
echo -e "${GREEN}        ASSISTANT D'INSTALLATION DU SERVEUR OMNISIGN${NC}"
echo "============================================================"
echo ""
echo "  Cet assistant va installer les composants requis et configurer"
echo "  votre serveur de diffusion dynamique OmniSign sur Linux."
echo ""

# 1. Vérification que le script n'est pas lancé en root direct
if [ "$EUID" -eq 0 ]; then
    echo -e "${RED}⚠️ Ne lancez pas ce script avec 'sudo' directement !${NC}"
    echo "Lancez-le en tant qu'utilisateur standard : ./setup_server.sh"
    exit 1
fi

echo "------------------------------------------------------------"
echo -e "${BLUE} Etape 1/3 : Installation des dépendances système (sudo requis)${NC}"
echo "------------------------------------------------------------"

# Demander le mot de passe sudo dès le départ
sudo -v || exit 1

echo -e "${GREEN}[INFO] Mise à jour des paquets système...${NC}"
sudo apt update

echo -e "${GREEN}[INFO] Installation de Node.js, npm, ffmpeg, poppler-utils, libreoffice et yt-dlp...${NC}"
sudo apt install -y nodejs npm ffmpeg poppler-utils libreoffice yt-dlp curl

# Vérification de l'installation de Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}[ERREUR] L'installation de Node.js a échoué. Veuillez l'installer manuellement.${NC}"
    exit 1
fi

NODE_VERSION=$(node -v)
echo -e "${GREEN}[OK] Node.js est bien installé (${NODE_VERSION}).${NC}"

echo ""
echo "------------------------------------------------------------"
echo -e "${BLUE} Etape 2/3 : Installation des dépendances Node.js${NC}"
echo "------------------------------------------------------------"
echo " Veuillez patienter pendant le téléchargement des modules..."
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/server" || cd "$SCRIPT_DIR" || exit 1

# Installation npm
npm install
if [ $? -ne 0 ]; then
    echo -e "${RED}[ERREUR] Des erreurs sont survenues lors de l'installation npm.${NC}"
    echo "Veuillez vérifier votre connexion internet et réessayer."
    exit 1
fi

echo -e "${GREEN}[INFO] Initialisation de la base de données...${NC}"
node server.js --init-only

ADMIN_PWD=""
if [ -f "admin_password.txt" ]; then
    ADMIN_PWD=$(cat admin_password.txt)
fi

echo ""
echo -e "${GREEN}[OK] Toutes les dépendances Node.js ont été installées avec succès.${NC}"
echo ""

echo "------------------------------------------------------------"
echo -e "${BLUE} Etape 3/3 : Création du raccourci sur le Bureau${NC}"
echo "------------------------------------------------------------"

LAUNCHER_SCRIPT="$SCRIPT_DIR/Lancer_OmniSign.sh"
chmod +x "$LAUNCHER_SCRIPT"

DESKTOP_DIR="$HOME/Desktop"
# Gérer le bureau en français et en anglais
if [ ! -d "$DESKTOP_DIR" ]; then
    DESKTOP_DIR="$HOME/Bureau"
fi

if [ -d "$DESKTOP_DIR" ]; then
    DESKTOP_FILE="$DESKTOP_DIR/OmniSign_Serveur.desktop"
    cat <<EOF > "$DESKTOP_FILE"
[Desktop Entry]
Version=1.0
Type=Application
Terminal=true
Name=OmniSign Serveur
Comment=Lancer le serveur OmniSign
Exec="$LAUNCHER_SCRIPT"
Icon=utilities-terminal
Categories=Application;
EOF
    chmod +x "$DESKTOP_FILE"
    # Pour certains environnements de bureau modernes, Trust le fichier .desktop
    gio set "$DESKTOP_FILE" metadata::trusted true 2>/dev/null || true
    echo -e "${GREEN}[OK] Raccourci \"OmniSign Serveur\" créé sur votre Bureau (${DESKTOP_DIR}) !${NC}"
else
    echo -e "${YELLOW}[INFO] Dossier Bureau non trouvé. Aucun raccourci n'a été créé.${NC}"
fi

echo ""
echo "============================================================"
echo -e "${GREEN}          INSTALLATION DU SERVEUR TERMINÉE !${NC}"
echo "============================================================"
echo ""
if [ -n "$ADMIN_PWD" ]; then
    echo -e "  ${YELLOW}============================================================${NC}"
    echo -e "  ${YELLOW}            IDENTIFIANTS DE PREMIÈRE CONNEXION${NC}"
    echo -e "  "
    echo -e "    Utilisateur  : admin"
    echo -e "    Mot de passe : ${GREEN}${ADMIN_PWD}${NC}"
    echo -e "  "
    echo -e "    Note : Ce mot de passe est enregistré dans :"
    echo -e "    $(pwd)/admin_password.txt"
    echo -e "    Veuillez le modifier immédiatement après votre connexion !"
    echo -e "  ${YELLOW}============================================================${NC}"
    echo ""
fi
echo " Vous pouvez lancer le serveur à tout moment en exécutant :"
echo -e "   ${BLUE}./Lancer_OmniSign.sh${NC}"
echo " ou depuis le raccourci sur le Bureau."
echo ""

read -p "Voulez-vous démarrer le serveur OmniSign maintenant ? (O/N) : " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Oo]$ ]]; then
    echo "Démarrage du serveur..."
    "$LAUNCHER_SCRIPT"
else
    echo "Merci d'avoir installé OmniSign !"
fi
