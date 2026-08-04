#!/bin/bash
# Configuration pour le lancement à distance (SSH) sur l'écran physique local
if [ -n "$SSH_CLIENT" ] || [ -n "$SSH_TTY" ] || [ -n "$SSH_CONNECTION" ]; then
    export DISPLAY=:0
    USER_UID=$(id -u)
    MUTTER_AUTH=$(find /run/user/$USER_UID/ -name ".mutter-Xwaylandauth.*" 2>/dev/null | head -n 1)
    if [ -n "$MUTTER_AUTH" ]; then
        export XAUTHORITY="$MUTTER_AUTH"
    elif [ -f "/run/user/$USER_UID/gdm/Xauthority" ]; then
        export XAUTHORITY="/run/user/$USER_UID/gdm/Xauthority"
    elif [ -f "$HOME/.Xauthority" ]; then
        export XAUTHORITY="$HOME/.Xauthority"
    fi
fi

# Fallback de sécurité si DISPLAY n'est pas défini
if [ -z "$DISPLAY" ]; then
    export DISPLAY=:0
fi

export GNOME_KEYRING_CONTROL=1
export GNOME_KEYRING_PID=1
export SECRET_VAULT_PASSWORD=none


# Temporisation au démarrage si le système vient de booter
UPTIME=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 999)
if [ "$UPTIME" -lt 60 ]; then
    echo "⌛ Système démarré depuis ${UPTIME}s. Pause de 12s pour laisser l'affichage s'initialiser..."
    sleep 12
fi


# Tuer swayidle ou tout processus de mise en veille automatique Wayland
pkill -f swayidle 2>/dev/null

# Désactiver la mise en veille X11 (DPMS, economiseur d'écran et écran noir)
xset s off 2>/dev/null
xset -dpms 2>/dev/null
xset s noblank 2>/dev/null
xset s 0 0 2>/dev/null

# Désactiver la mise en veille sous Wayland
if command -v wlopm &> /dev/null; then
    wlopm --on '*' 2>/dev/null
fi

# Boucle d'arrière-plan de maintien d'éveil (Anti-Sleep Watchdog)
(
    while true; do
        sleep 45
        xset s off 2>/dev/null
        xset -dpms 2>/dev/null
        xset s noblank 2>/dev/null
        if command -v wlopm &> /dev/null; then
            wlopm --on '*' 2>/dev/null
        fi
    done
) &

# Masquer le curseur de la souris (géré proprement via unclutter)
pkill -x unclutter 2>/dev/null
sleep 0.1
unclutter -idle 0.5 -root >/dev/null 2>&1 &

# Déterminer le dossier profil Chrome de l'utilisateur actif
PROFILE_DIR="$HOME/pidyn_chrome_profile"

# Nettoyage préventif du verrou de session Chromium
if [ -d "$PROFILE_DIR" ]; then
    find "$PROFILE_DIR" -name 'SingletonLock' -delete 2>/dev/null
    rm -rf "$PROFILE_DIR/Default/Cache" 2>/dev/null
    rm -rf "$PROFILE_DIR/Default/Code Cache" 2>/dev/null
fi

# Temporisation active : on attend que le serveur Node.js local réponde sur le port 8080
# avec une limite de sécurité de 30 secondes
SERVER_READY=false
for i in {1..30}; do
    if curl -s -o /dev/null http://127.0.0.1:8080/player; then
        SERVER_READY=true
        break
    fi
    sleep 1
done

if [ "$SERVER_READY" = false ]; then
    echo "⚠️ Le moteur de synchronisation (sync-engine.js) ne semble pas être lancé sur le port 8080."
    echo "   Veuillez vous assurer que 'node sync-engine.js' est bien démarré dans un autre terminal."
    echo "   Lancement de Chromium quand même..."
fi

# Récupération automatique du binaire Chromium / Chrome packagé par l'OS
CHROMIUM_BIN=$(command -v google-chrome || command -v chromium-browser || command -v chromium)

if [ -z "$CHROMIUM_BIN" ]; then
    echo "ERREUR : Aucun navigateur compatible (Google Chrome ou Chromium) n'a été trouvé."
    exit 1
fi

# Détection et configuration pour Wayland (particulièrement sous Ubuntu/Debian moderne)
EXTRA_FLAGS=""
if [ -n "$WAYLAND_DISPLAY" ] || [ "$XDG_SESSION_TYPE" = "wayland" ]; then
    # --disable-gpu est recommandé si l'écran reste blanc ou si l'accélération matérielle est inactive
    EXTRA_FLAGS="--ozone-platform=wayland --enable-features=UseOzonePlatform --use-gl=egl --disable-gpu"
else
    EXTRA_FLAGS="--disable-gpu"
fi

# Lancement de Chrome/Chromium en mode Kiosk épuré et performant avec journalisation vers chromium.log
$CHROMIUM_BIN \
  $EXTRA_FLAGS \
  --kiosk \
  --autoplay-policy=no-user-gesture-required \
  --password-store=basic \
  --use-mock-keychain \
  --user-data-dir="$PROFILE_DIR" \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-session-crashed-bubble \
  --disable-restart-bubble \
  --disable-dev-shm-usage \
  --js-flags='--max-old-space-size=512' \
  --enable-logging=stderr --v=1 \
  'http://127.0.0.1:8080/player' > "$(dirname "$0")/chromium.log" 2>&1
