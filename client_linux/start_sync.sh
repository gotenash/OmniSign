#!/bin/bash
# Script de lancement du moteur de synchronisation OmniSign pour Linux

# Naviguer vers le dossier contenant le script
cd "$(dirname "$0")"

# Charger NVM si présent dans le home de l'utilisateur pour trouver node
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    \. "$NVM_DIR/nvm.sh"
fi

# Trouver le binaire node
NODE_BIN=$(command -v node || command -v nodejs || which node)

if [ -z "$NODE_BIN" ]; then
    echo "[$(date '+%d/%m/%Y %H:%M:%S')] ❌ Erreur : Node.js n'a pas été trouvé. Assurez-vous qu'il est installé." >> sync-engine.log
    exit 1
fi

echo "[$(date '+%d/%m/%Y %H:%M:%S')] 🚀 Démarrage du moteur de synchronisation avec $NODE_BIN..." >> sync-engine.log
exec "$NODE_BIN" sync-engine.js >> sync-engine.log 2>&1
