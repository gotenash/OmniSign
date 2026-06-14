const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs-extra');
const multer = require('multer');
const bcrypt = require('bcrypt');
const AdmZip = require('adm-zip');
const mime = require('mime-types');
const { exec } = require('child_process');
const util = require('util');
const jwt = require('jsonwebtoken');
const knex = require('knex');
const sqlite3 = require('sqlite3'); // Required by knex for SQLite
const execPromise = util.promisify(exec);
const saltRounds = 10;

// Surcharge de console.log et console.error pour ajouter l'horodatage automatiquement
const originalLog = console.log;
console.log = (...args) => originalLog(`[${new Date().toLocaleString()}]`, ...args);
const originalError = console.error;
console.error = (...args) => originalError(`[${new Date().toLocaleString()}]`, ...args);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, X-API-KEY, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    // Réponse immédiate pour les requêtes de pré-vérification (Preflight)
    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

let JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key_very_secret_and_long'; // À changer en production !
let API_KEY = process.env.PIDYN_API_KEY || 'ma_cle_secrete_123';
let DISABLE_CLIENT_LOGS = false;
let DISABLE_DEBUG_LOGS = false;
let SPLASH_SCREEN_URL = '/img/splashscreen.png';
const SQLITE_DB_PATH = path.join(__dirname, 'pidyn.sqlite'); // New SQLite DB path
const MEDIA_DIR = path.join(__dirname, 'public/media');

// Initialize Knex
const db = knex({
    client: 'sqlite3',
    connection: {
        filename: SQLITE_DB_PATH,
    },
    useNullAsDefault: true, // Required for SQLite foreign keys
});

// Configuration de Multer pour gérer l'upload de fichiers
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, MEDIA_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Données par défaut pour l'initialisation
const defaultData = {
    users: [
        { username: 'admin', password: '123456', role: 'admin' },
        { username: 'editeur', password: '123456', role: 'editor' },
        { username: 'auteur', password: '123456', role: 'author' }
    ],
    settings: {
        jwtSecret: 'your_jwt_secret_key_very_secret_and_long',
        apiKey: 'ma_cle_secrete_123'
    }
};

// Database Initialization and Migration
async function initializeDatabase() {
    await db.schema.hasTable('users').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('users', (table) => {
                table.increments('id').primary();
                table.string('username').unique().notNullable();
                table.string('password').notNullable();
                table.string('role').notNullable(); // admin, editor, author
                table.string('email').unique();
            });
            console.log('Table "users" created.');
            // Insert default users
            const usersToInsert = await Promise.all(defaultData.users.map(async u => ({
                username: u.username,
                password: await bcrypt.hash(u.password, saltRounds),
                role: u.role
            })));
            await db('users').insert(usersToInsert);
            console.log('Default users inserted.');
        }
        // Migration : Ajout de la colonne email si elle n'existe pas
        const hasEmail = await db.schema.hasColumn('users', 'email');
        if (!hasEmail) {
            await db.schema.table('users', (table) => {
                table.string('email').unique();
            });
            console.log('Colonne "email" ajoutée à la table "users".');
        }
    });

    await db.schema.hasTable('playlists').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('playlists', (table) => {
                table.string('id').primary();
                table.string('name').notNullable();
                table.json('items').notNullable(); // Store array of items as JSON string
                table.string('backgroundUrl');
                table.string('backgroundColor');
                table.string('resolution');
            });
            console.log('Table "playlists" created.');
        }
    });

    await db.schema.hasTable('players').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('players', (table) => {
                table.string('id').primary(); // Device ID
                table.string('name').notNullable();
                table.string('manualPlaylistId');
                table.string('manualSequenceId');
                table.string('currentPlaylistId');
                table.string('currentSequenceId');
                table.integer('currentSequenceIndex');
                table.timestamp('lastSeen');
                table.string('status').notNullable(); // pending, approved
                table.string('ip');
                table.string('mac');
                table.string('wifiSSID');
                table.string('wifiSignal');
                table.json('downloadStatus'); // Store as JSON string
                table.string('groupId'); // Lien vers le groupe
            });
            console.log('Table "players" created.');
        }
    });

    await db.schema.hasTable('schedules').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('schedules', (table) => {
                table.string('id').primary();
                table.string('deviceId').notNullable();
                table.string('playlistId'); // Can be null if sequenceId is set
                table.string('sequenceId'); // Can be null if playlistId is set
                table.timestamp('startTime').notNullable();
                table.timestamp('endTime').notNullable();
            });
            console.log('Table "schedules" created.');
        }
    });

    await db.schema.hasTable('media').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('media', (table) => {
                table.string('id').primary();
                table.string('filename').notNullable();
                table.string('originalZip');
                table.string('url').notNullable();
                table.string('type').notNullable();
                table.string('uploadedBy').notNullable();
                table.timestamp('uploadDate').notNullable();
                table.string('parentZipDir');
            });
            console.log('Table "media" created.');
        }
    });

    await db.schema.hasTable('sequences').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('sequences', (table) => {
                table.string('id').primary();
                table.string('name').notNullable();
                table.json('playlistIds').notNullable(); // Store array of playlist IDs as JSON string
            });
            console.log('Table "sequences" created.');
        }
    });

    await db.schema.hasTable('settings').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('settings', (table) => {
                table.string('key').primary();
                table.string('value').notNullable();
            });
            console.log('Table "settings" created.');
            // Insert default settings
            await db('settings').insert([
                { key: 'jwtSecret', value: 'your_jwt_secret_key_very_secret_and_long' },
                { key: 'apiKey', value: 'ma_cle_secrete_123' },
                { key: 'disableClientLogs', value: 'false' },
                { key: 'splashScreenUrl', value: '/img/splashscreen.png' },
                { key: 'disableDebugLogs', value: 'false' }
            ]);
            console.log('Default settings inserted.');
        }
        // Migration : s'assurer que splashScreenUrl existe pour les bases existantes
        const splashSetting = await db('settings').where({ key: 'splashScreenUrl' }).first();
        if (!splashSetting) {
            await db('settings').insert({ key: 'splashScreenUrl', value: '/img/splashscreen.png' });
            console.log('Setting "splashScreenUrl" ajouté.');
        }
        // Migration : s'assurer que disableDebugLogs existe
        const debugSetting = await db('settings').where({ key: 'disableDebugLogs' }).first();
        if (!debugSetting) {
            await db('settings').insert({ key: 'disableDebugLogs', value: 'false' });
            console.log('Setting "disableDebugLogs" ajouté.');
        }
    });

    await db.schema.hasTable('groups').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('groups', (table) => {
                table.string('id').primary();
                table.string('name').notNullable();
                table.string('description');
            });
            console.log('Table "groups" créée.');
        }
    });

    await db.schema.hasTable('analytics').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('analytics', (table) => {
                table.increments('id').primary();
                table.string('deviceId').notNullable();
                table.string('playlistId');
                table.string('itemUrl');
                table.timestamp('timestamp').defaultTo(db.fn.now());
                table.integer('duration'); // en ms
            });
            console.log('Table "analytics" créée.');
        }
    });

    await db.schema.hasTable('alerts').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('alerts', (table) => {
                table.increments('id').primary();
                table.string('text').notNullable();
                table.string('type').defaultTo('info');
                table.string('targetDeviceId');
                table.timestamp('createdAt').defaultTo(db.fn.now());
            });
            console.log('Table "alerts" créée.');
        }
    });
}

// Load settings from DB
async function loadSettings() {
    const settings = await db('settings').select('*');
    const jwtSetting = settings.find(s => s.key === 'jwtSecret');
    const apiSetting = settings.find(s => s.key === 'apiKey');
    const logsSetting = settings.find(s => s.key === 'disableClientLogs');
    const debugSetting = settings.find(s => s.key === 'disableDebugLogs');
    const splashSetting = settings.find(s => s.key === 'splashScreenUrl');
    if (jwtSetting) JWT_SECRET = process.env.JWT_SECRET || jwtSetting.value;
    if (apiSetting) API_KEY = process.env.PIDYN_API_KEY || apiSetting.value;
    if (logsSetting) DISABLE_CLIENT_LOGS = logsSetting.value === 'true';
    if (debugSetting) DISABLE_DEBUG_LOGS = debugSetting.value === 'true';
    if (splashSetting) SPLASH_SCREEN_URL = splashSetting.value;
}

// Initialize DB and migrate data on server start
initializeDatabase().then(async () => {
    await loadSettings();
    console.log('✅ Base de données prête. JWT_SECRET et API_KEY chargés.');
    
    // Démarrer le serveur et les tâches de fond UNIQUEMENT quand la DB est prête
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`🚀 CMS Sécurisé sur le port ${PORT}`);
        checkSchedules(); // Évaluation initiale
        setInterval(checkSchedules, 60 * 1000); // Évaluation périodique
    });
}).catch(err => {
    console.error('❌ Échec de l\'initialisation de la base de données:', err);
    process.exit(1);
});

fs.ensureDirSync(MEDIA_DIR);

// Fonction pour vérifier et appliquer les planifications
const checkSchedules = async (targetDeviceId = null, forceEmit = false) => {
    const now = new Date();
    
    // Récupérer les lecteurs à vérifier
    let players;
    if (targetDeviceId) {
        const p = await db('players').where({ id: targetDeviceId }).first();
        players = p ? [p] : [];
    } else {
        players = await db('players').select('*');
    }

    const schedules = await db('schedules').select('*');

    for (const player of players) {
        if (player.status !== 'approved') continue; // Ne planifier que pour les afficheurs approuvés

        const deviceId = player.id;
        let activeSchedule = null;
        for (const schedule of schedules) {
            if (schedule.deviceId === deviceId) {
                const start = new Date(schedule.startTime);
                const end = new Date(schedule.endTime);
                if (now >= start && now < end) {
                    activeSchedule = schedule;
                    break;
                }
            }
        }

        // Déterminer si on joue une playlist directe ou une séquence
        let activeSequenceId = activeSchedule ? activeSchedule.sequenceId : (player.manualSequenceId || null);
        let newPlaylistId = activeSchedule ? activeSchedule.playlistId : (player.manualPlaylistId || null);

        if (activeSequenceId) {
            const seq = await db('sequences').where({ id: activeSequenceId }).first();
            if (player.currentSequenceId !== activeSequenceId) {
                await db('players').where({ id: deviceId }).update({ 
                    currentSequenceId: activeSequenceId, 
                    currentSequenceIndex: 0 
                });
                player.currentSequenceId = activeSequenceId;
                player.currentSequenceIndex = 0;
            }
            if (seq) {
                const playlistIds = JSON.parse(seq.playlistIds);
                newPlaylistId = playlistIds[player.currentSequenceIndex || 0];
            }
        } else {
            if (player.currentSequenceId) {
                await db('players').where({ id: deviceId }).update({ currentSequenceId: null, currentSequenceIndex: null });
                player.currentSequenceId = null;
            }
        }

        // Seulement mettre à jour si la playlist a changé
        if (player.currentPlaylistId !== newPlaylistId || forceEmit) {
            await db('players').where({ id: deviceId }).update({ currentPlaylistId: newPlaylistId });
            const targetPlaylist = await db('playlists').where({ id: newPlaylistId }).first();

            if (targetPlaylist) {
                targetPlaylist.items = JSON.parse(targetPlaylist.items);
                const playlistToSend = { ...targetPlaylist };
                playlistToSend.apiKey = API_KEY;
                playlistToSend.disableClientLogs = DISABLE_CLIENT_LOGS;
                playlistToSend.disableDebugLogs = DISABLE_DEBUG_LOGS;
                playlistToSend.splashScreenUrl = SPLASH_SCREEN_URL;
                if (player.currentSequenceId) {
                    const seq = await db('sequences').where({ id: player.currentSequenceId }).first();
                    playlistToSend.sequenceContext = {
                        sequenceId: player.currentSequenceId,
                        currentPlaylistIndex: player.currentSequenceIndex,
                        playlistIds: JSON.parse(seq.playlistIds)
                    };
                }
                io.to(deviceId).emit('playlist-updated', playlistToSend);
                console.log(`Player ${deviceId} switched to playlist: ${targetPlaylist.name}`);
            } else {
                io.to(deviceId).emit('playlist-updated', { name: 'No Playlist', items: [] }); // Envoyer une playlist vide
            }
        }
    }
};

// Middleware de sécurité
const authMiddleware = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Format: Bearer <token>

    // Authentification pour les clients Pi (API Key)
    if (apiKey === API_KEY) { // Check against the loaded API_KEY
        req.user = { role: 'admin' }; // Les écrans (Pi) sont authentifiés via clef
        return next();
    }

    if (req.path === '/api/player/log') {
        console.log(`[AUTH] Rejet log stats de ${req.ip}. Clé reçue: "${apiKey}", Attendue: "${API_KEY}"`);
    }

    // Authentification pour les utilisateurs admin (JWT)
    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET); // Check against the loaded JWT_SECRET
            req.user = decoded; // Le payload du JWT contient { username, role }
            return next();
        } catch (err) {
            return res.status(401).send('Token invalide ou expiré');
        }
    }
    res.status(403).send('Accès refusé. Aucun token ou clé API fourni.');
};

const checkRole = (roles) => (req, res, next) => {
    if (roles.includes(req.user.role)) return next();
    res.status(403).send('Accès refusé pour ce profil');
};

app.use(express.json());
app.use('/img', express.static(path.join(__dirname, 'img')));
app.use('/media', authMiddleware, express.static(MEDIA_DIR));

// Route par défaut pour servir l'interface d'administration
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Route pour l'éditeur de diaporama
app.get('/editor', (req, res) => {
    res.sendFile(path.join(__dirname, 'editor.html'));
});

// Route pour le lecteur (utilisée aussi pour la prévisualisation)
app.get('/player', (req, res) => {
    res.sendFile(path.join(__dirname, 'player.html'));
});

// Route pour la page de gestion des utilisateurs
app.get('/users', (req, res) => {
    res.sendFile(path.join(__dirname, 'users.html'));
});

// Route pour la page de gestion de la médiathèque
app.get('/mediatheque', (req, res) => {
    res.sendFile(path.join(__dirname, 'media.html'));
});

// Helper to get file type from mimetype or extension
const getFileType = (mimetype, filename) => {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('video/')) return 'video';
    if (mimetype.startsWith('audio/')) return 'audio';

    const ext = path.extname(filename).toLowerCase();
    if (ext === '.html' || ext === '.htm') return 'html';
    if (ext === '.svg') return 'svg';
    if (ext === '.json') return 'json';
    if (['.ttf', '.otf', '.woff', '.woff2'].includes(ext)) return 'font';
    return 'other';
};

// Route de login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await db('users').where({ username }).first();
    if (user && await bcrypt.compare(password, user.password)) {
        const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ token: token, role: user.role });
    } else {
        res.status(401).send('Identifiants incorrects');
    }
});

// API Admin : Lister les players et affecter des playlists
app.get('/api/admin/data', authMiddleware, checkRole(['admin', 'editor', 'author']), (req, res) => {
    // Fetch all data from DB
    Promise.all([
        db('players').select('*'),
        db('playlists').select('*').then(rows => rows.reduce((acc, p) => ({ ...acc, [p.id]: { ...p, items: JSON.parse(p.items) } }), {})),
        db('sequences').select('*').then(rows => rows.reduce((acc, s) => ({ ...acc, [s.id]: { ...s, playlistIds: JSON.parse(s.playlistIds) } }), {})),
        db('settings').select('*'),
        db('groups').select('*')
    ]).then(([players, playlists, sequences, settings, groups]) => {
        const formattedPlayers = players.reduce((acc, p) => ({ ...acc, [p.id]: { ...p, downloadStatus: JSON.parse(p.downloadStatus || '{}') } }), {});
        const formattedSettings = settings.reduce((acc, s) => ({ ...acc, [s.key]: s.value }), {});

        const responseData = {
            players: formattedPlayers,
            playlists,
            sequences,
            settings: formattedSettings,
            groups
        };

        if (req.user.role === 'admin') {
            res.json(responseData);
        } else {
            const { settings, ...publicData } = responseData; // Hide settings from non-admins
            res.json(publicData);
        }
    }).catch(err => {
        console.error('Error fetching admin data:', err);
        res.status(500).send('Error fetching data');
    });
});

// API Admin : Lister les médias
app.get('/api/admin/media', authMiddleware, checkRole(['admin', 'editor', 'author']), (req, res) => {
    db('media').select('*').then(media => res.json(media)).catch(err => res.status(500).send('Error fetching media'));
});

// API Player : Enregistrement des logs de diffusion
app.post('/api/player/log', authMiddleware, (req, res) => {
    const { deviceId, playlistId, itemUrl, duration } = req.body;
    console.log(`📊 Statistique reçue de ${deviceId}: ${itemUrl} (${duration}ms)`);
    db('analytics').insert({ deviceId, playlistId, itemUrl, duration })
        .then(() => res.json({ success: true }))
        .catch(err => res.status(500).send(err.message));
});

// API Admin : Statistiques de diffusion
app.get('/api/admin/analytics', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    db('analytics')
        .select('itemUrl')
        .count('id as count')
        .sum('duration as totalDuration')
        .groupBy('itemUrl')
        .orderBy('count', 'desc')
        .limit(50)
        .then(stats => res.json(stats))
        .catch(err => res.status(500).send(err.message));
});

app.get('/api/admin/analytics/hourly', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    // Récupérer les stats groupées par heure pour les dernières 24 heures
    db('analytics')
        .select(db.raw("strftime('%H', timestamp) as hour"))
        .count('id as count')
        .where('timestamp', '>', db.raw("datetime('now', '-24 hours')"))
        .groupBy('hour')
        .orderBy('hour', 'asc')
        .then(stats => {
            // On remplit les heures vides pour avoir un graphique complet (00h à 23h)
            const hourlyData = Array.from({ length: 24 }, (_, i) => {
                const hourStr = i.toString().padStart(2, '0');
                const stat = stats.find(s => s.hour === hourStr);
                return { hour: hourStr + 'h', count: stat ? stat.count : 0 };
            });
            res.json(hourlyData);
        })
        .catch(err => res.status(500).send(err.message));
});

app.delete('/api/admin/analytics', authMiddleware, checkRole(['admin']), (req, res) => {
    db('analytics').del()
        .then(() => res.json({ success: true }))
        .catch(err => res.status(500).send(err.message));
});

// API Admin : Gestion des Alertes / Messages Flash
app.get('/api/admin/alerts', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    db('alerts').select('*').orderBy('createdAt', 'desc')
        .then(alerts => res.json(alerts))
        .catch(err => res.status(500).send(err.message));
});

app.post('/api/admin/alerts', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { text, type, targetDeviceId } = req.body;
    if (!text) return res.status(400).send('Texte manquant');
    
    const newAlert = { text, type, targetDeviceId: targetDeviceId || null };
    db('alerts').insert(newAlert).then(([id]) => {
        const alertWithId = { id, ...newAlert };
        if (targetDeviceId) io.to(targetDeviceId).emit('show-alert', alertWithId);
        else io.emit('show-alert', alertWithId);
        res.json(alertWithId);
    }).catch(err => res.status(500).send(err.message));
});

app.delete('/api/admin/alerts/:id', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    db('alerts').where({ id: req.params.id }).del()
        .then(() => {
            io.emit('clear-alert', req.params.id);
            res.json({ success: true });
        }).catch(err => res.status(500).send(err.message));
});

// API Admin : Gestion des Groupes
app.get('/api/admin/groups', authMiddleware, checkRole(['admin', 'editor', 'author']), (req, res) => {
    db('groups').select('*').then(groups => res.json(groups)).catch(err => res.status(500).send(err.message));
});

app.post('/api/admin/groups', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { id, name, description } = req.body;
    if (!name) return res.status(400).send('Nom manquant');
    const groupId = id || `grp_${Date.now()}`;
    db('groups').insert({ id: groupId, name, description }).onConflict('id').merge()
        .then(() => res.json({ success: true, groupId }))
        .catch(err => res.status(500).send(err.message));
});

app.delete('/api/admin/groups/:id', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { id } = req.params;
    db('groups').where({ id }).del()
        .then(async (count) => {
            if (count > 0) {
                // Désassigner les joueurs de ce groupe
                await db('players').where({ groupId: id }).update({ groupId: null });
                res.json({ success: true });
            } else res.status(404).send('Groupe non trouvé');
        })
        .catch(err => res.status(500).send(err.message));
});

app.post('/api/admin/players/:deviceId/group', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { deviceId } = req.params;
    const { groupId } = req.body;
    db('players').where({ id: deviceId }).update({ groupId })
        .then(() => res.json({ success: true }))
        .catch(err => res.status(500).send(err.message));
});

app.post('/api/admin/groups/:groupId/assign', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { groupId } = req.params;
    const { targetId } = req.body; // targetId can be "p:id" or "s:id"

    if (!targetId) return res.status(400).send('Cible (playlist/séquence) manquante.');

    let updateData = {};
    if (targetId.startsWith('s:')) {
        updateData = { manualSequenceId: targetId.substring(2), manualPlaylistId: null };
    } else {
        updateData = { manualPlaylistId: targetId.replace('p:', ''), manualSequenceId: null };
    }

    db('players').where({ groupId }).update(updateData)
        .then(() => { checkSchedules(); res.json({ success: true }); })
        .catch(err => res.status(500).send('Erreur lors de l\'assignation au groupe: ' + err.message));
});

app.post('/api/admin/groups/:groupId/screenshot', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { groupId } = req.params;
    db('players').where({ groupId })
        .then(players => {
            players.forEach(p => io.to(p.id).emit('request-screenshot'));
            console.log(`📸 Demande de capture envoyée au groupe ${groupId} (${players.length} écrans)`);
            res.json({ success: true, count: players.length });
        })
        .catch(err => res.status(500).send(err.message));
});

// API Admin : Gestion des Séquences
app.get('/api/admin/sequences', authMiddleware, checkRole(['admin', 'editor', 'author']), (req, res) => {
    db('sequences').select('*').then(sequences => {
        const formattedSequences = sequences.reduce((acc, s) => ({ ...acc, [s.id]: { ...s, playlistIds: JSON.parse(s.playlistIds) } }), {});
        res.json(formattedSequences);
    }).catch(err => res.status(500).send('Error fetching sequences'));
});

app.post('/api/admin/sequences', authMiddleware, checkRole(['admin', 'editor', 'author']), (req, res) => {
    const { id, name, playlistIds } = req.body;
    if (!name || !playlistIds) return res.status(400).send('Données manquantes');
    const sequenceId = id || `seq_${Date.now()}`;
    db('sequences').insert({ id: sequenceId, name, playlistIds: JSON.stringify(playlistIds) })
        .then(() => res.json({ success: true, sequenceId }))
        .catch(err => res.status(500).send('Error creating sequence: ' + err.message));
});

app.delete('/api/admin/sequences/:id', authMiddleware, checkRole(['admin', 'editor', 'author']), (req, res) => {
    const { id } = req.params;
    db('sequences').where({ id }).del()
        .then(async (count) => {
            if (count > 0) {
                // Clean up player assignments
                await db('players').where({ manualSequenceId: id }).update({ manualSequenceId: null });
                res.json({ success: true });
            } else {
                res.status(404).send('Séquence non trouvée');
            }
        })
        .catch(err => res.status(500).send('Error deleting sequence: ' + err.message));
});

app.delete('/api/admin/media/:id', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { id } = req.params; // media ID
    db('media').where({ id }).first()
        .then(async (item) => {
            if (!item) return res.status(404).send('Média non trouvé');

            const relativePath = item.url.replace('/media/', '');
            const filePath = path.join(MEDIA_DIR, relativePath);

            try {
                if (fs.existsSync(filePath)) await fs.unlink(filePath);
            } catch (e) {
                console.error("Erreur lors de la suppression du fichier physique:", e);
            }

            await db('media').where({ id }).del();
            res.json({ success: true });
        })
        .catch(err => res.status(500).send('Error deleting media: ' + err.message));
});

// API Admin : Gestion des utilisateurs
app.get('/api/admin/users', authMiddleware, checkRole(['admin']), (req, res) => {
    db('users').select('id', 'username', 'role', 'email').then(users => res.json(users)).catch(err => res.status(500).send('Error fetching users'));
});

// API Admin : Gestion des agendas
app.get('/api/admin/schedules', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    db('schedules').select('*').then(schedules => res.json(schedules)).catch(err => res.status(500).send('Error fetching schedules'));
});

app.post('/api/admin/schedules', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { id, deviceId, playlistId, sequenceId, startTime, endTime } = req.body;
    if (!deviceId || (!playlistId && !sequenceId) || !startTime || !endTime) {
        return res.status(400).send('Données manquantes pour la planification.');
    }

    const scheduleId = id || `sch_${Date.now()}`;
    const newSchedule = { id: scheduleId, deviceId, playlistId, sequenceId, startTime, endTime };

    db('schedules').where({ id: scheduleId }).first()
        .then(async (existingSchedule) => {
            if (existingSchedule) {
                await db('schedules').where({ id: scheduleId }).update(newSchedule);
            } else {
                await db('schedules').insert(newSchedule);
            }
            await checkSchedules(); // Re-evaluate schedules immediately
            res.json({ success: true, scheduleId });
        }).catch(err => res.status(500).send('Error saving schedule: ' + err.message));
});

app.delete('/api/admin/schedules/:id', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { id } = req.params;
    db('schedules').where({ id }).del()
        .then(async (count) => {
            if (count > 0) {
                await checkSchedules(); // Re-evaluate schedules immediately
                res.json({ success: true });
            } else {
                res.status(404).send('Planification non trouvée');
            }
        })
        .catch(err => res.status(500).send('Error deleting schedule: ' + err.message));
});

app.post('/api/admin/users', authMiddleware, checkRole(['admin']), async (req, res) => {
    const { username, password, role, email } = req.body;
    if (!username || !password || !role) return res.status(400).send('Données manquantes');
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    db('users').where({ username }).first()
        .then(async (existingUser) => {
            if (existingUser) {
                await db('users').where({ username }).update({ password: hashedPassword, role, email });
            } else {
                await db('users').insert({ username, password: hashedPassword, role, email });
            }
            res.json({ success: true });
        })
        .catch(err => res.status(500).send('Error saving user: ' + err.message));
});

app.delete('/api/admin/users/:username', authMiddleware, checkRole(['admin']), (req, res) => {
    const { username } = req.params;
    if (username === 'admin') return res.status(400).send('Impossible de supprimer le compte admin principal');
    db('users').where({ username }).del()
        .then((count) => {
            if (count > 0) {
                res.json({ success: true });
            } else {
                res.status(404).send('Utilisateur non trouvé');
            }
        })
        .catch(err => res.status(500).send('Error deleting user: ' + err.message));
});

app.post('/api/admin/upload', authMiddleware, checkRole(['admin', 'editor', 'author']), upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send('Aucun fichier uploadé.');

    const originalFilename = req.file.originalname;
    const uploadedFilePath = req.file.path;
    const uploadedFileMimetype = req.file.mimetype;
    const uploadedFileName = req.file.filename; // This is the Date.now() + extname

    // Détection plus robuste du format ZIP (MimeType ou Extension)
    const isZip = uploadedFileMimetype === 'application/zip' || 
                  uploadedFileMimetype === 'application/x-zip-compressed' || 
                  path.extname(originalFilename).toLowerCase() === '.zip';

    if (isZip) {
        try {
            const zip = new AdmZip(uploadedFilePath);
            const zipEntries = zip.getEntries();

            const extractedFiles = [];
            const zipExtractDirName = `zip_extract_${Date.now()}_${path.parse(originalFilename).name.replace(/[^a-z0-9_.-]/gi, '_')}`;
            const zipExtractDirPath = path.join(MEDIA_DIR, zipExtractDirName);
            await fs.ensureDir(zipExtractDirPath);

            for (const zipEntry of zipEntries) {
                if (!zipEntry.isDirectory) {
                    const entryFilename = zipEntry.entryName;
                    const fullExtractPath = path.join(zipExtractDirPath, entryFilename);

                    // Ensure parent directories exist for the extracted file
                    await fs.ensureDir(path.dirname(fullExtractPath));

                    // Extract the file
                    // Correction de l'ordre des paramètres : (entryName, targetPath, maintainEntryPath, overwrite)
                    zip.extractEntryTo(zipEntry.entryName, path.dirname(fullExtractPath), false, true);

                    const extractedMimeType = mime.lookup(entryFilename) || 'application/octet-stream';
                    const urlPath = path.relative(MEDIA_DIR, fullExtractPath).split(path.sep).join('/');
                    const mediaItem = {
                        id: `m_${Date.now()}_${extractedFiles.length}`,
                        filename: entryFilename,
                        originalZip: originalFilename, // Permet de grouper dans l'éditeur
                        url: `/media/${urlPath}`,
                        type: getFileType(extractedMimeType, entryFilename),
                        uploadedBy: req.user.username,
                        uploadDate: new Date().toISOString(),
                        parentZipDir: zipExtractDirName // Link to the original zip extraction directory
                    };
                    await db('media').insert(mediaItem);
                    extractedFiles.push(mediaItem);
                }
            }
            // Remove the original zip file after extraction
            await fs.remove(uploadedFilePath);
            return res.json({ message: 'Fichier ZIP extrait avec succès et médias ajoutés.', extractedFiles });

        } catch (error) {
            console.error('Erreur lors de l\'extraction du fichier ZIP:', error);
            // Clean up the uploaded zip file if extraction fails
            await fs.remove(uploadedFilePath);
            return res.status(500).send('Erreur lors de l\'extraction du fichier ZIP.');
        }
    } else {
        // Existing logic for non-zip files
        const mediaItem = {
            id: `m_${Date.now()}`,
            filename: originalFilename,
            url: `/media/${uploadedFileName}`,
            type: getFileType(uploadedFileMimetype, originalFilename),
            uploadedBy: req.user.username,
            uploadDate: new Date().toISOString()
        };

    await db('media').insert(mediaItem);
    res.json(mediaItem);
    }
});

// Route pour l'import PPTX (Structure suggérée)
app.post('/api/admin/import-pptx', authMiddleware, checkRole(['admin', 'editor']), upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send('Aucun fichier PPTX.');

    try {
        const fileBaseName = path.parse(req.file.filename).name;
        const subFolderName = `pptx_${Date.now()}`;
        const outputDir = path.join(MEDIA_DIR, subFolderName);
        await fs.ensureDir(outputDir);

        // 1. Conversion PPTX -> PDF via LibreOffice
        await execPromise(`soffice --headless --convert-to pdf --outdir "${outputDir}" "${req.file.path}"`);
        
        const pdfPath = path.join(outputDir, `${fileBaseName}.pdf`);
        if (!await fs.pathExists(pdfPath)) {
            throw new Error("La conversion PDF a échoué. Vérifiez que LibreOffice est installé.");
        }

        // 2. Conversion PDF -> PNG (un par slide) via pdftocairo
        await execPromise(`pdftocairo -png "${pdfPath}" "${outputDir}/slide"`);

        // 3. Nettoyage (suppression du PDF temporaire et du PPTX uploadé)
        await fs.remove(pdfPath);
        await fs.remove(req.file.path);

        // 4. Lecture des images générées et création des entrées DB
        const files = await fs.readdir(outputDir);
        const imageFiles = files.filter(f => f.toLowerCase().endsWith('.png')).sort((a, b) => 
            a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'})
        );

        const playlistId = `pptx_${Date.now()}`;
        const playlistItems = await Promise.all(imageFiles.map(async (file, index) => {
            const relativeUrl = `/media/${subFolderName}/${file}`;
            // Ajout à la médiathèque globale
            const mediaItem = {
                id: `m_pptx_${Date.now()}_${index}`,
                filename: `${req.file.originalname} (Slide ${index + 1})`,
                url: relativeUrl,
                type: 'image',
                uploadedBy: req.user.username,
                uploadDate: new Date().toISOString()
            };
            await db('media').insert(mediaItem);
            return { type: 'image', url: relativeUrl, duration: 10000 };
        }));

        const playlistData = {
            id: playlistId,
            name: `Import: ${req.file.originalname}`,
            items: JSON.stringify(playlistItems),
            backgroundColor: "#ffffff",
            resolution: "16/9"
        };

        await db('playlists').insert(playlistData);
        res.json({ success: true, playlistId }); // Return the ID of the newly created playlist

    } catch (error) {
        console.error("Erreur import PPTX:", error);
        res.status(500).send("Erreur lors de l'importation : " + error.message);
    }
});

app.post('/api/admin/playlists', authMiddleware, checkRole(['admin', 'editor', 'author']), (req, res) => {
    const { id, name, items, backgroundUrl, backgroundColor, resolution } = req.body;
    // On génère un ID si c'est une nouvelle playlist
    const playlistId = id || `p_${Date.now()}`; // Use provided ID or generate new
    const playlistData = { id: playlistId, name, items: JSON.stringify(items), backgroundUrl, backgroundColor, resolution };
    db('playlists').where({ id: playlistId }).first()
        .then(async (existingPlaylist) => {
            if (existingPlaylist) {
                await db('playlists').where({ id: playlistId }).update(playlistData);
            } else {
                await db('playlists').insert(playlistData);
            }
            checkSchedules(null, true); // Force la mise à jour des écrans utilisant ce diaporama
            res.json({ success: true, playlistId });
        })
        .catch(err => res.status(500).send('Error saving playlist: ' + err.message));
});

app.delete('/api/admin/playlists/:id', authMiddleware, checkRole(['admin', 'editor', 'author']), (req, res) => {
    const { id } = req.params;
    db('playlists').where({ id }).del()
        .then(async (count) => {
            if (count > 0) {
                await db('players').where({ manualPlaylistId: id }).update({ manualPlaylistId: null });
                await db('players').where({ currentPlaylistId: id }).update({ currentPlaylistId: null });
                res.json({ success: true });
            } else {
                res.status(404).send('Diaporama non trouvé');
            }
        })
        .catch(err => res.status(500).send('Error deleting playlist: ' + err.message));
});

app.post('/api/admin/settings', authMiddleware, checkRole(['admin']), (req, res) => {
    const { jwtSecret, apiKey, disableClientLogs, disableDebugLogs, splashScreenUrl } = req.body;
    if (!jwtSecret || !apiKey) return res.status(400).send('Données manquantes');
    db('settings').where({ key: 'jwtSecret' }).update({ value: jwtSecret })
        .then(() => db('settings').where({ key: 'apiKey' }).update({ value: apiKey }))
        .then(() => db('settings').where({ key: 'disableClientLogs' }).update({ value: String(!!disableClientLogs) }))
        .then(() => db('settings').where({ key: 'disableDebugLogs' }).update({ value: String(!!disableDebugLogs) }))
        .then(() => db('settings').where({ key: 'splashScreenUrl' }).update({ value: splashScreenUrl || '/img/splashscreen.png' }))
        .then(() => {
            JWT_SECRET = jwtSecret;
            API_KEY = apiKey;
            DISABLE_CLIENT_LOGS = !!disableClientLogs;
            DISABLE_DEBUG_LOGS = !!disableDebugLogs;
            SPLASH_SCREEN_URL = splashScreenUrl || '/img/splashscreen.png';
            checkSchedules(null, true); // Force la mise à jour de tous les écrans connectés
            console.log("⚙️ Paramètres système mis à jour via l'interface admin.");
            res.json({ success: true });
        })
        .catch(err => res.status(500).send('Error saving settings: ' + err.message));
});

// API Admin : Outil de sauvegarde (Export ZIP)
app.get('/api/admin/backup', authMiddleware, checkRole(['admin']), async (req, res) => {
    try {
        const zip = new AdmZip();
        
        // 0. Ajout de la base de données SQLite brute
        if (fs.existsSync(SQLITE_DB_PATH)) {
            zip.addLocalFile(SQLITE_DB_PATH);
        }

        // 1. Export des données de la base
        const playlists = await db('playlists').select('*');
        const mediaRecords = await db('media').select('*');
        const sequences = await db('sequences').select('*');

        const dbExport = {
            version: "1.0",
            date: new Date().toISOString(),
            playlists: playlists.map(p => ({ ...p, items: JSON.parse(p.items) })),
            media: mediaRecords,
            sequences: sequences.map(s => ({ ...s, playlistIds: JSON.parse(s.playlistIds) }))
        };

        zip.addFile("database_export.json", Buffer.from(JSON.stringify(dbExport, null, 2), "utf8"));

        // 2. Ajout de la médiathèque physique
        if (fs.existsSync(MEDIA_DIR)) {
            zip.addLocalFolder(MEDIA_DIR, "media");
        }

        const buffer = zip.toBuffer();
        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', `attachment; filename=pidyn_backup_${Date.now()}.zip`);
        res.send(buffer);
    } catch (error) {
        console.error("Erreur lors de la sauvegarde :", error);
        res.status(500).send("Erreur lors de la génération de la sauvegarde.");
    }
});

app.post('/api/admin/restore', authMiddleware, checkRole(['admin']), upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send('Aucun fichier fourni.');

    try {
        const zip = new AdmZip(req.file.path);
        
        // 1. Extraction de la base de données (écrase l'existante)
        // Note: Sur Windows, le fichier peut être verrouillé. Le process.exit() aidera au redémarrage.
        zip.extractEntryTo("pidyn.sqlite", __dirname, false, true);

        // 2. Extraction des médias
        // Le ZIP contient un dossier "media/", on l'extrait vers le dossier parent de MEDIA_DIR
        const publicDir = path.join(__dirname, 'public');
        zip.extractEntryTo("media/", publicDir, true, true);

        await fs.remove(req.file.path); // Nettoyage du fichier temporaire

        res.json({ success: true, message: "Restauration effectuée. Redémarrage..." });

        // Forcer le redémarrage pour recharger la base de données proprement
        setTimeout(() => process.exit(0), 1500);
    } catch (err) {
        console.error("Erreur Restauration:", err);
        res.status(500).send("Erreur lors de la restauration : " + err.message);
    }
});

app.post('/api/admin/players/force-sync/:deviceId', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { deviceId } = req.params;
    db('players').where({ id: deviceId }).first()
        .then(player => {
            if (player) {
                checkSchedules(deviceId, true); // Fire and forget
                res.json({ success: true, message: 'Synchronisation forcée effectuée.' });
            } else {
                res.status(404).send('Player non trouvé');
            }
        })
        .catch(err => res.status(500).send('Error forcing sync: ' + err.message));
});

app.post('/api/admin/players/restart-screen/:deviceId', authMiddleware, checkRole(['admin']), (req, res) => {
    const { deviceId } = req.params;
    db('players').where({ id: deviceId }).first()
        .then(player => {
            if (player) {
                io.to(deviceId).emit('restart-service');
                console.log(`📡 Commande de redémarrage envoyée à ${deviceId}`);
                res.json({ success: true, message: 'Commande de redémarrage envoyée.' });
            } else {
                res.status(404).send('Player non trouvé');
            }
        })
        .catch(err => res.status(500).send('Error restarting screen: ' + err.message));
});

app.post('/api/admin/players/clear-cache/:deviceId', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { deviceId } = req.params;
    db('players').where({ id: deviceId }).first()
        .then(player => {
            if (player) {
                io.to(deviceId).emit('clear-local-cache');
                console.log(`🧹 Commande de nettoyage du cache envoyée à ${deviceId}`);
                res.json({ success: true, message: 'Commande de nettoyage envoyée.' });
            } else {
                res.status(404).send('Player non trouvé');
            }
        })
        .catch(err => res.status(500).send('Error clearing cache: ' + err.message));
});

app.post('/api/admin/players/approve/:deviceId', authMiddleware, checkRole(['admin']), (req, res) => {
    const { deviceId } = req.params;
    db('players').where({ id: deviceId }).update({ status: 'approved' })
        .then((count) => {
            if (count > 0) {
                res.json({ success: true });
            } else {
                res.status(404).send('Player non trouvé');
            }
        })
        .catch(err => res.status(500).send('Error approving player: ' + err.message));
});

app.delete('/api/admin/players/:deviceId', authMiddleware, checkRole(['admin']), (req, res) => {
    const { deviceId } = req.params;
    db('players').where({ id: deviceId }).del()
        .then((count) => {
            if (count > 0) {
                io.sockets.sockets.forEach(socket => {
                    if (socket.handshake.query.deviceId === deviceId) socket.disconnect(true);
                });
                res.json({ success: true });
            } else {
                res.status(404).send('Player non trouvé');
            }
        })
        .catch(err => res.status(500).send('Error deleting player: ' + err.message));
});

app.post('/api/admin/players/screen', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { deviceId, action } = req.body; // action: 'on' ou 'off'
    db('players').where({ id: deviceId }).first()
        .then(player => {
            if (player) {
                io.to(deviceId).emit('screen-command', { action });
                console.log(`📡 Commande envoyée à ${deviceId} : Écran ${action}`);
                res.json({ success: true });
            } else {
                res.status(404).send('Player non trouvé');
            }
        })
        .catch(err => res.status(500).send('Error sending screen command: ' + err.message));
});

app.post('/api/admin/assign', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { deviceId, targetId } = req.body; // targetId peut être "p:id" ou "s:id"
    let updateData = {};
    if (!targetId) {
        updateData = { manualPlaylistId: null, manualSequenceId: null };
    } else if (targetId.startsWith('s:')) {
        updateData = { manualSequenceId: targetId.substring(2), manualPlaylistId: null };
    } else {
        updateData = { manualPlaylistId: targetId.replace('p:', ''), manualSequenceId: null };
    }

    db('players').where({ id: deviceId }).update(updateData)
        .then((count) => {
            if (count > 0) {
                checkSchedules();
                res.json({ success: true });
            } else {
                res.status(404).send('Player non trouvé');
            }
        })
        .catch(err => res.status(500).send('Error assigning playlist/sequence: ' + err.message));
});

// Socket.io avec authentification et gestion de salon (Room)
io.use((socket, next) => {
    const authHeader = socket.handshake.auth.token; // Peut être API_KEY ou JWT

    // Authentification pour les clients Pi (API Key)
    if (authHeader === API_KEY) return next();

    // Authentification pour les clients Admin (JWT)
    if (authHeader) {
        try {
            const decoded = jwt.verify(authHeader, JWT_SECRET);
            socket.user = decoded; // Attacher les infos utilisateur au socket
            return next();
        } catch (err) {
            return next(new Error('Auth error: Invalid or expired token'));
        }
    }
    next(new Error('Auth error'));
});

io.on('connection', async (socket) => {
    const deviceId = socket.handshake.query.deviceId;
    console.log(`Player connecté : ${deviceId}`);
    
    socket.join(deviceId);
    
    const lastSeen = new Date();
    db('players').insert({ id: deviceId, name: `Nouveau Pi (${deviceId})`, status: 'pending', lastSeen, downloadStatus: '{}' })
     .onConflict('id').merge({ lastSeen: lastSeen }) // Only update lastSeen on conflict
        .then(async () => { // Use async here
            console.log(`Player ${deviceId} connected (Updated lastSeen)`);
            await checkSchedules(deviceId, true); // Ensure checkSchedules is awaited
            
            // Envoyer les alertes actives pour ce player
            const tableAlertsExists = await db.schema.hasTable('alerts'); // Check if table exists
            if (tableAlertsExists) {
                const alerts = await db('alerts').where('targetDeviceId', deviceId).orWhereNull('targetDeviceId');
                alerts.forEach(a => socket.emit('show-alert', a));
            }
        })
        .catch(err => console.error(`Error connection player ${deviceId}:`, err)); // More specific error message

    // Notifier les administrateurs que le lecteur est en ligne
    io.emit('admin-player-status', { deviceId, status: { online: true } });

    // Maintenir la date de dernière vue tant que le lecteur est connecté
    const heartbeat = setInterval(async () => {
        await db('players').where({ id: deviceId }).update({ lastSeen: new Date() });
    }, 30000); // Heartbeat every 30 seconds

    // Gérer les mises à jour de statut de téléchargement
    socket.on('player-status-update', (status) => {
        db('players').where({ id: deviceId }).update({ downloadStatus: JSON.stringify(status) })
            .then(() => {
                if (status.downloading === false) {
                    console.log(`✅ Afficheur ${deviceId} synchronisé avec succès.`);
                }
                io.emit('admin-player-status', { deviceId, status });
            })
            .catch(err => console.error(`Error updating download status for ${deviceId}:`, err));
    });

    // Mise à jour des infos réseau (IP/MAC)
    socket.on('player-info-update', (info) => {
        db('players').where({ id: deviceId }).update({ 
            ip: info.ip, 
            mac: info.mac,
            wifiSSID: info.ssid,
            wifiSignal: info.signal
        })
            .then(() => console.log(`Player ${deviceId} info updated: IP=${info.ip}, MAC=${info.mac}`))
            .catch(err => console.error(`Error updating player info for ${deviceId}:`, err));
    });

    // Gérer la demande de la playlist suivante dans une séquence
    socket.on('request-next-playlist-in-sequence', async () => {
        const player = await db('players').where({ id: deviceId }).first();
        const seq = player && player.currentSequenceId ? await db('sequences').where({ id: player.currentSequenceId }).first() : null;
        
        if (seq) {
            const playlistIds = JSON.parse(seq.playlistIds);
            const nextIndex = (player.currentSequenceIndex + 1) % playlistIds.length;
            await db('players').where({ id: deviceId }).update({ currentSequenceIndex: nextIndex });
            checkSchedules(deviceId, true);
        }
    });

    socket.on('disconnect', () => {
        clearInterval(heartbeat);
        // Notifier les administrateurs que le lecteur est hors ligne
        io.emit('admin-player-status', { deviceId, status: { online: false } });
    });
});

// Exécuter checkSchedules toutes les minutes
setInterval(() => checkSchedules(), 60 * 1000);

// Gestionnaire d'erreurs global pour capturer les erreurs Multer ou système
app.use((err, req, res, next) => {
    console.error("Erreur serveur :", err.message);
    res.status(500).send(err.message);
});