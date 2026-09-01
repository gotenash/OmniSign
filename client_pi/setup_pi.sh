#!/bin/bash

# Détection automatique de la partition de boot (Bookworm utilise /boot/firmware)
BOOT_DIR="/boot"
[ -d "/boot/firmware" ] && BOOT_DIR="/boot/firmware"

# Fichier de configuration à lire
SETUP_FILE="$BOOT_DIR/setup.txt"

# Détecter l'utilisateur non-root qui exécute le script (ou l'utilisateur d'origine si lancé avec sudo)
SUDO_USER_DETECTED=${SUDO_USER:-$(whoami)}
if [ "$SUDO_USER_DETECTED" = "root" ]; then
    SUDO_USER_DETECTED=$(logname 2>/dev/null || echo $USER)
    if [ "$SUDO_USER_DETECTED" = "root" ]; then
        SUDO_USER_DETECTED=$(awk -F: '$3 >= 1000 && $3 != 65534 {print $1; exit}' /etc/passwd)
    fi
fi
SUDO_USER_DETECTED=${SUDO_USER_DETECTED:-"pi"}

# Obtenir le home directory de cet utilisateur
USER_HOME=$(eval echo "~$SUDO_USER_DETECTED")
INSTALL_DIR="$USER_HOME/omnisign"

# Fichier de log pour le setup
LOG_FILE="/var/log/omnisign_setup.log"

# --- Fonctions utilitaires ---
log_message() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

error_exit() {
    log_message "ERREUR: $1"
    exit 1
}

# --- Début du script ---
log_message "Démarrage de la procédure de setup OmniSign..."

# 1. Vérifier si le fichier setup.txt existe
if [ ! -f "$SETUP_FILE" ]; then
    error_exit "Le fichier de configuration $SETUP_FILE est introuvable. Veuillez le créer."
fi

# 2. Lire les variables du fichier setup.txt
log_message "Lecture du fichier de configuration $SETUP_FILE..."

# Fonction pour extraire proprement les valeurs (gère les retours à la ligne Windows \r et les guillemets)
get_config_value() {
    grep "^$1=" "$SETUP_FILE" | cut -d'=' -f2- | tr -d '\r' | tr -d '"' | tr -d "'"
}

# Vérifier que les variables essentielles sont définies
DEVICE_ID=$(get_config_value "DEVICE_ID")
SERVER_URL=$(get_config_value "SERVER_URL")
API_KEY=$(get_config_value "API_KEY")

if [ -z "$DEVICE_ID" ] || [ -z "$SERVER_URL" ] || [ -z "$API_KEY" ]; then
    error_exit "Les variables DEVICE_ID, SERVER_URL ou API_KEY ne sont pas définies dans $SETUP_FILE."
fi

log_message "Configuration lue : DEVICE_ID=$DEVICE_ID, SERVER_URL=$SERVER_URL, API_KEY=********"

# 3. Mettre à jour le système et installer les dépendances
log_message "Mise à jour de la liste des paquets..."
sudo apt-get update -y || error_exit "Échec de la mise à jour des paquets."

# Installer Node.js (si non déjà présent)
if ! command -v node &> /dev/null; then
    log_message "Installation de Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - || error_exit "Échec du téléchargement du script NodeSource."
    sudo apt-get install -y nodejs || error_exit "Échec de l'installation de Node.js."
fi

# Installer Chromium, X11 et les dépendances système (y compris outils de gestion d'écran DPMS/Wayland/CEC)
sudo apt-get install -y --no-install-recommends xserver-xorg x11-xserver-utils xinit lightdm openbox chromium-browser unclutter wireless-tools scrot python3-xdg \
    fonts-noto fonts-noto-color-emoji fonts-liberation fonts-roboto cec-utils wlr-randr wlopm grim || sudo apt-get install -y --no-install-recommends chromium xserver-xorg x11-xserver-utils xinit lightdm openbox unclutter wireless-tools scrot python3-xdg fonts-noto fonts-noto-color-emoji fonts-liberation fonts-roboto cec-utils wlr-randr wlopm grim || error_exit "Échec de l'installation."

# 1. Augmenter le SWAP à 1024Mo (Crucial pour éviter l'Error 4 sur Pi Lite)
log_message "Augmentation de la taille du SWAP à 1024Mo..."
sudo apt-get install -y dphys-swapfile
sudo sed -i 's/^#*CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
sudo systemctl restart dphys-swapfile

# 1b. Désactiver l'alerte RAM < 1Go de Raspberry Pi OS (Spécifique Pi Zero)
if [ -f "/usr/bin/chromium-browser" ]; then
    sudo sed -i 's/line_warning 1024/#line_warning 1024/g' /usr/bin/chromium-browser 2>/dev/null
fi

# 2. Optimisation GPU (128Mo pour Pi 3)
if grep -q "^#*gpu_mem=" "$BOOT_DIR/config.txt"; then
    sudo sed -i 's/^#*gpu_mem=.*/gpu_mem=128/' "$BOOT_DIR/config.txt"
else
    echo "gpu_mem=128" | sudo tee -a "$BOOT_DIR/config.txt"
fi

# 2b. S'assurer que le driver KMS est activé (essentiel pour l'accélération matérielle)
if ! grep -q "^dtoverlay=vc4-kms-v3d" "$BOOT_DIR/config.txt"; then
    log_message "Activation du driver KMS (vc4-kms-v3d) dans config.txt..."
    echo "dtoverlay=vc4-kms-v3d" | sudo tee -a "$BOOT_DIR/config.txt"
fi

# 3. Installation de polices
if [ -d "$BOOT_DIR/fonts" ]; then
    sudo mkdir -p /usr/local/share/fonts/omnisign
    sudo cp "$BOOT_DIR/fonts"/*.{ttf,otf} /usr/local/share/fonts/omnisign/ 2>/dev/null
    sudo fc-cache -f -v
fi

# Déterminer le chemin vers le wrapper Chromium officiel (nécessaire pour charger les configurations d'accélération graphique de Pi OS)
CHROMIUM_BIN="/usr/bin/chromium-browser"
[ ! -f "$CHROMIUM_BIN" ] && CHROMIUM_BIN=$(command -v chromium-browser || command -v chromium)

# 4. Préparer le dossier de l'application
log_message "Préparation du dossier d'installation $INSTALL_DIR..."
sudo mkdir -p "$INSTALL_DIR" || error_exit "Échec de la création du dossier $INSTALL_DIR."

# Si le script de setup n'est pas déjà dans le dossier final, copier tous les fichiers
if [ "$(cd "$(dirname "$0")" && pwd)" != "$(cd "$INSTALL_DIR" && pwd)" ]; then
    log_message "Copie des fichiers de l'application vers $INSTALL_DIR..."
    sudo cp -r "$(dirname "$0")"/* "$INSTALL_DIR/" || error_exit "Échec de la copie des fichiers vers $INSTALL_DIR."
fi

sudo chown -R $SUDO_USER_DETECTED:$SUDO_USER_DETECTED "$INSTALL_DIR" || error_exit "Échec du changement de propriétaire du dossier $INSTALL_DIR."

# 5. Installer les dépendances Node.js
log_message "Installation des dépendances Node.js pour OmniSign..."
cd "$INSTALL_DIR" || error_exit "Impossible de naviguer vers $INSTALL_DIR."
# On force l'installation de socket.io-client pour éviter les modules manquants
sudo -u $SUDO_USER_DETECTED npm install socket.io-client axios fs-extra || error_exit "Échec de l'installation des dépendances npm."

# 6. Configurer le service systemd pour sync-engine.js
log_message "Configuration du service systemd pour sync-engine.js..."
cat <<EOF | sudo tee /etc/systemd/system/omnisign-sync.service > /dev/null
[Unit]
Description=OmniSign Sync Engine
After=network.target

[Service]
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node $INSTALL_DIR/sync-engine.js
Restart=always
User=$SUDO_USER_DETECTED
Environment="PIDYN_DEVICE_ID=$DEVICE_ID"
Environment="PIDYN_SERVER_URL=$SERVER_URL"
Environment="PIDYN_API_KEY=$API_KEY"

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable omnisign-sync.service
sudo systemctl restart omnisign-sync.service

# 7. Configurer le démarrage automatique via le script start_player
log_message "Configuration du démarrage automatique du joueur via start_player.sh..."

# Création du dossier d'autostart si inexistant
mkdir -p "$USER_HOME/.config/autostart"

cat <<EOF > "$USER_HOME/.config/autostart/omnisign.desktop"
[Desktop Entry]
Type=Application
Name=OmniSign Player
Exec=$INSTALL_DIR/start_player.sh
EOF

chown $SUDO_USER_DETECTED:$SUDO_USER_DETECTED "$USER_HOME/.config/autostart/omnisign.desktop"
chmod +x "$USER_HOME/.config/autostart/omnisign.desktop"
# 8. Nettoyage et finalisation
log_message "Configuration forcée de LightDM pour l'auto-login..."
sudo groupadd -r autologin 2>/dev/null
sudo gpasswd -a $SUDO_USER_DETECTED autologin
sudo mkdir -p /etc/lightdm/lightdm.conf.d
cat <<EOF | sudo tee /etc/lightdm/lightdm.conf.d/01-autologin.conf > /dev/null
[Seat:*]
autologin-user=$SUDO_USER_DETECTED
autologin-user-timeout=0
user-session=openbox
EOF

log_message "Configuration du démarrage automatique sur le bureau (Autologin)..."
log_message "Désactivation de la mise en veille système (raspi-config & cmdline.txt)..."
sudo raspi-config nonint do_blanking 0

# Désactiver la mise en veille du noyau Linux (consoleblank=0 dans cmdline.txt)
CMDLINE_FILE="$BOOT_DIR/cmdline.txt"
if [ -f "$CMDLINE_FILE" ] && ! grep -q "consoleblank=0" "$CMDLINE_FILE"; then
    sudo sed -i 's/$/ consoleblank=0/' "$CMDLINE_FILE"
fi

# Configurer Openbox pour interdire DPMS et l'écran noir au démarrage de session
mkdir -p "$USER_HOME/.config/openbox"
cat <<EOF > "$USER_HOME/.config/openbox/autostart"
xset s off &
xset -dpms &
xset s noblank &
EOF
chown -R $SUDO_USER_DETECTED:$SUDO_USER_DETECTED "$USER_HOME/.config/openbox"

sudo systemctl set-default graphical.target
sudo raspi-config nonint do_boot_behaviour B4 || log_message "Avertissement : Impossible de configurer l'autologin via raspi-config."

# Sécurité supplémentaire : Conversion LF des scripts et forçage des droits sur le dossier OmniSign
find "$INSTALL_DIR" -name "*.sh" -exec sed -i 's/\r$//' {} +
sudo chown -R $SUDO_USER_DETECTED:$SUDO_USER_DETECTED "$INSTALL_DIR"
sudo chmod -R 755 "$INSTALL_DIR"

# Nettoyage de toute ancienne planification de veille (DPMS)
TMP_CRON="/tmp/omnisign_cron"
sudo -u $SUDO_USER_DETECTED crontab -l 2>/dev/null | grep -v "xset dpms" > "$TMP_CRON" || echo "" > "$TMP_CRON"
sudo -u $SUDO_USER_DETECTED crontab "$TMP_CRON" && rm "$TMP_CRON"
sync

log_message "Nettoyage du fichier de setup..."
# sudo rm "$SETUP_FILE" # Commenté pour permettre de relancer le script si besoin

log_message "Procédure de setup OmniSign terminée. Redémarrage du système..."
sudo reboot