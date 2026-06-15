const { io } = require('socket.io-client');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const util = require('util');

const execPromise = util.promisify(exec);
const isWin = os.platform() === 'win32';

// Ajout de l'horodatage aux logs du client
const originalLog = console.log;
console.log = (...args) => originalLog(`[${new Date().toLocaleString()}]`, ...args);

const SERVER_URL = (process.env.PIDYN_SERVER_URL && process.env.PIDYN_SERVER_URL !== "undefined") ? process.env.PIDYN_SERVER_URL : 'http://localhost:3000';
const API_KEY = (process.env.PIDYN_API_KEY && process.env.PIDYN_API_KEY !== "undefined") ? process.env.PIDYN_API_KEY : 'ma_cle_secrete_123';
const DEVICE_ID = (process.env.PIDYN_DEVICE_ID && process.env.PIDYN_DEVICE_ID !== "undefined") ? process.env.PIDYN_DEVICE_ID : 'pc-stick-device';

const LOCAL_MEDIA_DIR = path.join(__dirname, 'media');
const LOCAL_MANIFEST = path.join(__dirname, 'playlist.json');

console.log(`--- Démarrage PiDyn Sync Windows (Node ${process.version}) ---`);
console.log(`📡 Serveur cible : ${SERVER_URL}`);
console.log(`🆔 ID Afficheur  : ${DEVICE_ID}`);

// Initialisation du fichier manifest pour que le player sache qu'il est en attente
async function ensureInitialManifest() {
    const exists = await fs.pathExists(LOCAL_MANIFEST);
    if (!exists) {
        const initialData = {
            id: 'waiting',
            deviceId: DEVICE_ID,
            serverUrl: SERVER_URL,
            items: [],
            status: 'waiting_approval'
        };
        await fs.writeJson(LOCAL_MANIFEST, initialData);
        console.log("📄 Manifest de sécurité créé.");
    }
}
ensureInitialManifest();

const socket = io(SERVER_URL, {
    auth: { token: API_KEY },
    query: { deviceId: DEVICE_ID },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    timeout: 20000
});

async function getNetworkInfo() {
    const interfaces = os.networkInterfaces();
    let info = { ip: 'Inconnue', mac: 'Inconnue', ssid: null, signal: null };
    
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal) {
                info.ip = iface.address;
                info.mac = iface.mac;
            }
        }
    }

    try {
        // Sur Windows, on utilise netsh pour récupérer les infos WiFi
        const { stdout } = await execPromise('netsh wlan show interfaces');
        const ssidMatch = stdout.match(/ SSID\s+:\s+(.*)/);
        const signalMatch = stdout.match(/ Signal\s+:\s+(.*)/);
        if (ssidMatch) info.ssid = ssidMatch[1].trim();
        if (signalMatch) info.signal = signalMatch[1].trim();
    } catch (e) { /* Pas de WiFi ou erreur netsh */ }

    return info;
}

async function syncPlaylist(playlistData) {
    if (!playlistData || !playlistData.items) {
        return console.warn('⚠️ Playlist reçue vide ou invalide.');
    }
    console.log('🔄 Synchronisation en cours...');
    await fs.ensureDir(LOCAL_MEDIA_DIR, { mode: 0o755 });

    const allUrls = [];
    if (playlistData.backgroundUrl) allUrls.push(playlistData.backgroundUrl);
    if (playlistData.splashScreenUrl) allUrls.push(playlistData.splashScreenUrl);
    playlistData.items.forEach(item => {
        if (item.backgroundUrl) allUrls.push(item.backgroundUrl);
        if (item.zones) item.zones.forEach(z => { 
            if (z.url) allUrls.push(z.url); 
            if (z.fontUrl) allUrls.push(z.fontUrl);
        });
    });
    const uniqueUrls = [...new Set(allUrls.filter(u => !!u))];
    let processedCount = 0;

    const downloadMedia = async (url) => {
        if (!url) return null;
        let relativePath;
        if (url.startsWith('/media/')) {
            relativePath = url.substring('/media/'.length);
        } else if (url.startsWith('/img/')) {
            relativePath = 'img/' + url.substring('/img/'.length);
        } else {
            relativePath = path.basename(url);
        }
        const localPath = path.join(LOCAL_MEDIA_DIR, relativePath);
        if (!(await fs.pathExists(localPath))) {
            try {
                console.log(`📥 Téléchargement : ${relativePath}`);
                await fs.ensureDir(path.dirname(localPath));
                const response = await axios({
                    url: `${SERVER_URL}${url}`,
                    headers: { 'X-API-KEY': API_KEY },
                    responseType: 'stream'
                });
                const writer = fs.createWriteStream(localPath);
                response.data.pipe(writer);
                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });
                await fs.chmod(localPath, 0o644);
            } catch (error) {
                console.error(`❌ Échec du téléchargement de ${relativePath}:`, error.message);
                return url;
            } 
        }
        processedCount++;
        socket.emit('player-status-update', { 
            downloading: true, 
            progress: Math.round((processedCount / uniqueUrls.length) * 100) 
        });
        // Force l'usage des slashes pour le HTML même sur Windows
        return `./media/${relativePath.split(path.sep).join('/')}`;
    };

    if (playlistData.backgroundUrl) playlistData.localBackgroundUrl = await downloadMedia(playlistData.backgroundUrl);
    if (playlistData.splashScreenUrl) playlistData.localSplashScreenUrl = await downloadMedia(playlistData.splashScreenUrl);

    for (const item of playlistData.items) {
        if (item.backgroundUrl) item.localBackgroundUrl = await downloadMedia(item.backgroundUrl);
        if (item.zones) {
            for (const zone of item.zones) {
                if (zone.url) zone.localUrl = await downloadMedia(zone.url);
                if (zone.fontUrl) zone.localFontUrl = await downloadMedia(zone.fontUrl);
            }
        }
    }

    try {
        const allLocalFiles = await fs.readdir(LOCAL_MEDIA_DIR, { recursive: true });
        for (const file of allLocalFiles) {
            const fullPath = path.join(LOCAL_MEDIA_DIR, file);
            const stats = await fs.stat(fullPath);
            if (stats.isDirectory()) continue;

            const relPath = path.relative(LOCAL_MEDIA_DIR, fullPath).split(path.sep).join('/');
            const relativeUrl = relPath.startsWith('img/') ? '/' + relPath : '/media/' + relPath;
            
            if (!uniqueUrls.includes(relativeUrl)) {
                console.log(`🗑️ Nettoyage : suppression du fichier inutilisé ${file}`);
                await fs.remove(fullPath);
            }
        }
    } catch (err) {
        console.error('⚠️ Erreur lors du nettoyage du cache :', err.message);
    }

    playlistData.deviceId = DEVICE_ID;
    playlistData.serverUrl = SERVER_URL;
    playlistData.apiKey = API_KEY;

    await fs.writeJson(LOCAL_MANIFEST, playlistData);
    await fs.chmod(LOCAL_MANIFEST, 0o644);
    socket.emit('player-status-update', { downloading: false });
    console.log('✅ Playlist locale à jour.');
}

socket.on('connect', async () => {
    console.log(`Connecté au CMS en tant que ${DEVICE_ID}`);
    const network = await getNetworkInfo();
    const totalMem = Math.round(os.totalmem() / 1024 / 1024);
    const freeMem = Math.round(os.freemem() / 1024 / 1024);
    console.log(`📊 Mémoire système : ${freeMem}MB libres / ${totalMem}MB au total`);
    socket.emit('player-info-update', network);
});

socket.on('playlist-updated', async (playlistData) => {
    await syncPlaylist(playlistData);
});

socket.on('screen-command', (data) => {
    const state = data.action === 'on' ? 'on' : 'off';
    console.log(`📺 Commande écran reçue : force ${state}`);
    
    const lparam = data.action === 'on' ? -1 : 2;
    const cmd = `powershell -command "(Add-Type '[DllImport(\"user32.dll\")] public class Win32 { [DllImport(\"user32.dll\")] public static extern int SendMessage(int hWnd, int hMsg, int wParam, int lParam); }' -PassThru)::SendMessage(0xffff, 0x0112, 0xf170, ${lparam})"`;
    exec(cmd);
});

socket.on('request-screenshot', () => {
    const screenshotPath = path.join(os.tmpdir(), 'screenshot.jpg');
    console.log(`📸 Prise d'une capture d'écran...`);
    const psCommand = `powershell -command "[Reflection.Assembly]::LoadWithPartialName('System.Drawing'); [Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); $screen = [System.Windows.Forms.Screen]::PrimaryScreen; $bitmap = New-Object System.Drawing.Bitmap $screen.Bounds.Width, $screen.Bounds.Height; $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($screen.Bounds.X, $screen.Bounds.Y, 0, 0, $bitmap.Size); $bitmap.Save('${screenshotPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Jpeg); $graphics.Dispose(); $bitmap.Dispose();"`;
    exec(psCommand, async (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ Erreur capture Windows : ${error.message}`);
            if (stderr) console.error(`❌ PowerShell stderr: ${stderr}`);
            return;
        }
        if (stdout) console.log(`✅ PowerShell stdout: ${stdout}`);
        const image = await fs.readFile(screenshotPath, { encoding: 'base64' });
        socket.emit('screenshot-taken', { deviceId: DEVICE_ID, image: `data:image/jpeg;base64,${image}` });
        await fs.remove(screenshotPath);
    });
});

socket.on('restart-service', () => {
    console.log(`🔄 Commande de redémarrage reçue. Arrêt du processus pour redémarrage par le gestionnaire Windows.`);
    process.exit(0);
});

process.on('unhandledRejection', (reason) => console.error('❌ Rejet non géré :', reason));
process.on('uncaughtException', (err) => console.error('❌ Exception non capturée :', err));