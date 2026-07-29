const { io } = require('socket.io-client');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const util = require('util');
const https = require('https');
const http = require('http');

const execPromise = util.promisify(exec);
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Tampon en mémoire pour les logs récents (recherche de bugs à distance)
const logBuffer = [];
const maxLogLines = 300;

// Ajout de l'horodatage aux logs du client
const originalLog = console.log;
console.log = (...args) => {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    const formatted = `[${new Date().toLocaleString()}] ${msg}`;
    try {
        originalLog(formatted);
    } catch (e) {
        // Ignorer si la sortie standard n'est plus disponible (ex: tty SSH fermé)
    }
    logBuffer.push(formatted);
    if (logBuffer.length > maxLogLines) logBuffer.shift();
};

const originalError = console.error;
console.error = (...args) => {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    const formatted = `[${new Date().toLocaleString()}] ❌ ${msg}`;
    try {
        originalError(formatted);
    } catch (e) {
        // Ignorer si la sortie d'erreur n'est plus disponible
    }
    logBuffer.push(formatted);
    if (logBuffer.length > maxLogLines) logBuffer.shift();
};

// Ignorer les erreurs d'écriture asynchrones sur stdout/stderr (EPIPE/EIO)
process.stdout.on('error', (err) => {
    if (err.code !== 'EPIPE' && err.code !== 'EIO') {
        try { originalLog('Err stdout:', err); } catch (e) {}
    }
});
process.stderr.on('error', (err) => {
    if (err.code !== 'EPIPE' && err.code !== 'EIO') {
        try { originalLog('Err stderr:', err); } catch (e) {}
    }
});

// Global exception handlers to prevent background crashes
process.on('uncaughtException', (err) => {
    if (err && (err.code === 'EPIPE' || err.code === 'EIO')) return; // Ignorer les déconnexions de TTY
    console.error('🔥 [CRASH ÉVITÉ] Exception non gérée :', err.stack || err.message || err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 [CRASH ÉVITÉ] Promesse rejetée non gérée :', reason);
});

const homeDir = os.homedir();
const uid = os.userInfo().uid || 1000;

// Charger setup.txt si présent (recherche locale puis dans /boot)
const LOCAL_SETUP = path.join(__dirname, 'setup.txt');
const BOOT_DIR = fs.existsSync('/boot/firmware') ? '/boot/firmware' : '/boot';
const BOOT_SETUP = path.join(BOOT_DIR, 'setup.txt');
const SETUP_FILE = fs.existsSync(LOCAL_SETUP) ? LOCAL_SETUP : BOOT_SETUP;
let localConfig = {};
if (fs.existsSync(SETUP_FILE)) {
    try {
        const content = fs.readFileSync(SETUP_FILE, 'utf-8');
        content.split('\n').forEach(line => {
            const parts = line.split('=');
            if (parts.length >= 2) {
                const key = parts[0].trim();
                const val = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
                if (key && val) {
                    localConfig[key] = val;
                }
            }
        });
        console.log("📝 Configuration chargée dynamiquement depuis setup.txt");
    } catch (e) {
        console.error("⚠️ Impossible de lire setup.txt :", e.message);
    }
}

const SERVER_URL = localConfig.SERVER_URL || (process.env.PIDYN_SERVER_URL && process.env.PIDYN_SERVER_URL !== "undefined" ? process.env.PIDYN_SERVER_URL : 'http://localhost:3000');
const API_KEY = localConfig.API_KEY || (process.env.PIDYN_API_KEY && process.env.PIDYN_API_KEY !== "undefined" ? process.env.PIDYN_API_KEY : 'ma_cle_secrete_123');
const DEVICE_ID = localConfig.DEVICE_ID || (process.env.PIDYN_DEVICE_ID && process.env.PIDYN_DEVICE_ID !== "undefined" ? process.env.PIDYN_DEVICE_ID : 'default-pi-device');

const LOCAL_MEDIA_DIR = path.join(__dirname, 'media');
const LOCAL_MANIFEST = path.join(__dirname, 'playlist.json');

let activeAlerts = []; // Stockage local des alertes actives

console.log(`--- Démarrage OmniSign Sync (Node ${process.version}) ---`);
console.log(`📡 Serveur cible : ${SERVER_URL}`);
console.log(`🆔 ID Afficheur  : ${DEVICE_ID}`);

if (!DEVICE_ID || DEVICE_ID === 'default-pi-device' || DEVICE_ID === 'undefined') {
    console.warn('⚠️  Attention : DEVICE_ID n\'est pas configuré ou utilise la valeur par défaut.');
    console.warn('    Vérifiez votre fichier setup.txt ou vos variables d\'environnement.');
}

// Initialisation du fichier manifest pour que le player sache qu'il est en attente
async function ensureInitialManifest() {
    const exists = await fs.pathExists(LOCAL_MANIFEST);
    if (!exists) {
        const initialData = {
            id: 'waiting',
            deviceId: DEVICE_ID,
            serverUrl: SERVER_URL,
            items: [],
            status: 'waiting_approval',
            disableClientLogs: false, // Default value
            disableDebugLogs: false,  // Default value
            splashScreenUrl: '/img/splashscreen.png' // Default splash screen
        };
        await fs.writeJson(LOCAL_MANIFEST, initialData);
        console.log("📄 Manifest de sécurité créé.");
    }
}
ensureInitialManifest();

if (SERVER_URL.includes('localhost')) {
    console.warn('⚠️  Attention : Le client pointe sur "localhost".');
    console.warn('    Si votre serveur est sur une autre machine, modifiez PIDYN_SERVER_URL.');
}

const socket = io(SERVER_URL, {
    auth: { token: API_KEY },
    query: { deviceId: DEVICE_ID },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    timeout: 20000,
    rejectUnauthorized: false
});

async function getNetworkInfo() {
    const interfaces = os.networkInterfaces();
    let info = { ip: 'Inconnue', mac: 'Inconnue', ssid: null, signal: null };
    
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // On cherche l'IPv4 qui n'est pas interne (localhost)
            if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal) {
                info.ip = iface.address;
                info.mac = iface.mac;
            }
        }
    }

    try {
        // Trixie/Bookworm utilisent NetworkManager (nmcli) par défaut
        const { stdout: nmcliSsid } = await execPromise("nmcli -t -f active,ssid dev wifi | grep '^yes' | cut -d: -f2 || echo ''");
        const { stdout: nmcliSignal } = await execPromise("nmcli -t -f active,signal dev wifi | grep '^yes' | cut -d: -f2 || echo ''");

        let ssid = nmcliSsid.trim();
        let signal = nmcliSignal.trim() ? nmcliSignal.trim() + "%" : "";

        // Fallback sur les anciens outils (wireless-tools) si nmcli ne renvoie rien
        if (!ssid) ssid = (await execPromise("iwgetid -r || echo ''")).stdout.trim();
        if (!signal) signal = (await execPromise("iwconfig 2>&1 | grep 'Link Quality' | head -n 1 | awk '{print $2}' | cut -d'=' -f2 || echo ''")).stdout.trim();

        if (ssid) info.ssid = ssid;
        if (signal) info.signal = signal;
    } catch (e) { /* Pas de WiFi ou interface wlan0 absente */ }

    info.platform = 'Linux';

    // Télémétrie de santé (RAM, Disque, Température CPU)
    try {
        info.totalMem = Math.round(os.totalmem() / 1024 / 1024);
        info.freeMem = Math.round(os.freemem() / 1024 / 1024);

        const { stdout: dfOut } = await execPromise("df -m . | tail -n 1");
        const parts = dfOut.trim().split(/\s+/);
        if (parts.length >= 4) {
            info.diskTotal = Math.round(parseInt(parts[1]) / 1024);
            info.diskFree = Math.round(parseInt(parts[3]) / 1024);
        }

        const { stdout: tempOut } = await execPromise("cat /sys/class/thermal/thermal_zone0/temp || sensors || echo ''");
        if (tempOut.trim()) {
            const val = parseFloat(tempOut.trim());
            info.cpuTemp = val > 1000 ? Math.round(val / 1000) : val;
        }
    } catch (e) {}

    try {
        let screenResolution = null;
        try {
            const { stdout } = await execPromise("xrandr 2>/dev/null | grep '*' | head -n1 | awk '{print $1}'");
            if (stdout.trim()) screenResolution = stdout.trim();
        } catch (e) {}
        if (!screenResolution) {
            try {
                const { stdout } = await execPromise("xdpyinfo 2>/dev/null | grep dimensions | awk '{print $2}'");
                if (stdout.trim()) screenResolution = stdout.trim();
            } catch (e) {}
        }
        if (!screenResolution) {
            try {
                const { stdout } = await execPromise("wlr-randr 2>/dev/null | grep -A 1 'Enabled: yes' | grep -v 'Enabled' | awk '{print $1}'");
                if (stdout.trim()) screenResolution = stdout.trim();
            } catch (e) {}
        }
        if (!screenResolution) {
            try {
                const { stdout } = await execPromise("fbset -s 2>/dev/null | grep geometry | awk '{print $2 \"x\" $3}'");
                if (stdout.trim()) screenResolution = stdout.trim();
            } catch (e) {}
        }
        if (screenResolution) info.screenResolution = screenResolution;
    } catch (e) {}

    return info;
}

async function syncPlaylist(playlistData) {
    if (!playlistData || !playlistData.items) {
        return console.warn('⚠️ Playlist reçue vide ou invalide.');
    }
    console.log('🔄 Synchronisation en cours...');
    await fs.ensureDir(LOCAL_MEDIA_DIR, { mode: 0o755 });

    // Identifier tous les fichiers uniques à traiter pour le calcul de progression
    const allUrls = [];
    if (playlistData.backgroundUrl) allUrls.push(playlistData.backgroundUrl);
    if (playlistData.splashScreenUrl) allUrls.push(playlistData.splashScreenUrl);
    playlistData.items.forEach(item => {
        if (item.backgroundUrl) allUrls.push(item.backgroundUrl);
        // Ajout du média contenu dans le template vidéo pour le téléchargement et le nettoyage
        if (item.template === 'video_fullscreen' && item.data && item.data.videoUrl) {
            allUrls.push(item.data.videoUrl);
        }
        if (item.zones) item.zones.forEach(z => { 
            if (z.url) allUrls.push(z.url); 
            if (z.fontUrl) allUrls.push(z.fontUrl);
        });
    });
    const uniqueUrls = [...new Set(allUrls.filter(u => !!u))];
    let processedCount = 0;

    const downloadSvgMetadata = async (url, relativePath) => {
        if (!url || !url.toLowerCase().endsWith('.svg')) return;
        try {
            const cleanUrl = url.startsWith('http://') || url.startsWith('https://') ? url : `/api/player/media/metadata?url=${encodeURIComponent(url)}`;
            const finalUrl = cleanUrl.startsWith('http') ? cleanUrl : `${SERVER_URL}${cleanUrl.startsWith('/') ? '' : '/'}${cleanUrl}`;
            const separator = finalUrl.includes('?') ? '&' : '?';
            const requestUrl = finalUrl.includes('apiKey=') ? finalUrl : `${finalUrl}${separator}apiKey=${encodeURIComponent(API_KEY)}`;
            
            const res = await axios.get(requestUrl, { timeout: 3000, httpsAgent: httpsAgent });
            if (res.data && res.data.metadata) {
                const metaPath = path.join(LOCAL_MEDIA_DIR, relativePath + '.json');
                const parsedMeta = typeof res.data.metadata === 'string' ? JSON.parse(res.data.metadata) : res.data.metadata;
                await fs.writeJson(metaPath, parsedMeta, { spaces: 2 });
                console.log(`  💾 Métadonnées d'animation synchronisées pour ${relativePath}`);
            }
        } catch (e) {
            // Pas d'animation ou erreur silencieuse
        }
    };

    // Fonction utilitaire pour télécharger un média
    const downloadMedia = async (url) => {
        if (!url) return null;
        // Préserver la structure des dossiers (pour Sozi)
        let relativePath;
        if (url.startsWith('/media/')) {
            relativePath = url.substring('/media/'.length);
        } else if (url.startsWith('/img/')) {
            relativePath = 'img/' + url.substring('/img/'.length);
        } else if (url.includes('/api/admin/qrcode')) {
            let textVal = 'default';
            try {
                const urlObj = new URL(url, url.startsWith('http') ? undefined : 'http://localhost');
                textVal = urlObj.searchParams.get('text') || 'default';
            } catch (e) {}
            const base64 = Buffer.from(textVal).toString('base64');
            const cleanText = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').substring(0, 30);
            relativePath = `qrcodes/qr_${cleanText}.png`;
        } else {
            relativePath = path.basename(url); // Fallback for other URLs
        }
        const localPath = path.join(LOCAL_MEDIA_DIR, relativePath);
        let isFileValid = false;
        try {
            if (await fs.pathExists(localPath)) {
                const stats = await fs.stat(localPath);
                if (stats.size > 0) {
                    isFileValid = true;
                }
            }
        } catch (e) {
            isFileValid = false;
        }

        if (!isFileValid) {
            try {
                console.log(`📥 Téléchargement : ${relativePath}`);
                await fs.ensureDir(path.dirname(localPath));
                const downloadUrl = url.startsWith('http://') || url.startsWith('https://') ? url : `${SERVER_URL}${url}`;
                const response = await axios({
                    url: downloadUrl,
                    headers: { 'X-API-KEY': API_KEY },
                    responseType: 'stream',
                    httpsAgent: httpsAgent
                });
                const writer = fs.createWriteStream(localPath);
                response.data.pipe(writer);
                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });
                await fs.chmod(localPath, 0o644);
                if (relativePath.toLowerCase().endsWith('.svg')) {
                    await downloadSvgMetadata(url, relativePath);
                }
            } catch (error) {
                console.error(`❌ Échec du téléchargement de ${relativePath}:`, error.message);
                try {
                    if (await fs.pathExists(localPath)) {
                        await fs.remove(localPath);
                    }
                } catch (e) {}
                return url; // Retourne l'URL distante en cas d'échec pour tenter une lecture directe
            } 
        } else {
            if (relativePath.toLowerCase().endsWith('.svg')) {
                await downloadSvgMetadata(url, relativePath);
            }
        }
        processedCount++;
        socket.emit('player-status-update', { 
            downloading: true, 
            progress: Math.round((processedCount / uniqueUrls.length) * 100) 
        });
        return `./media/${relativePath.replace(/\\/g, '/')}`; // Ensure forward slashes for HTML src
    };

    // Synchro du fond d'écran global
    if (playlistData.backgroundUrl) {
        playlistData.localBackgroundUrl = await downloadMedia(playlistData.backgroundUrl);
    }

    // Synchro du splashscreen
    if (playlistData.splashScreenUrl) {
        playlistData.localSplashScreenUrl = await downloadMedia(playlistData.splashScreenUrl);
    }

    // Synchro des items
    for (const item of playlistData.items) {
        if (item.backgroundUrl) item.localBackgroundUrl = await downloadMedia(item.backgroundUrl);
        
        // Téléchargement de la vidéo du template si présent
        if (item.template === 'video_fullscreen' && item.data && item.data.videoUrl) {
            item.data.localVideoUrl = await downloadMedia(item.data.videoUrl);
        }
        
        // On synchronise les médias de chaque zone
        if (item.zones) {
            for (const zone of item.zones) {
                if (zone.url) zone.localUrl = await downloadMedia(zone.url);
                if (zone.fontUrl) zone.localFontUrl = await downloadMedia(zone.fontUrl);
            }
        }
    }

    // --- FONCTION DE NETTOYAGE ---
    // Supprimer les fichiers locaux qui ne sont plus dans la playlist actuelle
    try {
        const activeLocalPaths = [];
        if (playlistData.localBackgroundUrl) activeLocalPaths.push(playlistData.localBackgroundUrl);
        if (playlistData.localSplashScreenUrl) activeLocalPaths.push(playlistData.localSplashScreenUrl);
        playlistData.items.forEach(item => {
            if (item.localBackgroundUrl) activeLocalPaths.push(item.localBackgroundUrl);
            if (item.data && item.data.localVideoUrl) activeLocalPaths.push(item.data.localVideoUrl);
            if (item.zones) item.zones.forEach(z => {
                if (z.localUrl) activeLocalPaths.push(z.localUrl);
                if (z.localFontUrl) activeLocalPaths.push(z.localFontUrl);
            });
        });

        const allLocalFiles = await fs.readdir(LOCAL_MEDIA_DIR, { recursive: true });
        for (const file of allLocalFiles) {
            const fullPath = path.join(LOCAL_MEDIA_DIR, file);
            const stats = await fs.stat(fullPath);
            if (stats.isDirectory()) continue;

            const relPath = path.relative(LOCAL_MEDIA_DIR, fullPath).split(path.sep).join('/');
            const localFileRelativePath = `./media/${relPath}`;
            
            if (!activeLocalPaths.includes(localFileRelativePath)) {
                console.log(`🗑️ Nettoyage : suppression du fichier inutilisé ${file}`);
                await fs.remove(fullPath);
            }
        }
    } catch (err) {
        console.error('⚠️ Erreur lors du nettoyage du cache :', err.message);
    }

    // Injection des paramètres de communication pour le player.html
    playlistData.deviceId = DEVICE_ID;
    playlistData.serverUrl = SERVER_URL;
    playlistData.apiKey = API_KEY;
    playlistData.activeAlerts = activeAlerts;

    playlistData.serverOnline = true;
    await fs.writeJson(LOCAL_MANIFEST, playlistData, { spaces: 2 });
    await fs.chmod(LOCAL_MANIFEST, 0o644);

    // Synchronisation hors-ligne des menus de cantine et des réunions
    try {
        const canteenRes = await axios.get(resolveMediaUrl(`/api/player/canteen/current?deviceId=${DEVICE_ID}`), { timeout: 5000 });
        if (canteenRes.data && Object.keys(canteenRes.data).length > 0) {
            await fs.writeJson(path.join(APP_DIR, 'canteen.json'), canteenRes.data, { spaces: 2 });
        }
    } catch (e) {}

    try {
        const meetingsRes = await axios.get(resolveMediaUrl(`/api/player/meetings/today?deviceId=${DEVICE_ID}`), { timeout: 5000 });
        if (meetingsRes.data && meetingsRes.data.meetings) {
            await fs.writeJson(path.join(APP_DIR, 'meetings.json'), meetingsRes.data, { spaces: 2 });
        }
    } catch (e) {}

    try {
        const templatesRes = await axios.get(resolveMediaUrl(`/api/player/templates?siteId=${playlistData.siteId || ''}`), { timeout: 5000 });
        if (templatesRes.data) {
            await fs.writeJson(path.join(APP_DIR, 'templates.json'), templatesRes.data, { spaces: 2 });
        }
    } catch (e) {}

    socket.emit('player-status-update', { downloading: false });
    console.log('✅ Playlist et données locales à jour.');
}

async function setServerStatus(isOnline) {
    try {
        if (await fs.pathExists(LOCAL_MANIFEST)) {
            const manifest = await fs.readJson(LOCAL_MANIFEST);
            if (manifest.serverOnline !== isOnline) {
                manifest.serverOnline = isOnline;
                await fs.writeJson(LOCAL_MANIFEST, manifest, { spaces: 2 });
            }
        }
    } catch (e) {}
}

socket.on('connect', async () => {
    await setServerStatus(true);
    console.log(`Connecté au CMS en tant que ${DEVICE_ID}`);
    // Envoyer les infos réseau au serveur
    const network = await getNetworkInfo();

    // --- DIAGNOSTIC TECHNIQUE ACCÉLÉRATION MATÉRIELLE ---
    try {
        const { stdout: gpuMem } = await execPromise("vcgencmd get_mem gpu || echo 'gpu=unknown'");
        const isV4L2Present = await fs.pathExists('/dev/video10'); // Périphérique standard du décodeur H264 sur Pi
        console.log(`[TECH] 🚀 Accélération Matérielle : ${isV4L2Present ? 'DISPONIBLE (V4L2)' : 'INACTIVE'} | ${gpuMem.trim()}`);
        network.gpu = isV4L2Present ? `Disponible (${gpuMem.trim().split('=')[1] || '?'})` : `Non détectée (${gpuMem.trim().split('=')[1] || '?'})`;
    } catch (e) {
        network.gpu = "Erreur vcgencmd";
    }

    const totalMem = Math.round(os.totalmem() / 1024 / 1024);
    const freeMem = Math.round(os.freemem() / 1024 / 1024);
    console.log(`📊 Mémoire système : ${freeMem}MB libres / ${totalMem}MB au total`);
    socket.emit('player-info-update', network);
});

// Envoi périodique de la télémétrie de santé au serveur (toutes les minutes)
setInterval(async () => {
    if (socket && socket.connected) {
        try {
            const network = await getNetworkInfo();
            socket.emit('player-info-update', network);
        } catch (e) {}
    }
}, 60000);

socket.on('disconnect', async (reason) => {
    console.log(`🔌 Connexion au CMS perdue (${reason})`);
    await setServerStatus(false);
});

socket.on('connect_error', async (err) => {
    await setServerStatus(false);
});

// --- GESTION DES ALERTES FLASH ---
socket.on('show-alert', async (alert) => {
    console.log(`🔔 Alerte reçue : [${alert.type}] ${alert.text}`);
    // Éviter les doublons
    if (!activeAlerts.find(a => a.id === alert.id)) {
        activeAlerts.push(alert);
        await updateManifestWithAlerts();
    }
});

socket.on('clear-alert', async (alertId) => {
    console.log(`🔕 Suppression de l'alerte ID: ${alertId}`);
    activeAlerts = activeAlerts.filter(a => a.id != alertId);
    await updateManifestWithAlerts();
});

async function updateManifestWithAlerts() {
    try {
        if (await fs.pathExists(LOCAL_MANIFEST)) {
            const manifest = await fs.readJson(LOCAL_MANIFEST);
            manifest.activeAlerts = activeAlerts;
            await fs.writeJson(LOCAL_MANIFEST, manifest);
            // Note: Le player.html doit être programmé pour surveiller les changements ou lire activeAlerts
        }
    } catch (err) {
        console.error("❌ Erreur maj manifest alertes:", err.message);
    }
}

// Surveillance périodique de la RAM (toutes les minutes)
setInterval(() => {
    const free = Math.round(os.freemem() / 1024 / 1024);
    if (free < 50) {
        console.warn(`⚠️ Alerte RAM basse : seulement ${free}MB restants !`);
    }
}, 60000);

socket.on('connect_error', (err) => console.error(`❌ Erreur de connexion au CMS (${SERVER_URL}) :`, err.message));
socket.on('disconnect', () => console.log('🔌 Déconnecté du serveur.'));

socket.on('playlist-updated', async (playlistData) => {
    await syncPlaylist(playlistData);

    // Si la playlist fait partie d'une séquence, on prépare le client à demander la suivante
    if (playlistData.sequenceContext) {
        const { sequenceId, currentPlaylistIndex, playlistIds } = playlistData.sequenceContext;
        // Pour l'instant, on ne fait rien de plus ici. Le client player.html devra gérer la fin de la playlist
        // et émettre 'request-next-playlist-in-sequence' via Socket.IO.
        // Cette logique sera implémentée dans player.html ou un script dédié à la lecture.
        console.log(`ℹ️ Playlist reçue fait partie de la séquence ${sequenceId}, index ${currentPlaylistIndex}/${playlistIds.length - 1}`);
    }
});

// Le client player.html devra émettre cet événement quand une playlist de séquence est terminée
// socket.emit('request-next-playlist-in-sequence', { deviceId: DEVICE_ID, sequenceId: '...', currentPlaylistIndex: ... });


// Écouter les commandes de contrôle de l'écran
socket.on('volume-change', (data) => {
    const rawVal = parseInt(data.volume);
    const vol = isNaN(rawVal) ? 100 : Math.max(0, Math.min(100, rawVal));
    console.log(`🔊 Commande de volume reçue : ${vol}%`);
    // Ajuster le volume système (pactl pour PulseAudio/PipeWire sur PC, amixer en fallback)
    exec(`pactl set-sink-volume @DEFAULT_SINK@ ${vol}% || amixer sset 'Master' ${vol}% || amixer sset 'PCM' ${vol}% || amixer sset 'HDMI' ${vol}%`, () => {});
});

// Écouter la demande de logs de l'admin
socket.on('request-logs', () => {
    socket.emit('logs-response', { deviceId: DEVICE_ID, logs: logBuffer.join('\n') });
});

let lastScreenState = null;
socket.on('screen-command', (data) => {
    const action = data.action; // 'on' ou 'off'
    if (lastScreenState === action) return; // Éviter d'exécuter inutilement si l'état est identique
    lastScreenState = action;

    const state = action === 'on' ? '1' : '0';
    console.log(`📺 Commande écran reçue : force ${state}`);
    
    // 1. Essayer via vcgencmd (RPi 3 / drivers legacy)
    exec(`vcgencmd display_power ${state}`, () => {});

    const envPrefix = `export DISPLAY=:0 XAUTHORITY=${homeDir}/.Xauthority`;
    const waylandEnv = `export XDG_RUNTIME_DIR=/run/user/${uid} WAYLAND_DISPLAY=wayland-0`;
    const runEnv = `export DISPLAY=:0 XAUTHORITY=${homeDir}/.Xauthority XDG_RUNTIME_DIR=/run/user/${uid} WAYLAND_DISPLAY=wayland-0`;

    if (action === 'off') {
        console.log("🛑 Extinction de l'écran (DPMS, Wayland, GNOME & CEC)...");
        
        // A. Fermer Chromium et unclutter pour libérer la veille
        exec('pkill -f chromium; pkill -f unclutter', () => {
            // B. X11 DPMS
            exec(`${envPrefix} && xset +dpms && xset dpms force off`, (error) => {
                if (!error) console.log("📺 Veille DPMS X11 forcée.");
            });

            // C. Wayland wlr-randr
            exec(`${waylandEnv} && wlr-randr`, (err, stdout) => {
                if (!err && stdout) {
                    const lines = stdout.split('\n');
                    lines.forEach(line => {
                        if (line && !line.startsWith(' ') && (line.includes('HDMI') || line.includes('DP') || line.includes('DSI'))) {
                            const outputName = line.split(' ')[0];
                            if (outputName) {
                                exec(`${waylandEnv} && wlr-randr --output ${outputName} --off`, () => {
                                    console.log(`📺 Écran Wayland ${outputName} éteint (wlr-randr).`);
                                });
                            }
                        }
                    });
                }
            });

            // D. Wayland wlopm
            exec(`${waylandEnv} && wlopm --off HDMI-A-1`, () => {});
            exec(`${waylandEnv} && wlopm --off HDMI-A-2`, () => {});

            // E. HDMI-CEC (Téléviseurs)
            exec('echo "standby 0" | cec-client -s -d 1', (cecErr) => {
                if (!cecErr) console.log("📺 Commande de veille HDMI-CEC envoyée à la TV.");
            });

            // F. GNOME Mutter via busctl/dbus-send (Wayland & X11 GNOME sessions)
            exec('busctl --user set-property org.gnome.Mutter.DisplayConfig /org/gnome/Mutter/DisplayConfig org.gnome.Mutter.DisplayConfig PowerSaveMode i 1', () => {});
            exec('dbus-send --session --dest=org.gnome.ScreenSaver --type=method_call /org/gnome/ScreenSaver org.gnome.ScreenSaver.SetActive boolean:true', () => {});
        });
    } else {
        console.log("🚀 Allumage de l'écran (DPMS, Wayland, GNOME & CEC)...");

        // A. X11 DPMS
        exec(`${envPrefix} && xset +dpms && xset dpms force on`, (error) => {
            if (!error) console.log("📺 Veille DPMS X11 désactivée.");
        });

        // B. Wayland wlr-randr
        exec(`${waylandEnv} && wlr-randr`, (err, stdout) => {
            if (!err && stdout) {
                const lines = stdout.split('\n');
                lines.forEach(line => {
                    if (line && !line.startsWith(' ') && (line.includes('HDMI') || line.includes('DP') || line.includes('DSI'))) {
                        const outputName = line.split(' ')[0];
                        if (outputName) {
                            exec(`${waylandEnv} && wlr-randr --output ${outputName} --on`, () => {
                                                        console.log(`📺 Écran Wayland ${outputName} allumé (wlr-randr).`);
                            });
                        }
                    }
                });
            }
        });

        // C. Wayland wlopm
        exec(`${waylandEnv} && wlopm --on HDMI-A-1`, () => {});
        exec(`${waylandEnv} && wlopm --on HDMI-A-2`, () => {});

        // D. HDMI-CEC (Téléviseurs)
        exec('echo "on 0" | cec-client -s -d 1', (cecErr) => {
            if (!cecErr) console.log("📺 Commande d'allumage HDMI-CEC envoyée à la TV.");
        });

        // E. GNOME Mutter via busctl/dbus-send (Wayland & X11 GNOME sessions)
        exec('busctl --user set-property org.gnome.Mutter.DisplayConfig /org/gnome/Mutter/DisplayConfig org.gnome.Mutter.DisplayConfig PowerSaveMode i 0', () => {});
        exec('dbus-send --session --dest=org.gnome.ScreenSaver --type=method_call /org/gnome/ScreenSaver org.gnome.ScreenSaver.SetActive boolean:false', () => {});

        // E. Nettoyer et relancer le player en arrière-plan (avec X11 & Wayland env)
        setTimeout(() => {
            console.log("📺 Nettoyage et lancement du player Chromium...");
            exec('pkill -f chromium; pkill -f unclutter', () => {
                const launcherPath = path.join(__dirname, 'start_player.sh');
                exec(`${runEnv} && ${launcherPath} &`, (launchErr) => {
                    if (launchErr) {
                        console.error(`❌ Erreur lors du lancement du player : ${launchErr.message}`);
                    } else {
                        console.log("📺 Player Chromium relancé.");
                    }
                });
            });
        }, 1500); // Petite pause pour s'assurer que le signal vidéo est bien revenu
    }
});

// Écouter les commandes de capture d'écran
socket.on('request-screenshot', () => {
    const screenshotPath = '/tmp/screenshot.jpg';
    console.log(`📸 Prise d'une capture d'écran...`);
    
    const displayVal = process.env.DISPLAY || ':0';
    let xauthVal = process.env.XAUTHORITY;
    if (!xauthVal) {
        const gdmXauth = `/run/user/${uid}/gdm/Xauthority`;
        if (fs.existsSync(gdmXauth)) {
            xauthVal = gdmXauth;
        } else {
            xauthVal = `${homeDir}/.Xauthority`;
        }
    }
    const runtimeDirVal = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
    const waylandDisplayVal = process.env.WAYLAND_DISPLAY || 'wayland-0';

    const waylandCmd = `export XDG_RUNTIME_DIR=${runtimeDirVal} WAYLAND_DISPLAY=${waylandDisplayVal} && grim ${screenshotPath}`;
    const gnomeCmd = `export DISPLAY=${displayVal} XAUTHORITY=${xauthVal} && gnome-screenshot -f ${screenshotPath}`;
    const scrotCmd = `export DISPLAY=${displayVal} XAUTHORITY=${xauthVal} && scrot ${screenshotPath}`;
    
    exec(waylandCmd, (waylandErr) => {
        if (!waylandErr) {
            console.log("✅ Capture d'écran réussie via grim (Wayland).");
            sendScreenshot();
        } else {
            // Repli 2 : gnome-screenshot (X11/GNOME) qui gère l'accélération matérielle
            exec(gnomeCmd, (gnomeErr) => {
                if (!gnomeErr) {
                    console.log("✅ Capture d'écran réussie via gnome-screenshot (GNOME).");
                    sendScreenshot();
                } else {
                    console.log("ℹ️ Échec gnome-screenshot, tentative de repli sur scrot (X11 générique)...");
                    exec(scrotCmd, (scrotErr) => {
                        if (!scrotErr) {
                            console.log("✅ Capture d'écran réussie via scrot (X11).");
                            sendScreenshot();
                        } else {
                            console.error(`❌ Échec de la capture d'écran (grim, gnome-screenshot & scrot)`);
                        }
                    });
                }
            });
        }
    });

    async function sendScreenshot() {
        try {
            const image = await fs.readFile(screenshotPath, { encoding: 'base64' });
            socket.emit('screenshot-taken', { deviceId: DEVICE_ID, image: `data:image/jpeg;base64,${image}` });
            await fs.remove(screenshotPath);
        } catch (err) {
            console.error(`❌ Erreur lors de la lecture ou envoi de la capture : ${err.message}`);
        }
    }
});

// Écouter les commandes de nettoyage du cache
socket.on('clear-local-cache', async () => {
    console.log(`🧹 Commande de nettoyage du cache reçue.`);
    try {
        await fs.emptyDir(LOCAL_MEDIA_DIR);
        if (await fs.pathExists(LOCAL_MANIFEST)) {
            await fs.remove(LOCAL_MANIFEST);
        }
        console.log('✅ Cache local nettoyé. En attente de la prochaine synchro...');
        // Le serveur renverra la playlist car le fichier local a disparu ou lors de la prochaine vérification
    } catch (error) {
        console.error(`❌ Erreur lors du nettoyage du cache : ${error.message}`);
    }
});

// Écouter les commandes de redémarrage du service
socket.on('restart-service', () => {
    console.log(`🔄 Commande de redémarrage du service reçue.`);
    exec('systemctl --user restart pidyn-sync.service || sudo systemctl restart pidyn-sync.service', (error, stdout, stderr) => {
        if (error) console.error(`❌ Erreur d'exécution : ${error.message}`);
    });
});

// Écouter les commandes de redémarrage du système
socket.on('reboot-device', () => {
    console.log(`🔌 Commande de redémarrage système (reboot) reçue.`);
    exec('reboot || systemctl reboot || sudo reboot', (error, stdout, stderr) => {
        if (error) console.error(`❌ Erreur d'exécution : ${error.message}`);
    });
});

// Gestion des erreurs globales pour éviter le crash du service
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Rejet de promesse non géré :', reason);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Exception non capturée :', err);
});

// ==========================================
// SERVEUR WEB LOCAL SUR LE PORT 8080
// Permet de distribuer player.html et les médias sans dépendance externe
// ==========================================
const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
};

const localServer = http.createServer(async (req, res) => {
    // Nettoyer l'URL et décoder les URI (espaces, accents)
    let safeUrl = req.url.split('?')[0];
    try {
        safeUrl = decodeURIComponent(safeUrl);
    } catch (e) {
        // En cas d'erreur de décodage, garder la valeur brute
    }

    if (safeUrl === '/' || safeUrl === '/player') {
        safeUrl = '/player.html';
    }

    const filePath = path.join(__dirname, safeUrl);

    try {
        const exists = await fs.pathExists(filePath);
        if (!exists) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Fichier non trouvé');
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const stat = await fs.stat(filePath);
        const fileSize = stat.size;
        const range = req.headers.range;

        // Gérer les Range Requests (indispensable pour la lecture vidéo dans Chrome)
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            if (start >= fileSize || end >= fileSize) {
                res.writeHead(416, {
                    "Content-Range": `bytes */${fileSize}`,
                    "Content-Type": "text/plain; charset=utf-8"
                });
                return res.end("Plage de données non satisfiable");
            }

            const chunksize = (end - start) + 1;
            const fileStream = fs.createReadStream(filePath, { start, end });
            fileStream.on('error', (streamErr) => {
                console.error(`⚠️ Erreur de flux de lecture (206) :`, streamErr.message);
            });
            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': contentType,
            };
            res.writeHead(206, head);
            fileStream.pipe(res);
        } else {
            const head = {
                'Content-Length': fileSize,
                'Content-Type': contentType,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            };
            res.writeHead(200, head);
            const fileStream = fs.createReadStream(filePath);
            fileStream.on('error', (streamErr) => {
                console.error(`⚠️ Erreur de flux de lecture (200) :`, streamErr.message);
            });
            fileStream.pipe(res);
        }
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Erreur serveur : ${err.message}`);
    }
});

const LOCAL_PORT = 8080;
localServer.listen(LOCAL_PORT, '127.0.0.1', () => {
    console.log(`🌐 Serveur Web local démarré sur http://127.0.0.1:${LOCAL_PORT}`);
});

