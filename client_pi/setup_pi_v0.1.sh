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
source "$SETUP_FILE"

# Vérifier que les variables essentielles sont définies
: "${DEVICE_ID?}"
: "${SERVER_URL?}"
: "${API_KEY?}"

if [ -z "$DEVICE_ID" ] || [ -z "$SERVER_URL" ] || [ -z "$API_KEY" ]; then
    error_exit "Les variables DEVICE_ID, SERVER_URL ou API_KEY ne sont pas définies dans $SETUP_FILE."
fi

log_message "Configuration lue : DEVICE_ID=$DEVICE_ID, SERVER_URL=$SERVER_URL, API_KEY=********"

# 3. Mettre à jour le système et installer les dépendances
log_message "Mise à jour du système et installation des dépendances (Node.js, Chromium, X11)..."
sudo apt-get update -y || error_exit "Échec de la mise à jour des paquets."
sudo apt-get upgrade -y || log_message "Échec de la mise à jour du système (peut être ignoré si mineur)."

# Installer Node.js (si non déjà présent)
if ! command -v node &> /dev/null; then
    log_message "Installation de Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - || error_exit "Échec du téléchargement du script NodeSource."
    sudo apt-get install -y nodejs || error_exit "Échec de l'installation de Node.js."
fi

# Installer Chromium, X11 et un gestionnaire de fenêtres minimal (Openbox + LightDM)
sudo apt-get install -y xserver-xorg x11-xserver-utils xinit lightdm openbox chromium unclutter || error_exit "Échec de l'installation des composants graphiques."

# 4. Préparer le dossier de l'application
log_message "Préparation du dossier d'installation $INSTALL_DIR..."
sudo mkdir -p "$INSTALL_DIR" || error_exit "Échec de la création du dossier $INSTALL_DIR."
sudo chown -R pi:pi "$INSTALL_DIR" || error_exit "Échec du changement de propriétaire du dossier $INSTALL_DIR."

# Copier les fichiers de l'application (supposant qu'ils sont dans /boot/pidyn_client)
# Il faudrait que vous copiiez le contenu de votre dossier client ici avant de flasher l'image
log_message "Copie des fichiers de l'application..."
cp -r "$BOOT_DIR/pidyn_client/"* "$INSTALL_DIR/" || error_exit "Échec de la copie des fichiers de l'application depuis $BOOT_DIR/pidyn_client."

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
mkdir -p /home/pi/.config/openbox
cat <<EOF | tee /home/pi/.config/openbox/autostart > /dev/null
# Désactiver la mise en veille et l'économiseur d'écran (X11)
xset s off
xset s noblank
xset -dpms

# Cacher le pointeur de la souris après 5s d'inactivité
unclutter -idle 5 &

# Lancer Chromium sans barre d'erreur et en mode kiosque
/usr/bin/chromium \\
  --noerrdialogs \\
  --disable-infobars \\
  --allow-file-access-from-files \
  --kiosk \\
  --check-for-update-interval=31536000 \\
  --user-data-dir="/home/pi/chrome_profile" \\
  "file://$INSTALL_DIR/player.html" &
EOF
chown pi:pi /home/pi/.config/openbox/autostart
chmod +x /home/pi/.config/openbox/autostart

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
sudo raspi-config nonint do_blanking 1

sudo systemctl set-default graphical.target
sudo raspi-config nonint do_boot_behaviour B4 || log_message "Avertissement : Impossible de configurer l'autologin via raspi-config."

log_message "Configuration de la planification de l'écran (On: 07:00, Off: 22:00)..."
# On utilise crontab pour piloter xset. DISPLAY=:0 est nécessaire pour cibler la session graphique.
OFF_TIME="0 22 * * *"
ON_TIME="0 7 * * *"
# Supprimer les anciennes entrées xset si elles existent pour éviter les doublons
CURRENT_CRON=$(sudo -u pi crontab -l 2>/dev/null | grep -v "xset dpms")
echo -e "${CURRENT_CRON}\n${OFF_TIME} export DISPLAY=:0 && xset dpms force off\n${ON_TIME} export DISPLAY=:0 && xset dpms force on" | sudo -u pi crontab -

log_message "Nettoyage du fichier de setup..."
sudo rm "$SETUP_FILE" # Supprimer le fichier de setup pour éviter une re-configuration

log_message "Procédure de setup PiDyn terminée. Redémarrage du système..."
sudo reboot
```

---

### 3. Fichier de configuration `setup.txt` (exemple)

Ce fichier devra être placé à la racine de la partition `boot` de la carte SD du Raspberry Pi.