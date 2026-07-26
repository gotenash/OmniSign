const { io } = require('socket.io-client');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const http = require('http');
const { exec, execSync } = require('child_process');
const os = require('os');
const util = require('util');

const execPromise = util.promisify(exec);
const isWin = os.platform() === 'win32';

// Tampon en mémoire pour les logs récents (recherche de bugs à distance)
const logBuffer = [];
const maxLogLines = 300;
let activeAlerts = []; // Stockage local des alertes actives

// Ajout de l'horodatage aux logs du client
const originalLog = console.log;
console.log = (...args) => {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    const formatted = `[${new Date().toLocaleString()}] ${msg}`;
    try {
        originalLog(formatted);
    } catch (e) {
        // Ignorer si la sortie standard n'est plus disponible (ex: tty fermé)
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

// Lecture du fichier setup.txt s'il existe
let fileConfig = {};
const setupTxtPath = path.join(__dirname, 'setup.txt');
if (fs.existsSync(setupTxtPath)) {
    try {
        const content = fs.readFileSync(setupTxtPath, 'utf8');
        content.split(/\r?\n/).forEach(line => {
            const parts = line.split('=');
            if (parts.length >= 2) {
                const key = parts[0].trim();
                const val = parts.slice(1).join('=').trim().replace(/^["']|["']$/g, '');
                fileConfig[key] = val;
            }
        });
    } catch (e) {}
}

const SERVER_URL = (process.env.PIDYN_SERVER_URL && process.env.PIDYN_SERVER_URL !== "undefined") ? process.env.PIDYN_SERVER_URL : (fileConfig.SERVER_URL || fileConfig.PIDYN_SERVER_URL || 'http://localhost:3000');
const API_KEY = (process.env.PIDYN_API_KEY && process.env.PIDYN_API_KEY !== "undefined") ? process.env.PIDYN_API_KEY : (fileConfig.API_KEY || fileConfig.PIDYN_API_KEY || 'ma_cle_secrete_123');
const DEVICE_ID = (process.env.PIDYN_DEVICE_ID && process.env.PIDYN_DEVICE_ID !== "undefined") ? process.env.PIDYN_DEVICE_ID : (fileConfig.DEVICE_ID || fileConfig.PIDYN_DEVICE_ID || 'pc-stick-device');

const LOCAL_MEDIA_DIR = path.join(__dirname, 'media');
const LOCAL_MANIFEST = path.join(__dirname, 'playlist.json');

console.log(`--- Démarrage OmniSign Sync Windows (Node ${process.version}) ---`);
console.log(`📡 Serveur cible : ${SERVER_URL}`);
console.log(`🆔 ID Afficheur  : ${DEVICE_ID}`);

// Initialisation du fichier manifest pour que le player sache qu'il est en attente
async function ensureInitialManifest() {
    const exists = await fs.pathExists(LOCAL_MANIFEST);
    if (!exists) {
        const initialData = {
            id: 'waiting',
            deviceId: DEVICE_ID,
            items: [],
            activeAlerts: []
        };
        await fs.writeJson(LOCAL_MANIFEST, initialData, { spaces: 2 });
    }
}
ensureInitialManifest();

// Récupérer la liste de toutes les interfaces réseau (IPv4 non internes)
async function getNetworkInfo() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    let mac = 'Inconnue';

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(`${name}: ${iface.address}`);
                if (mac === 'Inconnue' && iface.mac && iface.mac !== '00:00:00:00:00:00') {
                    mac = iface.mac;
                }
            }
        }
    }
    const totalMem = Math.round(os.totalmem() / 1024 / 1024);
    const freeMem = Math.round(os.freemem() / 1024 / 1024);

    let diskTotal = null;
    let diskFree = null;

    try {
        const psDisk = `powershell -command "Get-CimInstance -ClassName Win32_LogicalDisk -Filter \\\"DeviceID='C:'\\\" | Select-Object Size, FreeSpace"`;
        const stdout = execSync(psDisk).toString();
        const matches = stdout.match(/\d+/g);
        if (matches && matches.length >= 2) {
            diskFree = Math.round(parseInt(matches[0]) / 1024 / 1024 / 1024);
            diskTotal = Math.round(parseInt(matches[1]) / 1024 / 1024 / 1024);
        }
    } catch (e) {}

    return {
        ip: ips.length > 0 ? ips.join(' | ') : '127.0.0.1',
        mac: mac,
        platform: 'Windows',
        totalMem,
        freeMem,
        diskTotal,
        diskFree
    };
}

const socket = io(SERVER_URL, {
    query: { deviceId: DEVICE_ID },
    auth: { apiKey: API_KEY },
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000
});

function getLocalFilename(url) {
    if (!url) return '';
    let name = '';
    try {
        const parsed = new URL(url, SERVER_URL);
        name = path.basename(parsed.pathname);
    } catch (e) {
        name = path.basename(url.split('?')[0]);
    }
    try {
        name = decodeURIComponent(name);
    } catch (e) {}
    return name;
}

function resolveMediaUrl(url) {
    if (!url) return '';
    const baseUrl = (url.startsWith('http://') || url.startsWith('https://')) ? url : `${SERVER_URL}${url.startsWith('/') ? '' : '/'}${url}`;
    if (baseUrl.includes('apiKey=')) return baseUrl;
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}apiKey=${encodeURIComponent(API_KEY)}`;
}

async function downloadFile(url, destPath) {
    const fullUrl = resolveMediaUrl(url);
    console.log(`📥 Téléchargement : ${getLocalFilename(url)}`);
    const writer = fs.createWriteStream(destPath);
    const response = await axios({
        url: fullUrl,
        method: 'GET',
        headers: { 'X-API-KEY': API_KEY },
        responseType: 'stream'
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

async function cleanUnusedFiles(neededFiles) {
    await fs.ensureDir(LOCAL_MEDIA_DIR);
    const filesOnDisk = await fs.readdir(LOCAL_MEDIA_DIR);
    for (const file of filesOnDisk) {
        if (!neededFiles.includes(file)) {
            console.log(`🗑️ Nettoyage : suppression du fichier inutilisé ${file}`);
            await fs.remove(path.join(LOCAL_MEDIA_DIR, file));
        }
    }
}

async function syncPlaylist(playlistData) {
    if (!playlistData || !playlistData.items) return;
    console.log('🔄 Synchronisation de la playlist...');
    
    // Transmettre l'état des téléchargements vers le serveur
    socket.emit('player-status-update', { downloading: true, progress: 0 });

    await fs.ensureDir(LOCAL_MEDIA_DIR);
    const neededFiles = [];

    const itemsToDownload = [];
    playlistData.items.forEach(item => {
        if (item.url && (item.type === 'image' || item.type === 'video' || item.type === 'audio')) {
            const filename = getLocalFilename(item.url);
            neededFiles.push(filename);
            itemsToDownload.push({ url: item.url, filename });
        }
        if (item.data) {
            if (item.data.videoUrl) {
                const filename = getLocalFilename(item.data.videoUrl);
                neededFiles.push(filename);
                itemsToDownload.push({ url: item.data.videoUrl, filename });
            }
            if (item.data.imageUrl) {
                const filename = getLocalFilename(item.data.imageUrl);
                neededFiles.push(filename);
                itemsToDownload.push({ url: item.data.imageUrl, filename });
            }
            if (item.data.audioUrl) {
                const filename = getLocalFilename(item.data.audioUrl);
                neededFiles.push(filename);
                itemsToDownload.push({ url: item.data.audioUrl, filename });
            }
            if (item.data.zones && Array.isArray(item.data.zones)) {
                item.data.zones.forEach(z => {
                    if (z.mediaUrl) {
                        const filename = getLocalFilename(z.mediaUrl);
                        neededFiles.push(filename);
                        itemsToDownload.push({ url: z.mediaUrl, filename });
                    }
                });
            }
        }
        if (item.type === 'pptx' && item.slides && Array.isArray(item.slides)) {
            item.slides.forEach(slideUrl => {
                const filename = getLocalFilename(slideUrl);
                neededFiles.push(filename);
                itemsToDownload.push({ url: slideUrl, filename });
            });
        }
        if (item.qrCodeUrl) {
            const filename = getLocalFilename(item.qrCodeUrl);
            neededFiles.push(filename);
            itemsToDownload.push({ url: item.qrCodeUrl, filename });
        }
    });

    const totalToDownload = itemsToDownload.length;
    let completedDownloads = 0;

    for (const item of itemsToDownload) {
        const localPath = path.join(LOCAL_MEDIA_DIR, item.filename);
        const exists = await fs.pathExists(localPath);
        if (!exists) {
            try {
                await downloadFile(item.url, localPath);
            } catch (err) {
                console.error(`❌ Échec du téléchargement pour ${item.filename}:`, err.message);
                socket.emit('player-status-update', { downloading: false, error: err.message });
            }
        }
        completedDownloads++;
        const progressPercentage = Math.round((completedDownloads / totalToDownload) * 100);
        socket.emit('player-status-update', { downloading: true, progress: progressPercentage });
    }

    await cleanUnusedFiles(neededFiles);

    const localPlaylist = JSON.parse(JSON.stringify(playlistData));
    localPlaylist.items.forEach(item => {
        if (item.url && (item.type === 'image' || item.type === 'video' || item.type === 'audio')) {
            item.url = `/media/${getLocalFilename(item.url)}`;
        }
        if (item.data) {
            if (item.data.videoUrl) {
                item.data.localVideoUrl = `/media/${getLocalFilename(item.data.videoUrl)}`;
                item.data.videoUrl = `/media/${getLocalFilename(item.data.videoUrl)}`;
            }
            if (item.data.imageUrl) {
                item.data.localImageUrl = `/media/${getLocalFilename(item.data.imageUrl)}`;
                item.data.imageUrl = `/media/${getLocalFilename(item.data.imageUrl)}`;
            }
            if (item.data.audioUrl) {
                item.data.audioUrl = `/media/${getLocalFilename(item.data.audioUrl)}`;
            }
            if (item.data.zones && Array.isArray(item.data.zones)) {
                item.data.zones.forEach(z => {
                    if (z.mediaUrl) z.mediaUrl = `/media/${getLocalFilename(z.mediaUrl)}`;
                });
            }
        }
        if (item.type === 'pptx' && item.slides && Array.isArray(item.slides)) {
            item.slides = item.slides.map(slideUrl => `/media/${getLocalFilename(slideUrl)}`);
        }
        if (item.qrCodeUrl) {
            item.qrCodeUrl = `/media/${getLocalFilename(item.qrCodeUrl)}`;
        }
    });

    localPlaylist.deviceId = DEVICE_ID;
    localPlaylist.serverUrl = SERVER_URL;
    localPlaylist.apiKey = API_KEY;
    localPlaylist.activeAlerts = activeAlerts;
    localPlaylist.serverOnline = true;

    await fs.writeJson(LOCAL_MANIFEST, localPlaylist, { spaces: 2 });
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
        const templatesRes = await axios.get(resolveMediaUrl(`/api/player/templates?siteId=${localPlaylist.siteId || ''}`), { timeout: 5000 });
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

// Maintien d'éveil permanent de l'écran et du système Windows (SetThreadExecutionState)
function keepWindowsAwake() {
    const psCmd = `powershell -command "$code = 'using System; using System.Runtime.InteropServices; public class WinAwake { [DllImport(\\\"kernel32.dll\\\")] public static extern uint SetThreadExecutionState(uint f); public static void Keep() { SetThreadExecutionState(0x80000005); } }'; Add-Type -TypeDefinition $code; [WinAwake]::Keep()"`;
    exec(psCmd, () => {});
}
keepWindowsAwake();
setInterval(keepWindowsAwake, 60000);

// Écouteur du raccourci clavier global Ctrl + AltGr + K pour exécuter kill_omnisign.bat
function startHotkeyListener() {
    const scriptPath = path.join(__dirname, 'hotkey_listener.ps1');
    const cmd = `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`;
    console.log("⌨️ Raccourci d'arrêt système actif : Ctrl + AltGr + K");
    exec(cmd, (err) => {
        if (!err) console.log("🛑 Raccourci d'arrêt déclenché (Ctrl + AltGr + K).");
    });
}
startHotkeyListener();

socket.on('connect', async () => {
    keepWindowsAwake();
    await setServerStatus(true);
    console.log(`Connecté au CMS en tant que ${DEVICE_ID}`);
    const network = await getNetworkInfo();
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

// Écouter les commandes de contrôle à distance (Reboot, Restart, Écran, Volume, Cache)
socket.on('reboot-device', () => {
    console.log('⚡ Commande reçue : Redémarrage physique de Windows (Reboot)');
    exec('shutdown /r /t 2 /f', (err) => {
        if (err) console.error('⚠️ Erreur redémarrage Windows :', err.message);
    });
});

socket.on('restart-service', () => {
    console.log('🔄 Commande reçue : Relance du joueur OmniSign');
    exec('taskkill /f /im chrome.exe', () => {
        const batPath = path.join(__dirname, 'omnisign-start.bat');
        exec(`cmd.exe /c "${batPath}"`, (err) => {
            if (err) console.error('⚠️ Erreur relance joueur :', err.message);
        });
    });
});

let lastScreenState = 'on';

socket.on('screen-command', (data) => {
    const action = data.action; // 'on' ou 'off'
    if (lastScreenState === action) return;
    lastScreenState = action;

    console.log(`📺 Commande écran Windows reçue : ${action.toUpperCase()}`);

    if (action === 'off') {
        // 1. Fermer Chrome/Edge pour arrêter complètement le diaporama et stopper la consommation CPU/GPU
        exec('taskkill /f /im chrome.exe /im msedge.exe >nul 2>&1', () => {
            console.log("🛑 Navigateur Chrome fermé pour la mise en veille de l'écran.");
            // 2. Éteindre l'affichage Windows via Win32 API
            const psCmd = `powershell -command "$code = 'using System; using System.Runtime.InteropServices; public class WinMon { [DllImport(\\\"user32.dll\\\")] public static extern int SendMessage(int h, int m, int w, int l); public static void Off() { SendMessage(0xFFFF, 0x0112, 0xF170, 2); } }'; Add-Type -TypeDefinition $code; [WinMon]::Off()"`;
            exec(psCmd);
        });
    } else if (action === 'on') {
        // 1. Rallumer l'affichage Windows via Win32 API
        const psCmd = `powershell -command "$code = 'using System; using System.Runtime.InteropServices; public class WinMon { [DllImport(\\\"user32.dll\\\")] public static extern int SendMessage(int h, int m, int w, int l); [DllImport(\\\"user32.dll\\\")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e); public static void On() { SendMessage(0xFFFF, 0x0112, 0xF170, -1); keybd_event(0, 0, 0, UIntPtr.Zero); } }'; Add-Type -TypeDefinition $code; [WinMon]::On()"`;
        exec(psCmd, () => {
            // 2. Relancer Google Chrome en mode Kiosk
            setTimeout(() => {
                exec('tasklist /fi "IMAGENAME eq chrome.exe"', (err, stdout) => {
                    if (!stdout || !stdout.includes('chrome.exe')) {
                        console.log("🚀 Relancement de Google Chrome Kiosk sur réveil de l'écran...");
                        const chromeCmd = `start "" "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --kiosk --no-first-run --user-data-dir="%TEMP%\\omnisign_chrome_profile" --disable-cache --disk-cache-size=1 --media-cache-size=1 --edge-touch-filtering=disabled --autoplay-policy=no-user-gesture-required --ignore-gpu-blocklist --enable-gpu-rasterization --disable-gpu-driver-bug-workarounds --gpu-no-context-lost "http://localhost:8080/player.html"`;
                        exec(chromeCmd);
                    }
                });
            }, 1000);
        });
    }
});

socket.on('clear-local-cache', async () => {
    console.log('🧹 Commande reçue : Purge du cache local');
    try {
        await fs.emptyDir(LOCAL_MEDIA_DIR);
        console.log('✅ Cache médias vidé.');
    } catch (err) {
        console.error('⚠️ Erreur vidage cache :', err.message);
    }
});

socket.on('playlist-updated', async (playlistData) => {
    await syncPlaylist(playlistData);
});

// Écouter le contrôle du volume à distance sous Windows
socket.on('volume-change', (data) => {
    const rawVal = parseInt(data.volume);
    const vol = isNaN(rawVal) ? 100 : Math.max(0, Math.min(100, rawVal));
    console.log(`🔊 Modification du volume système Windows : ${vol}%`);
    const scriptPath = path.join(__dirname, 'set_volume.ps1');
    const cmd = `powershell -ExecutionPolicy Bypass -File "${scriptPath}" -Volume ${vol}`;
    exec(cmd, (err) => {
        if (err) console.error(`⚠️ Erreur réglage volume Windows :`, err.message);
    });
});

// Écouter les messages d'alerte Flash
socket.on('show-alert', async (alert) => {
    console.log(`🚨 Notification / Message Flash reçu : "${alert.text}"`);
    if (!activeAlerts.find(a => a.id === alert.id)) {
        activeAlerts.push(alert);
        await updateManifestWithAlerts();
    }
});

socket.on('clear-alert', async (alertId) => {
    console.log(`🔕 Fin du message Flash ID : ${alertId}`);
    activeAlerts = activeAlerts.filter(a => a.id != alertId);
    await updateManifestWithAlerts();
});

async function updateManifestWithAlerts() {
    try {
        const exists = await fs.pathExists(LOCAL_MANIFEST);
        if (exists) {
            const manifest = await fs.readJson(LOCAL_MANIFEST);
            manifest.activeAlerts = activeAlerts;
            await fs.writeJson(LOCAL_MANIFEST, manifest, { spaces: 2 });
        }
    } catch (e) {
        console.error("Erreur lors de la mise à jour des alertes dans le manifest local :", e);
    }
}

// Écouter la demande de logs de l'admin
socket.on('request-logs', () => {
    socket.emit('logs-response', { deviceId: DEVICE_ID, logs: logBuffer.join('\n') });
});

socket.on('request-screenshot', () => {
    const screenshotPath = path.join(os.tmpdir(), 'screenshot.jpg');
    console.log(`📸 Prise d'une capture d'écran...`);
    const psCommand = `powershell -command "[Reflection.Assembly]::LoadWithPartialName('System.Drawing'); [Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); $screen = [System.Windows.Forms.Screen]::PrimaryScreen; $bitmap = New-Object System.Drawing.Bitmap $screen.Bounds.Width, $screen.Bounds.Height; $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($screen.Bounds.X, $screen.Bounds.Y, 0, 0, $bitmap.Size); $bitmap.Save('${screenshotPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Jpeg); $graphics.Dispose(); $bitmap.Dispose();"`;
    exec(psCommand, async (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ Erreur capture Windows : ${error.message}`);
            return;
        }
        const image = await fs.readFile(screenshotPath, { encoding: 'base64' });
        socket.emit('screenshot-taken', { deviceId: DEVICE_ID, image: `data:image/jpeg;base64,${image}` });
        await fs.remove(screenshotPath);
    });
});

socket.on('restart-service', () => {
    console.log(`🔄 Commande de redémarrage reçue. Arrêt du processus pour redémarrage par le gestionnaire Windows.`);
    process.exit(0);
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
    let rawUrl = req.url.split('?')[0];
    let safeUrl = rawUrl;
    try {
        safeUrl = decodeURIComponent(rawUrl);
    } catch (e) {}

    if (safeUrl === '/' || safeUrl === '/player') {
        safeUrl = '/player.html';
        rawUrl = '/player.html';
    }

    let filePath = path.join(__dirname, safeUrl);

    try {
        let exists = await fs.pathExists(filePath);
        if (!exists) {
            const rawFilePath = path.join(__dirname, rawUrl);
            if (await fs.pathExists(rawFilePath)) {
                filePath = rawFilePath;
                exists = true;
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end('Fichier non trouvé');
            }
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const stat = await fs.stat(filePath);
        const fileSize = stat.size;
        const range = req.headers.range;

        // Gérer les Range Requests pour la lecture des fichiers vidéo sous Chrome
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
        console.error(`Erreur serveur web local :`, err);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Erreur interne serveur');
    }
});

const LOCAL_PORT = 8080;
localServer.listen(LOCAL_PORT, '0.0.0.0', () => {
    console.log(`🌐 Serveur web local Windows démarré sur http://localhost:${LOCAL_PORT}`);
});

localServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`⚠️ Le port ${LOCAL_PORT} est déjà occupé. Utilisation du serveur web externe déjà actif.`);
    } else {
        console.error(`❌ Erreur serveur web local :`, err.message);
    }
});