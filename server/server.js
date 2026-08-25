const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs-extra');
const multer = require('multer');
const bcrypt = require('bcrypt');
const AdmZip = require('adm-zip');
const mime = require('mime-types');
const { exec, spawn } = require('child_process');
const util = require('util');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const knex = require('knex');
const sqlite3 = require('sqlite3'); // Required by knex for SQLite
const QRCode = require('qrcode');
const crypto = require('crypto');
const execPromise = util.promisify(exec);
const saltRounds = 10;

function generateStrongPassword(length = 16) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#*()_+-=';
    let pwd = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
        pwd += chars[bytes[i] % chars.length];
    }
    return pwd;
}


// Surcharge de console.log et console.error pour ajouter l'horodatage automatiquement
const originalLog = console.log;
console.log = (...args) => originalLog(`[${new Date().toLocaleString()}]`, ...args);
const originalError = console.error;
console.error = (...args) => originalError(`[${new Date().toLocaleString()}]`, ...args);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8, // 100 MB max payload size for screenshots
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
let SCREEN_WAKE_TIME = '07:00';
let SCREEN_SLEEP_TIME = '22:00';
let SCREEN_SLEEP_SCHEDULE = null;
let SPLASH_SCREEN_URL = '/img/splashscreen.png';
let SMTP_HOST = '';
let SMTP_PORT = '587';
let SMTP_USER = '';
let SMTP_PASS = '';
let NOTIFICATION_EMAIL = '';
let EMAIL_NOTIFICATIONS_ENABLED = true;
let NOTIFY_PLAYLIST_CHANGE = true;
let NOTIFY_PLAYER_OFFLINE = true;
let NOTIFY_PLAYER_ONLINE = true;
let NOTIFY_TECH_ALERT = true;
let OFFLINE_ALERT_DELAY = 15;
let SHOW_OFFLINE_ALERT = true;
let PERIODIC_SCREENSHOT_ENABLED = false;
let PERIODIC_SCREENSHOT_INTERVAL = 5; // En minutes
const SQLITE_DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'pidyn.sqlite'); // New SQLite DB path
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'public/media');

const resolveLocalBinary = (filename) => {
    const isWin = process.platform === 'win32';
    const cleanName = isWin ? filename : filename.replace('.exe', '');
    
    // 1. Check in root server folder
    const pathRoot = path.join(__dirname, cleanName);
    if (fs.existsSync(pathRoot)) return `"${pathRoot}"`;
    
    // 2. Check in 'bin' subfolder
    const pathBin = path.join(__dirname, 'bin', cleanName);
    if (fs.existsSync(pathBin)) return `"${pathBin}"`;
    
    // 3. Check in 'app' subfolder
    const pathApp = path.join(__dirname, 'app', cleanName);
    if (fs.existsSync(pathApp)) return `"${pathApp}"`;
    
    return cleanName; // Fallback to global command
};

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
        { username: 'auteur', password: '123456', role: 'author' },
        { username: 'cuisinier', password: '123456', role: 'cook' },
        { username: 'secretaire', password: '123456', role: 'secretary' }
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
                table.string('role').notNullable(); // admin, editor, author, cook
                table.string('email').unique();
            });
            console.log('Table "users" created.');
            // Insert default users
            const adminPassword = generateStrongPassword(16);
            const dbDir = path.dirname(SQLITE_DB_PATH);
            const pwdFilePath = path.join(dbDir, 'admin_password.txt');
            fs.writeFileSync(pwdFilePath, adminPassword, 'utf8');

            const usersToInsert = await Promise.all(defaultData.users.map(async u => {
                const isAdmin = u.role === 'admin';
                const pwd = isAdmin ? adminPassword : u.password;
                return {
                    username: u.username,
                    password: await bcrypt.hash(pwd, saltRounds),
                    role: u.role
                };
            }));
            await db('users').insert(usersToInsert);
            console.log('Default users inserted.');

            console.log('\n============================================================');
            console.log('              PREMIER DÉMARRAGE DE OMNISIGN');
            console.log('              ');
            console.log('  Un mot de passe administrateur fort a été généré :');
            console.log('  ');
            console.log('  Utilisateur : admin');
            console.log(`  Mot de passe : ${adminPassword}`);
            console.log('  ');
            console.log('  Ce mot de passe est enregistré dans :');
            console.log(`  ${pwdFilePath}`);
            console.log('  ');
            console.log('  Veuillez le changer après votre première connexion !');
            console.log('============================================================\n');
        }
        // Migration : Ajout de la colonne email si elle n'existe pas
        const hasEmail = await db.schema.hasColumn('users', 'email');
        if (!hasEmail) {
            await db.schema.table('users', (table) => {
                table.string('email').unique();
            });
            console.log('Colonne "email" ajoutée à la table "users".');
        } else {
            // Nettoyage des anciennes valeurs vides pour éviter les conflits d'unicité SQLite
            await db('users').where({ email: '' }).update({ email: null });
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

        // Migration : Ajout des colonnes de suivi si absentes
        const columnsToAdd = ['createdBy', 'updatedBy', 'createdAt', 'updatedAt', 'status'];
        for (const col of columnsToAdd) {
            const hasCol = await db.schema.hasColumn('playlists', col);
            if (!hasCol) {
                await db.schema.table('playlists', (table) => {
                    if (col === 'createdBy' || col === 'updatedBy') {
                        table.string(col);
                    } else if (col === 'status') {
                        table.string(col).defaultTo('approved');
                    } else {
                        table.timestamp(col);
                    }
                });
                console.log(`Colonne de suivi/statut "${col}" ajoutée à la table "playlists".`);
            }
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
                table.boolean('offlineAlertSent').defaultTo(false);
                table.integer('volume').defaultTo(100);
                table.text('latestScreenshot');
                table.string('screenResolution');
            });
            console.log('Table "players" created.');
        }

        // Migration : Ajout de la colonne offlineAlertSent si elle n'existe pas
        const hasOfflineAlertSent = await db.schema.hasColumn('players', 'offlineAlertSent');
        if (!hasOfflineAlertSent) {
            await db.schema.table('players', (table) => {
                table.boolean('offlineAlertSent').defaultTo(false);
            });
            console.log('Colonne "offlineAlertSent" ajoutée à la table "players".');
        }

        // Migration : Ajout de la colonne volume si elle n'existe pas
        const hasVolume = await db.schema.hasColumn('players', 'volume');
        if (!hasVolume) {
            await db.schema.table('players', (table) => {
                table.integer('volume').defaultTo(100);
            });
            console.log('Colonne "volume" ajoutée à la table "players".');
        }

        // Migration : Ajout de la colonne latestScreenshot si elle n'existe pas
        const hasLatestScreenshot = await db.schema.hasColumn('players', 'latestScreenshot');
        if (!hasLatestScreenshot) {
            await db.schema.table('players', (table) => {
                table.text('latestScreenshot');
            });
            console.log('Colonne "latestScreenshot" ajoutée à la table "players".');
        }

        // Migration : Ajout des colonnes de télémétrie et de santé (RAM, Disque, Temp CPU)
        const hasHealthCols = await db.schema.hasColumn('players', 'totalMem');
        if (!hasHealthCols) {
            await db.schema.table('players', (table) => {
                table.integer('totalMem');
                table.integer('freeMem');
                table.integer('diskTotal');
                table.integer('diskFree');
                table.float('cpuTemp');
                table.string('lastHealthAlertSent');
            });
            console.log('Colonnes de télémétrie et santé ajoutées à la table "players".');
        }

        // Migration : Ajout de la colonne screenResolution si elle n'existe pas
        const hasScreenResolution = await db.schema.hasColumn('players', 'screenResolution');
        if (!hasScreenResolution) {
            await db.schema.table('players', (table) => {
                table.string('screenResolution');
            });
            console.log('Colonne "screenResolution" ajoutée à la table "players".');
        }
    });

    await db.schema.hasTable('schedules').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('schedules', (table) => {
                table.string('id').primary();
                table.string('name').notNullable();
                table.string('targetType').defaultTo('player'); // 'player', 'group', 'global'
                table.string('targetId'); // deviceId or groupId
                table.string('deviceId'); // Backwards compatibility
                table.string('playlistId'); // Can be null if sequenceId is set
                table.string('sequenceId'); // Can be null if playlistId is set
                table.string('scheduleType').defaultTo('recurring'); // 'recurring' or 'date_range'
                table.string('daysOfWeek').defaultTo('[1,2,3,4,5]'); // JSON string of days [1=Mon..7=Sun]
                table.string('timeStart').defaultTo('00:00'); // HH:mm
                table.string('timeEnd').defaultTo('23:59'); // HH:mm
                table.string('startDate'); // YYYY-MM-DD for date_range
                table.string('endDate'); // YYYY-MM-DD for date_range
                table.integer('priority').defaultTo(10);
                table.boolean('active').defaultTo(true);
                table.timestamp('startTime');
                table.timestamp('endTime');
            });
            console.log('Table "schedules" créée avec support de la planification avancée.');
        } else {
            const hasName = await db.schema.hasColumn('schedules', 'name');
            if (!hasName) {
                await db.schema.table('schedules', (table) => {
                    table.string('name').defaultTo('Règle de diffusion');
                    table.string('targetType').defaultTo('player');
                    table.string('targetId');
                    table.string('scheduleType').defaultTo('recurring');
                    table.string('daysOfWeek').defaultTo('[1,2,3,4,5]');
                    table.string('timeStart').defaultTo('00:00');
                    table.string('timeEnd').defaultTo('23:59');
                    table.string('startDate');
                    table.string('endDate');
                    table.integer('priority').defaultTo(10);
                    table.boolean('active').defaultTo(true);
                });
                console.log('Colonnes de planification avancée ajoutées à la table "schedules".');
            }
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
                table.string('parentFolderId');
                table.string('parentFolderName');
                table.text('metadata');
            });
            console.log('Table "media" created.');
        }

        // Migration : Ajout des colonnes parentFolderId et parentFolderName si absentes
        const hasParentFolderId = await db.schema.hasColumn('media', 'parentFolderId');
        if (!hasParentFolderId) {
            await db.schema.table('media', (table) => {
                table.string('parentFolderId');
                table.string('parentFolderName');
            });
            console.log('Colonnes "parentFolderId" et "parentFolderName" ajoutées à la table "media".');
        }

        // Migration : Ajout de la colonne metadata si absente
        const hasMetadata = await db.schema.hasColumn('media', 'metadata');
        if (!hasMetadata) {
            await db.schema.table('media', (table) => {
                table.text('metadata');
            });
            console.log('Colonne "metadata" ajoutée à la table "media".');
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
                { key: 'disableDebugLogs', value: 'false' },
                { key: 'screenWakeTime', value: '07:00' },
                { key: 'screenSleepTime', value: '22:00' },
                { key: 'smtpHost', value: '' },
                { key: 'smtpPort', value: '587' },
                { key: 'smtpUser', value: '' },
                { key: 'smtpPass', value: '' },
                { key: 'notificationEmail', value: '' },
                { key: 'emailNotificationsEnabled', value: 'true' },
                { key: 'notifyPlaylistChange', value: 'true' },
                { key: 'notifyPlayerOffline', value: 'true' },
                { key: 'notifyPlayerOnline', value: 'true' },
                { key: 'notifyTechAlert', value: 'true' },
                { key: 'offlineAlertDelay', value: '15' },
                { key: 'showOfflineAlert', value: 'true' }
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
        // Migration : s'assurer que showOfflineAlert existe
        const showOfflineAlertSetting = await db('settings').where({ key: 'showOfflineAlert' }).first();
        if (!showOfflineAlertSetting) {
            await db('settings').insert({ key: 'showOfflineAlert', value: 'true' });
            console.log('Setting "showOfflineAlert" ajouté.');
        }
        // Migration : s'assurer que les temps de veille existent
        const wakeSetting = await db('settings').where({ key: 'screenWakeTime' }).first();
        if (!wakeSetting) {
            await db('settings').insert({ key: 'screenWakeTime', value: '07:00' });
            console.log('Setting "screenWakeTime" ajouté.');
        }
        const sleepSetting = await db('settings').where({ key: 'screenSleepTime' }).first();
        if (!sleepSetting) {
            await db('settings').insert({ key: 'screenSleepTime', value: '22:00' });
            console.log('Setting "screenSleepTime" ajouté.');
        }
        // Migration : s'assurer que screenSleepSchedule existe
        const scheduleSetting = await db('settings').where({ key: 'screenSleepSchedule' }).first();
        if (!scheduleSetting) {
            const oldWake = await db('settings').where({ key: 'screenWakeTime' }).first();
            const oldSleep = await db('settings').where({ key: 'screenSleepTime' }).first();
            const wakeVal = oldWake ? oldWake.value : '07:00';
            const sleepVal = oldSleep ? oldSleep.value : '22:00';

            const initialSchedule = {
                "1": { "enabled": true, "slots": [ { "wake": wakeVal, "sleep": sleepVal }, { "wake": "", "sleep": "" } ] },
                "2": { "enabled": true, "slots": [ { "wake": wakeVal, "sleep": sleepVal }, { "wake": "", "sleep": "" } ] },
                "3": { "enabled": true, "slots": [ { "wake": wakeVal, "sleep": sleepVal }, { "wake": "", "sleep": "" } ] },
                "4": { "enabled": true, "slots": [ { "wake": wakeVal, "sleep": sleepVal }, { "wake": "", "sleep": "" } ] },
                "5": { "enabled": true, "slots": [ { "wake": wakeVal, "sleep": sleepVal }, { "wake": "", "sleep": "" } ] },
                "6": { "enabled": false, "slots": [ { "wake": wakeVal, "sleep": sleepVal }, { "wake": "", "sleep": "" } ] },
                "7": { "enabled": false, "slots": [ { "wake": wakeVal, "sleep": sleepVal }, { "wake": "", "sleep": "" } ] }
            };

            await db('settings').insert({ key: 'screenSleepSchedule', value: JSON.stringify(initialSchedule) });
            console.log('Setting "screenSleepSchedule" ajouté via migration des anciennes valeurs.');
        }
        // Migration : SMTP settings
        const smtpKeys = ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'notificationEmail'];
        for (const k of smtpKeys) {
            const exists = await db('settings').where({ key: k }).first();
            if (!exists) {
                await db('settings').insert({ key: k, value: k === 'smtpPort' ? '587' : '' });
                console.log(`Setting "${k}" ajouté.`);
            }
        }
        // Migration : Paramètres de notifications
        const notificationSettings = [
            { key: 'emailNotificationsEnabled', value: 'true' },
            { key: 'notifyPlaylistChange', value: 'true' },
            { key: 'notifyPlayerOffline', value: 'true' },
            { key: 'notifyPlayerOnline', value: 'true' },
            { key: 'notifyTechAlert', value: 'true' },
            { key: 'offlineAlertDelay', value: '15' }
        ];
        for (const s of notificationSettings) {
            const exists = await db('settings').where({ key: s.key }).first();
            if (!exists) {
                await db('settings').insert(s);
                console.log(`Setting "${s.key}" ajouté.`);
            }
        }
        // Migration : Sauvegarde automatique
        const autoBackupSettings = [
            { key: 'autoBackupEnabled', value: 'false' },
            { key: 'autoBackupFrequency', value: 'weekly' },
            { key: 'autoBackupExcludeMedia', value: 'true' },
            { key: 'autoBackupKeepCount', value: '7' },
            { key: 'lastAutoBackupTime', value: '' }
        ];
        for (const s of autoBackupSettings) {
            const exists = await db('settings').where({ key: s.key }).first();
            if (!exists) {
                await db('settings').insert(s);
                console.log(`Setting "${s.key}" ajouté.`);
            }
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

    await db.schema.hasTable('canteen_menus').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('canteen_menus', (table) => {
                table.string('id').primary(); // Format: siteId_weekId
                table.string('siteId').notNullable();
                table.string('week_id').notNullable();
                table.json('data').notNullable();  // Stocke l'objet menu complet
                table.timestamp('updatedAt').defaultTo(db.fn.now());
            });
            console.log('Table "canteen_menus" créée.');
        } else {
            const hasId = await db.schema.hasColumn('canteen_menus', 'id');
            if (!hasId) {
                await db.schema.table('canteen_menus', (table) => {
                    table.string('id').nullable();
                });
                console.log('Colonne "id" ajoutée à la table "canteen_menus".');
            }
            const hasSiteId = await db.schema.hasColumn('canteen_menus', 'siteId');
            if (!hasSiteId) {
                await db.schema.table('canteen_menus', (table) => {
                    table.string('siteId').defaultTo('site_paris');
                });
                console.log('Colonne "siteId" ajoutée à la table "canteen_menus".');
            }
        }
    });

    // Table sites
    await db.schema.hasTable('sites').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('sites', (table) => {
                table.string('id').primary();
                table.string('name').unique().notNullable();
                table.string('description');
            });
            console.log('Table "sites" créée.');
        }
    });

    // Table meeting_rooms (Salles de réunion)
    await db.schema.hasTable('meeting_rooms').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('meeting_rooms', (table) => {
                table.string('id').primary();
                table.string('name').notNullable();
                table.string('siteId').notNullable();
                table.integer('capacity').defaultTo(10);
                table.string('location').defaultTo('');
                table.string('color').defaultTo('#3498db');
                table.string('photo').nullable().defaultTo('');
                table.timestamp('createdAt').defaultTo(db.fn.now());
            });
            console.log('Table "meeting_rooms" créée.');
        } else {
            // S'assurer que la colonne 'photo' existe pour les installations existantes
            const hasPhotoColumn = await db.schema.hasColumn('meeting_rooms', 'photo');
            if (!hasPhotoColumn) {
                await db.schema.table('meeting_rooms', (table) => {
                    table.string('photo').nullable().defaultTo('');
                });
                console.log('Colonne "photo" ajoutée à la table "meeting_rooms".');
            }
        }
    });

    // Table meetings (Réunions / Agenda)
    await db.schema.hasTable('meetings').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('meetings', (table) => {
                table.string('id').primary();
                table.string('title').notNullable();
                table.string('roomId').notNullable();
                table.string('siteId').notNullable();
                table.string('organizer').defaultTo('');
                table.string('startTime').notNullable();
                table.string('endTime').notNullable();
                table.text('notes').defaultTo('');
                table.string('status').defaultTo('confirmed');
                table.string('createdBy').defaultTo('');
                table.timestamp('createdAt').defaultTo(db.fn.now());
            });
            console.log('Table "meetings" créée.');
        }
    });

    // Ajouter siteId aux tables
    const tablesToMigrate = ['users', 'playlists', 'media', 'sequences', 'players', 'groups'];
    for (const tableName of tablesToMigrate) {
        const hasSiteId = await db.schema.hasColumn(tableName, 'siteId');
        if (!hasSiteId) {
            await db.schema.table(tableName, (table) => {
                table.string('siteId').nullable();
            });
            console.log(`Colonne "siteId" ajoutée à la table "${tableName}".`);
        }
    }

    // Table audit_logs
    await db.schema.hasTable('audit_logs').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('audit_logs', (table) => {
                table.increments('id').primary();
                table.string('timestamp').notNullable();
                table.string('username').notNullable();
                table.string('ip');
                table.string('action').notNullable();
                table.text('details');
                table.string('siteId');
            });
            console.log('Table "audit_logs" créée.');
        }
    });

    // Table custom_templates
    await db.schema.hasTable('custom_templates').then(async (exists) => {
        if (!exists) {
            await db.schema.createTable('custom_templates', (table) => {
                table.string('id').primary();
                table.string('templateType').notNullable();
                table.string('siteId').nullable();
                table.text('config').notNullable();
                table.string('updatedAt').notNullable();
                table.string('name').nullable();
                table.boolean('isActive').defaultTo(false);
                table.boolean('isSystem').defaultTo(false);
                table.string('createdBy').nullable();
            });
            console.log('Table "custom_templates" créée.');
        } else {
            const hasName = await db.schema.hasColumn('custom_templates', 'name');
            if (!hasName) {
                await db.schema.table('custom_templates', (table) => {
                    table.string('name').nullable();
                });
                console.log('Colonne "name" ajoutée à "custom_templates".');
            }
            const hasIsActive = await db.schema.hasColumn('custom_templates', 'isActive');
            if (!hasIsActive) {
                await db.schema.table('custom_templates', (table) => {
                    table.boolean('isActive').defaultTo(false);
                });
                console.log('Colonne "isActive" ajoutée à "custom_templates".');
            }
            const hasIsSystem = await db.schema.hasColumn('custom_templates', 'isSystem');
            if (!hasIsSystem) {
                await db.schema.table('custom_templates', (table) => {
                    table.boolean('isSystem').defaultTo(false);
                });
                console.log('Colonne "isSystem" ajoutée à "custom_templates".');
            }
            const hasCreatedBy = await db.schema.hasColumn('custom_templates', 'createdBy');
            if (!hasCreatedBy) {
                await db.schema.table('custom_templates', (table) => {
                    table.string('createdBy').nullable();
                });
                console.log('Colonne "createdBy" ajoutée à "custom_templates".');
            }
        }
    });

    // Migration : Ajouter les colonnes 2FA à la table users
    const has2FA = await db.schema.hasColumn('users', 'twoFactorEnabled');
    if (!has2FA) {
        await db.schema.table('users', (table) => {
            table.boolean('twoFactorEnabled').defaultTo(false);
            table.string('twoFactorSecret').nullable();
        });
        console.log('Colonnes 2FA ajoutées à la table "users".');
    }
}

// Helper pour enregistrer une action dans le journal d'audit
async function logAction(username, role, siteId, action, details, req = null) {
    try {
        let ip = null;
        if (req) {
            ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            if (ip && ip.includes(',')) {
                ip = ip.split(',')[0].trim();
            }
        }
        
        await db('audit_logs').insert({
            timestamp: new Date().toISOString(),
            username: username || 'system',
            ip: ip || '127.0.0.1',
            action: action,
            details: details || '',
            siteId: siteId || null
        });
    } catch (err) {
        console.error('❌ Erreur lors de l\'enregistrement dans le journal d\'audit:', err);
    }
}

// Outils de Double Authentification (2FA) natifs
function generateBase32Secret() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const randomBytes = crypto.randomBytes(10);
    let bits = '';
    for (let i = 0; i < randomBytes.length; i++) {
        bits += randomBytes[i].toString(2).padStart(8, '0');
    }
    let base32 = '';
    for (let i = 0; i < bits.length; i += 5) {
        base32 += alphabet[parseInt(bits.substr(i, 5), 2)];
    }
    return base32;
}

function base32Decode(base32) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const cleaned = base32.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
    let bits = '';
    for (let i = 0; i < cleaned.length; i++) {
        const val = alphabet.indexOf(cleaned[i]);
        if (val === -1) throw new Error('Caractère Base32 invalide');
        bits += val.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.substr(i, 8), 2));
    }
    return Buffer.from(bytes);
}

function verifyTOTP(secretBase32, code, window = 1, timeStep = 30) {
    try {
        const key = base32Decode(secretBase32);
        const currentCounter = Math.floor(Date.now() / 1000 / timeStep);
        
        for (let i = -window; i <= window; i++) {
            const counter = currentCounter + i;
            const buffer = Buffer.alloc(8);
            buffer.writeUInt32BE(0, 0);
            buffer.writeUInt32BE(counter, 4);
            
            const hmac = crypto.createHmac('sha1', key);
            hmac.update(buffer);
            const hmacResult = hmac.digest();
            
            const offset = hmacResult[hmacResult.length - 1] & 0xf;
            const candidateCodeVal = ((hmacResult[offset] & 0x7f) << 24) |
                                     ((hmacResult[offset + 1] & 0xff) << 16) |
                                     ((hmacResult[offset + 2] & 0xff) << 8) |
                                     (hmacResult[offset + 3] & 0xff);
            const candidateCode = (candidateCodeVal % 1000000).toString().padStart(6, '0');
            
            if (candidateCode === code) {
                return true;
            }
        }
    } catch (e) {
        console.error("Erreur vérification TOTP:", e);
    }
    return false;
}


async function seedDefaultTemplates() {
    try {
        // 1. Migrer les modèles existants pour avoir les nouvelles colonnes correctement renseignées
        const existing = await db('custom_templates').select('*');
        
        for (const item of existing) {
            let updated = false;
            const payload = {};
            if (item.name === null || item.name === undefined) {
                payload.name = item.id.includes('canteen') ? 'Menu Cantine Personnalisé' : 'Réunion Personnalisée';
                updated = true;
            }
            if (item.isActive === null || item.isActive === undefined) {
                payload.isActive = 1;
                updated = true;
            }
            if (item.isSystem === null || item.isSystem === undefined) {
                payload.isSystem = 0;
                updated = true;
            }
            if (updated) {
                await db('custom_templates').where({ id: item.id }).update(payload);
                console.log(`Migré le template existant ${item.id} avec succès.`);
            }
        }

        // 2. Insérer les modèles système par défaut si absents
        const defaultTemplates = [
            {
                id: 'canteen_default',
                templateType: 'canteen',
                siteId: null,
                name: 'Menu Classique',
                isActive: 1,
                isSystem: 1,
                config: JSON.stringify({
                    backgroundColor: '#1a252f',
                    backgroundUrl: '',
                    fontFamily: 'sans-serif',
                    titleColor: '#3498db',
                    titleFontSize: '32',
                    textColor: '#ffffff',
                    textFontSize: '20',
                    borderStyle: 'none',
                    borderColor: '#3498db',
                    borderWidth: '0',
                    borderRadius: '8',
                    customCss: '',
                    customHtml: ''
                }),
                updatedAt: new Date().toISOString()
            },
            {
                id: 'canteen_dark_modern',
                templateType: 'canteen',
                siteId: null,
                name: 'Sombre Moderne',
                isActive: 0,
                isSystem: 1,
                config: JSON.stringify({
                    backgroundColor: '#0f172a',
                    backgroundUrl: '',
                    fontFamily: 'sans-serif',
                    titleColor: '#38bdf8',
                    titleFontSize: '36',
                    textColor: '#f8fafc',
                    textFontSize: '22',
                    borderStyle: 'solid',
                    borderColor: '#38bdf8',
                    borderWidth: '2',
                    borderRadius: '16',
                    customCss: '.menu-title { font-weight: 800; letter-spacing: 1px; text-transform: uppercase; }',
                    customHtml: `<div class="menu-title" style="color:{{titleColor}}; font-size:{{titleFontSize}}px; text-align:center; margin-bottom:20px; border-bottom:2px dashed {{titleColor}}; padding-bottom:10px;">🍽️ {{title}} ({{day}})</div>\n<div style="color:{{textColor}}; font-size:{{textFontSize}}px; display:flex; flex-direction:column; gap:12px; padding: 0 10px;">\n  <div style="background:rgba(255,255,255,0.05); padding:12px; border-radius:8px;">🟢 <b>Entrée:</b> {{starter}}</div>\n  <div style="background:rgba(255,255,255,0.05); padding:12px; border-radius:8px;">🥩 <b>Plat:</b> {{main}}</div>\n  <div style="background:rgba(255,255,255,0.05); padding:12px; border-radius:8px;">🍰 <b>Dessert:</b> {{dessert}}</div>\n</div>`
                }),
                updatedAt: new Date().toISOString()
            },
            {
                id: 'canteen_warm_bistro',
                templateType: 'canteen',
                siteId: null,
                name: 'Warm Bistro',
                isActive: 0,
                isSystem: 1,
                config: JSON.stringify({
                    backgroundColor: '#2e1a0b',
                    backgroundUrl: '',
                    fontFamily: 'serif',
                    titleColor: '#eab308',
                    titleFontSize: '34',
                    textColor: '#fef08a',
                    textFontSize: '22',
                    borderStyle: 'double',
                    borderColor: '#eab308',
                    borderWidth: '4',
                    borderRadius: '4',
                    customCss: '.menu-item { font-style: italic; margin-bottom: 8px; }',
                    customHtml: `<div style="text-align:center; font-family:serif; border: 2px solid #eab308; padding:15px; height:100%; box-sizing:border-box;">\n  <div style="color:{{titleColor}}; font-size:{{titleFontSize}}px; font-weight:bold; margin-bottom:15px; border-bottom:1px solid {{titleColor}}; padding-bottom:5px;">🍷 {{title}} 🍷</div>\n  <div style="color:{{textColor}}; font-size:{{textFontSize}}px; line-height:1.6;">\n    <div class="menu-item"><b>Entrée</b><br>{{starter}}</div>\n    <div class="menu-item"><b>Plat Principal</b><br>{{main}}</div>\n    <div class="menu-item"><b>Dessert du Chef</b><br>{{dessert}}</div>\n  </div>\n</div>`
                }),
                updatedAt: new Date().toISOString()
            },
            {
                id: 'canteen_slate_chalk',
                templateType: 'canteen',
                siteId: null,
                name: 'Ardoise Bistrot',
                isActive: 0,
                isSystem: 1,
                config: JSON.stringify({
                    backgroundColor: '#1e1e1e',
                    backgroundUrl: '',
                    fontFamily: 'monospace',
                    titleColor: '#ffffff',
                    titleFontSize: '45',
                    textColor: '#ffffff',
                    textFontSize: '28',
                    borderStyle: 'solid',
                    borderColor: '#ffffff',
                    borderWidth: '3',
                    borderRadius: '12',
                    customCss: '',
                    customHtml: `<div style="border:3px solid #ffffff; border-radius:12px; padding:30px; height:100%; box-sizing:border-box; display:flex; flex-direction:column; justify-content:center; text-align:center; font-family:'Courier New', Courier, monospace; background:rgba(0,0,0,0.4);">\n  <div style="font-size:45px; color:#ffffff; font-weight:bold; border-bottom:2px dashed #ffffff; padding-bottom:15px; margin-bottom:25px; text-transform:uppercase;">🍳 L'Ardoise du Jour 🍳</div>\n  <div style="display:flex; flex-direction:column; gap:20px;">\n    <div>\n      <span style="font-size:18px; color:#aaaaaa; font-weight:bold; letter-spacing:2px; display:block; margin-bottom:5px;">ENTRÉE</span>\n      <span style="font-size:28px; color:#ffffff; font-weight:bold; font-style:italic;">{{starter}}</span>\n    </div>\n    <div style="width:50px; height:1px; background:#aaaaaa; margin:0 auto;"></div>\n    <div>\n      <span style="font-size:18px; color:#aaaaaa; font-weight:bold; letter-spacing:2px; display:block; margin-bottom:5px;">PLAT</span>\n      <span style="font-size:28px; color:#ffffff; font-weight:bold; font-style:italic;">{{main}}</span>\n    </div>\n    <div style="width:50px; height:1px; background:#aaaaaa; margin:0 auto;"></div>\n    <div>\n      <span style="font-size:18px; color:#aaaaaa; font-weight:bold; letter-spacing:2px; display:block; margin-bottom:5px;">DESSERT</span>\n      <span style="font-size:28px; color:#ffffff; font-weight:bold; font-style:italic;">{{dessert}}</span>\n    </div>\n  </div>\n</div>`
                }),
                updatedAt: new Date().toISOString()
            },
            {
                id: 'canteen_eco_fresh',
                templateType: 'canteen',
                siteId: null,
                name: 'Frais & Nature',
                isActive: 0,
                isSystem: 1,
                config: JSON.stringify({
                    backgroundColor: '#e8f5e9',
                    backgroundUrl: '',
                    fontFamily: 'sans-serif',
                    titleColor: '#2e7d32',
                    titleFontSize: '42',
                    textColor: '#1b5e20',
                    textFontSize: '26',
                    borderStyle: 'solid',
                    borderColor: '#2e7d32',
                    borderWidth: '4',
                    borderRadius: '24',
                    customCss: '',
                    customHtml: `<div style="border:4px solid #2e7d32; border-radius:24px; padding:35px; height:100%; box-sizing:border-box; display:flex; flex-direction:column; justify-content:center; text-align:center; font-family:sans-serif; background:#ffffff; color:#1b5e20;">\n  <div style="font-size:42px; color:#2e7d32; font-weight:bold; margin-bottom:30px;">🌿 Le Jardin des Saveurs 🌿</div>\n  <div style="display:flex; flex-direction:column; gap:25px; align-items:stretch;">\n    <div style="background:#f1f8e9; padding:15px; border-radius:12px; border-left:6px solid #8bc34a;">\n      <span style="font-size:16px; color:#558b2f; font-weight:bold; display:block; text-align:left; margin-bottom:5px;">🥣 L'ENTRÉE DU POTAGER</span>\n      <span style="font-size:26px; color:#1b5e20; font-weight:bold; display:block; text-align:left;">{{starter}}</span>\n    </div>\n    <div style="background:#f1f8e9; padding:15px; border-radius:12px; border-left:6px solid #4caf50;">\n      <span style="font-size:16px; color:#2e7d32; font-weight:bold; display:block; text-align:left; margin-bottom:5px;">🍛 LE PLAT CULTIVÉ</span>\n      <span style="font-size:26px; color:#1b5e20; font-weight:bold; display:block; text-align:left;">{{main}}</span>\n    </div>\n    <div style="background:#f1f8e9; padding:15px; border-radius:12px; border-left:6px solid #009688;">\n      <span style="font-size:16px; color:#00796b; font-weight:bold; display:block; text-align:left; margin-bottom:5px;">🍎 LE DESSERT VERGER</span>\n      <span style="font-size:26px; color:#1b5e20; font-weight:bold; display:block; text-align:left;">{{dessert}}</span>\n    </div>\n  </div>\n</div>`
                }),
                updatedAt: new Date().toISOString()
            },
            {
                id: 'canteen_bright_pop',
                templateType: 'canteen',
                siteId: null,
                name: 'Pop Coloré',
                isActive: 0,
                isSystem: 1,
                config: JSON.stringify({
                    backgroundColor: '#ff6b6b',
                    backgroundUrl: '',
                    fontFamily: 'sans-serif',
                    titleColor: '#feca57',
                    titleFontSize: '48',
                    textColor: '#ffffff',
                    textFontSize: '26',
                    borderStyle: 'none',
                    borderColor: '#ffffff',
                    borderWidth: '0',
                    borderRadius: '0',
                    customCss: '',
                    customHtml: `<div style="padding:30px; height:100%; box-sizing:border-box; display:flex; flex-direction:column; justify-content:space-between; color:#ffffff; font-family:sans-serif; text-shadow:1px 1px 3px rgba(0,0,0,0.2);">\n  <div style="font-size:48px; font-weight:900; letter-spacing:-2px; text-transform:uppercase; text-align:left; line-height:1;">BON AP' !<br><span style="color:#feca57; font-size:32px;">Menu de ce midi</span></div>\n  <div style="display:flex; flex-direction:column; gap:15px; margin: 30px 0;">\n    <div style="background:rgba(255,255,255,0.15); padding:15px; border-radius:15px;">\n      <span style="font-size:26px; font-weight:bold;"><span style="color:#feca57;">🥗 </span>{{starter}}</span>\n    </div>\n    <div style="background:rgba(255,255,255,0.15); padding:15px; border-radius:15px;">\n      <span style="font-size:26px; font-weight:bold;"><span style="color:#ff9ff3;">🍗 </span>{{main}}</span>\n    </div>\n    <div style="background:rgba(255,255,255,0.15); padding:15px; border-radius:15px;">\n      <span style="font-size:26px; font-weight:bold;"><span style="color:#48dbfb;">🍰 </span>{{dessert}}</span>\n    </div>\n  </div>\n  <div style="font-size:16px; opacity:0.8; text-align:right;">OmniSign Canteen Pop Style</div>\n</div>`
                }),
                updatedAt: new Date().toISOString()
            },
            {
                id: 'meeting_default',
                templateType: 'meeting',
                siteId: null,
                name: 'Réunion Classique',
                isActive: 1,
                isSystem: 1,
                config: JSON.stringify({
                    backgroundColor: '#1a252f',
                    backgroundUrl: '',
                    fontFamily: 'sans-serif',
                    titleColor: '#ffffff',
                    titleFontSize: '36',
                    textColor: '#bdc3c7',
                    textFontSize: '22',
                    badgeBgAvailable: '#27ae60',
                    badgeBgBusy: '#e74c3c',
                    borderStyle: 'none',
                    borderColor: '#3498db',
                    borderWidth: '0',
                    borderRadius: '8',
                    customCss: '',
                    customHtml: ''
                }),
                updatedAt: new Date().toISOString()
            },
            {
                id: 'meeting_tech_neon',
                templateType: 'meeting',
                siteId: null,
                name: 'Néon High-Tech',
                isActive: 0,
                isSystem: 1,
                config: JSON.stringify({
                    backgroundColor: '#090d16',
                    backgroundUrl: '',
                    fontFamily: 'monospace',
                    titleColor: '#00f2fe',
                    titleFontSize: '40',
                    textColor: '#a5b4fc',
                    textFontSize: '24',
                    badgeBgAvailable: '#10b981',
                    badgeBgBusy: '#f43f5e',
                    borderStyle: 'solid',
                    borderColor: '#00f2fe',
                    borderWidth: '2',
                    borderRadius: '12',
                    customCss: '.neon-card { box-shadow: 0 0 15px rgba(0,242,254,0.3); } .neon-badge { padding: 4px 12px; border-radius: 4px; font-weight: bold; }',
                    customHtml: `<div class="neon-card" style="padding:20px; border:1px solid #00f2fe; border-radius:8px; background:rgba(0,242,254,0.02); height:100%; box-sizing:border-box; display:flex; gap:25px; align-items:stretch;">
  <div class="room-photo-container" style="flex:1.2; display:flex; align-items:center; justify-content:center;">
    <img src="{{photo}}" style="width:100%; max-height:85vh; object-fit:cover; border-radius:6px; border:1px solid #00f2fe; box-shadow:0 0 10px rgba(0,242,254,0.2);" onerror="this.closest('.room-photo-container').style.display='none';">
  </div>
  <div style="flex:1; display:flex; flex-direction:column; justify-content:space-between;">
    <div>
      <div style="color:{{titleColor}}; font-size:{{titleFontSize}}px; font-weight:bold; letter-spacing:-1px; border-left:4px solid {{titleColor}}; padding-left:10px; margin-bottom:15px;">{{room}}</div>
      <div style="color:{{textColor}}; font-size:{{textFontSize}}px;">📢 {{subject}}</div>
    </div>
    <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid rgba(0,242,254,0.1); padding-top:15px;">
      <span class="neon-badge" style="background:{{badgeBg}}; color:white;">STATUS: {{status}}</span>
      <span style="color:#6366f1; font-weight:bold;">🕒 {{startTime}} - {{endTime}}</span>
    </div>
  </div>
</div>`
                }),
                updatedAt: new Date().toISOString()
            },
            {
                id: 'meeting_glassmorphism',
                templateType: 'meeting',
                siteId: null,
                name: 'Glassmorphism Épuré',
                isActive: 0,
                isSystem: 1,
                config: JSON.stringify({
                    backgroundColor: '#0f172a',
                    backgroundUrl: '',
                    fontFamily: 'sans-serif',
                    titleColor: '#38bdf8',
                    titleFontSize: '38',
                    textColor: '#94a3b8',
                    textFontSize: '22',
                    badgeBgAvailable: '#10b981',
                    badgeBgBusy: '#f43f5e',
                    borderStyle: 'none',
                    borderColor: '#ffffff',
                    borderWidth: '0',
                    borderRadius: '0',
                    customCss: '',
                    customHtml: `<div style="padding:40px; height:100%; box-sizing:border-box; display:flex; gap:30px; align-items:center; justify-content:center; font-family:sans-serif;">
  <div class="room-photo-container" style="flex:1.2; display:flex; align-items:center; justify-content:center; height:80%;">
    <img src="{{photo}}" style="width:100%; max-height:75vh; object-fit:cover; border-radius:24px; border:1px solid rgba(255,255,255,0.15); box-shadow:0 8px 32px rgba(0,0,0,0.3);" onerror="this.closest('.room-photo-container').style.display='none';">
  </div>
  <div style="flex:1; background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.15); border-radius:24px; padding:40px; box-shadow:0 8px 32px rgba(0,0,0,0.3); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); text-align:center;">
    <div style="font-size:22px; color:#38bdf8; font-weight:bold; text-transform:uppercase; letter-spacing:3px; margin-bottom:15px;">📍 {{room}}</div>
    <div style="font-size:38px; color:#ffffff; font-weight:bold; margin-bottom:10px;">{{subject}}</div>
    <div style="font-size:22px; color:#94a3b8; font-weight:500; margin-bottom:30px;">⏱️ {{startTime}} - {{endTime}}</div>
    <div>
      <span style="display:inline-block; padding:10px 30px; font-size:18px; font-weight:bold; border-radius:100px; color:#ffffff; background:{{badgeBg}};">{{status}}</span>
    </div>
  </div>
</div>`
                }),
                updatedAt: new Date().toISOString()
            },
            {
                id: 'meeting_corp_navy',
                templateType: 'meeting',
                siteId: null,
                name: 'Corporate Navy',
                isActive: 0,
                isSystem: 1,
                config: JSON.stringify({
                    backgroundColor: '#0f1e36',
                    backgroundUrl: '',
                    fontFamily: 'sans-serif',
                    titleColor: '#d4af37',
                    titleFontSize: '36',
                    textColor: '#94a3b8',
                    textFontSize: '20',
                    badgeBgAvailable: '#10b981',
                    badgeBgBusy: '#f43f5e',
                    borderStyle: 'none',
                    borderColor: '#ffffff',
                    borderWidth: '0',
                    borderRadius: '0',
                    customCss: '',
                    customHtml: `<div style="border-top:10px solid #d4af37; padding:40px; height:100%; box-sizing:border-box; display:flex; gap:30px; font-family:sans-serif; color:#ffffff;">
  <div class="room-photo-container" style="flex:1.2; display:flex; align-items:center; justify-content:center;">
    <img src="{{photo}}" style="width:100%; max-height:80vh; object-fit:cover; border-radius:8px; border:2px solid rgba(255,255,255,0.05); box-shadow:0 15px 30px rgba(0,0,0,0.4);" onerror="this.closest('.room-photo-container').style.display='none';">
  </div>
  <div style="flex:1; display:flex; flex-direction:column; justify-content:space-between;">
    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:15px;">
      <span style="font-size:32px; font-weight:bold; color:#d4af37;">🏢 {{room}}</span>
      <span style="display:inline-block; padding:6px 15px; font-size:16px; font-weight:bold; border-radius:4px; color:#ffffff; background:{{badgeBg}};">{{status}}</span>
    </div>
    <div style="margin:20px 0;">
      <span style="font-size:18px; color:#94a3b8; font-weight:bold; display:block; margin-bottom:5px; text-transform:uppercase; letter-spacing:1px;">SUJET DE RÉUNION</span>
      <span style="font-size:36px; font-weight:bold; display:block;">{{subject}}</span>
    </div>
    <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); padding:15px; border-radius:8px;">
      <span style="font-size:20px; color:#94a3b8;">Créneau réservé</span>
      <span style="font-size:24px; font-weight:bold; color:#d4af37;">🕒 {{startTime}} - {{endTime}}</span>
    </div>
  </div>
</div>`
                }),
                updatedAt: new Date().toISOString()
            },
            {
                id: 'meeting_creative_orange',
                templateType: 'meeting',
                siteId: null,
                name: 'Orange Créatif',
                isActive: 0,
                isSystem: 1,
                config: JSON.stringify({
                    backgroundColor: '#ff7a00',
                    backgroundUrl: '',
                    fontFamily: 'sans-serif',
                    titleColor: '#ffffff',
                    titleFontSize: '60',
                    textColor: '#ffffff',
                    textFontSize: '32',
                    badgeBgAvailable: '#2ecc71',
                    badgeBgBusy: '#e74c3c',
                    borderStyle: 'none',
                    borderColor: '#ffffff',
                    borderWidth: '0',
                    borderRadius: '0',
                    customCss: '',
                    customHtml: `<div style="padding:40px; height:100%; box-sizing:border-box; display:flex; gap:30px; font-family:sans-serif; color:#ffffff;">
  <div class="room-photo-container" style="flex:1.2; display:flex; align-items:center; justify-content:center;">
    <img src="{{photo}}" style="width:100%; max-height:80vh; object-fit:cover; border-radius:20px; border:3px solid #ffffff; box-shadow:0 10px 20px rgba(0,0,0,0.15);" onerror="this.closest('.room-photo-container').style.display='none';">
  </div>
  <div style="flex:1; display:flex; flex-direction:column; justify-content:space-between;">
    <div>
      <div style="font-size:60px; font-weight:900; letter-spacing:-2px; text-transform:uppercase; line-height:1; margin-bottom:10px;">{{room}}</div>
      <div style="font-size:20px; font-weight:bold; opacity:0.9;">PLANNING DE SALLE</div>
    </div>
    <div style="background:#ffffff; color:#ff7a00; padding:25px; border-radius:20px; box-shadow:0 10px 20px rgba(0,0,0,0.15); margin: 20px 0;">
      <div style="font-size:16px; font-weight:bold; color:#888888; text-transform:uppercase; margin-bottom:5px;">RÉUNION ACTUELLE</div>
      <div style="font-size:32px; font-weight:bold; line-height:1.2; margin-bottom:10px;">{{subject}}</div>
      <div style="font-size:20px; font-weight:bold; color:#ff7a00;">⏱️ {{startTime}} - {{endTime}}</div>
    </div>
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <span style="font-size:16px; font-weight:bold; opacity:0.8;">STATUT :</span>
      <span style="display:inline-block; padding:8px 25px; font-size:16px; font-weight:bold; border-radius:100px; color:#ffffff; background:{{badgeBg}}; border:2px solid #ffffff;">{{status}}</span>
    </div>
  </div>
</div>`
                }),
                updatedAt: new Date().toISOString()
            },
            {
                id: 'meeting_elegant_dark',
                templateType: 'meeting',
                siteId: null,
                name: 'Sombre Élégant',
                isActive: 0,
                isSystem: 1,
                config: JSON.stringify({
                    backgroundColor: '#1c1917',
                    backgroundUrl: '',
                    fontFamily: 'serif',
                    titleColor: '#e7e5e4',
                    titleFontSize: '36',
                    textColor: '#f5f5f4',
                    textFontSize: '32',
                    badgeBgAvailable: '#22c55e',
                    badgeBgBusy: '#ef4444',
                    borderStyle: 'none',
                    borderColor: '#ffffff',
                    borderWidth: '0',
                    borderRadius: '0',
                    customCss: '',
                    customHtml: `<div style="border:2px solid #78716c; margin:20px; padding:35px; height:calc(100% - 40px); box-sizing:border-box; display:flex; gap:30px; font-family:serif; color:#f5f5f4;">
  <div class="room-photo-container" style="flex:1.2; display:flex; align-items:center; justify-content:center;">
    <img src="{{photo}}" style="width:100%; max-height:75vh; object-fit:cover; border-radius:4px; border:1px solid #78716c; box-shadow:0 8px 16px rgba(0,0,0,0.5);" onerror="this.closest('.room-photo-container').style.display='none';">
  </div>
  <div style="flex:1; display:flex; flex-direction:column; justify-content:space-between;">
    <div style="text-align:center;">
      <div style="font-size:36px; font-weight:bold; letter-spacing:2px; font-family:serif; text-transform:uppercase; color:#e7e5e4;">✨ {{room}} ✨</div>
      <div style="width:100px; height:1px; background:#78716c; margin:15px auto;"></div>
    </div>
    <div style="text-align:center; padding: 20px 0;">
      <div style="font-size:32px; font-family:serif; font-style:italic; color:#f5f5f4; margin-bottom:15px;">{{subject}}</div>
      <span style="display:inline-block; font-family:sans-serif; padding:5px 20px; border-radius:20px; border:1px solid #78716c; background:{{badgeBg}}; color:#ffffff; font-size:14px; font-weight:bold; letter-spacing:1px; text-transform:uppercase;">{{status}}</span>
    </div>
    <div style="text-align:center; font-size:20px; color:#a8a29e;">
      <span>Horaires de réservation : <b>{{startTime}} - {{endTime}}</b></span>
    </div>
  </div>
</div>`
                }),
                updatedAt: new Date().toISOString()
            }
        ];

        for (const t of defaultTemplates) {
            const exists = await db('custom_templates').where({ id: t.id }).first();
            if (!exists) {
                const hasActive = await db('custom_templates').where({ templateType: t.templateType, isActive: 1 }).first();
                if (hasActive) {
                    t.isActive = 0;
                }
                await db('custom_templates').insert(t);
                console.log(`Modèle système par défaut "${t.name}" inséré.`);
            } else if (exists.isSystem) {
                // Mettre à jour la config (avec le HTML mis à jour) pour les modèles système existants
                await db('custom_templates').where({ id: t.id }).update({ config: t.config });
            }
        }
    } catch (err) {
        console.error("Erreur lors de la population des templates par défaut:", err);
    }
}

// Load settings from DB
async function loadSettings() {
    const settings = await db('settings').select('*');
    const jwtSetting = settings.find(s => s.key === 'jwtSecret');
    const apiSetting = settings.find(s => s.key === 'apiKey');
    const logsSetting = settings.find(s => s.key === 'disableClientLogs');
    const debugSetting = settings.find(s => s.key === 'disableDebugLogs');
    const wakeSetting = settings.find(s => s.key === 'screenWakeTime');
    const sleepSetting = settings.find(s => s.key === 'screenSleepTime');
    const splashSetting = settings.find(s => s.key === 'splashScreenUrl');
    const smtpHostSetting = settings.find(s => s.key === 'smtpHost');
    const smtpPortSetting = settings.find(s => s.key === 'smtpPort');
    const smtpUserSetting = settings.find(s => s.key === 'smtpUser');
    const smtpPassSetting = settings.find(s => s.key === 'smtpPass');
    const notifyEmailSetting = settings.find(s => s.key === 'notificationEmail');
    const emailNotificationsEnabledSetting = settings.find(s => s.key === 'emailNotificationsEnabled');
    const notifyPlaylistChangeSetting = settings.find(s => s.key === 'notifyPlaylistChange');
    const notifyPlayerOfflineSetting = settings.find(s => s.key === 'notifyPlayerOffline');
    const notifyPlayerOnlineSetting = settings.find(s => s.key === 'notifyPlayerOnline');
    const notifyTechAlertSetting = settings.find(s => s.key === 'notifyTechAlert');
    const offlineAlertDelaySetting = settings.find(s => s.key === 'offlineAlertDelay');
    const showOfflineAlertSetting = settings.find(s => s.key === 'showOfflineAlert');
    const periodicScreenshotEnabledSetting = settings.find(s => s.key === 'periodicScreenshotEnabled');
    const periodicScreenshotIntervalSetting = settings.find(s => s.key === 'periodicScreenshotInterval');
    const scheduleSetting = settings.find(s => s.key === 'screenSleepSchedule');

    if (jwtSetting) JWT_SECRET = process.env.JWT_SECRET || jwtSetting.value;
    if (apiSetting) API_KEY = process.env.PIDYN_API_KEY || apiSetting.value;
    if (logsSetting) DISABLE_CLIENT_LOGS = logsSetting.value === 'true';
    if (debugSetting) DISABLE_DEBUG_LOGS = debugSetting.value === 'true';
    if (wakeSetting) SCREEN_WAKE_TIME = wakeSetting.value;
    if (sleepSetting) SCREEN_SLEEP_TIME = sleepSetting.value;
    if (scheduleSetting) {
        try {
            SCREEN_SLEEP_SCHEDULE = JSON.parse(scheduleSetting.value);
        } catch (e) {
            console.error("Erreur parsing screenSleepSchedule au démarrage:", e);
            SCREEN_SLEEP_SCHEDULE = null;
        }
    }
    if (splashSetting) SPLASH_SCREEN_URL = splashSetting.value;
    if (smtpHostSetting) SMTP_HOST = smtpHostSetting.value;
    if (smtpPortSetting) SMTP_PORT = smtpPortSetting.value;
    if (smtpUserSetting) SMTP_USER = smtpUserSetting.value;
    if (smtpPassSetting) SMTP_PASS = smtpPassSetting.value;
    if (notifyEmailSetting) NOTIFICATION_EMAIL = notifyEmailSetting.value;
    if (emailNotificationsEnabledSetting) EMAIL_NOTIFICATIONS_ENABLED = emailNotificationsEnabledSetting.value === 'true';
    if (notifyPlaylistChangeSetting) NOTIFY_PLAYLIST_CHANGE = notifyPlaylistChangeSetting.value === 'true';
    if (notifyPlayerOfflineSetting) NOTIFY_PLAYER_OFFLINE = notifyPlayerOfflineSetting.value === 'true';
    if (notifyPlayerOnlineSetting) NOTIFY_PLAYER_ONLINE = notifyPlayerOnlineSetting.value === 'true';
    if (notifyTechAlertSetting) NOTIFY_TECH_ALERT = notifyTechAlertSetting.value === 'true';
    if (offlineAlertDelaySetting) OFFLINE_ALERT_DELAY = parseInt(offlineAlertDelaySetting.value, 10) || 15;
    if (showOfflineAlertSetting) SHOW_OFFLINE_ALERT = showOfflineAlertSetting.value !== 'false';
    if (periodicScreenshotEnabledSetting) PERIODIC_SCREENSHOT_ENABLED = periodicScreenshotEnabledSetting.value === 'true';
    if (periodicScreenshotIntervalSetting) PERIODIC_SCREENSHOT_INTERVAL = parseInt(periodicScreenshotIntervalSetting.value, 10) || 5;
}

// Initialize DB and migrate data on server start
initializeDatabase().then(async () => {
    await seedDefaultTemplates();
    await loadSettings();
    console.log('✅ Base de données prête. JWT_SECRET et API_KEY chargés.');
    
    if (process.argv.includes('--init-only')) {
        console.log('Database initialization complete. Exiting (--init-only)...');
        process.exit(0);
    }
    
    // Démarrer le serveur et les tâches de fond UNIQUEMENT quand la DB est prête
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`🚀 CMS Sécurisé sur le port ${PORT}`);
        checkSchedules(); // Évaluation initiale
        checkOfflinePlayers(); // Évaluation initiale de l'état des écrans
        triggerPeriodicScreenshots(); // Évaluation initiale des captures périodiques
        setInterval(checkSchedules, 60 * 1000); // Évaluation périodique
        setInterval(checkOfflinePlayers, 60 * 1000); // Évaluation périodique de l'état des écrans
        setInterval(triggerPeriodicScreenshots, 60 * 1000); // Évaluation périodique des captures
        
        // Démarrage de la sauvegarde automatique périodique
        setTimeout(runAutoBackupCheck, 10000); // Premier check après 10s
        setInterval(runAutoBackupCheck, 60 * 60 * 1000); // Vérification toutes les heures
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

    // Calcul de l'état de l'écran (On/Off) basé sur l'heure actuelle et le calendrier
    const currentDayNum = now.getDay() === 0 ? 7 : now.getDay();
    const currentTimeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    
    let isAwakeTime = false;
    
    if (SCREEN_SLEEP_SCHEDULE) {
        try {
            const sched = typeof SCREEN_SLEEP_SCHEDULE === 'string'
                ? JSON.parse(SCREEN_SLEEP_SCHEDULE)
                : SCREEN_SLEEP_SCHEDULE;
            const daySched = sched[String(currentDayNum)];
            if (daySched && daySched.enabled) {
                if (daySched.slots && Array.isArray(daySched.slots)) {
                    for (const slot of daySched.slots) {
                        const wake = slot.wake;
                        const sleep = slot.sleep;
                        if (wake && sleep) {
                            if (wake < sleep) {
                                if (currentTimeStr >= wake && currentTimeStr < sleep) {
                                    isAwakeTime = true;
                                    break;
                                }
                            } else {
                                if (currentTimeStr >= wake || currentTimeStr < sleep) {
                                    isAwakeTime = true;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error("Erreur lors de l'évaluation de SCREEN_SLEEP_SCHEDULE:", e);
            isAwakeTime = SCREEN_WAKE_TIME < SCREEN_SLEEP_TIME 
                ? (currentTimeStr >= SCREEN_WAKE_TIME && currentTimeStr < SCREEN_SLEEP_TIME)
                : (currentTimeStr >= SCREEN_WAKE_TIME || currentTimeStr < SCREEN_SLEEP_TIME);
        }
    } else {
        isAwakeTime = SCREEN_WAKE_TIME < SCREEN_SLEEP_TIME 
            ? (currentTimeStr >= SCREEN_WAKE_TIME && currentTimeStr < SCREEN_SLEEP_TIME)
            : (currentTimeStr >= SCREEN_WAKE_TIME || currentTimeStr < SCREEN_SLEEP_TIME);
    }

    for (const player of players) {
        if (player.status !== 'approved') continue; // Ne planifier que pour les afficheurs approuvés

        const deviceId = player.id;

        // Envoyer la commande de mise en veille/réveil à l'écran
        io.to(deviceId).emit('screen-command', { action: isAwakeTime ? 'on' : 'off' });

        // Filtrer les planifications applicables à cet écran (par deviceId, par groupId ou globales)
        const matchingSchedules = schedules.filter(s => {
            // Règle active ?
            if (s.active === 0 || s.active === false || s.active === 'false') return false;

            // Vérification de la cible (Écran spécifique, Groupe d'écrans, ou Global)
            const isTargetMatch = 
                (s.targetType === 'player' && (s.targetId === deviceId || s.deviceId === deviceId)) ||
                (s.targetType === 'group' && s.targetId && s.targetId === player.groupId) ||
                (s.targetType === 'global' || !s.targetType);
            
            if (!isTargetMatch) return false;

            // Déterminer le jour actuel (1=Lundi..7=Dimanche)
            const currentDayNum = now.getDay() === 0 ? 7 : now.getDay();
            const currentDateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');

            if (s.scheduleType === 'recurring' || (!s.scheduleType && !s.startDate && !s.startTime)) {
                // Vérifier les jours de la semaine
                let days = [1, 2, 3, 4, 5];
                try {
                    days = typeof s.daysOfWeek === 'string' ? JSON.parse(s.daysOfWeek) : (s.daysOfWeek || [1, 2, 3, 4, 5]);
                } catch (e) {}
                if (Array.isArray(days) && !days.includes(currentDayNum)) return false;

                // Vérifier la plage horaire HH:mm
                const start = s.timeStart || '00:00';
                const end = s.timeEnd || '23:59';
                if (start <= end) {
                    if (currentTimeStr < start || currentTimeStr > end) return false;
                } else { // Traitement pour créneau de nuit chevauchant minuit (ex: 22:00 à 06:00)
                    if (currentTimeStr < start && currentTimeStr > end) return false;
                }
                return true;
            } else if (s.scheduleType === 'date_range' || s.startDate) {
                // Vérifier la plage de dates
                if (s.startDate && currentDateStr < s.startDate) return false;
                if (s.endDate && currentDateStr > s.endDate) return false;

                // Si des heures spécifiques sont aussi définies pour l'événement
                if (s.timeStart && s.timeEnd) {
                    if (s.timeStart <= s.timeEnd) {
                        if (currentTimeStr < s.timeStart || currentTimeStr > s.timeEnd) return false;
                    } else {
                        if (currentTimeStr < s.timeStart && currentTimeStr > s.timeEnd) return false;
                    }
                }
                return true;
            } else if (s.startTime && s.endTime) {
                // Retrocompatibilité pour anciens enregistrements ISO
                const start = new Date(s.startTime);
                const end = new Date(s.endTime);
                return now >= start && now < end;
            }

            return false;
        });

        // Trier par priorité décroissante (les règles à priorité élevée comme 100 prévalent sur la priorité normale 10)
        matchingSchedules.sort((a, b) => {
            const prioA = parseInt(a.priority) || 10;
            const prioB = parseInt(b.priority) || 10;
            return prioB - prioA;
        });

        const activeSchedule = matchingSchedules.length > 0 ? matchingSchedules[0] : null;

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
                if (targetPlaylist.status && targetPlaylist.status !== 'approved') {
                    console.warn(`[WARNING] Tentative de diffusion du diaporama non validé "${targetPlaylist.name}" (Statut: ${targetPlaylist.status}) sur l'écran ${deviceId}. Remplacement par une playlist vide.`);
                    io.to(deviceId).emit('playlist-updated', { name: 'Diaporama non validé', items: [] });
                } else {
                    targetPlaylist.items = JSON.parse(targetPlaylist.items);
                    const playlistToSend = { ...targetPlaylist };
                    playlistToSend.apiKey = API_KEY;
                    playlistToSend.disableClientLogs = DISABLE_CLIENT_LOGS;
                    playlistToSend.disableDebugLogs = DISABLE_DEBUG_LOGS;
                    playlistToSend.splashScreenUrl = SPLASH_SCREEN_URL;
                    playlistToSend.showOfflineAlert = SHOW_OFFLINE_ALERT;
                    playlistToSend.volume = player.volume !== undefined ? player.volume : 100;
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
                }
            } else {
                io.to(deviceId).emit('playlist-updated', { name: 'No Playlist', items: [] }); // Envoyer une playlist vide
            }
        }
    }
};

function filterBySiteId(query, user, siteIdColumn = 'siteId') {
    if (user.role === 'admin' && !user.siteId) {
        return query;
    }
    if (user.siteId) {
        return query.where(siteIdColumn, user.siteId);
    }
    return query.where(siteIdColumn, '__NO_ACCESS__');
}

// Middleware de sécurité
const authMiddleware = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    const authHeader = req.headers['authorization'];
    const headerToken = authHeader && authHeader.split(' ')[1]; // Format: Bearer <token>
    const queryToken = req.query.token; // Check for token in query parameter

    // Authentification pour les clients Pi (API Key)
    if (apiKey === API_KEY) { // Check against the loaded API_KEY
        req.user = { role: 'player' }; // Les écrans (Pi) sont authentifiés via clef
        return next();
    }

    if (req.path === '/api/player/log') {
        console.log(`[AUTH] Rejet log stats de ${req.ip}. Clé reçue: "${apiKey}", Attendue: "${API_KEY}"`);
        // If it's a player log, and API key is wrong, reject.
        return res.status(403).send('Accès refusé. Clé API invalide.');
    }

    // Authentification pour les utilisateurs admin (JWT)
    let jwtToVerify = headerToken;
    if (!jwtToVerify && queryToken) { // If no token in header, check query parameter
        jwtToVerify = queryToken;
    }

    if (jwtToVerify) {
        try {
            const decoded = jwt.verify(jwtToVerify, JWT_SECRET); // Check against the loaded JWT_SECRET
            req.user = decoded; // Le payload du JWT contient { username, role }
            return next();
        } catch (err) {
            console.warn(`[AUTH] JWT verification failed for ${req.ip} (token in ${headerToken ? 'header' : 'query'}): ${err.message}`);
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
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/media', authMiddleware, express.static(MEDIA_DIR));

// Route par défaut pour servir l'interface d'administration
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Route pour la gestion des écrans
app.get('/ecrans', (req, res) => {
    res.sendFile(path.join(__dirname, 'ecrans.html'));
});

// Route pour la gestion des diaporamas et séquences
app.get('/diaporamas', (req, res) => {
    res.sendFile(path.join(__dirname, 'diaporamas.html'));
});

// Route pour les paramètres système
app.get('/systeme', (req, res) => {
    res.sendFile(path.join(__dirname, 'systeme.html'));
});

// Route pour la gestion de la cantine (accessible par cook, author, editor, admin)
app.get('/canteen', (req, res) => {
    res.sendFile(path.join(__dirname, 'canteen.html'));
});

// Route pour l'éditeur de diaporama
app.get('/editor', (req, res) => {
    res.sendFile(path.join(__dirname, 'editor.html'));
});

// Route pour le lecteur (gère à la fois /player et /preview-player.html)
app.get(['/player', '/preview-player.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'preview-player.html'));
});

// Route pour la page de gestion des utilisateurs
app.get('/users', (req, res) => {
    res.sendFile(path.join(__dirname, 'users.html'));
});

// Route pour la page de personnalisation des modèles
app.get('/templates', (req, res) => {
    res.sendFile(path.join(__dirname, 'templates.html'));
});

// Route pour la page de gestion des sites
app.get('/sites', (req, res) => {
    res.sendFile(path.join(__dirname, 'sites.html'));
});

// Route pour la page de gestion de la médiathèque
app.get('/mediatheque', (req, res) => {
    res.sendFile(path.join(__dirname, 'media.html'));
});

// Route pour l'éditeur d'animation Sozi (SVG)
app.get('/sozi_editor', (req, res) => {
    res.sendFile(path.join(__dirname, 'sozi_editor.html'));
});
app.get('/sozi_editor.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'sozi_editor.html'));
});

// Route pour la page de gestion des réunions et salles
app.get('/meetings', (req, res) => {
    res.sendFile(path.join(__dirname, 'meetings.html'));
});
app.get('/reunions', (req, res) => {
    res.sendFile(path.join(__dirname, 'meetings.html'));
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
        // Sécurité : Supprimer le fichier de mot de passe initial après la première connexion réussie de l'admin
        if (user.role === 'admin') {
            try {
                const dbDir = path.dirname(SQLITE_DB_PATH);
                const pwdFilePath = path.join(dbDir, 'admin_password.txt');
                if (await fs.pathExists(pwdFilePath)) {
                    await fs.remove(pwdFilePath);
                    console.log('🔒 Fichier de mot de passe d\'installation temporaire (admin_password.txt) supprimé après connexion de l\'admin.');
                    await logAction(user.username, user.role, user.siteId, 'securite_initialisation', 'Suppression du mot de passe initial temporaire admin_password.txt', req);
                }
            } catch (err) {
                console.error('Erreur lors de la suppression automatique de admin_password.txt:', err);
            }
        }

        // Si la double authentification est activée pour l'admin
        if (user.username === 'admin' && user.twoFactorEnabled) {
            // Générer un jeton temporaire JWT valide pour 5 minutes
            const tempToken = jwt.sign({ username: user.username, role: user.role, siteId: user.siteId, is2FA: true }, JWT_SECRET, { expiresIn: '5m' });
            return res.json({ status: '2fa_required', tempToken });
        }

        await logAction(user.username, user.role, user.siteId, 'connexion_reussie', 'Connexion réussie au CMS', req);

        const token = jwt.sign({ username: user.username, role: user.role, siteId: user.siteId }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ token: token, role: user.role, username: user.username, siteId: user.siteId });
    } else {
        await logAction(username || 'anonymous', null, null, 'connexion_echouee', `Tentative de connexion échouée pour l'utilisateur : ${username || 'inconnu'}`, req);
        res.status(401).send('Identifiants incorrects');
    }
});

// Route de vérification de la double authentification (2FA) pour le login
app.post('/api/login/verify-2fa', async (req, res) => {
    const { tempToken, code } = req.body;
    if (!tempToken || !code) return res.status(400).send("Paramètres manquants");

    try {
        const decoded = jwt.verify(tempToken, JWT_SECRET);
        if (!decoded || !decoded.is2FA) {
            return res.status(401).send("Jeton temporaire invalide ou expiré");
        }

        const user = await db('users').where({ username: decoded.username }).first();
        if (!user) return res.status(404).send("Utilisateur non trouvé");

        const isValid = verifyTOTP(user.twoFactorSecret, code);
        if (isValid) {
            await logAction(user.username, user.role, user.siteId, 'connexion_reussie', 'Connexion réussie au CMS (via 2FA)', req);
            const token = jwt.sign({ username: user.username, role: user.role, siteId: user.siteId }, JWT_SECRET, { expiresIn: '1h' });
            res.json({ token: token, role: user.role, username: user.username, siteId: user.siteId });
        } else {
            await logAction(user.username, user.role, user.siteId, 'connexion_echouee', `Code 2FA invalide saisi par ${user.username}`, req);
            res.status(401).send("Code de validation 2FA incorrect");
        }
    } catch (err) {
        console.error("Erreur vérification login 2FA:", err);
        res.status(401).send("Jeton temporaire expiré ou invalide");
    }
});

// API Admin : Lister les players et affecter des playlists
app.get('/api/admin/data', authMiddleware, checkRole(['admin', 'editor', 'author', 'cook', 'secretary']), (req, res) => {
    const playersQuery = filterBySiteId(db('players').select('*'), req.user);
    const playlistsQuery = filterBySiteId(db('playlists').select('*'), req.user);
    const sequencesQuery = filterBySiteId(db('sequences').select('*'), req.user);
    const groupsQuery = filterBySiteId(db('groups').select('*'), req.user);

    Promise.all([
        playersQuery,
        playlistsQuery.then(rows => rows.reduce((acc, p) => ({ ...acc, [p.id]: { ...p, items: JSON.parse(p.items) } }), {})),
        sequencesQuery.then(rows => rows.reduce((acc, s) => ({ ...acc, [s.id]: { ...s, playlistIds: JSON.parse(s.playlistIds) } }), {})),
        db('settings').select('*'),
        groupsQuery
    ]).then(([players, playlists, sequences, settings, groups]) => {
        const formattedPlayers = players
            .filter(p => p.id && p.id !== 'undefined' && p.id !== 'null')
            .reduce((acc, p) => ({ ...acc, [p.id]: { ...p, downloadStatus: JSON.parse(p.downloadStatus || '{}') } }), {});
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
    filterBySiteId(db('media').select('*'), req.user)
        .then(media => res.json(media))
        .catch(err => res.status(500).send('Error fetching media'));
});

// API Admin : Récupérer les détails d'un média (y compris les métadonnées Sozi)
app.get('/api/admin/media/:id', authMiddleware, checkRole(['admin', 'editor', 'author']), (req, res) => {
    db('media').where({ id: req.params.id }).first()
        .then(media => {
            if (!media) return res.status(404).send('Média non trouvé');
            res.json(media);
        })
        .catch(err => res.status(500).send('Erreur lors de la récupération du média'));
});

// API Admin : Enregistrer les métadonnées d'animation (Sozi) d'un média
app.post('/api/admin/media/:id/metadata', authMiddleware, checkRole(['admin', 'editor', 'author']), (req, res) => {
    const { metadata } = req.body;
    const dbValue = (metadata === null || metadata === undefined) ? null : (typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
    db('media').where({ id: req.params.id }).update({ metadata: dbValue })
        .then(() => res.json({ success: true }))
        .catch(err => res.status(500).send('Erreur lors de la sauvegarde des métadonnées'));
});

// API Player : Enregistrement des logs de diffusion
app.post('/api/player/log', authMiddleware, (req, res) => {
    const { deviceId, playlistId, itemUrl, duration } = req.body;
    console.log(`📊 Statistique reçue de ${deviceId}: ${itemUrl} (${duration}ms)`);
    db('analytics').insert({ deviceId, playlistId, itemUrl, duration })
        .then(() => {
            io.emit('admin-analytics-update'); // Notifier les admins d'une nouvelle stat
            res.json({ success: true });
        })
        .catch(err => res.status(500).send(err.message));
});

// API Admin : Statistiques de diffusion
app.get('/api/admin/analytics', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { groupId, deviceId } = req.query;
    let query = db('analytics')
        .join('players', 'analytics.deviceId', '=', 'players.id')
        .select('analytics.itemUrl')
        .count('analytics.id as count')
        .sum('analytics.duration as totalDuration')
        .groupBy('analytics.itemUrl')
        .orderBy('count', 'desc')
        .limit(50);

    if (groupId) {
        query.where('players.group', groupId);
    }
    if (deviceId) {
        query.where('analytics.deviceId', deviceId);
    }

    filterBySiteId(query, req.user, 'players.siteId')
        .then(stats => res.json(stats))
        .catch(err => res.status(500).send(err.message));
});

app.get('/api/admin/analytics/hourly', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { groupId, deviceId } = req.query;
    let query = db('analytics')
        .join('players', 'analytics.deviceId', '=', 'players.id')
        .select(db.raw("strftime('%H', analytics.timestamp, 'localtime') as hour"))
        .count('analytics.id as count')
        .where('analytics.timestamp', '>', db.raw("datetime('now', '-24 hours')"))
        .groupBy('hour')
        .orderBy('hour', 'asc');

    if (groupId) {
        query.where('players.group', groupId);
    }
    if (deviceId) {
        query.where('analytics.deviceId', deviceId);
    }

    filterBySiteId(query, req.user, 'players.siteId')
        .then(stats => {
            const hourlyData = Array.from({ length: 24 }, (_, i) => {
                const hourStr = i.toString().padStart(2, '0');
                const stat = stats.find(s => s.hour === hourStr);
                return { hour: hourStr + 'h', count: stat ? stat.count : 0 };
            });
            res.json(hourlyData);
        })
        .catch(err => res.status(500).send(err.message));
});

app.get('/api/admin/analytics/daily-duration', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { groupId, deviceId } = req.query;
    let query = db('analytics')
        .join('players', 'analytics.deviceId', '=', 'players.id')
        .select(db.raw("date(analytics.timestamp, 'localtime') as day"))
        .sum('analytics.duration as durationMs')
        .where('analytics.timestamp', '>', db.raw("datetime('now', '-7 days')"))
        .groupBy('day')
        .orderBy('day', 'asc');

    if (groupId) {
        query.where('players.group', groupId);
    }
    if (deviceId) {
        query.where('analytics.deviceId', deviceId);
    }

    filterBySiteId(query, req.user, 'players.siteId')
        .then(stats => {
            const dailyData = [];
            for (let i = 6; i >= 0; i--) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                const dayStr = d.toISOString().split('T')[0];
                const stat = stats.find(s => s.day === dayStr);
                const ms = stat ? stat.durationMs : 0;
                const hours = parseFloat((ms / 3600000).toFixed(2));
                dailyData.push({ day: dayStr, hours });
            }
            res.json(dailyData);
        })
        .catch(err => res.status(500).send(err.message));
});

app.get('/api/admin/analytics/by-device', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { groupId } = req.query;
    let query = db('analytics')
        .join('players', 'analytics.deviceId', '=', 'players.id')
        .select('players.name as playerName')
        .count('analytics.id as count')
        .groupBy('players.name')
        .orderBy('count', 'desc');

    if (groupId) {
        query.where('players.group', groupId);
    }

    filterBySiteId(query, req.user, 'players.siteId')
        .then(stats => res.json(stats))
        .catch(err => res.status(500).send(err.message));
});

app.get('/api/admin/analytics/by-type', authMiddleware, checkRole(['admin', 'editor']), async (req, res) => {
    const { groupId, deviceId } = req.query;
    try {
        let query = db('analytics')
            .join('players', 'analytics.deviceId', '=', 'players.id')
            .select('analytics.itemUrl')
            .count('analytics.id as count');

        if (groupId) {
            query.where('players.group', groupId);
        }
        if (deviceId) {
            query.where('analytics.deviceId', deviceId);
        }

        const stats = await filterBySiteId(query.groupBy('analytics.itemUrl'), req.user, 'players.siteId');

        const counts = { image: 0, video: 0, template: 0, other: 0 };
        stats.forEach(s => {
            const url = (s.itemUrl || '').toLowerCase();
            if (url.includes('/canteen') || url.includes('/meetings') || url.includes('/planning')) {
                counts.template += s.count;
            } else if (url.match(/\.(mp4|webm|ogg|mov)$/)) {
                counts.video += s.count;
            } else if (url.match(/\.(jpeg|jpg|png|gif|webp|svg)$/)) {
                counts.image += s.count;
            } else {
                counts.other += s.count;
            }
        });

        res.json([
            { label: 'Images', value: counts.image },
            { label: 'Vidéos', value: counts.video },
            { label: 'Modèles', value: counts.template },
            { label: 'Autres', value: counts.other }
        ]);
    } catch (err) {
        res.status(500).send(err.message);
    }
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
    filterBySiteId(db('groups').select('*'), req.user)
        .then(groups => res.json(groups))
        .catch(err => res.status(500).send(err.message));
});

app.post('/api/admin/groups', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { id, name, description } = req.body;
    if (!name) return res.status(400).send('Nom manquant');
    const groupId = id || `grp_${Date.now()}`;
    db('groups').insert({ id: groupId, name, description, siteId: req.user.siteId }).onConflict('id').merge()
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
    filterBySiteId(db('sequences').select('*'), req.user)
        .then(sequences => {
            const formattedSequences = sequences.reduce((acc, s) => ({ ...acc, [s.id]: { ...s, playlistIds: JSON.parse(s.playlistIds) } }), {});
            res.json(formattedSequences);
        }).catch(err => res.status(500).send('Error fetching sequences'));
});

app.post('/api/admin/sequences', authMiddleware, checkRole(['admin', 'editor', 'author']), (req, res) => {
    const { id, name, playlistIds } = req.body;
    if (!name || !playlistIds) return res.status(400).send('Données manquantes');
    const sequenceId = id || `seq_${Date.now()}`;
    db('sequences').insert({ id: sequenceId, name, playlistIds: JSON.stringify(playlistIds), siteId: req.user.siteId })
        .then(() => res.json({ success: true, sequenceId }))
        .catch(err => res.status(500).send('Error creating sequence: ' + err.message));
});

app.delete('/api/admin/sequences/:id', authMiddleware, checkRole(['admin', 'editor', 'author']), (req, res) => {
    const { id } = req.params;
    db('sequences').where({ id }).first()
        .then(async (existingSequence) => {
            if (!existingSequence) return res.status(404).send('Séquence non trouvée');

            // Vérifier les droits
            if (req.user.siteId && existingSequence.siteId !== req.user.siteId) {
                return res.status(403).send("Vous n'êtes pas autorisé à supprimer une séquence d'un autre site.");
            }

            await db('sequences').where({ id }).del();
            // Clean up player assignments
            await db('players').where({ manualSequenceId: id }).update({ manualSequenceId: null });
            await db('players').where({ currentSequenceId: id }).update({ currentSequenceId: null, currentSequenceIndex: null });
            await db('schedules').where({ sequenceId: id }).del();
            res.json({ success: true });
        })
        .catch(err => res.status(500).send('Error deleting sequence: ' + err.message));
});

// Helper pour vérifier si des médias sont utilisés dans les playlists (fond global, fond de slide, zones de slide)
async function getMediaUsagePlaylists(mediaUrls) {
    try {
        const playlists = await db('playlists').select('name', 'items', 'backgroundUrl');
        const usedInPlaylists = new Set();
        
        for (const p of playlists) {
            if (p.backgroundUrl && mediaUrls.includes(p.backgroundUrl)) {
                usedInPlaylists.add(p.name);
                continue;
            }
            
            let items = [];
            try {
                items = JSON.parse(p.items || '[]');
            } catch (e) {
                console.error("Erreur parsing items de la playlist :", e);
            }
            
            let found = false;
            for (const item of items) {
                if (item.backgroundUrl && mediaUrls.includes(item.backgroundUrl)) {
                    usedInPlaylists.add(p.name);
                    found = true;
                    break;
                }
                if (item.zones && Array.isArray(item.zones)) {
                    for (const zone of item.zones) {
                        if (zone.url && mediaUrls.includes(zone.url)) {
                            usedInPlaylists.add(p.name);
                            found = true;
                            break;
                        }
                    }
                }
                if (found) break;
            }
        }
        
        return Array.from(usedInPlaylists);
    } catch (err) {
        console.error("Erreur dans getMediaUsagePlaylists:", err);
        return [];
    }
}

app.delete('/api/admin/media/folder/:folderId', authMiddleware, checkRole(['admin', 'editor', 'author']), (req, res) => {
    const { folderId } = req.params;
    const force = req.query.force === 'true';

    db('media').where({ parentFolderId: folderId })
        .then(async (items) => {
            if (items.length === 0) return res.status(404).send('Dossier non trouvé ou vide');

            // Vérifier les droits
            for (const item of items) {
                if (req.user.role === 'author' && item.uploadedBy !== req.user.username) {
                    return res.status(403).send("Vous n'êtes pas autorisé à supprimer ce dossier car certains médias ne vous appartiennent pas.");
                }
                if (req.user.siteId && item.siteId !== req.user.siteId) {
                    return res.status(403).send("Vous n'êtes pas autorisé à supprimer ce dossier car il appartient à un autre site.");
                }
            }
            
            if (!force) {
                const urls = items.map(item => item.url);
                const usedIn = await getMediaUsagePlaylists(urls);
                if (usedIn.length > 0) {
                    return res.status(409).json({
                        error: 'in_use',
                        playlists: usedIn,
                        message: `Ce dossier contient des images utilisées dans les diaporamas suivants : ${usedIn.join(', ')}.`
                    });
                }
            }

            // Supprimer les fichiers physiques sur le disque
            for (const item of items) {
                const relativePath = item.url.replace('/media/', '');
                const filePath = path.join(MEDIA_DIR, relativePath);
                try {
                    if (fs.existsSync(filePath)) await fs.unlink(filePath);
                } catch (e) {
                    console.error("Erreur lors de la suppression du fichier physique:", e);
                }
            }

            // Supprimer le dossier physique s'il est vide/existe
            try {
                const folderPath = path.join(MEDIA_DIR, folderId);
                if (fs.existsSync(folderPath)) {
                    await fs.remove(folderPath);
                }
            } catch (e) {
                console.error("Erreur lors de la suppression du dossier physique:", e);
            }

            await db('media').where({ parentFolderId: folderId }).del();
            res.json({ success: true });
        })
        .catch(err => res.status(500).send('Error deleting folder: ' + err.message));
});

app.delete('/api/admin/media/:id', authMiddleware, checkRole(['admin', 'editor', 'author']), (req, res) => {
    const { id } = req.params; // media ID
    const force = req.query.force === 'true';

    db('media').where({ id }).first()
        .then(async (item) => {
            if (!item) return res.status(404).send('Média non trouvé');

            // Vérifier les droits
            if (req.user.role === 'author' && item.uploadedBy !== req.user.username) {
                return res.status(403).send("Vous n'êtes pas autorisé à supprimer ce média car il ne vous appartient pas.");
            }
            if (req.user.siteId && item.siteId !== req.user.siteId) {
                return res.status(403).send("Vous n'êtes pas autorisé à supprimer ce média d'un autre site.");
            }

            if (!force) {
                const usedIn = await getMediaUsagePlaylists([item.url]);
                if (usedIn.length > 0) {
                    return res.status(409).json({
                        error: 'in_use',
                        playlists: usedIn,
                        message: `Ce média est utilisé dans les diaporamas suivants : ${usedIn.join(', ')}.`
                    });
                }
            }

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
    db('users').select('id', 'username', 'role', 'email', 'siteId').then(users => res.json(users)).catch(err => res.status(500).send('Error fetching users'));
});

// Route pour le planning / agenda de diffusion
app.get('/planning', (req, res) => {
    res.sendFile(path.join(__dirname, 'planning.html'));
});

// API Admin : Gestion des agendas / planifications
app.get('/api/admin/schedules', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    db('schedules').select('*')
        .then(schedules => res.json(schedules))
        .catch(err => res.status(500).send('Error fetching schedules: ' + err.message));
});

app.post('/api/admin/schedules', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { 
        id, 
        name, 
        targetType, 
        targetId, 
        deviceId, 
        playlistId, 
        sequenceId, 
        scheduleType, 
        daysOfWeek, 
        timeStart, 
        timeEnd, 
        startDate, 
        endDate, 
        priority, 
        active, 
        startTime, 
        endTime 
    } = req.body;

    if (!name || (!playlistId && !sequenceId)) {
        return res.status(400).send('Données manquantes pour la planification (nom et contenu requis).');
    }

    const scheduleId = id || `sch_${Date.now()}`;
    const newSchedule = {
        id: scheduleId,
        name: name || 'Règle de diffusion',
        targetType: targetType || 'player',
        targetId: targetId || deviceId || null,
        deviceId: targetId || deviceId || null,
        playlistId: playlistId || null,
        sequenceId: sequenceId || null,
        scheduleType: scheduleType || 'recurring',
        daysOfWeek: Array.isArray(daysOfWeek) ? JSON.stringify(daysOfWeek) : (daysOfWeek || '[1,2,3,4,5]'),
        timeStart: timeStart || '00:00',
        timeEnd: timeEnd || '23:59',
        startDate: startDate || null,
        endDate: endDate || null,
        priority: priority !== undefined ? parseInt(priority) : 10,
        active: active !== undefined ? (active ? 1 : 0) : 1,
        startTime: startTime || null,
        endTime: endTime || null
    };

    db('schedules').where({ id: scheduleId }).first()
        .then(async (existingSchedule) => {
            if (existingSchedule) {
                await db('schedules').where({ id: scheduleId }).update(newSchedule);
            } else {
                await db('schedules').insert(newSchedule);
            }
            await checkSchedules(null, true); // Re-evaluate schedules immediately for all screens
            res.json({ success: true, scheduleId });
        })
        .catch(err => res.status(500).send('Error saving schedule: ' + err.message));
});

app.put('/api/admin/schedules/:id/toggle', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { id } = req.params;
    db('schedules').where({ id }).first()
        .then(async (schedule) => {
            if (!schedule) return res.status(404).send('Planification non trouvée');
            const newActiveState = schedule.active ? 0 : 1;
            await db('schedules').where({ id }).update({ active: newActiveState });
            await checkSchedules(null, true);
            res.json({ success: true, active: !!newActiveState });
        })
        .catch(err => res.status(500).send('Error toggling schedule: ' + err.message));
});

app.delete('/api/admin/schedules/:id', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { id } = req.params;
    db('schedules').where({ id }).del()
        .then(async (count) => {
            if (count > 0) {
                await checkSchedules(null, true); // Re-evaluate schedules immediately for all screens
                res.json({ success: true });
            } else {
                res.status(404).send('Planification non trouvée');
            }
        })
        .catch(err => res.status(500).send('Error deleting schedule: ' + err.message));
});

app.post('/api/admin/users', authMiddleware, checkRole(['admin']), async (req, res) => {
    const { username, password, role, email, siteId } = req.body;
    if (!username || !password || !role) return res.status(400).send('Données manquantes');
    if (username === 'admin' && req.user.username !== 'admin') {
        return res.status(403).send("Seul le compte super admin principal peut modifier les informations de l'utilisateur admin");
    }
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    db('users').where({ username }).first()
        .then(async (existingUser) => {
            const cleanEmail = (email && email.trim()) ? email.trim() : null;
            const userData = { password: hashedPassword, role, email: cleanEmail, siteId: siteId || null };
            if (existingUser) {
                await db('users').where({ username }).update(userData);
                await logAction(req.user.username, req.user.role, req.user.siteId, 'user_update', `Modification de l'utilisateur "${username}" (Rôle : ${role})`, req);
            } else {
                await db('users').insert({ username, ...userData });
                await logAction(req.user.username, req.user.role, req.user.siteId, 'user_create', `Création de l'utilisateur "${username}" (Rôle : ${role})`, req);
            }
            res.json({ success: true });
        })
        .catch(err => res.status(500).send('Error saving user: ' + err.message));
});

app.delete('/api/admin/users/:username', authMiddleware, checkRole(['admin']), (req, res) => {
    const { username } = req.params;
    if (username === 'admin') return res.status(400).send('Impossible de supprimer le compte admin principal');
    db('users').where({ username }).del()
        .then(async (count) => {
            if (count > 0) {
                await logAction(req.user.username, req.user.role, req.user.siteId, 'user_delete', `Suppression de l'utilisateur "${username}"`, req);
                res.json({ success: true });
            } else {
                res.status(404).send('Utilisateur non trouvé');
            }
        })
        .catch(err => res.status(500).send('Error deleting user: ' + err.message));
});

// API Admin : Gestion des sites
app.get('/api/admin/sites', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    db('sites').select('*')
        .then(sites => res.json(sites))
        .catch(err => res.status(500).send('Error fetching sites: ' + err.message));
});

app.post('/api/admin/sites', authMiddleware, checkRole(['admin']), (req, res) => {
    const { id, name, description } = req.body;
    if (!name) return res.status(400).send('Le nom du site est obligatoire.');

    const siteId = id || `site_${Date.now()}`;
    const siteData = { id: siteId, name, description: description || '' };

    db('sites').where({ id: siteId }).first()
        .then(async (existingSite) => {
            if (existingSite) {
                await db('sites').where({ id: siteId }).update(siteData);
            } else {
                await db('sites').insert(siteData);
            }
            res.json({ success: true, siteId });
        })
        .catch(err => res.status(500).send('Error saving site: ' + err.message));
});

app.delete('/api/admin/sites/:id', authMiddleware, checkRole(['admin']), async (req, res) => {
    const { id } = req.params;
    try {
        const usersCount = await db('users').where({ siteId: id }).count('id as count').first();
        const playersCount = await db('players').where({ siteId: id }).count('id as count').first();
        if (usersCount.count > 0 || playersCount.count > 0) {
            return res.status(400).send("Impossible de supprimer ce site car il contient encore des utilisateurs ou des écrans.");
        }

        await db('sites').where({ id }).del();
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('Error deleting site: ' + err.message);
    }
});

app.post('/api/admin/upload', authMiddleware, checkRole(['admin', 'editor', 'author']), upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send('Aucun fichier uploadé.');

    req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
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
                        parentZipDir: zipExtractDirName, // Link to the original zip extraction directory
                        siteId: req.user.siteId
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
            uploadDate: new Date().toISOString(),
            siteId: req.user.siteId
        };

    await db('media').insert(mediaItem);
    res.json(mediaItem);
    }
});

app.post('/api/admin/media/youtube', authMiddleware, checkRole(['admin', 'editor', 'author']), async (req, res) => {
    const { youtubeUrl } = req.body;
    if (!youtubeUrl) return res.status(400).json({ message: 'URL YouTube manquante' });

    const ytDlpCmd = resolveLocalBinary('yt-dlp.exe');
    const ffmpegCmd = resolveLocalBinary('ffmpeg.exe');

    // Vérification rapide de la présence des utilitaires système
    try {
        await execPromise(`${ytDlpCmd} --version`);
        await execPromise(`${ffmpegCmd} -version`);
    } catch (e) {
        return res.status(500).json({ message: `Utilitaires système manquants (yt-dlp ou ffmpeg).` });
    }

    // Répondre immédiatement au client
    res.json({ success: true, message: 'Téléchargement démarré en tâche de fond.' });

    // Lancer le téléchargement en tâche de fond
    (async () => {
        try {
            console.log(`📥 [YouTube BG] Récupération du titre : ${youtubeUrl}`);
            const cookiesPath = path.join(__dirname, 'cookies.txt');
            const cookiesCmdArg = fs.existsSync(cookiesPath) ? ` --cookies "${cookiesPath}"` : '';

            const { stdout: titleBuffer } = await execPromise(`${ytDlpCmd} --encoding utf-8${cookiesCmdArg} --get-title "${youtubeUrl}"`, { 
                encoding: 'buffer',
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
            });
            const title = titleBuffer.toString('utf8');
            const cleanTitle = title.trim().replace(/[/\\?%*:|"<>]/g, '-');
            const safeFilename = `yt_${Date.now()}_${cleanTitle}.mp4`;
            const outputPath = path.join(MEDIA_DIR, safeFilename);

            console.log(`📥 [YouTube BG] Début du téléchargement : ${youtubeUrl}`);
            const downloadArgs = [
                '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
                '--recode-video', 'mp4',
                '--postprocessor-args', 'ffmpeg:-c:v libx264 -profile:v baseline -level 3.0 -pix_fmt yuv420p -b:v 2000k -maxrate 2000k -bufsize 4000k -c:a aac -movflags +faststart',
                '-o', outputPath,
                youtubeUrl,
                '--newline',
                '--progress'
            ];
            if (fs.existsSync(cookiesPath)) {
                downloadArgs.unshift('--cookies', cookiesPath);
            }
            const executable = ytDlpCmd.replace(/"/g, '');
            const downloadProcess = spawn(executable, downloadArgs, {
                env: { ...process.env, PYTHONUNBUFFERED: "1" }
            });

            await new Promise((resolve, reject) => {
                downloadProcess.stdout.on('data', (data) => {
                    const output = data.toString();
                    const lines = output.split(/[\r\n]+/);
                    // Parcourir de la fin vers le début pour émettre le pourcentage le plus récent
                    for (let i = lines.length - 1; i >= 0; i--) {
                        const match = lines[i].match(/(\d+(?:\.\d+)?)%/);
                        if (match) {
                            io.emit('youtube-download-progress', { url: youtubeUrl, progress: match[1] });
                            break; 
                        }
                    }
                });
                downloadProcess.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`Le téléchargement a échoué avec le code ${code}`));
                });
                downloadProcess.on('error', reject);
            });

            // Enregistrer l'entrée dans la base de données
            const mediaItem = {
                id: `m_yt_${Date.now()}`,
                filename: `${title.trim()}.mp4`,
                url: `/media/${safeFilename}`,
                type: 'video',
                uploadedBy: req.user.username,
                uploadDate: new Date().toISOString(),
                siteId: req.user.siteId
            };

            await db('media').insert(mediaItem);
            console.log(`✅ [YouTube BG] Vidéo importée avec succès : ${mediaItem.filename}`);
            io.emit('youtube-download-complete', mediaItem);
        } catch (error) {
            console.error("❌ [YouTube BG] Erreur lors du téléchargement :", error.message);
            io.emit('youtube-download-error', { url: youtubeUrl, message: error.message });
        }
    })();
});

// Route pour l'import PPTX (Structure suggérée)
app.post('/api/admin/import-pptx', authMiddleware, checkRole(['admin', 'editor', 'author']), upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send('Aucun fichier PPTX.');

    req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    try {
        const fileBaseName = path.parse(req.file.filename).name;
        const subFolderName = `pptx_${Date.now()}`;
        const outputDir = path.join(MEDIA_DIR, subFolderName);
        await fs.ensureDir(outputDir);

        // Détection et résolution des chemins de soffice (LibreOffice) et pdftocairo
        let sofficeCmd = 'soffice';
        if (process.platform === 'win32') {
            const defaultPaths = [
                'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
                'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
            ];
            for (const p of defaultPaths) {
                if (await fs.pathExists(p)) {
                    sofficeCmd = `"${p}"`;
                    break;
                }
            }
            // Si pas trouvé dans les dossiers par défaut, on cherche aussi dans les sous-dossiers locaux 'app' ou 'bin'
            if (sofficeCmd === 'soffice') {
                const localSoffice = resolveLocalBinary('soffice.exe');
                if (localSoffice !== 'soffice') {
                    sofficeCmd = localSoffice;
                }
            }
        }

        const pdftocairoCmd = resolveLocalBinary('pdftocairo.exe');

        // 1. Conversion PPTX -> PDF via LibreOffice
        await execPromise(`${sofficeCmd} --headless --convert-to pdf --outdir "${outputDir}" "${req.file.path}"`);
        
        const pdfPath = path.join(outputDir, `${fileBaseName}.pdf`);
        
        // Attente de la création effective du fichier PDF (max 15 secondes)
        let fileCreated = false;
        for (let i = 0; i < 30; i++) {
            if (await fs.pathExists(pdfPath)) {
                fileCreated = true;
                break;
            }
            await new Promise(r => setTimeout(r, 500));
        }
        
        if (!fileCreated) {
            throw new Error(`La conversion PDF a échoué. Vérifiez que LibreOffice est installé. Commande tentée : ${sofficeCmd}`);
        }

        // 2. Conversion PDF -> PNG (un par slide) via pdftocairo
        const slidePrefix = path.join(outputDir, 'slide');
        await execPromise(`${pdftocairoCmd} -png "${pdfPath}" "${slidePrefix}"`);

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
                uploadDate: new Date().toISOString(),
                parentFolderId: subFolderName,
                parentFolderName: req.file.originalname,
                siteId: req.user.siteId
            };
            await db('media').insert(mediaItem);
            return { duration: 10000, backgroundColor: '#000000', backgroundUrl: relativeUrl, zones: [] };
        }));

        const playlistData = {
            id: playlistId,
            name: `Import: ${req.file.originalname}`,
            items: JSON.stringify(playlistItems),
            backgroundColor: "#ffffff",
            resolution: "16/9",
            createdBy: req.user.username,
            updatedBy: req.user.username,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            siteId: req.user.siteId
        };

        await db('playlists').insert(playlistData);
        res.json({ success: true, playlistId, items: playlistItems }); // Return the ID of the newly created playlist and the items

    } catch (error) {
        console.error("Erreur import PPTX:", error);
        res.status(500).send("Erreur lors de l'importation : " + error.message);
    }
});

app.post('/api/admin/playlists', authMiddleware, checkRole(['admin', 'editor', 'author']), (req, res) => {
    const { id, name, items, backgroundUrl, backgroundColor, resolution } = req.body;
    const playlistId = id || `p_${Date.now()}`;
    
    // Déterminer le statut selon le rôle de l'utilisateur
    const isValidator = req.user.role === 'admin' || req.user.role === 'editor';
    let status = req.body.status || 'approved';
    if (!isValidator) {
        // Un auteur ne peut enregistrer qu'en Brouillon ou En attente de validation
        status = req.body.status === 'pending' ? 'pending' : 'draft';
    }

    const playlistData = { 
        id: playlistId, 
        name, 
        items: JSON.stringify(items), 
        backgroundUrl, 
        backgroundColor, 
        resolution,
        status
    };

    db('playlists').where({ id: playlistId }).first()
        .then(async (existingPlaylist) => {
            if (existingPlaylist) {
                // Vérifier les droits
                if (req.user.role === 'author' && existingPlaylist.createdBy !== req.user.username) {
                    return res.status(403).send("Vous n'êtes pas autorisé à modifier ce diaporama car il ne vous appartient pas.");
                }
                if (req.user.siteId && existingPlaylist.siteId !== req.user.siteId) {
                    return res.status(403).send("Vous n'êtes pas autorisé à modifier un diaporama d'un autre site.");
                }

                playlistData.updatedBy = req.user.username;
                playlistData.updatedAt = new Date().toISOString();
                await db('playlists').where({ id: playlistId }).update(playlistData);
                await logAction(req.user.username, req.user.role, req.user.siteId, 'playlist_update', `Modification du diaporama "${name}"`, req);
            } else {
                playlistData.createdBy = req.user.username;
                playlistData.updatedBy = req.user.username;
                playlistData.createdAt = new Date().toISOString();
                playlistData.updatedAt = new Date().toISOString();
                playlistData.siteId = req.user.siteId; // Assigner le siteId
                await db('playlists').insert(playlistData);
                await logAction(req.user.username, req.user.role, req.user.siteId, 'playlist_create', `Création du diaporama "${name}"`, req);
            }
            checkSchedules(null, true);

            if (NOTIFY_PLAYLIST_CHANGE) {
                const actionText = existingPlaylist ? "modifié" : "créé";
                const subject = `📢 Diaporama ${actionText} : ${name}`;
                const text = `Le diaporama "${name}" (ID: ${playlistId}) a été ${actionText} par l'utilisateur "${req.user.username}" (Statut: ${status}).`;
                const html = `<h3>📢 Diaporama ${actionText}</h3>
                             <p><b>Nom :</b> ${name}</p>
                             <p><b>ID :</b> <code>${playlistId}</code></p>
                             <p><b>Auteur :</b> ${req.user.username}</p>
                             <p><b>Statut :</b> ${status}</p>`;
                sendNotificationEmail(subject, text, html, req.user.siteId);
            }

            res.json({ success: true, playlistId });
        })
        .catch(err => res.status(500).send('Error saving playlist: ' + err.message));
});

app.post('/api/admin/playlists/:id/approve', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { id } = req.params;
    db('playlists').where({ id }).update({ status: 'approved' })
        .then(async (count) => {
            if (count > 0) {
                checkSchedules(null, true);
                const playlist = await db('playlists').where({ id }).first();
                const plName = playlist ? playlist.name : id;
                await logAction(req.user.username, req.user.role, req.user.siteId, 'playlist_approve', `Approbation du diaporama "${plName}"`, req);
                res.json({ success: true });
            } else {
                res.status(404).send('Diaporama non trouvé');
            }
        })
        .catch(err => res.status(500).send('Error approving playlist: ' + err.message));
});

app.post('/api/admin/playlists/:playlistId/publish', authMiddleware, checkRole(['admin', 'editor']), async (req, res) => {
    const { playlistId } = req.params;
    const { playerIds, groupIds } = req.body;
    
    try {
        // 1. Valider le diaporama automatiquement lors de la publication
        await db('playlists').where({ id: playlistId }).update({ status: 'approved' });
        
        // 2. Assigner aux lecteurs individuels sélectionnés
        if (playerIds && Array.isArray(playerIds)) {
            await db('players').whereIn('id', playerIds).update({ manualPlaylistId: playlistId, manualSequenceId: null });
        }
        
        // 3. Assigner aux groupes d'écrans sélectionnés
        if (groupIds && Array.isArray(groupIds) && groupIds.length > 0) {
            await db('players').whereIn('groupId', groupIds).update({ manualPlaylistId: playlistId, manualSequenceId: null });
        }
        
        checkSchedules(null, true);

        const playlist = await db('playlists').where({ id: playlistId }).first();
        const plName = playlist ? playlist.name : playlistId;
        await logAction(req.user.username, req.user.role, req.user.siteId, 'playlist_publish', `Publication directe du diaporama "${plName}" sur les écrans`, req);

        if (NOTIFY_PLAYLIST_CHANGE) {
            const playlist = await db('playlists').where({ id: playlistId }).first();
            if (playlist) {
                const subject = `🚀 Diaporama publié : ${playlist.name}`;
                const text = `Le diaporama "${playlist.name}" a été publié par "${req.user.username}" sur les afficheurs/groupes.`;
                const html = `<h3>🚀 Diaporama publié</h3>
                             <p><b>Nom :</b> ${playlist.name}</p>
                             <p><b>Publié par :</b> ${req.user.username}</p>
                             <p><b>Destinations :</b> ${playerIds ? playerIds.length : 0} lecteur(s) individuel(s), ${groupIds ? groupIds.length : 0} groupe(s).</p>`;
                sendNotificationEmail(subject, text, html, req.user.siteId);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error("Erreur publication direct:", err);
        res.status(500).send('Error publishing playlist: ' + err.message);
    }
});

app.delete('/api/admin/playlists/:id', authMiddleware, checkRole(['admin', 'editor', 'author']), (req, res) => {
    const { id } = req.params;
    db('playlists').where({ id }).first()
        .then(async (existingPlaylist) => {
            if (!existingPlaylist) return res.status(404).send('Diaporama non trouvé');

            // Vérifier les droits
            if (req.user.role === 'author' && existingPlaylist.createdBy !== req.user.username) {
                return res.status(403).send("Vous n'êtes pas autorisé à supprimer ce diaporama car il ne vous appartient pas.");
            }
            if (req.user.siteId && existingPlaylist.siteId !== req.user.siteId) {
                return res.status(403).send("Vous n'êtes pas autorisé à supprimer un diaporama d'un autre site.");
            }

            await db('playlists').where({ id }).del();
            await logAction(req.user.username, req.user.role, req.user.siteId, 'playlist_delete', `Suppression du diaporama "${existingPlaylist.name}"`, req);
            await db('players').where({ manualPlaylistId: id }).update({ manualPlaylistId: null });
            await db('players').where({ currentPlaylistId: id }).update({ currentPlaylistId: null });
            await db('schedules').where({ playlistId: id }).del();
            res.json({ success: true });
        })
        .catch(err => res.status(500).send('Error deleting playlist: ' + err.message));
});

app.post('/api/admin/settings', authMiddleware, checkRole(['admin']), async (req, res) => {
    const settingsToUpdate = req.body;
    if (!settingsToUpdate.jwtSecret || !settingsToUpdate.apiKey) return res.status(400).send('Données manquantes');

    try {
        const updates = Object.entries(settingsToUpdate).map(([key, value]) => {
            // Normalisation des valeurs pour la DB (booleans en string)
            let finalValue = value;
            if (typeof value === 'boolean') finalValue = String(value);
            
            return db('settings')
                .insert({ key, value: String(finalValue) })
                .onConflict('key')
                .merge();
        });

        await Promise.all(updates);

        // Mise à jour des variables globales en mémoire
        JWT_SECRET = settingsToUpdate.jwtSecret;
        API_KEY = settingsToUpdate.apiKey;
        DISABLE_CLIENT_LOGS = !!settingsToUpdate.disableClientLogs;
        DISABLE_DEBUG_LOGS = !!settingsToUpdate.disableDebugLogs;
        SCREEN_WAKE_TIME = settingsToUpdate.screenWakeTime || '07:00';
        SCREEN_SLEEP_TIME = settingsToUpdate.screenSleepTime || '22:00';
        if (settingsToUpdate.screenSleepSchedule) {
            try {
                SCREEN_SLEEP_SCHEDULE = typeof settingsToUpdate.screenSleepSchedule === 'string'
                    ? JSON.parse(settingsToUpdate.screenSleepSchedule)
                    : settingsToUpdate.screenSleepSchedule;
            } catch (e) {
                console.error("Erreur de parsing screenSleepSchedule dans POST settings:", e);
            }
        }
        SPLASH_SCREEN_URL = settingsToUpdate.splashScreenUrl || '/img/splashscreen.png';
        SMTP_HOST = settingsToUpdate.smtpHost || '';
        SMTP_PORT = settingsToUpdate.smtpPort || '587';
        SMTP_USER = settingsToUpdate.smtpUser || '';
        SMTP_PASS = settingsToUpdate.smtpPass || '';
        NOTIFICATION_EMAIL = settingsToUpdate.notificationEmail || '';
        EMAIL_NOTIFICATIONS_ENABLED = settingsToUpdate.emailNotificationsEnabled === true || settingsToUpdate.emailNotificationsEnabled === 'true';
        NOTIFY_PLAYLIST_CHANGE = settingsToUpdate.notifyPlaylistChange === true || settingsToUpdate.notifyPlaylistChange === 'true';
        NOTIFY_PLAYER_OFFLINE = settingsToUpdate.notifyPlayerOffline === true || settingsToUpdate.notifyPlayerOffline === 'true';
        NOTIFY_PLAYER_ONLINE = settingsToUpdate.notifyPlayerOnline === true || settingsToUpdate.notifyPlayerOnline === 'true';
        NOTIFY_TECH_ALERT = settingsToUpdate.notifyTechAlert === true || settingsToUpdate.notifyTechAlert === 'true';
        OFFLINE_ALERT_DELAY = parseInt(settingsToUpdate.offlineAlertDelay, 10) || 15;
        SHOW_OFFLINE_ALERT = settingsToUpdate.showOfflineAlert === true || settingsToUpdate.showOfflineAlert === 'true';
        PERIODIC_SCREENSHOT_ENABLED = settingsToUpdate.periodicScreenshotEnabled === true || settingsToUpdate.periodicScreenshotEnabled === 'true';
        PERIODIC_SCREENSHOT_INTERVAL = parseInt(settingsToUpdate.periodicScreenshotInterval, 10) || 5;

        checkSchedules(null, true); 
        console.log("⚙️ Paramètres système mis à jour.");
        await logAction(req.user.username, req.user.role, req.user.siteId, 'settings_update', 'Modification des paramètres système généraux', req);
        res.json({ success: true });
    } catch (err) {
        console.error("Erreur sauvegarde settings:", err);
        res.status(500).send('Error saving settings: ' + err.message);
    }
});

// GET /api/admin/2fa/status - Récupérer l'état 2FA de l'administrateur
app.get('/api/admin/2fa/status', authMiddleware, async (req, res) => {
    try {
        const user = await db('users').where({ username: req.user.username }).first();
        if (!user) return res.status(404).send('Utilisateur non trouvé');
        res.json({ twoFactorEnabled: !!user.twoFactorEnabled });
    } catch (err) {
        console.error("Erreur status 2FA:", err);
        res.status(500).send("Erreur lors de la récupération du statut 2FA");
    }
});

// GET /api/admin/2fa/setup - Générer la clé et le QR code de configuration
app.get('/api/admin/2fa/setup', authMiddleware, async (req, res) => {
    try {
        if (req.user.username !== 'admin') {
            return res.status(403).send("La double authentification est réservée à l'administrateur système.");
        }
        
        const secret = generateBase32Secret();
        const label = `OmniSign:${req.user.username}`;
        const otpAuthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=OmniSign`;
        const qrCodeDataUrl = await QRCode.toDataURL(otpAuthUrl);
        
        res.json({ secret, qrCodeDataUrl });
    } catch (err) {
        console.error("Erreur génération 2FA setup:", err);
        res.status(500).send("Erreur lors de la génération du QR code 2FA");
    }
});

// POST /api/admin/2fa/enable - Activer la double authentification
app.post('/api/admin/2fa/enable', authMiddleware, async (req, res) => {
    try {
        if (req.user.username !== 'admin') {
            return res.status(403).send("La double authentification est réservée à l'administrateur système.");
        }
        
        const { secret, code } = req.body;
        if (!secret || !code) return res.status(400).send("Paramètres manquants");
        
        const isValid = verifyTOTP(secret, code);
        if (isValid) {
            await db('users').where({ username: req.user.username }).update({
                twoFactorSecret: secret,
                twoFactorEnabled: true
            });
            await logAction(req.user.username, req.user.role, req.user.siteId, '2fa_enable', "Double authentification activée pour l'administrateur", req);
            res.json({ success: true });
        } else {
            res.status(400).send("Code de validation 2FA incorrect. Veuillez réessayer.");
        }
    } catch (err) {
        console.error("Erreur activation 2FA:", err);
        res.status(500).send("Erreur lors de l'activation de la 2FA");
    }
});

// POST /api/admin/2fa/disable - Désactiver la double authentification
app.post('/api/admin/2fa/disable', authMiddleware, async (req, res) => {
    try {
        if (req.user.username !== 'admin') {
            return res.status(403).send("La double authentification est réservée à l'administrateur système.");
        }
        
        const { password } = req.body;
        if (!password) return res.status(400).send("Mot de passe requis");
        
        const user = await db('users').where({ username: req.user.username }).first();
        if (!user) return res.status(404).send("Utilisateur non trouvé");
        
        const isMatch = await bcrypt.compare(password, user.password);
        if (isMatch) {
            await db('users').where({ username: req.user.username }).update({
                twoFactorSecret: null,
                twoFactorEnabled: false
            });
            await logAction(req.user.username, req.user.role, req.user.siteId, '2fa_disable', "Double authentification désactivée pour l'administrateur", req);
            res.json({ success: true });
        } else {
            res.status(400).send("Mot de passe incorrect");
        }
    } catch (err) {
        console.error("Erreur désactivation 2FA:", err);
        res.status(500).send("Erreur lors de la désactivation de la 2FA");
    }
});

// API Admin : Récupérer le journal d'audit filtré et paginé
app.get('/api/admin/system/logs', authMiddleware, checkRole(['admin', 'editor', 'author', 'cook', 'secretary']), async (req, res) => {
    try {
        let { page = 1, limit = 50, username, action, search } = req.query;
        page = parseInt(page, 10) || 1;
        limit = parseInt(limit, 10) || 50;
        const offset = (page - 1) * limit;

        // Query builder de base
        let query = db('audit_logs');
        let countQuery = db('audit_logs').count('* as count');

        // Isolation multi-site : Les non-admins ne voient que les logs de leur propre site
        if (req.user.role !== 'admin') {
            if (req.user.siteId) {
                query = query.where({ siteId: req.user.siteId });
                countQuery = countQuery.where({ siteId: req.user.siteId });
            } else {
                query = query.where({ siteId: '___none___' });
                countQuery = countQuery.where({ siteId: '___none___' });
            }
        }

        // Filtre par utilisateur
        if (username) {
            query = query.where('username', 'like', `%${username}%`);
            countQuery = countQuery.where('username', 'like', `%${username}%`);
        }

        // Filtre par type d'action
        if (action) {
            query = query.where({ action });
            countQuery = countQuery.where({ action });
        }

        // Filtre de recherche dans les détails
        if (search) {
            query = query.where('details', 'like', `%${search}%`);
            countQuery = countQuery.where('details', 'like', `%${search}%`);
        }

        // Exécuter les requêtes
        const [totalCountResult] = await countQuery;
        const total = totalCountResult.count;

        const logs = await query
            .select('*')
            .orderBy('timestamp', 'desc')
            .limit(limit)
            .offset(offset);

        res.json({
            logs,
            pagination: {
                total,
                page,
                limit,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        console.error("Erreur récupération logs d'audit:", err);
        res.status(500).send("Erreur lors de la récupération du journal d'audit : " + err.message);
    }
});

// API Cookies YouTube
app.get('/api/admin/system/cookies/status', authMiddleware, checkRole(['admin']), async (req, res) => {
    try {
        const cookiesPath = path.join(__dirname, 'cookies.txt');
        const exists = await fs.pathExists(cookiesPath);
        res.json({ exists });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.post('/api/admin/system/cookies', authMiddleware, checkRole(['admin']), upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send('Aucun fichier fourni.');
    try {
        const cookiesPath = path.join(__dirname, 'cookies.txt');
        await fs.move(req.file.path, cookiesPath, { overwrite: true });
        res.json({ success: true, message: 'Fichier cookies.txt mis à jour.' });
    } catch (err) {
        res.status(500).send('Erreur lors de la sauvegarde : ' + err.message);
    }
});

app.delete('/api/admin/system/cookies', authMiddleware, checkRole(['admin']), async (req, res) => {
    try {
        const cookiesPath = path.join(__dirname, 'cookies.txt');
        if (await fs.pathExists(cookiesPath)) {
            await fs.remove(cookiesPath);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// --- API GESTION DES MENUS DE CANTINE MULTI-SITES & MULTI-SEMAINES ---

// Helper pour calculer la semaine ISO (ex: 2026-W29 -> 2026-29)
const getIsoWeekString = (dateObj = new Date()) => {
    const d = new Date(Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const year = d.getUTCFullYear();
    const oneJan = new Date(Date.UTC(year, 0, 1));
    const weekNo = Math.ceil((((d - oneJan) / 86400000) + 1) / 7);
    return `${year}-${weekNo.toString().padStart(2, '0')}`;
};

// GET /api/admin/canteen/:weekId - Récupérer le menu d'une semaine pour un site donné
app.get('/api/admin/canteen/:weekId', authMiddleware, checkRole(['admin', 'editor', 'author', 'cook']), async (req, res) => {
    try {
        let { weekId } = req.params;
        weekId = weekId.replace('-W', '-');
        
        let targetSiteId = req.user.siteId;
        if (req.user.role === 'admin' && req.query.siteId) {
            targetSiteId = req.query.siteId;
        }
        if (!targetSiteId) {
            const firstSite = await db('sites').first();
            targetSiteId = firstSite ? firstSite.id : 'site_paris';
        }

        const menuId = `${targetSiteId}_${weekId}`;
        const record = await db('canteen_menus').where({ id: menuId }).first() 
                    || await db('canteen_menus').where({ week_id: menuId }).first()
                    || await db('canteen_menus').where({ siteId: targetSiteId, week_id: weekId }).first()
                    || await db('canteen_menus').where({ week_id: weekId }).first();

        if (record) {
            const dataObj = typeof record.data === 'string' ? JSON.parse(record.data) : record.data;
            res.json({ weekId, siteId: targetSiteId, data: dataObj });
        } else {
            res.json({ weekId, siteId: targetSiteId, data: {} });
        }
    } catch (err) {
        console.error("Erreur GET /api/admin/canteen/:weekId:", err);
        res.status(500).send("Erreur lors de la récupération du menu de la cantine.");
    }
});

// POST /api/admin/canteen - Enregistrer / Mettre à jour le menu d'une semaine pour un site
app.post('/api/admin/canteen', authMiddleware, checkRole(['admin', 'editor', 'author', 'cook']), async (req, res) => {
    try {
        let { weekId, data, siteId } = req.body;
        if (!weekId || !data) return res.status(400).send('weekId et data sont requis.');
        weekId = weekId.replace('-W', '-');

        let targetSiteId = req.user.siteId;
        if (req.user.role === 'admin' && siteId) {
            targetSiteId = siteId;
        }
        if (!targetSiteId) {
            const firstSite = await db('sites').first();
            targetSiteId = firstSite ? firstSite.id : 'site_paris';
        }

        const menuId = `${targetSiteId}_${weekId}`;
        const existing = await db('canteen_menus').where({ id: menuId }).first()
                     || await db('canteen_menus').where({ week_id: menuId }).first()
                     || await db('canteen_menus').where({ siteId: targetSiteId, week_id: weekId }).first();

        const payload = {
            id: menuId,
            siteId: targetSiteId,
            week_id: menuId, // Guarantees uniqueness on legacy databases where week_id is UNIQUE primary key
            data: JSON.stringify(data),
            updatedAt: new Date()
        };

        if (existing) {
            await db('canteen_menus').where({ id: existing.id || existing.week_id || menuId }).update(payload);
        } else {
            try {
                await db('canteen_menus').insert(payload);
            } catch (e) {
                await db('canteen_menus').insert({
                    week_id: menuId,
                    data: JSON.stringify(data),
                    updatedAt: new Date()
                });
            }
        }

        res.json({ success: true, message: `Menu enregistré pour la semaine ${weekId} (Site: ${targetSiteId})` });
    } catch (err) {
        console.error("Erreur POST /api/admin/canteen:", err);
        res.status(500).send("Erreur lors de la sauvegarde du menu de la cantine : " + err.message);
    }
});

// GET /api/player/media/metadata - Endpoint public/player pour récupérer les métadonnées Sozi d'un SVG
app.get('/api/player/media/metadata', async (req, res) => {
    try {
        const { filename, url } = req.query;
        let query = db('media');
        if (filename) query = query.where({ filename });
        else if (url) query = query.where({ url });
        else return res.status(400).send('Filename or URL required');
        
        const media = await query.first();
        if (!media) return res.status(404).send('Média non trouvé');
        res.json({ metadata: media.metadata });
    } catch (err) {
        console.error("Erreur GET /api/player/media/metadata:", err);
        res.status(500).send("Erreur serveur");
    }
});

// GET /api/player/canteen/current - Endpoint live pour les Players / Diaporamas
app.get('/api/player/canteen/current', async (req, res) => {
    try {
        const { deviceId, siteId: paramSiteId, weekId: paramWeekId } = req.query;
        let targetSiteId = (paramSiteId && paramSiteId !== 'undefined' && paramSiteId !== 'null') ? paramSiteId : null;

        if (deviceId && deviceId !== 'undefined' && deviceId !== 'null' && !targetSiteId) {
            const player = await db('players').where({ id: deviceId }).first();
            if (player) targetSiteId = player.siteId;
        }

        if (!targetSiteId) {
            const canteenRecord = await db('canteen_menus').first();
            if (canteenRecord && canteenRecord.siteId) {
                targetSiteId = canteenRecord.siteId;
            } else {
                const firstSite = await db('sites').first();
                targetSiteId = firstSite ? firstSite.id : 'site_paris';
            }
        }

        const currentWeekId = paramWeekId ? paramWeekId.replace('-W', '-') : getIsoWeekString(new Date());
        const menuId = `${targetSiteId}_${currentWeekId}`;

        const record = await db('canteen_menus').where({ id: menuId }).first()
                    || await db('canteen_menus').where({ week_id: menuId }).first()
                    || await db('canteen_menus').where({ siteId: targetSiteId, week_id: currentWeekId }).first()
                    || await db('canteen_menus').where({ week_id: currentWeekId }).first();

        if (record) {
            const dataObj = typeof record.data === 'string' ? JSON.parse(record.data) : record.data;
            res.json(dataObj);
        } else {
            res.json({});
        }
    } catch (err) {
        console.error("Erreur GET /api/player/canteen/current:", err);
        res.json({});
    }
});
// --- API PERSONNALISATION DES MODÈLES (Cantine, Réunion, etc.) ---

// GET /api/admin/templates - Récupérer tous les modèles disponibles pour le site de l'utilisateur
app.get('/api/admin/templates', authMiddleware, checkRole(['admin', 'editor']), async (req, res) => {
    try {
        const targetSiteId = req.user.siteId || null;
        
        let query = db('custom_templates');
        if (targetSiteId) {
            query = query.where(function() {
                this.where({ siteId: targetSiteId }).orWhereNull('siteId');
            });
        }
        
        const records = await query.select('*');
        
        const formatted = records.map(r => ({
            id: r.id,
            name: r.name || (r.isSystem ? 'Modèle Système' : 'Sans nom'),
            templateType: r.templateType,
            siteId: r.siteId,
            isActive: !!r.isActive,
            isSystem: !!r.isSystem,
            createdBy: r.createdBy,
            config: typeof r.config === 'string' ? JSON.parse(r.config) : r.config,
            updatedAt: r.updatedAt
        }));
        
        res.json(formatted);
    } catch (err) {
        console.error("Erreur GET /api/admin/templates:", err);
        res.status(500).send("Erreur lors du chargement des modèles.");
    }
});

// POST /api/admin/templates - Créer un nouveau modèle personnalisé
app.post('/api/admin/templates', authMiddleware, checkRole(['admin', 'editor']), async (req, res) => {
    try {
        const { name, templateType, config } = req.body;
        if (!name || !templateType) {
            return res.status(400).send("Nom et type de modèle requis.");
        }

        const targetSiteId = req.user.siteId || null;
        const templateId = `tpl_${templateType}_${Date.now()}`;

        const payload = {
            id: templateId,
            name: name.trim(),
            templateType: templateType,
            siteId: targetSiteId,
            config: typeof config === 'string' ? config : JSON.stringify(config),
            isActive: 0,
            isSystem: 0,
            createdBy: req.user.username,
            updatedAt: new Date().toISOString()
        };

        await db('custom_templates').insert(payload);
        res.json({ success: true, message: "Modèle créé avec succès.", templateId });
    } catch (err) {
        console.error("Erreur POST /api/admin/templates:", err);
        res.status(500).send("Erreur lors de la création du modèle.");
    }
});

// PUT /api/admin/templates/:id - Mettre à jour un modèle personnalisé ou système
app.put('/api/admin/templates/:id', authMiddleware, checkRole(['admin', 'editor']), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, config } = req.body;
        
        const existing = await db('custom_templates').where({ id }).first();
        if (!existing) {
            return res.status(404).send("Modèle non trouvé.");
        }

        // Si l'utilisateur est rattaché à un site et qu'il essaie de modifier un modèle global
        if (req.user.siteId && existing.siteId !== req.user.siteId) {
            return res.status(403).send("Vous ne pouvez pas modifier un modèle global.");
        }

        const payload = {
            updatedAt: new Date().toISOString()
        };
        if (name !== undefined) payload.name = name.trim();
        if (config !== undefined) payload.config = typeof config === 'string' ? config : JSON.stringify(config);

        await db('custom_templates').where({ id }).update(payload);
        checkSchedules(null, true);
        res.json({ success: true, message: "Modèle mis à jour avec succès." });
    } catch (err) {
        console.error("Erreur PUT /api/admin/templates/:id:", err);
        res.status(500).send("Erreur lors de la mise à jour du modèle.");
    }
});

// POST /api/admin/templates/:id/apply - Activer un modèle
app.post('/api/admin/templates/:id/apply', authMiddleware, checkRole(['admin', 'editor']), async (req, res) => {
    try {
        const { id } = req.params;
        
        const template = await db('custom_templates').where({ id }).first();
        if (!template) {
            return res.status(404).send("Modèle non trouvé.");
        }

        if (req.user.siteId && template.siteId && template.siteId !== req.user.siteId) {
            return res.status(403).send("Vous n'êtes pas autorisé à appliquer ce modèle.");
        }

        const type = template.templateType;
        const targetSiteId = req.user.siteId || template.siteId || null;

        await db.transaction(async trx => {
            if (targetSiteId) {
                await trx('custom_templates')
                    .where({ templateType: type, siteId: targetSiteId })
                    .update({ isActive: 0 });
            } else {
                await trx('custom_templates')
                    .where({ templateType: type })
                    .whereNull('siteId')
                    .update({ isActive: 0 });
            }

            await trx('custom_templates')
                .where({ id })
                .update({ isActive: 1 });
        });
        checkSchedules(null, true);
        res.json({ success: true, message: "Modèle appliqué avec succès." });
    } catch (err) {
        console.error("Erreur POST /api/admin/templates/:id/apply:", err);
        res.status(500).send("Erreur lors de l'application du modèle.");
    }
});

// DELETE /api/admin/templates/:id - Supprimer un modèle personnalisé
app.delete('/api/admin/templates/:id', authMiddleware, checkRole(['admin', 'editor']), async (req, res) => {
    try {
        const { id } = req.params;
        const template = await db('custom_templates').where({ id }).first();
        if (!template) {
            return res.status(404).send("Modèle non trouvé.");
        }

        if (template.isSystem) {
            return res.status(400).send("Impossible de supprimer un modèle système.");
        }

        if (req.user.siteId && template.siteId !== req.user.siteId) {
            return res.status(403).send("Vous n'êtes pas autorisé à supprimer ce modèle.");
        }

        if (template.isActive) {
            const type = template.templateType;
            const siteId = template.siteId;
            
            let fallback = await db('custom_templates')
                .where({ templateType: type, siteId, isSystem: 1 })
                .first()
                || await db('custom_templates')
                .where({ templateType: type, isSystem: 1 })
                .first()
                || await db('custom_templates')
                .where({ templateType: type })
                .whereNot({ id })
                .first();

            if (fallback) {
                await db('custom_templates').where({ id: fallback.id }).update({ isActive: 1 });
            }
        }

        await db('custom_templates').where({ id }).del();
        res.json({ success: true, message: "Modèle supprimé avec succès." });
    } catch (err) {
        console.error("Erreur DELETE /api/admin/templates/:id:", err);
        res.status(500).send("Erreur lors de la suppression du modèle.");
    }
});

// GET /api/admin/templates/:type - Récupérer le modèle actif pour un type donné (Rétrocompatibilité)
app.get('/api/admin/templates/:type', authMiddleware, checkRole(['admin', 'editor']), async (req, res) => {
    try {
        const { type } = req.params;
        const targetSiteId = req.user.siteId || null;

        let record = null;
        if (targetSiteId) {
            record = await db('custom_templates').where({ templateType: type, siteId: targetSiteId, isActive: 1 }).first();
        }

        if (!record) {
            record = await db('custom_templates').where({ templateType: type, siteId: null, isActive: 1 }).first();
        }

        if (!record) {
            record = await db('custom_templates').where({ templateType: type }).first();
        }

        if (record) {
            const configObj = typeof record.config === 'string' ? JSON.parse(record.config) : record.config;
            res.json({
                id: record.id,
                templateType: record.templateType,
                siteId: record.siteId,
                config: configObj,
                updatedAt: record.updatedAt
            });
        } else {
            res.json({ templateType: type, siteId: targetSiteId, config: {} });
        }
    } catch (err) {
        console.error("Erreur GET /api/admin/templates/:type:", err);
        res.status(500).send("Erreur lors de la récupération du modèle.");
    }
});

// POST /api/admin/templates/:type - Enregistrer / Mettre à jour le modèle actif pour le site (Rétrocompatibilité)
app.post('/api/admin/templates/:type', authMiddleware, checkRole(['admin', 'editor']), async (req, res) => {
    try {
        const { type } = req.params;
        const { config } = req.body;
        const targetSiteId = req.user.siteId || null;

        let template = null;
        if (targetSiteId) {
            template = await db('custom_templates').where({ templateType: type, siteId: targetSiteId, isActive: 1 }).first();
        }
        if (!template) {
            template = await db('custom_templates').where({ templateType: type, siteId: null, isActive: 1 }).first();
        }

        if (template) {
            await db('custom_templates').where({ id: template.id }).update({
                config: typeof config === 'string' ? config : JSON.stringify(config),
                updatedAt: new Date().toISOString()
            });
            checkSchedules(null, true);
            res.json({ success: true, message: "Modèle mis à jour avec succès.", templateId: template.id });
        } else {
            const templateId = `tpl_${type}_${Date.now()}`;
            await db('custom_templates').insert({
                id: templateId,
                name: 'Modèle Actif',
                templateType: type,
                siteId: targetSiteId,
                config: typeof config === 'string' ? config : JSON.stringify(config),
                isActive: 1,
                isSystem: 0,
                createdBy: req.user.username,
                updatedAt: new Date().toISOString()
            });
            checkSchedules(null, true);
            res.json({ success: true, message: "Modèle créé et appliqué avec succès.", templateId });
        }
    } catch (err) {
        console.error("Erreur POST /api/admin/templates/:type:", err);
        res.status(500).send("Erreur lors de l'enregistrement du modèle.");
    }
});

// GET /api/player/templates - Endpoint public pour récupérer les styles de modèles d'un site (Version Active)
app.get('/api/player/templates', async (req, res) => {
    try {
        const { siteId } = req.query;
        const targetSiteId = (siteId && siteId !== 'undefined' && siteId !== 'null') ? siteId : null;

        const result = {};

        for (const type of ['canteen', 'meeting']) {
            let activeTemplate = null;
            if (targetSiteId) {
                activeTemplate = await db('custom_templates')
                    .where({ templateType: type, siteId: targetSiteId, isActive: 1 })
                    .first();
            }

            if (!activeTemplate) {
                activeTemplate = await db('custom_templates')
                    .where({ templateType: type, siteId: null, isActive: 1 })
                    .first();
            }

            if (!activeTemplate) {
                activeTemplate = await db('custom_templates')
                    .where({ templateType: type })
                    .first();
            }

            if (activeTemplate) {
                const configObj = typeof activeTemplate.config === 'string' ? JSON.parse(activeTemplate.config) : activeTemplate.config;
                result[type] = configObj;
            } else {
                result[type] = {};
            }
        }

        res.json(result);
    } catch (err) {
        console.error("Erreur GET /api/player/templates:", err);
        res.json({});
    }
});
// --- API GESTION DES SALLES DE RÉUNION ET RÉUNIONS (AGENDA & GUIDANCE VISITEURS) ---

// 1. SALLES DE RÉUNION (Meeting Rooms)
app.get('/api/admin/meeting-rooms', authMiddleware, checkRole(['admin', 'editor', 'author', 'secretary']), async (req, res) => {
    try {
        let targetSiteId = req.user.siteId;
        if (req.user.role === 'admin' && req.query.siteId) {
            targetSiteId = req.query.siteId;
        }
        
        let query = db('meeting_rooms').select('*');
        if (targetSiteId) {
            query = query.where({ siteId: targetSiteId });
        }
        const rooms = await query.orderBy('name', 'asc');
        res.json(rooms);
    } catch (err) {
        res.status(500).send('Erreur lors de la récupération des salles : ' + err.message);
    }
});

app.post('/api/admin/meeting-rooms/upload', authMiddleware, checkRole(['admin', 'editor', 'secretary']), upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('Aucun fichier uploadé.');
        
        const roomsImgDir = path.join(__dirname, 'img', 'rooms');
        await fs.ensureDir(roomsImgDir);
        
        const destPath = path.join(roomsImgDir, req.file.filename);
        await fs.move(req.file.path, destPath);
        
        const fileUrl = `/img/rooms/${req.file.filename}`;
        res.json({ success: true, url: fileUrl });
    } catch (err) {
        res.status(500).send('Erreur lors du téléchargement de la photo : ' + err.message);
    }
});

app.post('/api/admin/meeting-rooms', authMiddleware, checkRole(['admin', 'editor', 'secretary']), async (req, res) => {
    try {
        const { id, name, capacity, location, color, siteId, photo } = req.body;
        if (!name) return res.status(400).send('Le nom de la salle est requis.');

        let targetSiteId = req.user.siteId;
        if (req.user.role === 'admin' && siteId) {
            targetSiteId = siteId;
        }
        if (!targetSiteId) {
            const firstSite = await db('sites').first();
            targetSiteId = firstSite ? firstSite.id : 'site_paris';
        }

        const roomId = id || `room_${Date.now()}`;
        const roomData = {
            id: roomId,
            name: name.trim(),
            siteId: targetSiteId,
            capacity: parseInt(capacity, 10) || 10,
            location: (location || '').trim(),
            color: color || '#3498db',
            photo: photo || ''
        };

        const existing = await db('meeting_rooms').where({ id: roomId }).first();
        if (existing) {
            await db('meeting_rooms').where({ id: roomId }).update(roomData);
        } else {
            await db('meeting_rooms').insert(roomData);
        }
        res.json({ success: true, room: roomData });
    } catch (err) {
        res.status(500).send('Erreur lors de la sauvegarde de la salle : ' + err.message);
    }
});

app.delete('/api/admin/meeting-rooms/:id', authMiddleware, checkRole(['admin', 'secretary']), async (req, res) => {
    try {
        const { id } = req.params;
        await db('meetings').where({ roomId: id }).del();
        await db('meeting_rooms').where({ id }).del();
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('Erreur lors de la suppression de la salle : ' + err.message);
    }
});

// 2. RÉUNIONS / AGENDA (Meetings)
app.get('/api/admin/meetings', authMiddleware, checkRole(['admin', 'editor', 'author', 'secretary']), async (req, res) => {
    try {
        const { date, siteId } = req.query;
        let targetSiteId = req.user.siteId;
        if (req.user.role === 'admin' && siteId) {
            targetSiteId = siteId;
        }

        let query = db('meetings').select('*');
        if (targetSiteId) {
            query = query.where({ siteId: targetSiteId });
        }
        if (date) {
            query = query.where('startTime', 'like', `${date}%`);
        }
        const meetings = await query.orderBy('startTime', 'asc');
        res.json(meetings);
    } catch (err) {
        res.status(500).send('Erreur lors de la récupération des réunions : ' + err.message);
    }
});

app.post('/api/admin/meetings', authMiddleware, checkRole(['admin', 'editor', 'author', 'secretary']), async (req, res) => {
    try {
        const { id, title, roomId, startTime, endTime, organizer, notes, siteId } = req.body;
        if (!title || !roomId || !startTime || !endTime) {
            return res.status(400).send('Titre, salle, heure de début et heure de fin sont requis.');
        }

        let targetSiteId = req.user.siteId;
        if (req.user.role === 'admin' && siteId) {
            targetSiteId = siteId;
        }
        if (!targetSiteId) {
            const room = await db('meeting_rooms').where({ id: roomId }).first();
            targetSiteId = room ? room.siteId : 'site_paris';
        }

        const meetingId = id || `mtg_${Date.now()}`;
        const payload = {
            id: meetingId,
            title: title.trim(),
            roomId,
            siteId: targetSiteId,
            organizer: (organizer || '').trim(),
            startTime,
            endTime,
            notes: (notes || '').trim(),
            status: 'confirmed',
            createdBy: req.user.username
        };

        const existing = await db('meetings').where({ id: meetingId }).first();
        if (existing) {
            await db('meetings').where({ id: meetingId }).update(payload);
        } else {
            await db('meetings').insert(payload);
        }
        res.json({ success: true, meeting: payload });
    } catch (err) {
        res.status(500).send('Erreur lors de la sauvegarde de la réunion : ' + err.message);
    }
});

app.delete('/api/admin/meetings/:id', authMiddleware, checkRole(['admin', 'editor', 'secretary']), async (req, res) => {
    try {
        const { id } = req.params;
        await db('meetings').where({ id }).del();
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('Erreur lors de la suppression de la réunion : ' + err.message);
    }
});

// 3. API LIVE POUR LES PLAYERS & PANNEAUX D'ORIENTATION DES VISITEURS
app.get('/api/player/meetings/today', async (req, res) => {
    try {
        const { deviceId, siteId: paramSiteId, date: paramDate } = req.query;
        let targetSiteId = (paramSiteId && paramSiteId !== 'undefined' && paramSiteId !== 'null') ? paramSiteId : null;

        if (deviceId && deviceId !== 'undefined' && deviceId !== 'null' && !targetSiteId) {
            const player = await db('players').where({ id: deviceId }).first();
            if (player) targetSiteId = player.siteId;
        }

        if (!targetSiteId) {
            const meetingRecord = await db('meetings').first();
            if (meetingRecord && meetingRecord.siteId) {
                targetSiteId = meetingRecord.siteId;
            } else {
                const firstSite = await db('sites').first();
                targetSiteId = firstSite ? firstSite.id : 'site_paris';
            }
        }

        const todayStr = paramDate || new Date().toISOString().split('T')[0];

        const rooms = await db('meeting_rooms').where({ siteId: targetSiteId }).orderBy('name', 'asc');
        const meetings = await db('meetings')
            .where({ siteId: targetSiteId })
            .where('startTime', 'like', `${todayStr}%`)
            .orderBy('startTime', 'asc');

        res.json({
            date: todayStr,
            siteId: targetSiteId,
            rooms,
            meetings
        });
    } catch (err) {
        console.error("Erreur API player meetings:", err);
        res.json({ rooms: [], meetings: [] });
    }
});

// --- API JEU DE DONNÉES DE DÉMONSTRATION (5 COLLÈGES) ---

// Helper pour connaître le statut du jeu de données de démo
app.get('/api/admin/system/demo-data/status', authMiddleware, checkRole(['admin']), async (req, res) => {
    try {
        const demoSitesCount = await db('sites').where('id', 'like', 'demo_%').count('id as count');
        const demoUsersCount = await db('users').where('email', 'like', '%@kikoo.ovh').count('id as count');
        const count = (demoSitesCount[0] ? demoSitesCount[0].count : 0) + (demoUsersCount[0] ? demoUsersCount[0].count : 0);
        res.json({ exists: count > 0, sitesCount: demoSitesCount[0] ? demoSitesCount[0].count : 0, usersCount: demoUsersCount[0] ? demoUsersCount[0].count : 0 });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Helper de suppression sélective des données démo uniquement
async function deleteDemoData() {
    const hasMeetings = await db.schema.hasTable('meetings');
    if (hasMeetings) await db('meetings').where('id', 'like', 'demo_%').orWhere('siteId', 'like', 'demo_%').del();

    const hasRooms = await db.schema.hasTable('meeting_rooms');
    if (hasRooms) await db('meeting_rooms').where('id', 'like', 'demo_%').orWhere('siteId', 'like', 'demo_%').del();

    const hasCanteen = await db.schema.hasTable('canteen_menus');
    if (hasCanteen) {
        const hasIdCol = await db.schema.hasColumn('canteen_menus', 'id');
        const hasSiteIdCol = await db.schema.hasColumn('canteen_menus', 'siteId');
        
        if (hasIdCol && hasSiteIdCol) {
            await db('canteen_menus').where('id', 'like', 'demo_%').orWhere('siteId', 'like', 'demo_%').del();
        } else if (hasSiteIdCol) {
            await db('canteen_menus').where('siteId', 'like', 'demo_%').del();
        } else if (hasIdCol) {
            await db('canteen_menus').where('id', 'like', 'demo_%').del();
        } else {
            await db('canteen_menus').where('week_id', 'like', 'demo_%').del();
        }
    }

    await db('playlists').where('id', 'like', 'demo_%').orWhere('siteId', 'like', 'demo_%').del();
    await db('players').where('id', 'like', 'demo_%').orWhere('siteId', 'like', 'demo_%').del();
    await db('users').where('email', 'like', '%@kikoo.ovh').orWhere('siteId', 'like', 'demo_%').del();
    await db('sites').where('id', 'like', 'demo_%').del();
}

// POST /api/admin/system/demo-data/generate - Générer le jeu de données conséquent (5 Collèges)
app.post('/api/admin/system/demo-data/generate', authMiddleware, checkRole(['admin']), async (req, res) => {
    try {
        await deleteDemoData();

        const generatedCredentials = [];
        const todayStr = new Date().toISOString().split('T')[0];

        const currentIsoWeek = getIsoWeekString(new Date());
        const dNext = new Date();
        dNext.setDate(dNext.getDate() + 7);
        const nextIsoWeek = getIsoWeekString(dNext);

        const colleges = [
            {
                id: 'demo_stexupery',
                name: 'Collège Antoine de Saint-Exupéry',
                desc: 'Établissement secondaire connecté - Site Principal',
                users: [
                    { username: 'chef.stexupery', role: 'cook', email: 'chef.stexupery@kikoo.ovh' },
                    { username: 'secretaire.stexupery', role: 'secretary', email: 'secretaire.stexupery@kikoo.ovh' },
                    { username: 'auteur.stexupery', role: 'author', email: 'auteur.stexupery@kikoo.ovh' }
                ],
                rooms: [
                    { id: 'demo_room_stex_1', name: 'Salle Le Petit Prince', capacity: 15, location: '1er Étage - Aile Ouest', color: '#3498db' },
                    { id: 'demo_room_stex_2', name: 'Amphithéâtre Aéropostale', capacity: 50, location: 'RDC Bâtiment A', color: '#9b59b6' }
                ],
                meetings: [
                    { id: 'demo_mtg_stex_1', title: 'Conseil de Classe 3ème A', roomId: 'demo_room_stex_1', startTime: `${todayStr}T09:00:00`, endTime: `${todayStr}T10:30:00`, organizer: 'M. le Principal', notes: 'Présence obligatoire des délégués' },
                    { id: 'demo_mtg_stex_2', title: 'Commission Cantine & Éco-Délégués', roomId: 'demo_room_stex_2', startTime: `${todayStr}T14:00:00`, endTime: `${todayStr}T15:30:00`, organizer: 'Chef Cuisinier', notes: 'Dégustation des nouveaux menus bio' }
                ],
                canteenCurrent: {
                    Lundi: { starter: 'Salade niçoise au thon', main: 'Sauté de dinde sauce crème & riz basmati', dessert: 'Tarte fine aux pommes' },
                    Mardi: { starter: 'Velouté de potiron maison', main: 'Filet de colin sauce oseille & brunoise de légumes', dessert: 'Éclair au chocolat' },
                    Mercredi: { starter: 'Carottes râpées bio & graines de courge', main: 'Lasagnes végétariennes aux épinards', dessert: 'Salade de fruits frais de saison' },
                    Jeudi: { starter: 'Taboulé oriental à la menthe', main: 'Poulet rôti de la ferme & frites croustillantes', dessert: 'Mousse au chocolat noir' },
                    Vendredi: { starter: 'Salade verte & croûtons à l\'ail', main: 'Pavé de saumon grillé & purée maison', dessert: 'Yaourt bio de producteurs locaux' }
                },
                canteenNext: {
                    Lundi: { starter: 'Concombres à la crème d\'aneth', main: 'Steak haché bouchère & coquillettes', dessert: 'Compote de pommes cannelle' },
                    Mardi: { starter: 'Salade piémontaise', main: 'Rôti de veau au jus & haricots verts', dessert: 'Flan pâtissier maison' },
                    Mercredi: { starter: 'Betteraves rouges en vinaigrette', main: 'Omelette aux fines herbes & salade', dessert: 'Fruit de saison' },
                    Jeudi: { starter: 'Céleri rémoulade', main: 'Sauté de porc aux pruneaux & riz', dessert: 'Tartelette aux fraises' },
                    Vendredi: { starter: 'Quiche aux poireaux', main: 'Dos de cabillaud au citron & riz pilaf', dessert: 'Fromage blanc & coulis' }
                }
            },
            {
                id: 'demo_curie',
                name: 'Collège Marie Curie',
                desc: 'Pôle scientifique & innovation numérique',
                users: [
                    { username: 'chef.curie', role: 'cook', email: 'chef.curie@kikoo.ovh' },
                    { username: 'secretaire.curie', role: 'secretary', email: 'secretaire.curie@kikoo.ovh' },
                    { username: 'prof.curie', role: 'author', email: 'prof.curie@kikoo.ovh' }
                ],
                rooms: [
                    { id: 'demo_room_curie_1', name: 'Laboratoire Radium', capacity: 12, location: '2ème Étage - Bâtiment Sciences', color: '#2ecc71' },
                    { id: 'demo_room_curie_2', name: 'Salle Nobel', capacity: 20, location: '1er Étage - Centre de Documentation', color: '#e67e22' }
                ],
                meetings: [
                    { id: 'demo_mtg_curie_1', title: 'Atelier Robotique & Concours Sciences', roomId: 'demo_room_curie_1', startTime: `${todayStr}T10:00:00`, endTime: `${todayStr}T12:00:00`, organizer: 'Mme Curie (Prof. Physique)', notes: 'Démonstration des robots Arduino' },
                    { id: 'demo_mtg_curie_2', title: 'Réunion Parents-Enseignants 4ème', roomId: 'demo_room_curie_2', startTime: `${todayStr}T16:30:00`, endTime: `${todayStr}T18:30:00`, organizer: 'Vie Scolaire', notes: 'Accueil café en salle Nobel' }
                ],
                canteenCurrent: {
                    Lundi: { starter: 'Salade de tomates & mozzarella', main: 'Escalope de dinde panée & haricots beurre', dessert: 'Brownie aux noix' },
                    Mardi: { starter: 'Soupe de poireaux & pommes de terre', main: 'Bourguignon de bœuf & purée', dessert: 'Crème dessert vanille' },
                    Mercredi: { starter: 'Macedoine de légumes', main: 'Raviolis au fromage & salade', dessert: 'Crumble aux poires' },
                    Jeudi: { starter: 'Salade cauchoise', main: 'Rôti de porc au thym & lentilles', dessert: 'Gâteau au citron' },
                    Vendredi: { starter: 'Friand au fromage', main: 'Filet de lieu noir & riz saucée provençale', dessert: 'Ile flottante' }
                },
                canteenNext: {
                    Lundi: { starter: 'Radis au beurre', main: 'Nuggets de poulet & frites', dessert: 'Yaourt nature bio' },
                    Mardi: { starter: 'Salade de gésiers', main: 'Sauté de dinde aux champignons & pâtes', dessert: 'Tarte aux prunes' },
                    Mercredi: { starter: 'Potage Saint-Germain', main: 'Tartiflette au reblochon & salade', dessert: 'Salade d\'oranges' },
                    Jeudi: { starter: 'Avocat vinaigrette', main: 'Couscous royal aux légumes', dessert: 'Semoule au lait' },
                    Vendredi: { starter: 'Salade niçoise', main: 'Soles meunières & pommes vapeur', dessert: 'Tarte aux abricots' }
                }
            },
            {
                id: 'demo_jverne',
                name: 'Collège Jules Verne',
                desc: 'Établissement international et découvertes',
                users: [
                    { username: 'chef.jverne', role: 'cook', email: 'chef.jverne@kikoo.ovh' },
                    { username: 'secretaire.jverne', role: 'secretary', email: 'secretaire.jverne@kikoo.ovh' }
                ],
                rooms: [
                    { id: 'demo_room_jverne_1', name: 'Salle Nautilus', capacity: 18, location: 'RDC Aile Océan', color: '#1abc9c' },
                    { id: 'demo_room_jverne_2', name: 'Salle Tour du Monde', capacity: 25, location: '2ème Étage', color: '#e74c3c' }
                ],
                meetings: [
                    { id: 'demo_mtg_jverne_1', title: 'Organisation Voyage Linguistique Angleterre', roomId: 'demo_room_jverne_2', startTime: `${todayStr}T11:00:00`, endTime: `${todayStr}T12:30:00`, organizer: 'Prof. d\'Anglais', notes: 'Distribution des passeports et consignes' }
                ],
                canteenCurrent: {
                    Lundi: { starter: 'Coleslaw maison', main: 'Fish & Chips à l\'anglaise & petits pois', dessert: 'Muffin aux myrtilles' },
                    Mardi: { starter: 'Gazpacho andalou', main: 'Paëlla valencienne au poulet & fruits de mer', dessert: 'Churros au sucre' },
                    Mercredi: { starter: 'Salade grecque (Feta & Olives)', main: 'Moussaka de bœuf & salade', dessert: 'Baklava aux amandes' },
                    Jeudi: { starter: 'Antipasti de légumes grillés', main: 'Pizza reine artisanale & salade verte', dessert: 'Tiramisu traditionnel' },
                    Vendredi: { starter: 'Salade asiatique aux germes de soja', main: 'Wok de nouilles & crevettes sautées', dessert: 'Perles de coco' }
                },
                canteenNext: {
                    Lundi: { starter: 'Salade strasbourgeoise', main: 'Choucroute garnie', dessert: 'Kugelhopf' },
                    Mardi: { starter: 'Bruschetta aux tomates', main: 'Risotto aux champignons', dessert: 'Panna cotta aux fruits rouges' },
                    Mercredi: { starter: 'Salade mexicaine', main: 'Chili con carne & riz', dessert: 'Donut glacé' },
                    Jeudi: { starter: 'Soupe à l\'oignon', main: 'Blanquette de veau & riz', dessert: 'Tarte Tatin' },
                    Vendredi: { starter: 'Salade scandinave', main: 'Pavé de saumon aneth & vapeur', dessert: 'Brioche perdue' }
                }
            },
            {
                id: 'demo_jmoulin',
                name: 'Collège Jean Moulin',
                desc: 'Établissement engagé & Citoyenneté',
                users: [
                    { username: 'chef.jmoulin', role: 'cook', email: 'chef.jmoulin@kikoo.ovh' },
                    { username: 'secretaire.jmoulin', role: 'secretary', email: 'secretaire.jmoulin@kikoo.ovh' }
                ],
                rooms: [
                    { id: 'demo_room_jmoulin_1', name: 'Salle Résistance', capacity: 16, location: '1er Étage Bâtiment Historique', color: '#34495e' },
                    { id: 'demo_room_jmoulin_2', name: 'Salle Clostermann', capacity: 40, location: 'RDC Grande Salle', color: '#f39c12' }
                ],
                meetings: [
                    { id: 'demo_mtg_jmoulin_1', title: 'Comité d\'Éducation à la Santé et la Citoyenneté (CESC)', roomId: 'demo_room_jmoulin_1', startTime: `${todayStr}T14:00:00`, endTime: `${todayStr}T16:00:00`, organizer: 'Infirmière Scolaire', notes: 'Bilan des actions de prévention' }
                ],
                canteenCurrent: {
                    Lundi: { starter: 'Salade maraîchère bio', main: 'Sauté de dinde aux poivrons & blé', dessert: 'Fromage de chèvre & pomme' },
                    Mardi: { starter: 'Soupe de poireaux local', main: 'Hachis parmentier maison & salade', dessert: 'Compote poire-vanille' },
                    Mercredi: { starter: 'Betteraves bio râpées', main: 'Galettes de sarrazin complète (Œuf/Fromage)', dessert: 'Crêpe au sucre' },
                    Jeudi: { starter: 'Salade de lentilles du Puy', main: 'Saucisse de Toulouse & purée maison', dessert: 'Tarte aux poires' },
                    Vendredi: { starter: 'Terrine de poisson faite maison', main: 'Filet de merlu & riz de Camargue', dessert: 'Yaourt nature fermier' }
                },
                canteenNext: {
                    Lundi: { starter: 'Salade verte bio', main: 'Rôti de dinde & pommes rissolées', dessert: 'Poire au sirop' },
                    Mardi: { starter: 'Velouté de carottes', main: 'Sauté de bœuf & coquillettes', dessert: 'Crème chocolat' },
                    Mercredi: { starter: 'Radis & beurre bio', main: 'Quiche lorraine & salade', dessert: 'Fruit frais' },
                    Jeudi: { starter: 'Salade composée', main: 'Poulet rôti & haricots vert', dessert: 'Flan aux œufs' },
                    Vendredi: { starter: 'Salade de thon', main: 'Dos de cabillaud & riz', dessert: 'Gâteau basque' }
                }
            },
            {
                id: 'demo_peluard',
                name: 'Collège Paul Éluard',
                desc: 'Établissement des Arts, Culture et Poésie',
                users: [
                    { username: 'chef.peluard', role: 'cook', email: 'chef.peluard@kikoo.ovh' },
                    { username: 'secretaire.peluard', role: 'secretary', email: 'secretaire.peluard@kikoo.ovh' }
                ],
                rooms: [
                    { id: 'demo_room_peluard_1', name: 'Salle Liberté', capacity: 14, location: '1er Étage - Aile Arts', color: '#d35400' },
                    { id: 'demo_room_peluard_2', name: 'Salle Poésie', capacity: 10, location: '2ème Étage', color: '#8e44ad' }
                ],
                meetings: [
                    { id: 'demo_mtg_peluard_1', title: 'Préparation du Printemps des Poètes', roomId: 'demo_room_peluard_1', startTime: `${todayStr}T15:00:00`, endTime: `${todayStr}T17:00:00`, organizer: 'Prof. de Lettres & Arts', notes: 'Exposition des œuvres des 5ème' }
                ],
                canteenCurrent: {
                    Lundi: { starter: 'Salade de jeunes pousses & noix', main: 'Filet de poulet rôti & gratin dauphinois', dessert: 'Tartelette aux framboises' },
                    Mardi: { starter: 'Potage de potimarron aux châtaignes', main: 'Rôti de porc aux pommes & purée', dessert: 'Fondant au chocolat' },
                    Mercredi: { starter: 'Salade d\'endives aux noix', main: 'Gnocchis au pesto & parmesan', dessert: 'Tiramisu spéculoos' },
                    Jeudi: { starter: 'Salade niçoise', main: 'Sauté de veau marengo & riz', dessert: 'Tarte aux myrtilles' },
                    Vendredi: { starter: 'Salade de crevettes à l\'avocat', main: 'Pavé de truite & fondue de poireaux', dessert: 'Panna cotta mangue' }
                },
                canteenNext: {
                    Lundi: { starter: 'Carottes bio râpées', main: 'Sauté de dinde & pâtes', dessert: 'Pomme bio' },
                    Mardi: { starter: 'Soupe de légumes', main: 'Steak haché & frites maison', dessert: 'Profiteroles' },
                    Mercredi: { starter: 'Salade verte', main: 'Pizza margherita & salade', dessert: 'Compote pomme-fraise' },
                    Jeudi: { starter: 'Salade maraîchère', main: 'Poulet rôti & petits pois', dessert: 'Tarte normande' },
                    Vendredi: { starter: 'Salade de macaronis', main: 'Filet de colin & riz pilaf', dessert: 'Yaourt aux fruits' }
                }
            }
        ];

        for (const col of colleges) {
            await db('sites').insert({ id: col.id, name: col.name, description: col.desc })
                .onConflict('id').merge();

            for (const u of col.users) {
                const userPassword = generateStrongPassword(10);
                const userPasswordHash = await bcrypt.hash(userPassword, saltRounds);
                await db('users').insert({
                    username: u.username,
                    password: userPasswordHash,
                    role: u.role,
                    email: u.email,
                    siteId: col.id
                }).onConflict('username').merge();

                generatedCredentials.push({
                    college: col.name,
                    username: u.username,
                    password: userPassword,
                    role: u.role
                });
            }

            for (const r of col.rooms) {
                await db('meeting_rooms').insert({
                    id: r.id,
                    name: r.name,
                    siteId: col.id,
                    capacity: r.capacity,
                    location: r.location,
                    color: r.color
                }).onConflict('id').merge();
            }

            for (const m of col.meetings) {
                await db('meetings').insert({
                    id: m.id,
                    title: m.title,
                    roomId: m.roomId,
                    siteId: col.id,
                    organizer: m.organizer,
                    startTime: m.startTime,
                    endTime: m.endTime,
                    notes: m.notes,
                    status: 'confirmed',
                    createdBy: 'secretaire'
                }).onConflict('id').merge();
            }

            const upsertCanteenMenu = async (payload) => {
                const uniqueWeekKey = payload.id; // Format: siteId_weekId (e.g. demo_curie_2026-30)
                const payloadWithUniqueKey = { ...payload, week_id: uniqueWeekKey };

                try {
                    const existing = await db('canteen_menus').where({ id: payload.id }).first()
                                 || await db('canteen_menus').where({ week_id: uniqueWeekKey }).first()
                                 || await db('canteen_menus').where({ siteId: payload.siteId, week_id: payload.week_id }).first();
                    if (existing) {
                        await db('canteen_menus').where({ id: existing.id || existing.week_id || payload.id }).update(payloadWithUniqueKey);
                    } else {
                        await db('canteen_menus').insert(payloadWithUniqueKey);
                    }
                } catch (e) {
                    await db('canteen_menus').insert({
                        week_id: uniqueWeekKey,
                        data: payload.data,
                        updatedAt: payload.updatedAt
                    });
                }
            };

            await upsertCanteenMenu({
                id: `${col.id}_${currentIsoWeek}`,
                siteId: col.id,
                week_id: currentIsoWeek,
                data: JSON.stringify(col.canteenCurrent),
                updatedAt: new Date()
            });

            await upsertCanteenMenu({
                id: `${col.id}_${nextIsoWeek}`,
                siteId: col.id,
                week_id: nextIsoWeek,
                data: JSON.stringify(col.canteenNext),
                updatedAt: new Date()
            });

            const playlistId = `demo_p_${col.id}`;
            const playlistItems = [
                {
                    duration: 10000,
                    backgroundColor: '#1a252f',
                    template: 'canteen',
                    data: { title: `MENU CANTINE - ${col.name.toUpperCase()}`, useLiveMenu: true }
                },
                {
                    duration: 10000,
                    backgroundColor: '#2c3e50',
                    template: 'meeting',
                    data: { room: 'Salle Principale', useLiveMeeting: true }
                }
            ];

            await db('playlists').insert({
                id: playlistId,
                name: `Playlist Démo - ${col.name}`,
                items: JSON.stringify(playlistItems),
                siteId: col.id,
                createdBy: 'admin'
            }).onConflict('id').merge();

            const playerId = `demo_screen_${col.id}`;
            await db('players').insert({
                id: playerId,
                name: `Écran Accueil (${col.name})`,
                status: 'approved',
                siteId: col.id,
                manualPlaylistId: playlistId,
                lastSeen: new Date(),
                downloadStatus: '{}'
            }).onConflict('id').merge();
        }

        console.log("✅ Jeu de données démo (5 Collèges) généré avec succès.");
        res.json({ 
            success: true, 
            message: "Jeu de données démo (5 Collèges) créé avec succès !",
            credentials: generatedCredentials
        });
    } catch (err) {
        console.error("Erreur génération demo data:", err);
        res.status(500).send("Erreur lors de la génération du jeu de données : " + err.message);
    }
});

// DELETE /api/admin/system/demo-data/clear - Supprimer exclusivement le jeu de données démo
app.delete('/api/admin/system/demo-data/clear', authMiddleware, checkRole(['admin']), async (req, res) => {
    try {
        await deleteDemoData();
        console.log("🧹 Jeu de données démo (5 Collèges) supprimé. Données de tests intactes.");
        res.json({ success: true, message: "Jeu de données de démonstration supprimé. Vos autres données de tests sont intactes." });
    } catch (err) {
        console.error("Erreur suppression demo data:", err);
        res.status(500).send("Erreur lors de la suppression du jeu de données démo : " + err.message);
    }
});

// Génération de Code QR locale et offline-safe
app.get('/api/admin/qrcode', authMiddleware, checkRole(['admin', 'editor', 'author', 'player']), async (req, res) => {
    const { text } = req.query;
    if (!text) return res.status(400).send('Paramètre text manquant.');
    try {
        const buffer = await QRCode.toBuffer(text, { type: 'png', width: 512, margin: 1 });
        res.set('Content-Type', 'image/png');
        res.send(buffer);
    } catch (err) {
        res.status(500).send('Erreur génération QR Code : ' + err.message);
    }
});
async function sendNotificationEmail(subject, text, html, siteId = null) {
    if (!EMAIL_NOTIFICATIONS_ENABLED || !SMTP_HOST) return;

    const recipients = new Set();
    if (NOTIFICATION_EMAIL) recipients.add(NOTIFICATION_EMAIL);

    if (siteId) {
        try {
            const siteUsers = await db('users').where({ siteId }).select('email');
            siteUsers.forEach(u => {
                if (u.email && u.email.trim() !== '') {
                    recipients.add(u.email.trim());
                }
            });
        } catch (e) {
            console.error("Erreur lors de la récupération des e-mails du site :", e.message);
        }
    }

    if (recipients.size === 0) return;

    const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: parseInt(SMTP_PORT, 10),
        secure: parseInt(SMTP_PORT, 10) === 465, // SSL sur 465, TLS ailleurs
        auth: {
            user: SMTP_USER,
            pass: SMTP_PASS
        }
    });

    const toList = Array.from(recipients).join(', ');

    try {
        await transporter.sendMail({
            from: `"PiDyn System" <${SMTP_USER}>`,
            to: toList,
            subject: subject,
            text: text,
            html: html
        });
        console.log(`📧 Notification courriel envoyée à [${toList}] : "${subject}"`);
    } catch (error) {
        console.error("❌ Échec de l'envoi de la notification courriel :", error.message);
    }
}

async function checkOfflinePlayers() {
    if (!NOTIFY_PLAYER_OFFLINE && !NOTIFY_PLAYER_ONLINE) return;

    try {
        const players = await db('players').select('*');
        const now = new Date();

        for (const player of players) {
            const isConnected = io.sockets.adapter.rooms.has(player.id); // check if the room exists/has connections

            if (isConnected) {
                // Si l'afficheur est connecté et qu'on avait envoyé une alerte de déconnexion
                if (player.offlineAlertSent) {
                    await db('players').where({ id: player.id }).update({ offlineAlertSent: false });
                    
                    if (NOTIFY_PLAYER_ONLINE) {
                        const subject = `🟢 Écran rétabli : ${player.name}`;
                        const text = `L'afficheur d'affichage dynamique "${player.name}" (ID: ${player.id}) est de nouveau en ligne.\n\nDate de reconnexion : ${now.toLocaleString()}`;
                        const html = `<h3>🟢 Écran de nouveau en ligne</h3>
                                     <p>L'afficheur d'affichage dynamique <b>${player.name}</b> (ID: <code>${player.id}</code>) s'est reconnecté avec succès.</p>
                                     <p><b>Date de reconnexion :</b> ${now.toLocaleString()}</p>`;
                        await sendNotificationEmail(subject, text, html, player.siteId);
                    }
                }
            } else {
                // Si l'afficheur est déconnecté
                if (player.lastSeen) {
                    const elapsedMinutes = Math.floor((now - new Date(player.lastSeen)) / 1000 / 60);

                    // Si le délai d'alerte est dépassé et qu'on n'a pas encore envoyé d'alerte
                    if (elapsedMinutes >= OFFLINE_ALERT_DELAY && !player.offlineAlertSent) {
                        await db('players').where({ id: player.id }).update({ offlineAlertSent: true });

                        if (NOTIFY_PLAYER_OFFLINE) {
                            const subject = `🔴 Écran hors-ligne : ${player.name}`;
                            const text = `L'afficheur d'affichage dynamique "${player.name}" (ID: ${player.id}) est hors-ligne.\n\nDernière vue : ${new Date(player.lastSeen).toLocaleString()} (soit il y a ${elapsedMinutes} minutes).`;
                            const html = `<h3>🔴 Écran hors-ligne détecté</h3>
                                         <p>L'afficheur d'affichage dynamique <b>${player.name}</b> (ID: <code>${player.id}</code>) ne répond plus.</p>
                                         <p><b>Dernière vue :</b> ${new Date(player.lastSeen).toLocaleString()} (soit il y a ${elapsedMinutes} minutes).</p>
                                         <p><i>Veuillez vérifier l'alimentation et la connexion réseau de l'appareil.</i></p>`;
                            await sendNotificationEmail(subject, text, html, player.siteId);
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.error("❌ Erreur lors de la vérification des écrans hors-ligne :", err.message);
    }
}

let lastScreenshotTimes = {};
async function triggerPeriodicScreenshots() {
    if (!PERIODIC_SCREENSHOT_ENABLED) return;

    try {
        const intervalMs = (parseInt(PERIODIC_SCREENSHOT_INTERVAL, 10) || 5) * 60 * 1000;
        const now = Date.now();

        const activeLimit = new Date(Date.now() - 60000);
        const players = await db('players').where('lastSeen', '>', activeLimit);

        for (const player of players) {
            const lastTime = lastScreenshotTimes[player.id] || 0;
            if (now - lastTime >= intervalMs) {
                io.to(player.id).emit('request-screenshot');
                console.log(`📸 [PÉRIODIQUE] Demande de capture automatique envoyée à ${player.id}`);
                lastScreenshotTimes[player.id] = now;
            }
        }
    } catch (err) {
        console.error("❌ Erreur lors de la capture périodique :", err.message);
    }
}

app.post('/api/admin/test-email', authMiddleware, checkRole(['admin']), async (req, res) => {
    const { smtpHost, smtpPort, smtpUser, smtpPass, notificationEmail } = req.body;
    
    const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(smtpPort),
        secure: parseInt(smtpPort) === 465, // SSL sur 465, TLS ailleurs
        auth: {
            user: smtpUser,
            pass: smtpPass
        }
    });

    try {
        await transporter.sendMail({
            from: `"PiDyn System" <${smtpUser}>`,
            to: notificationEmail,
            subject: "Test de notification PiDyn",
            text: "Ceci est un mail de test envoyé depuis votre serveur d'affichage dynamique PiDyn.",
            html: "<b>Ceci est un mail de test</b> envoyé depuis votre serveur d'affichage dynamique PiDyn."
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// API Admin : Outil de sauvegarde (Export ZIP)
app.get('/api/admin/backup', authMiddleware, checkRole(['admin']), async (req, res) => {
    const excludeMedia = req.query.excludeMedia === 'true';
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

        // 2. Ajout de la médiathèque physique si non exclue
        if (!excludeMedia && fs.existsSync(MEDIA_DIR)) {
            zip.addLocalFolder(MEDIA_DIR, "media");
        }

        const tempFilePath = path.join(__dirname, `temp_backup_${Date.now()}.zip`);
        zip.writeZip(tempFilePath);

        res.download(tempFilePath, excludeMedia ? `backup_light_pidyn_${Date.now()}.zip` : `backup_pidyn_${Date.now()}.zip`, async (err) => {
            try {
                if (fs.existsSync(tempFilePath)) {
                    await fs.remove(tempFilePath);
                }
            } catch (cleanupErr) {
                console.error("Erreur nettoyage backup temporaire:", cleanupErr);
            }
            if (err && !res.headersSent) {
                console.error("Erreur lors de l'envoi de la sauvegarde:", err);
            }
        });
    } catch (error) {
        console.error("Erreur lors de la sauvegarde :", error);
        res.status(500).send("Erreur lors de la génération de la sauvegarde : " + error.message);
    }
});

app.post('/api/admin/restore', authMiddleware, checkRole(['admin']), upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send('Aucun fichier fourni.');

    try {
        const zip = new AdmZip(req.file.path);
        
        // 1. Extraction de la base de données (écrase l'existante)
        // Note: Sur Windows, le fichier peut être verrouillé. Le process.exit() aidera au redémarrage.
        const dbDir = path.dirname(SQLITE_DB_PATH);
        zip.extractEntryTo("pidyn.sqlite", dbDir, false, true);

        // 2. Extraction des médias
        // Le ZIP contient un dossier "media/", on l'extrait vers le dossier parent de MEDIA_DIR
        const mediaParentDir = path.dirname(MEDIA_DIR);
        zip.extractEntryTo("media/", mediaParentDir, true, true);

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

app.post('/api/admin/players/reboot/:deviceId', authMiddleware, checkRole(['admin']), (req, res) => {
    const { deviceId } = req.params;
    db('players').where({ id: deviceId }).first()
        .then(player => {
            if (player) {
                io.to(deviceId).emit('reboot-device');
                console.log(`📡 Commande de redémarrage système envoyée à ${deviceId}`);
                res.json({ success: true, message: 'Commande de redémarrage système envoyée.' });
            } else {
                res.status(404).send('Player non trouvé');
            }
        })
        .catch(err => res.status(500).send('Error rebooting system: ' + err.message));
});

app.post('/api/admin/players/screenshot/:deviceId', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { deviceId } = req.params;
    db('players').where({ id: deviceId }).first()
        .then(player => {
            if (player) {
                io.to(deviceId).emit('request-screenshot');
                console.log(`📸 Demande de capture envoyée à ${deviceId}`);
                res.json({ success: true });
            } else {
                res.status(404).send('Player non trouvé');
            }
        })
        .catch(err => res.status(500).send('Error sending screenshot command: ' + err.message));
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
        .then(async (count) => {
            if (count > 0) {
                io.sockets.sockets.forEach(socket => {
                    if (socket.handshake.query.deviceId === deviceId) socket.disconnect(true);
                });
                await db('schedules').where({ deviceId }).del();
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

app.post('/api/admin/players/:deviceId/volume', authMiddleware, checkRole(['admin', 'editor']), (req, res) => {
    const { deviceId } = req.params;
    const { volume } = req.body;
    db('players').where({ id: deviceId }).update({ volume })
        .then((count) => {
            if (count > 0) {
                io.to(deviceId).emit('volume-change', { volume });
                console.log(`📡 Commande de volume envoyée à ${deviceId} : ${volume}%`);
                res.json({ success: true });
            } else {
                res.status(404).send('Player non trouvé');
            }
        })
        .catch(err => res.status(500).send('Error updating volume: ' + err.message));
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
    const authHeader = socket.handshake.auth.token || socket.handshake.auth.apiKey; // Peut être API_KEY ou JWT
    const deviceId = socket.handshake.query.deviceId;

    // Authentification pour les clients Pi / Windows / Linux (API Key)
    if (authHeader === API_KEY) return next();

    // Authentification pour les clients Admin (JWT)
    if (authHeader) {
        // Gestion optionnelle du préfixe Bearer
        const token = (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) ? authHeader.split(' ')[1] : authHeader;

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            socket.user = decoded; // Attacher les infos utilisateur au socket
            return next();
        } catch (err) {
            if (deviceId) {
                console.warn(`[SOCKET] Clé API invalide ou malformée fournie par "${deviceId}" (${socket.handshake.address})`);
            } else {
                console.error(`[SOCKET] Échec auth JWT: ${err.message}`);
            }
            return next(new Error('Auth error: Invalid or expired token'));
        }
    }
    console.warn(`[SOCKET] Tentative de connexion sans authentification valide de ${socket.handshake.address}`);
    next(new Error('Auth error'));
});

io.on('connection', async (socket) => {
    const deviceId = socket.handshake.query.deviceId;

    // Autoriser les connexions provenant de l'interface d'administration (Admin/Editor)
    if (socket.user) {
        console.log(`[SOCKET] Interface Admin connectée (Utilisateur: ${socket.user.username})`);
        
        // Relayer les demandes de logs de l'admin
        socket.on('admin-request-logs', (data) => {
            console.log(`[SOCKET] Demande de logs reçue de l'admin pour le client ${data.deviceId}`);
            io.to(data.deviceId).emit('request-logs');
        });
        
        return; // Les admins n'ont pas besoin des listeners spécifiques aux "Players" ci-dessous
    }

    // Pour les Players (Raspberry Pi), le deviceId est obligatoire
    if (!deviceId || deviceId === 'undefined' || deviceId === 'null') {
        console.error(`[SOCKET] Connexion refusée : deviceId manquant ou invalide pour le socket ${socket.id}`);
        return socket.disconnect(true);
    }

    console.log(`Player connecté : ${deviceId}`);
    
    socket.join(deviceId);
    
    let defaultName = `Nouveau Client (${deviceId})`;
    const devLower = deviceId.toLowerCase();
    if (devLower.includes('win') || devLower.includes('pc') || devLower.includes('stick')) {
        defaultName = `Nouveau PC Windows (${deviceId})`;
    } else if (devLower.includes('linux') || devLower.includes('mint')) {
        defaultName = `Nouveau PC Linux (${deviceId})`;
    } else if (devLower.includes('pi') || devLower.includes('rpi')) {
        defaultName = `Nouveau Pi (${deviceId})`;
    }

    const lastSeen = new Date();
    db('players').insert({ id: deviceId, name: defaultName, status: 'pending', lastSeen, downloadStatus: '{}' })
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

    // Relayer la capture d'écran reçue du client vers l'interface Admin et l'enregistrer
    socket.on('screenshot-taken', (data) => {
        console.log(`✅ Capture d'écran reçue de ${data.deviceId} et relayée aux admins`);
        db('players').where({ id: data.deviceId }).update({ latestScreenshot: data.image })
            .then(() => {
                io.emit('screenshot-taken', data);
            })
            .catch(err => console.error("Error saving player screenshot:", err));
    });

    socket.on('logs-response', (data) => {
        console.log(`[SOCKET] Logs reçus du client ${data.deviceId}, relais vers l'admin`);
        io.emit('admin-logs-response', data);
    });

    // Gérer les mises à jour de statut de téléchargement
    socket.on('player-status-update', async (status) => {
        try {
            await db('players').where({ id: deviceId }).update({ downloadStatus: JSON.stringify(status) });
            
            if (status.downloading === false) {
                if (status.error) {
                    console.error(`⚠️ Afficheur ${deviceId} a rencontré une erreur de synchro: ${status.error}`);
                    
                    if (NOTIFY_TECH_ALERT) {
                        const player = await db('players').where({ id: deviceId }).first();
                        const subject = `⚠️ Erreur de synchronisation : ${player ? player.name : deviceId}`;
                        const text = `L'afficheur "${player ? player.name : deviceId}" (ID: ${deviceId}) signale une erreur de téléchargement / synchronisation :\n\nMessage : ${status.error}`;
                        const html = `<h3>⚠️ Alerte Technique : Échec de synchronisation</h3>
                                     <p>L'afficheur <b>${player ? player.name : deviceId}</b> (ID: <code>${deviceId}</code>) a rencontré une erreur lors de la mise à jour de son contenu :</p>
                                     <p style="color: #e74c3c; font-family: monospace; background: #f9f9f9; padding: 10px; border-left: 3px solid #e74c3c;">${status.error}</p>
                                     <p><i>Veuillez vérifier que tous les fichiers médias réfécérencieux dans la playlist sont accessibles et valides sur le CMS.</i></p>`;
                        await sendNotificationEmail(subject, text, html, player ? player.siteId : null);
                    }
                } else {
                    console.log(`✅ Afficheur ${deviceId} synchronisé avec succès.`);
                }
            }
            io.emit('admin-player-status', { deviceId, status });
        } catch (err) {
            console.error(`Error updating download status for ${deviceId}:`, err);
        }
    });

    // Mise à jour des infos réseau (IP/MAC), plateforme et télémétrie de santé
    socket.on('player-info-update', async (info) => {
        try {
            const player = await db('players').where({ id: deviceId }).first();
            const updateData = {
                ip: info.ip,
                mac: info.mac,
                wifiSSID: info.ssid,
                wifiSignal: info.signal
            };

            if (info.totalMem !== undefined) updateData.totalMem = info.totalMem;
            if (info.freeMem !== undefined) updateData.freeMem = info.freeMem;
            if (info.diskTotal !== undefined) updateData.diskTotal = info.diskTotal;
            if (info.diskFree !== undefined) updateData.diskFree = info.diskFree;
            if (info.cpuTemp !== undefined) updateData.cpuTemp = info.cpuTemp;
            if (info.screenResolution !== undefined) updateData.screenResolution = info.screenResolution;

            // Mettre à jour le nom par défaut si le nom contient la valeur initiale générique "Nouveau Pi" / "Nouveau Client"
            if (player && (player.name.startsWith('Nouveau Pi') || player.name.startsWith('Nouveau Client') || player.name.startsWith('Nouveau PC')) && info.platform) {
                updateData.name = `Client ${info.platform} (${deviceId})`;
            }

            await db('players').where({ id: deviceId }).update(updateData);
            io.emit('admin-player-status', { deviceId, status: { health: updateData } });
            console.log(`Player ${deviceId} info updated: IP=${info.ip} | RAM: ${info.freeMem}/${info.totalMem}MB | Disk: ${info.diskFree}/${info.diskTotal}GB | Temp: ${info.cpuTemp || 'N/A'}°C`);
        } catch (err) {
            console.error(`Error updating player info for ${deviceId}:`, err);
        }
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


// Fonction pour envoyer des notifications Webhook (Slack, Discord, Teams, Custom)
async function sendWebhookNotification(webhookUrl, title, message, color = 0x3498db) {
    if (!webhookUrl) return;
    try {
        let payload = {};
        if (webhookUrl.includes('discord.com')) {
            payload = {
                embeds: [{
                    title: title,
                    description: message,
                    color: color,
                    timestamp: new Date().toISOString()
                }]
            };
        } else if (webhookUrl.includes('slack.com')) {
            payload = {
                text: `*${title}*\n${message}`
            };
        } else if (webhookUrl.includes('office.com') || webhookUrl.includes('teams')) {
            payload = {
                "@type": "MessageCard",
                "@context": "http://schema.org/extensions",
                "summary": title,
                "themeColor": color.toString(16),
                "title": title,
                "text": message
            };
        } else {
            payload = { title, message, timestamp: new Date().toISOString() };
        }

        await axios.post(webhookUrl, payload, { timeout: 5000 });
        console.log(`🔔 Notification Webhook envoyée à ${webhookUrl}`);
    } catch (e) {
        console.error(`⚠️ Erreur envoi Webhook vers ${webhookUrl}:`, e.message);
    }
}

// Worker de surveillance de la santé des écrans et alertes de déconnexion
const checkHealthAndNotifications = async () => {
    try {
        const settings = await db('settings').select('*');
        const enableAlertsSetting = settings.find(s => s.key === 'enable_health_notifications');
        const enableAlerts = enableAlertsSetting ? enableAlertsSetting.value === 'true' : false;
        
        if (!enableAlerts) return;

        const webhookUrlSetting = settings.find(s => s.key === 'health_webhook_url');
        const webhookUrl = webhookUrlSetting ? webhookUrlSetting.value : '';
        if (!webhookUrl) return;

        const offlineThresholdSetting = settings.find(s => s.key === 'health_offline_threshold_minutes');
        const thresholdMinutes = offlineThresholdSetting ? (parseInt(offlineThresholdSetting.value) || 10) : 10;
        const thresholdMs = thresholdMinutes * 60 * 1000;

        const players = await db('players').where({ status: 'approved' });
        const now = new Date();

        for (const player of players) {
            if (!player.lastSeen) continue;
            const lastSeenDate = new Date(player.lastSeen);
            const isOffline = (now - lastSeenDate) > thresholdMs;

            const lastAlertDate = player.lastHealthAlertSent ? new Date(player.lastHealthAlertSent) : null;
            const canSendAlert = !lastAlertDate || (now - lastAlertDate) > (15 * 60 * 1000);

            if (isOffline && canSendAlert) {
                const title = `🚨 Alerte Écran Hors-Ligne : ${player.name}`;
                const message = `L'écran **${player.name}** (ID: \`${player.id}\`, IP: ${player.ip || 'Inconnue'}) ne répond plus depuis plus de ${thresholdMinutes} minutes (Dernière connexion: ${lastSeenDate.toLocaleString()}).`;
                
                await sendWebhookNotification(webhookUrl, title, message, 0xe74c3c);
                await db('players').where({ id: player.id }).update({ lastHealthAlertSent: now.toISOString() });
            }
        }
    } catch (e) {
        console.error("Erreur worker checkHealthAndNotifications:", e.message);
    }
};

setInterval(checkHealthAndNotifications, 2 * 60 * 1000);

// Endpoint de test Webhook
app.post('/api/admin/system/test-webhook', authMiddleware, checkRole(['admin']), async (req, res) => {
    const { webhookUrl } = req.body;
    if (!webhookUrl) return res.status(400).send('URL Webhook manquante');
    
    try {
        await sendWebhookNotification(
            webhookUrl, 
            "🔔 Test de Notification OmniSign", 
            "Ceci est un message de test envoyé depuis le serveur OmniSign. Les notifications de santé et de déconnexion sont correctement configurées !",
            0x2ecc71
        );
        res.json({ success: true, message: 'Notification Webhook de test envoyée avec succès.' });
    } catch (e) {
        res.status(500).send('Erreur lors de l\'envoi du Webhook test : ' + e.message);
    }
});

// Worker de surveillance et génération des sauvegardes automatiques
async function runAutoBackupCheck() {
    try {
        const settings = await db('settings').select('*');
        const enabledSetting = settings.find(s => s.key === 'autoBackupEnabled');
        const enabled = enabledSetting ? enabledSetting.value === 'true' : false;
        if (!enabled) return;

        const frequencySetting = settings.find(s => s.key === 'autoBackupFrequency');
        const frequency = frequencySetting ? frequencySetting.value : 'weekly'; // daily, weekly, monthly

        const excludeMediaSetting = settings.find(s => s.key === 'autoBackupExcludeMedia');
        const excludeMedia = excludeMediaSetting ? excludeMediaSetting.value !== 'false' : true;

        const keepCountSetting = settings.find(s => s.key === 'autoBackupKeepCount');
        const keepCount = keepCountSetting ? (parseInt(keepCountSetting.value, 10) || 7) : 7;

        const lastBackupSetting = settings.find(s => s.key === 'lastAutoBackupTime');
        const lastBackupTime = lastBackupSetting && lastBackupSetting.value ? new Date(lastBackupSetting.value) : null;

        const now = new Date();

        // Vérifier si un backup est dû
        let isDue = false;
        if (!lastBackupTime) {
            isDue = true;
        } else {
            const diffMs = now - lastBackupTime;
            const diffDays = diffMs / (24 * 60 * 60 * 1000);

            if (frequency === 'daily') {
                if (diffDays >= 0.95) isDue = true;
            } else if (frequency === 'weekly') {
                if (diffDays >= 6.9) isDue = true;
            } else if (frequency === 'monthly') {
                if (now.getMonth() !== lastBackupTime.getMonth() || now.getFullYear() !== lastBackupTime.getFullYear()) {
                    isDue = true;
                }
            }
        }

        if (isDue) {
            console.log(`[AutoBackup] Lancement de la sauvegarde automatique périodique (${frequency}, excludeMedia: ${excludeMedia})...`);
            await generateAutoBackup(excludeMedia, keepCount);
            
            await db('settings')
                .insert({ key: 'lastAutoBackupTime', value: now.toISOString() })
                .onConflict('key')
                .merge();
            console.log("[AutoBackup] Sauvegarde automatique terminée avec succès.");
        }
    } catch (err) {
        console.error("Erreur dans le worker de sauvegarde automatique:", err);
    }
}

async function generateAutoBackup(excludeMedia, keepCount) {
    const backupDir = path.join(__dirname, 'backups');
    await fs.ensureDir(backupDir);

    const zip = new AdmZip();
    
    // 0. Base SQLite
    if (fs.existsSync(SQLITE_DB_PATH)) {
        zip.addLocalFile(SQLITE_DB_PATH);
    }

    // 1. Export JSON des tables
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

    // 2. Médiathèque
    if (!excludeMedia && fs.existsSync(MEDIA_DIR)) {
        zip.addLocalFolder(MEDIA_DIR, "media");
    }

    const typeStr = excludeMedia ? 'light' : 'full';
    const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `backup_auto_${typeStr}_${timestampStr}.zip`;
    const destPath = path.join(backupDir, fileName);

    zip.writeZip(destPath);
    console.log(`[AutoBackup] Fichier généré: ${destPath}`);

    // 3. Rotation des sauvegardes
    try {
        const files = await fs.readdir(backupDir);
        const prefix = `backup_auto_${typeStr}_`;
        const autoBackupFiles = files
            .filter(f => f.startsWith(prefix) && f.endsWith('.zip'))
            .map(f => {
                const filePath = path.join(backupDir, f);
                const stat = fs.statSync(filePath);
                return { name: f, path: filePath, mtime: stat.mtime };
            });

        autoBackupFiles.sort((a, b) => b.mtime - a.mtime);

        if (autoBackupFiles.length > keepCount) {
            const toDelete = autoBackupFiles.slice(keepCount);
            for (const f of toDelete) {
                await fs.remove(f.path);
                console.log(`[AutoBackup] Suppression ancienne sauvegarde: ${f.name}`);
            }
        }
    } catch (rotationErr) {
        console.error("[AutoBackup] Erreur lors de la rotation des sauvegardes:", rotationErr);
    }
}

// Gestionnaire d'erreurs global pour capturer les erreurs Multer ou système
app.use((err, req, res, next) => {
    console.error("Erreur serveur :", err.message);
    res.status(500).send(err.message);
});