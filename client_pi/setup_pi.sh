#!/bin/bash

# Détection automatique de la partition de boot (Bookworm utilise /boot/firmware)
BOOT_DIR="/boot"
[ -d "/boot/firmware" ] && BOOT_DIR="/boot/firmware"

# Fichier de configuration à lire
SETUP_FILE="$BOOT_DIR/setup.txt"

# Dossier d'installation de l'application PiDyn
INSTALL_DIR="/home/pi/pidyn"

# Fichier de log pour le setup
LOG_FILE="/var/log/pidyn_setup.log"

# --- Fonctions utilitaires ---
log_message() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

error_exit() {
    log_message "ERREUR: $1"
    exit 1
}

# --- Début du script ---
log_message "Démarrage de la procédure de setup PiDyn..."

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

# Installer Chromium, X11 et les dépendances système
sudo apt-get install -y --no-install-recommends xserver-xorg x11-xserver-utils xinit lightdm openbox chromium-browser unclutter wireless-tools scrot python3-xdg \
    fonts-noto fonts-noto-color-emoji fonts-liberation fonts-roboto || sudo apt-get install -y --no-install-recommends chromium xserver-xorg x11-xserver-utils xinit lightdm openbox unclutter wireless-tools scrot python3-xdg fonts-noto fonts-noto-color-emoji fonts-liberation fonts-roboto || error_exit "Échec de l'installation."

# 1. Augmenter le SWAP à 1024Mo (Crucial pour éviter l'Error 4 sur Pi Lite)
log_message "Augmentation de la taille du SWAP à 1024Mo..."
sudo sed -i 's/^#*CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
sudo systemctl restart dphys-swapfile

# 2. Optimisation GPU (128Mo minimum)
sudo sed -i 's/^gpu_mem=.*/gpu_mem=128/' "$BOOT_DIR/config.txt" || echo "gpu_mem=128" | sudo tee -a "$BOOT_DIR/config.txt"

# 3. Installation de polices
if [ -d "$BOOT_DIR/fonts" ]; then
    sudo mkdir -p /usr/local/share/fonts/pidyn
    sudo cp "$BOOT_DIR/fonts"/*.{ttf,otf} /usr/local/share/fonts/pidyn/ 2>/dev/null
    sudo fc-cache -f -v
fi

# Déterminer dynamiquement le binaire Chromium
CHROMIUM_BIN=$(command -v chromium-browser || command -v chromium)

# 4. Préparer le dossier de l'application
log_message "Préparation du dossier d'installation $INSTALL_DIR..."
sudo mkdir -p "$INSTALL_DIR" || error_exit "Échec de la création du dossier $INSTALL_DIR."
sudo chown -R pi:pi "$INSTALL_DIR" || error_exit "Échec du changement de propriétaire du dossier $INSTALL_DIR."

# 5. Installer les dépendances Node.js
log_message "Installation des dépendances Node.js pour PiDyn..."
cd "$INSTALL_DIR" || error_exit "Impossible de naviguer vers $INSTALL_DIR."
# On force l'installation de socket.io-client pour éviter les modules manquants
sudo -u pi npm install socket.io-client axios fs-extra || error_exit "Échec de l'installation des dépendances npm."

# 6. Configurer le service systemd pour sync-engine.js
log_message "Configuration du service systemd pour sync-engine.js..."
cat <<EOF | sudo tee /etc/systemd/system/pidyn-sync.service > /dev/null
[Unit]
Description=PiDyn Sync Engine
After=network.target

[Service]
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node $INSTALL_DIR/sync-engine.js
Restart=always
User=pi
Environment="PIDYN_DEVICE_ID=$DEVICE_ID"
Environment="PIDYN_SERVER_URL=$SERVER_URL"
Environment="PIDYN_API_KEY=$API_KEY"

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable pidyn-sync.service
sudo systemctl restart pidyn-sync.service

# 7. Configurer le démarrage automatique du navigateur en mode kiosque
log_message "Configuration du démarrage automatique du navigateur en mode kiosque..."
# Configuration spécifique pour Openbox (plus fiable)
sudo mkdir -p /home/pi/.config/openbox
sudo chown -R pi:pi /home/pi/.config

cat <<EOF | sudo tee /home/pi/.config/openbox/autostart > /dev/null
# Désactiver la mise en veille et l'économiseur d'écran (X11)
xset s off
xset s noblank
xset -dpms
# Cacher le pointeur de la souris (plus efficace avec -grab pour les écrans tactiles)
unclutter -idle 0.5 -root &
# Nettoyer le profil Chrome pour éviter les corruptions de cache
rm -rf /home/pi/chrome_profile && mkdir -p /home/pi/chrome_profile
# Lancer Chromium sans barre d'erreur et en mode kiosque
export CHROME_DEVEL_SANDBOX=/usr/local/sbin/chrome-devel-sandbox
export DISPLAY=:0
$CHROMIUM_BIN --no-sandbox --disable-dev-shm-usage --noerrdialogs --disable-infobars --kiosk \
  --allow-file-access-from-files --disable-features=Translate --autoplay-policy=no-user-gesture-required \
  --user-data-dir="/home/pi/chrome_profile" --disk-cache-size=1 --media-cache-size=1 \
  --disable-background-networking --disable-sync --no-first-run --disable-component-update \
  --disable-gpu --disable-software-rasterizer --disable-gpu-compositing --js-flags="--max-old-space-size=256" \
  "file://${INSTALL_DIR}/player.html" &
EOF
sudo chown pi:pi /home/pi/.config/openbox/autostart
sudo chmod +x /home/pi/.config/openbox/autostart

# 8. Nettoyage et finalisation
log_message "Configuration forcée de LightDM pour l'auto-login..."
sudo groupadd -r autologin 2>/dev/null
sudo gpasswd -a pi autologin
sudo mkdir -p /etc/lightdm/lightdm.conf.d
cat <<EOF | sudo tee /etc/lightdm/lightdm.conf.d/01-autologin.conf > /dev/null
[Seat:*]
autologin-user=pi
autologin-user-timeout=0
user-session=openbox
EOF

log_message "Configuration du démarrage automatique sur le bureau (Autologin)..."
log_message "Désactivation de la mise en veille système (raspi-config)..."
sudo raspi-config nonint do_blanking 0

sudo systemctl set-default graphical.target
sudo raspi-config nonint do_boot_behaviour B4 || log_message "Avertissement : Impossible de configurer l'autologin via raspi-config."

# Sécurité supplémentaire : On force les droits sur tout le dossier PiDyn
sudo chown -R pi:pi "$INSTALL_DIR"
sudo chmod -R 755 "$INSTALL_DIR"

# Nettoyage de toute ancienne planification de veille (DPMS)
TMP_CRON="/tmp/pidyn_cron"
sudo -u pi crontab -l 2>/dev/null | grep -v "xset dpms" > "$TMP_CRON" || echo "" > "$TMP_CRON"
sudo -u pi crontab "$TMP_CRON" && rm "$TMP_CRON"
sync

log_message "Nettoyage du fichier de setup..."
# sudo rm "$SETUP_FILE" # Commenté pour permettre de relancer le script si besoin

log_message "Procédure de setup PiDyn terminée. Redémarrage du système..."
sudo reboot