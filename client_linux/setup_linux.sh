#!/bin/bash
# Script d'installation OmniSign Client pour Linux (Mint, Ubuntu, Debian, etc.)

echo "=== Installation du Client OmniSign pour Linux ==="

# 1. Vérification que le script n'est pas lancé en root direct (besoin de l'utilisateur de session pour l'autostart)
if [ "$EUID" -eq 0 ]; then
    echo "⚠️ Ne lancez pas ce script avec 'sudo' directement !"
    echo "Lancez-le en tant qu'utilisateur standard : ./setup_linux.sh"
    exit 1
fi

# 2. Installation des paquets système requis
echo "📦 Installation des dépendances système..."
sudo apt update
sudo apt install -y nodejs npm unclutter curl alsa-utils x11-xserver-utils scrot grim

# Installer google-chrome ou chromium si non présent
if ! command -v google-chrome &>/dev/null && ! command -v chromium-browser &>/dev/null && ! command -v chromium &>/dev/null; then
    echo "🌐 Aucun navigateur compatible trouvé. Installation de Chromium..."
    sudo apt install -y chromium-browser || sudo apt install -y chromium
fi

# 3. Installation des modules Node.js locaux
echo "📦 Installation des dépendances Node.js du client..."
cd "$(dirname "$0")"
NODE_OPTIONS="--dns-result-order=ipv4first" npm install socket.io-client axios fs-extra

# Rendre les scripts de lancement exécutables
chmod +x start_player.sh
chmod +x start_sync.sh

# Convertir les fins de ligne CRLF (Windows) en LF (Linux) pour éviter les erreurs d'interpréteur
sed -i 's/\r$//' start_player.sh 2>/dev/null
sed -i 's/\r$//' start_sync.sh 2>/dev/null
sed -i 's/\r$//' installer_linux.sh 2>/dev/null

# 4. Configuration du lancement automatique (Autostart Bureau)
echo "⚙️ Configuration du démarrage automatique de la session..."
AUTOSTART_DIR="$HOME/.config/autostart"
mkdir -p "$AUTOSTART_DIR"

# Nettoyer les anciennes configurations pour éviter le lancement en double
rm -f "$AUTOSTART_DIR/omnisign.desktop"
rm -f "$AUTOSTART_DIR/omnisign-player.desktop"
rm -f "$AUTOSTART_DIR/omnisign-sync.desktop"
rm -f "$AUTOSTART_DIR/pidyn.desktop"
rm -f "$AUTOSTART_DIR/pidyn-player.desktop"
rm -f "$AUTOSTART_DIR/pidyn-sync.desktop"

# Créer l'autostart pour le moteur de synchronisation OmniSign Sync
cat <<EOF > "$AUTOSTART_DIR/omnisign-sync.desktop"
[Desktop Entry]
Type=Application
Exec=$(pwd)/start_sync.sh
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
Name=OmniSign Sync Engine
Comment=Moteur de synchronisation OmniSign
EOF

# Créer l'autostart pour le Player d'affichage
cat <<EOF > "$AUTOSTART_DIR/omnisign-player.desktop"
[Desktop Entry]
Type=Application
Exec=$(pwd)/start_player.sh
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
Name=OmniSign Player
Comment=Navigateur Kiosk d'affichage OmniSign
EOF

echo "✅ Installation terminée avec succès !"
echo "⚙️ Veuillez configurer le fichier $(pwd)/setup.txt avec les informations de votre serveur."
echo "🔄 Au prochain démarrage de la session (ou redémarrage du PC), l'affichage dynamique démarrera automatiquement."
echo "💡 Pour lancer manuellement le client maintenant, exécutez dans deux terminaux :"
echo "   1) $(pwd)/start_sync.sh"
echo "   2) $(pwd)/start_player.sh"
