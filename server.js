require('dotenv').config();

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { MongoClient } = require('mongodb');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------
const REQUIRED_ENV = ['MONGODB_URI', 'TUYA_CLIENT_ID', 'TUYA_SECRET'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length) {
    console.error(`[FATAL] Missing required environment variable(s): ${missingEnv.join(', ')}`);
    console.error('Copy .env.example to .env and fill in the required values.');
    process.exit(1);
}

const MONGODB_URI = process.env.MONGODB_URI;
const CLIENT_ID = process.env.TUYA_CLIENT_ID;
const SECRET = process.env.TUYA_SECRET;
const BASE_URL = process.env.TUYA_BASE_URL || 'https://openapi-sg.iotbing.com';
const PORT = Number(process.env.PORT) || 5000;
const HUB_TIMEZONE = process.env.HUB_TIMEZONE || 'Asia/Dhaka';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function envNumber(name, fallback, min, max) {
    const raw = Number(process.env[name]);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, raw));
}

const TUYA_POLL_INTERVAL_MS = envNumber('TUYA_POLL_INTERVAL_MS', 60_000, 15_000, 600_000);
const TUYA_ERROR_BACKOFF_MS = envNumber('TUYA_ERROR_BACKOFF_MS', 150_000, 30_000, 900_000);
const TUYA_TOKEN_RETRY_MS = envNumber('TUYA_TOKEN_RETRY_MS', 15_000, 5_000, 120_000);
const AUTOMATION_TICK_MS = envNumber('AUTOMATION_TICK_MS', 5_000, 1_000, 60_000);
const POWER_CALIBRATION = envNumber('POWER_CALIBRATION', 1.02, 0.1, 10);
const VOLTAGE_CALIBRATION = envNumber('VOLTAGE_CALIBRATION', 1.02, 0.1, 10);

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const logError = (...args) => console.error(`[${new Date().toISOString()}]`, ...args);

// -----------------------------------------------------------------------------
// Express / security middleware
// -----------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net'],
            // Helmet's default CSP includes `script-src-attr 'none'`, which blocks
            // this dashboard's inline onclick/onchange handlers. Explicitly allow
            // those handlers so the UI controls remain functional.
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'", 'https://api.open-meteo.com', 'https://geocoding-api.open-meteo.com'],
            fontSrc: ["'self'", 'data:'],
            objectSrc: ["'none'"],
            frameAncestors: ["'self'"],
        },
    },
}));
app.use(compression());

if (ALLOWED_ORIGINS.length) {
    app.use(cors({
        origin(origin, callback) {
            if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
            return callback(new Error('Origin not allowed by CORS'));
        },
    }));
}

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    maxAge: '10m',
    setHeaders(res, filePath) {
        if (filePath.endsWith('index.html') || filePath.endsWith('sw.js') || filePath.endsWith('manifest.json')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    },
}));

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 180,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests, please slow down.' },
});
app.use('/api/', apiLimiter);

// -----------------------------------------------------------------------------
// In-memory state + defaults
// -----------------------------------------------------------------------------
let accessToken = '';
let tokenExpireTime = 0;
let exchangeRates = { BDT: 1, USD: 0.0091, EUR: 0.0084, CNY: 0.066 };
let deviceCache = {};
let db = null;
let dbCollection = null;
let mongoClient = null;
let server = null;

const MAX_DEVICES = 30;
const MAX_SCHEDULES_PER_DEVICE = 40;
const MAX_ACTIVITY_LOG = 80;
const ALLOWED_CURRENCIES = ['BDT', 'USD', 'EUR', 'CNY'];
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function defaultUsage() {
    return {
        hourly: Array(24).fill(0),
        daily: Array(7).fill(0),
        weekly: Array(4).fill(0),
        monthly: Array(6).fill(0),
    };
}

function defaultAutomation() {
    return {
        schedules: [],
        timer: { active: false, executeAt: 0, action: false },
        mode: 'manual',
        standbyKill: false,
        standbyTimer: 0,
        voltageProtect: false,
        voltageMin: 170,
        voltageMax: 260,
        budgetKill: false,
    };
}

function defaultDeviceCache() {
    const now = Date.now();
    return {
        isPowerOn: false,
        power: 0,
        voltage: 0,
        online: false,
        lastCalcTime: now,
        sampledAt: 0,
        updatedAt: now,
    };
}

function normalizeNumberArray(value, length) {
    const arr = Array.isArray(value) ? value.slice(-length) : [];
    while (arr.length < length) arr.unshift(0);
    return arr.map((v) => Number.isFinite(Number(v)) ? Number(v) : 0);
}

function normalizeUsage(value) {
    const v = value || {};
    return {
        hourly: normalizeNumberArray(v.hourly, 24),
        daily: normalizeNumberArray(v.daily, 7),
        weekly: normalizeNumberArray(v.weekly, 4),
        monthly: normalizeNumberArray(v.monthly, 6),
    };
}

function normalizeAutomation(value) {
    const merged = { ...defaultAutomation(), ...(value || {}) };
    merged.schedules = Array.isArray(merged.schedules) ? merged.schedules.slice(0, MAX_SCHEDULES_PER_DEVICE) : [];
    merged.timer = {
        ...defaultAutomation().timer,
        ...(merged.timer && typeof merged.timer === 'object' ? merged.timer : {}),
    };
    merged.mode = ['manual', 'day', 'night'].includes(merged.mode) ? merged.mode : 'manual';
    merged.voltageMin = Number.isFinite(Number(merged.voltageMin)) ? Number(merged.voltageMin) : 170;
    merged.voltageMax = Number.isFinite(Number(merged.voltageMax)) ? Number(merged.voltageMax) : 260;
    if (merged.voltageMin >= merged.voltageMax) {
        merged.voltageMin = 170;
        merged.voltageMax = 260;
    }
    merged.standbyTimer = Number.isFinite(Number(merged.standbyTimer)) ? Math.max(0, Number(merged.standbyTimer)) : 0;
    merged.standbyKill = !!merged.standbyKill;
    merged.voltageProtect = !!merged.voltageProtect;
    merged.budgetKill = !!merged.budgetKill;
    return merged;
}

function logActivity(deviceId, type, message, deviceNameOverride) {
    if (!db) return;
    if (!Array.isArray(db.activityLog)) db.activityLog = [];
    const device = db.devices.find((d) => d.id === deviceId);
    db.activityLog.unshift({
        ts: Date.now(),
        deviceId,
        deviceName: deviceNameOverride || (device ? device.name : deviceId),
        type,
        message,
    });
    if (db.activityLog.length > MAX_ACTIVITY_LOG) db.activityLog.length = MAX_ACTIVITY_LOG;
}

// -----------------------------------------------------------------------------
// Calendar helpers for Dhaka / configured hub time
// -----------------------------------------------------------------------------
function hubNow() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: HUB_TIMEZONE }));
}

function pad2(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function monthKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }
function weekKey(d) {
    const copy = new Date(d);
    const daysSinceMonday = (copy.getDay() + 6) % 7;
    copy.setDate(copy.getDate() - daysSinceMonday);
    return dateKey(copy);
}
function dateKeyToUtc(key) {
    const [y, m, d] = String(key).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}
function daysBetween(a, b) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(b))) return 0;
    return Math.round((dateKeyToUtc(b) - dateKeyToUtc(a)) / 86_400_000);
}
function monthsBetween(a, b) {
    if (!/^\d{4}-\d{2}$/.test(String(a)) || !/^\d{4}-\d{2}$/.test(String(b))) return 0;
    const [ay, am] = a.split('-').map(Number);
    const [by, bm] = b.split('-').map(Number);
    return (by * 12 + bm) - (ay * 12 + am);
}
function shiftZeros(arr, steps, length) {
    const count = Math.min(Math.max(0, steps), length);
    for (let i = 0; i < count; i++) {
        arr.shift();
        arr.push(0);
    }
}

function ensureRotationKeys() {
    const now = hubNow();
    let changed = false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(db.settings.lastDateKey || ''))) {
        db.settings.lastDateKey = dateKey(now); changed = true;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(db.settings.lastWeekKey || ''))) {
        db.settings.lastWeekKey = weekKey(now); changed = true;
    }
    if (!/^\d{4}-\d{2}$/.test(String(db.settings.lastMonthKey || ''))) {
        db.settings.lastMonthKey = monthKey(now); changed = true;
    }
    return changed;
}

function checkTimeRotation() {
    if (!db || !db.settings) return false;
    const now = hubNow();
    const currentDate = dateKey(now);
    const currentWeek = weekKey(now);
    const currentMonth = monthKey(now);
    let mutated = ensureRotationKeys();

    const dayDelta = daysBetween(db.settings.lastDateKey, currentDate);
    if (dayDelta > 0) {
        for (const device of db.devices) {
            const usage = db.usage[device.id];
            if (!usage) continue;
            usage.hourly = Array(24).fill(0);
            shiftZeros(usage.daily, dayDelta, 7);
        }
        db.settings.lastDateKey = currentDate;
        mutated = true;
    } else if (dayDelta < 0) {
        db.settings.lastDateKey = currentDate;
        mutated = true;
    }

    const weekDeltaDays = daysBetween(db.settings.lastWeekKey, currentWeek);
    if (weekDeltaDays > 0) {
        const weeks = Math.max(1, Math.floor(weekDeltaDays / 7));
        for (const device of db.devices) {
            const usage = db.usage[device.id];
            if (usage) shiftZeros(usage.weekly, weeks, 4);
        }
        db.settings.lastWeekKey = currentWeek;
        mutated = true;
    } else if (weekDeltaDays < 0) {
        db.settings.lastWeekKey = currentWeek;
        mutated = true;
    }

    const monthDelta = monthsBetween(db.settings.lastMonthKey, currentMonth);
    if (monthDelta > 0) {
        for (const device of db.devices) {
            const usage = db.usage[device.id];
            if (usage) shiftZeros(usage.monthly, monthDelta, 6);
        }
        db.settings.lastMonthKey = currentMonth;
        mutated = true;
    } else if (monthDelta < 0) {
        db.settings.lastMonthKey = currentMonth;
        mutated = true;
    }

    return mutated;
}

// -----------------------------------------------------------------------------
// MongoDB persistence: serialized + debounced, never attempts to $set _id
// -----------------------------------------------------------------------------
let stateDirty = false;
let saveTimer = null;
let saveQueue = Promise.resolve();

function stateSnapshot() {
    const { _id, ...persisted } = db;
    return JSON.parse(JSON.stringify(persisted));
}

function markStateDirty(delayMs = 200) {
    if (!dbCollection || !db) return;
    stateDirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        flushState().catch(() => {});
    }, Math.max(0, delayMs));
}

async function flushState() {
    if (!dbCollection || !db) return;
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }

    saveQueue = saveQueue.catch(() => {}).then(async () => {
        while (stateDirty) {
            stateDirty = false;
            const snapshot = stateSnapshot();
            try {
                await dbCollection.updateOne({ _id: 'main' }, { $set: snapshot }, { upsert: true });
            } catch (error) {
                stateDirty = true;
                logError('MongoDB state save failed:', error.message);
                throw error;
            }
        }
    });
    return saveQueue;
}

async function initDB() {
    mongoClient = new MongoClient(MONGODB_URI, { maxPoolSize: 10 });
    await mongoClient.connect();
    dbCollection = mongoClient.db('smart_home').collection('state');

    db = await dbCollection.findOne({ _id: 'main' });
    if (!db) {
        db = {
            _id: 'main',
            settings: {
                baseRateBDT: 15,
                currency: 'BDT',
                monthlyBudget: 500,
                weatherLocation: 'Dhanmondi, Dhaka',
                language: 'en',
            },
            devices: [],
            usage: {},
            automations: {},
            activityLog: [],
        };
        await dbCollection.insertOne(db);
    }

    db.settings = {
        baseRateBDT: 15,
        currency: 'BDT',
        monthlyBudget: 500,
        weatherLocation: 'Dhanmondi, Dhaka',
        language: 'en',
        ...(db.settings || {}),
    };
    if (!ALLOWED_CURRENCIES.includes(db.settings.currency)) db.settings.currency = 'BDT';
    if (!['en', 'bn'].includes(db.settings.language)) db.settings.language = 'en';
    if (!Array.isArray(db.devices)) db.devices = [];
    if (!db.usage || typeof db.usage !== 'object') db.usage = {};
    if (!db.automations || typeof db.automations !== 'object') db.automations = {};
    if (!Array.isArray(db.activityLog)) db.activityLog = [];
    db.activityLog = db.activityLog.slice(0, MAX_ACTIVITY_LOG);

    const seen = new Set();
    db.devices = db.devices.filter((device) => {
        if (!device || typeof device.id !== 'string' || seen.has(device.id)) return false;
        seen.add(device.id);
        device.name = sanitizeName(device.name || 'Device');
        return true;
    }).slice(0, MAX_DEVICES);

    for (const device of db.devices) {
        db.usage[device.id] = normalizeUsage(db.usage[device.id]);
        db.automations[device.id] = normalizeAutomation(db.automations[device.id]);
        deviceCache[device.id] = defaultDeviceCache();
    }

    ensureRotationKeys();
    stateDirty = true;
    await flushState();
    log('MongoDB connected & state loaded');
}

// -----------------------------------------------------------------------------
// Input helpers
// -----------------------------------------------------------------------------
const isNonEmptyString = (v, maxLen = 100) => typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
const isValidDeviceId = (v) => typeof v === 'string' && /^[a-zA-Z0-9_-]{5,64}$/.test(v);
function sanitizeName(name) {
    return String(name || '').trim().slice(0, 60).replace(/[<>]/g, '');
}
function deviceExists(id) {
    return !!(db && db.devices.find((d) => d.id === id) && db.automations[id] && db.usage[id]);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// -----------------------------------------------------------------------------
// Exchange rates
// -----------------------------------------------------------------------------
async function updateExchangeRates() {
    try {
        const res = await axios.get('https://api.exchangerate-api.com/v4/latest/BDT', { timeout: 8000 });
        if (res.data?.rates) exchangeRates = res.data.rates;
    } catch (error) {
        logError('Exchange rate update failed:', error.message);
    }
}
const exchangeRateTimer = setInterval(updateExchangeRates, 12 * 60 * 60 * 1000);

// -----------------------------------------------------------------------------
// Health endpoints, intentionally unauthenticated for Render / cron monitors
// -----------------------------------------------------------------------------
app.get('/api/ping', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send('OK');
});

app.get('/api/health', asyncHandler(async (req, res) => {
    let mongoHealthy = false;
    try {
        if (mongoClient) {
            await mongoClient.db('admin').command({ ping: 1 });
            mongoHealthy = true;
        }
    } catch (error) {
        mongoHealthy = false;
    }

    const healthy = !!db && mongoHealthy;
    res.setHeader('Cache-Control', 'no-store');
    res.status(healthy ? 200 : 503).json({
        success: healthy,
        dbLoaded: !!db,
        mongoConnected: mongoHealthy,
        tuyaTokenActive: !!(accessToken && Date.now() < tokenExpireTime),
        devices: db?.devices?.length || 0,
        uptimeSeconds: Math.round(process.uptime()),
    });
}));

// -----------------------------------------------------------------------------
// Tuya helpers
// -----------------------------------------------------------------------------
function generateSignature(method, endpoint, body = '', token = '') {
    const t = Date.now().toString();
    const contentHash = crypto.createHash('sha256').update(body).digest('hex');
    const signStr = CLIENT_ID + token + t + `${method}\n${contentHash}\n\n${endpoint}`;
    return {
        t,
        sign: crypto.createHmac('sha256', SECRET).update(signStr).digest('hex').toUpperCase(),
    };
}

function isTuyaAuthError(data) {
    const code = String(data?.code ?? '');
    return code === '1010' || code === '1011';
}

function invalidateTuyaToken() {
    accessToken = '';
    tokenExpireTime = 0;
}

async function getToken(forceRefresh = false) {
    if (!forceRefresh && accessToken && Date.now() < tokenExpireTime) return accessToken;

    const endpoint = '/v1.0/token?grant_type=1';
    const { t, sign } = generateSignature('GET', endpoint);
    try {
        const res = await axios.get(`${BASE_URL}${endpoint}`, {
            headers: { client_id: CLIENT_ID, sign, t, sign_method: 'HMAC-SHA256' },
            timeout: 8000,
        });
        if (res.data?.success && res.data?.result?.access_token) {
            accessToken = res.data.result.access_token;
            const expiresIn = Math.max(60, Number(res.data.result.expire_time) || 3600);
            const bufferSeconds = Math.min(200, Math.max(30, Math.floor(expiresIn * 0.1)));
            tokenExpireTime = Date.now() + Math.max(30, expiresIn - bufferSeconds) * 1000;
            return accessToken;
        }
        invalidateTuyaToken();
        logError('Tuya token request failed:', res.data);
    } catch (error) {
        invalidateTuyaToken();
        logError('Tuya token request error:', error.message);
    }
    return '';
}

async function sendToggleCommand(deviceId, state, allowRetry = true) {
    const token = await getToken();
    if (!token) return false;

    const endpoint = `/v1.0/devices/${deviceId}/commands`;
    const body = JSON.stringify({ commands: [{ code: 'switch_1', value: state }] });
    const { t, sign } = generateSignature('POST', endpoint, body, token);

    try {
        const res = await axios.post(`${BASE_URL}${endpoint}`, body, {
            headers: {
                client_id: CLIENT_ID,
                access_token: token,
                sign,
                t,
                sign_method: 'HMAC-SHA256',
                'Content-Type': 'application/json',
            },
            timeout: 8000,
        });

        if (res.data?.success) {
            if (deviceCache[deviceId]) {
                deviceCache[deviceId].isPowerOn = state;
                deviceCache[deviceId].updatedAt = Date.now();
            }
            return true;
        }

        if (allowRetry && isTuyaAuthError(res.data)) {
            invalidateTuyaToken();
            await getToken(true);
            return sendToggleCommand(deviceId, state, false);
        }

        logError(`Tuya toggle failed for ${deviceId}:`, res.data);
        return false;
    } catch (error) {
        logError(`Tuya toggle request error for ${deviceId}:`, error.message);
        return false;
    }
}

const deviceCommandQueues = new Map();
function toggleDevice(deviceId, state) {
    const previous = deviceCommandQueues.get(deviceId) || Promise.resolve();
    let tracked;
    const command = previous.catch(() => {}).then(() => sendToggleCommand(deviceId, state));
    tracked = command.finally(() => {
        if (deviceCommandQueues.get(deviceId) === tracked) deviceCommandQueues.delete(deviceId);
    });
    deviceCommandQueues.set(deviceId, tracked);
    return tracked;
}

function markDeviceOffline(deviceId, data) {
    const cache = deviceCache[deviceId];
    if (cache) {
        cache.online = false;
        cache.updatedAt = Date.now();
        // Do not backfill unknown energy usage after an outage.
        cache.lastCalcTime = Date.now();
    }
    if (isTuyaAuthError(data)) invalidateTuyaToken();
}

// -----------------------------------------------------------------------------
// API routes
// -----------------------------------------------------------------------------
app.get('/api/data', (req, res) => {
    res.json({
        ...db,
        currentRates: exchangeRates,
        serverConfig: {
            timeZone: HUB_TIMEZONE,
            tuyaPollIntervalMs: TUYA_POLL_INTERVAL_MS,
        },
    });
});

app.get('/api/status', (req, res) => res.json({ success: true, result: deviceCache }));

app.get('/api/status/:id', (req, res) => {
    const data = deviceCache[req.params.id];
    if (data) return res.json({ success: true, result: data });
    return res.status(404).json({ success: false, error: 'Device not found' });
});

app.get('/api/export/:id', (req, res) => {
    const usage = db.usage[req.params.id];
    if (!usage) return res.status(404).send('Device not found');
    let csv = 'Hour,Energy_kWh\n';
    usage.hourly.forEach((val, i) => {
        csv += `${pad2(i)}:00,${Number(val || 0).toFixed(4)}\n`;
    });
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.attachment(`device_${req.params.id}_today.csv`);
    return res.send(csv);
});

app.post('/api/devices', (req, res) => {
    const { id, name } = req.body || {};
    if (!isValidDeviceId(id)) return res.status(400).json({ success: false, error: 'Invalid device id format' });
    if (!isNonEmptyString(name, 60)) return res.status(400).json({ success: false, error: 'Invalid device name' });
    if (db.devices.length >= MAX_DEVICES) return res.status(400).json({ success: false, error: `Maximum of ${MAX_DEVICES} devices reached` });
    if (db.devices.find((d) => d.id === id)) return res.status(409).json({ success: false, error: 'Device already exists' });

    const cleanName = sanitizeName(name);
    db.devices.push({ id, name: cleanName });
    db.usage[id] = defaultUsage();
    db.automations[id] = defaultAutomation();
    deviceCache[id] = defaultDeviceCache();
    logActivity(id, 'device_added', `${cleanName} was added`);
    markStateDirty();
    return res.json({ success: true });
});

app.patch('/api/devices/:id', (req, res) => {
    if (!deviceExists(req.params.id)) return res.status(404).json({ success: false, error: 'Device not found' });
    const { name } = req.body || {};
    if (!isNonEmptyString(name, 60)) return res.status(400).json({ success: false, error: 'Invalid device name' });
    const device = db.devices.find((d) => d.id === req.params.id);
    const previousName = device.name;
    device.name = sanitizeName(name);
    logActivity(device.id, 'device_renamed', `${previousName} renamed to ${device.name}`);
    markStateDirty();
    return res.json({ success: true, device });
});

app.delete('/api/devices/:id', (req, res) => {
    const device = db.devices.find((d) => d.id === req.params.id);
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
    logActivity(device.id, 'device_removed', `${device.name} was removed`, device.name);
    db.devices = db.devices.filter((d) => d.id !== req.params.id);
    delete db.usage[req.params.id];
    delete db.automations[req.params.id];
    delete deviceCache[req.params.id];
    markStateDirty();
    return res.json({ success: true });
});

app.post('/api/toggle/:id', asyncHandler(async (req, res) => {
    if (!deviceExists(req.params.id)) return res.status(404).json({ success: false, error: 'Device not found' });
    if (typeof req.body?.state !== 'boolean') return res.status(400).json({ success: false, error: 'state must be boolean' });

    const success = await toggleDevice(req.params.id, req.body.state);
    if (!success) return res.status(502).json({ success: false, error: 'Device command failed' });

    db.automations[req.params.id].mode = 'manual';
    db.automations[req.params.id].standbyTimer = 0;
    logActivity(req.params.id, 'manual_toggle', `Turned ${req.body.state ? 'ON' : 'OFF'} manually`);
    markStateDirty();
    return res.json({ success: true });
}));

app.post('/api/cycle/:id', asyncHandler(async (req, res) => {
    if (!deviceExists(req.params.id)) return res.status(404).json({ success: false, error: 'Device not found' });

    const offSuccess = await toggleDevice(req.params.id, false);
    if (!offSuccess) return res.status(502).json({ success: false, error: 'Could not turn device off' });
    await sleep(3500);
    const onSuccess = await toggleDevice(req.params.id, true);
    if (!onSuccess) return res.status(502).json({ success: false, error: 'Device turned off, but could not turn it back on' });

    db.automations[req.params.id].mode = 'manual';
    db.automations[req.params.id].standbyTimer = 0;
    logActivity(req.params.id, 'power_cycle', 'Power cycled');
    markStateDirty();
    return res.json({ success: true });
}));

app.post('/api/toggle-all', asyncHandler(async (req, res) => {
    if (typeof req.body?.state !== 'boolean') return res.status(400).json({ success: false, error: 'state must be boolean' });

    const results = [];
    for (const device of db.devices) {
        const success = await toggleDevice(device.id, req.body.state);
        results.push({ id: device.id, success });
        if (success && db.automations[device.id]) {
            db.automations[device.id].mode = 'manual';
            db.automations[device.id].standbyTimer = 0;
            logActivity(device.id, 'manual_toggle', `Master command turned ${req.body.state ? 'ON' : 'OFF'}`);
        }
        await sleep(350);
    }
    markStateDirty();
    const success = results.every((r) => r.success);
    return res.status(success ? 200 : 207).json({ success, results });
}));

app.post('/api/settings', (req, res) => {
    const patch = {};
    const body = req.body || {};

    if (body.baseRateBDT !== undefined) {
        const rate = Number(body.baseRateBDT);
        if (!Number.isFinite(rate) || rate < 0 || rate > 10000) return res.status(400).json({ success: false, error: 'Invalid rate' });
        patch.baseRateBDT = rate;
    }
    if (body.currency !== undefined) {
        if (!ALLOWED_CURRENCIES.includes(body.currency)) return res.status(400).json({ success: false, error: 'Invalid currency' });
        patch.currency = body.currency;
    }
    if (body.monthlyBudget !== undefined) {
        const budget = Number(body.monthlyBudget);
        if (!Number.isFinite(budget) || budget <= 0 || budget > 1_000_000) return res.status(400).json({ success: false, error: 'Monthly budget must be greater than 0' });
        patch.monthlyBudget = budget;
    }
    if (body.weatherLocation !== undefined) {
        if (!isNonEmptyString(body.weatherLocation, 100)) return res.status(400).json({ success: false, error: 'Invalid location' });
        patch.weatherLocation = sanitizeName(body.weatherLocation);
    }
    if (body.language !== undefined) {
        if (!['en', 'bn'].includes(body.language)) return res.status(400).json({ success: false, error: 'Invalid language' });
        patch.language = body.language;
    }

    db.settings = { ...db.settings, ...patch };
    markStateDirty();
    return res.json({ success: true, settings: db.settings });
});

app.post('/api/automations/:id', (req, res) => {
    if (!deviceExists(req.params.id)) return res.status(404).json({ success: false, error: 'Device not found' });

    const auto = db.automations[req.params.id];
    const body = req.body || {};
    const patch = {};

    if (body.mode !== undefined) {
        if (!['manual', 'day', 'night'].includes(body.mode)) return res.status(400).json({ success: false, error: 'Invalid mode' });
        patch.mode = body.mode;
    }
    if (body.standbyKill !== undefined) patch.standbyKill = !!body.standbyKill;
    if (body.voltageProtect !== undefined) patch.voltageProtect = !!body.voltageProtect;
    if (body.budgetKill !== undefined) patch.budgetKill = !!body.budgetKill;

    if (body.voltageMin !== undefined) {
        const value = Number(body.voltageMin);
        if (!Number.isFinite(value) || value < 0 || value > 500) return res.status(400).json({ success: false, error: 'Invalid voltageMin' });
        patch.voltageMin = value;
    }
    if (body.voltageMax !== undefined) {
        const value = Number(body.voltageMax);
        if (!Number.isFinite(value) || value < 0 || value > 500) return res.status(400).json({ success: false, error: 'Invalid voltageMax' });
        patch.voltageMax = value;
    }
    const nextMin = patch.voltageMin ?? auto.voltageMin;
    const nextMax = patch.voltageMax ?? auto.voltageMax;
    if (nextMin >= nextMax) return res.status(400).json({ success: false, error: 'voltageMin must be lower than voltageMax' });

    if (body.timer !== undefined) {
        const timer = body.timer;
        if (!timer || typeof timer !== 'object' || typeof timer.active !== 'boolean' || typeof timer.executeAt !== 'number' || typeof timer.action !== 'boolean') {
            return res.status(400).json({ success: false, error: 'Invalid timer payload' });
        }
        if (timer.active && (!Number.isFinite(timer.executeAt) || timer.executeAt <= Date.now() || timer.executeAt > Date.now() + 31 * 24 * 60 * 60 * 1000)) {
            return res.status(400).json({ success: false, error: 'Timer must be within the next 31 days' });
        }
        patch.timer = { active: timer.active, executeAt: timer.executeAt, action: timer.action };
    }

    if (body.schedules !== undefined) {
        if (!Array.isArray(body.schedules) || body.schedules.length > MAX_SCHEDULES_PER_DEVICE) {
            return res.status(400).json({ success: false, error: 'Invalid schedules payload' });
        }
        const valid = body.schedules.every((s) => (
            s &&
            ['string', 'number'].includes(typeof s.id) &&
            TIME_RE.test(String(s.time || '')) &&
            typeof s.action === 'boolean' &&
            (s.enabled === undefined || typeof s.enabled === 'boolean')
        ));
        if (!valid) return res.status(400).json({ success: false, error: 'Invalid schedule entry' });
        patch.schedules = body.schedules.map((s) => ({
            id: s.id,
            time: s.time,
            action: !!s.action,
            enabled: s.enabled !== false,
        }));
    }

    Object.assign(auto, patch);
    markStateDirty();
    return res.json({ success: true, automation: auto });
});

app.delete('/api/usage/:id', (req, res) => {
    if (!deviceExists(req.params.id)) return res.status(404).json({ success: false, error: 'Device not found' });
    db.usage[req.params.id] = defaultUsage();
    logActivity(req.params.id, 'history_cleared', 'Usage history was cleared');
    markStateDirty();
    return res.json({ success: true });
});

app.get('/api/activity', (req, res) => res.json({ success: true, result: db.activityLog || [] }));

// -----------------------------------------------------------------------------
// Time-based automation ticker: timers and schedules do not wait for Tuya polling
// -----------------------------------------------------------------------------
let automationTickerRunning = false;
let scheduleExecutionDate = '';
let lastAutomationClockMs = 0;
const executedScheduleKeys = new Set();

async function runTimeAutomations() {
    if (automationTickerRunning || !db) return;
    automationTickerRunning = true;
    try {
        if (checkTimeRotation()) markStateDirty();

        const now = hubNow();
        const today = dateKey(now);
        const nowMs = Date.now();
        const nowClockMs = now.getTime();
        const maxScheduleCatchupMs = 15 * 60 * 1000;
        const previousClockMs = lastAutomationClockMs || (nowClockMs - AUTOMATION_TICK_MS * 2);
        const scheduleWindowStart = Math.max(previousClockMs, nowClockMs - maxScheduleCatchupMs);
        lastAutomationClockMs = nowClockMs;

        if (scheduleExecutionDate !== today) {
            scheduleExecutionDate = today;
            executedScheduleKeys.clear();
        }

        for (const device of db.devices) {
            const auto = db.automations[device.id];
            const cache = deviceCache[device.id];
            if (!auto || !cache) continue;

            if (auto.timer?.active && nowMs >= auto.timer.executeAt) {
                const desired = !!auto.timer.action;
                const success = await toggleDevice(device.id, desired);
                if (success) {
                    auto.timer.active = false;
                    auto.mode = 'manual';
                    auto.standbyTimer = 0;
                    logActivity(device.id, 'timer', `Timer fired: turned ${desired ? 'ON' : 'OFF'}`);
                    markStateDirty();
                }
            }

            const scheduleCandidates = [];
            for (const schedule of (auto.schedules || [])) {
                if (!schedule.enabled || !TIME_RE.test(String(schedule.time || ''))) continue;
                const [hh, mm] = schedule.time.split(':').map(Number);

                // Check today and, when the ticker crosses midnight, the previous calendar day.
                for (const dayOffset of [0, -1]) {
                    const scheduledAt = new Date(now);
                    scheduledAt.setDate(scheduledAt.getDate() + dayOffset);
                    scheduledAt.setHours(hh, mm, 0, 0);
                    const scheduledClockMs = scheduledAt.getTime();
                    if (scheduledClockMs > scheduleWindowStart && scheduledClockMs <= nowClockMs) {
                        scheduleCandidates.push({ schedule, scheduledAt, scheduledClockMs });
                    }
                }
            }

            if (scheduleCandidates.length) {
                // If multiple schedules become due together, the latest due schedule / list order wins.
                scheduleCandidates.sort((a, b) => a.scheduledClockMs - b.scheduledClockMs);
                const candidate = scheduleCandidates[scheduleCandidates.length - 1];
                const schedule = candidate.schedule;
                const executionDay = dateKey(candidate.scheduledAt);
                const executionKey = `${executionDay}|${device.id}|${schedule.id}`;
                if (!executedScheduleKeys.has(executionKey)) {
                    const desired = !!schedule.action;
                    const success = await toggleDevice(device.id, desired);
                    if (success) {
                        executedScheduleKeys.add(executionKey);
                        logActivity(device.id, 'schedule', `Schedule ${schedule.time}: turned ${desired ? 'ON' : 'OFF'}`);
                        markStateDirty();
                    }
                }
            }
        }
    } catch (error) {
        logError('Automation ticker error:', error.message);
    } finally {
        automationTickerRunning = false;
    }
}
const automationTimer = setInterval(runTimeAutomations, AUTOMATION_TICK_MS);

// -----------------------------------------------------------------------------
// Tuya status polling: sensor values, energy accounting, safety automations
// -----------------------------------------------------------------------------
let polling = false;
let pollTimer = null;

async function pollTuya() {
    if (polling) return;
    polling = true;
    let cycleHadError = false;
    let nextDelay = TUYA_POLL_INTERVAL_MS;

    try {
        if (!db) return;
        if (checkTimeRotation()) markStateDirty();
        if (!db.devices.length) return;

        const token = await getToken();
        if (!token) {
            cycleHadError = true;
            nextDelay = TUYA_TOKEN_RETRY_MS;
            return;
        }

        const now = hubNow();
        const hour = now.getHours();
        const nowMs = Date.now();

        for (const device of db.devices) {
            const cache = deviceCache[device.id];
            const auto = db.automations[device.id];
            const usage = db.usage[device.id];
            if (!cache || !auto || !usage) continue;

            try {
                const endpoint = `/v1.0/devices/${device.id}/status`;
                const currentToken = await getToken();
                if (!currentToken) throw new Error('No Tuya access token');
                const { t, sign } = generateSignature('GET', endpoint, '', currentToken);
                const response = await axios.get(`${BASE_URL}${endpoint}`, {
                    headers: {
                        client_id: CLIENT_ID,
                        access_token: currentToken,
                        sign,
                        t,
                        sign_method: 'HMAC-SHA256',
                    },
                    timeout: 8000,
                });

                if (!response.data?.success || !Array.isArray(response.data?.result)) {
                    cycleHadError = true;
                    markDeviceOffline(device.id, response.data);
                    continue;
                }

                const status = response.data.result;
                const switchValue = status.find((s) => s.code === 'switch_1' || s.code === 'switch')?.value;
                const powerRaw = Number(status.find((s) => s.code === 'cur_power')?.value);
                const voltageRaw = Number(status.find((s) => s.code === 'cur_voltage')?.value);
                const isPowerOn = typeof switchValue === 'boolean' ? switchValue : cache.isPowerOn;
                const currentPower = Number.isFinite(powerRaw) ? (powerRaw / 10) * POWER_CALIBRATION : 0;
                const currentVoltage = Number.isFinite(voltageRaw) ? (voltageRaw / 10) * VOLTAGE_CALIBRATION : 0;

                // Clamp elapsed time so a network outage cannot fabricate hours of usage at one stale wattage.
                const maxDeltaMs = Math.max(TUYA_POLL_INTERVAL_MS * 3, 180_000);
                const elapsedMs = Math.max(0, Math.min(nowMs - cache.lastCalcTime, maxDeltaMs));
                const deltaHours = elapsedMs / 3_600_000;

                cache.lastCalcTime = nowMs;
                cache.sampledAt = nowMs;
                cache.updatedAt = nowMs;
                cache.power = Math.max(0, currentPower);
                cache.voltage = Math.max(0, currentVoltage);
                cache.isPowerOn = !!isPowerOn;
                cache.online = true;

                if (isPowerOn && currentPower > 0 && deltaHours > 0) {
                    const kwh = (currentPower / 1000) * deltaHours;
                    usage.hourly[hour] += kwh;
                    usage.daily[usage.daily.length - 1] += kwh;
                    usage.weekly[usage.weekly.length - 1] += kwh;
                    usage.monthly[usage.monthly.length - 1] += kwh;
                }

                // Safety: voltage guard
                if (auto.voltageProtect && isPowerOn) {
                    const vMin = Number(auto.voltageMin) || 170;
                    const vMax = Number(auto.voltageMax) || 260;
                    if (currentVoltage > vMax || (currentVoltage < vMin && currentVoltage > 50)) {
                        const success = await toggleDevice(device.id, false);
                        if (success) {
                            auto.mode = 'manual';
                            auto.standbyTimer = 0;
                            logActivity(device.id, 'voltage_guard', `Cut power at ${currentVoltage.toFixed(1)}V (limits ${vMin}-${vMax}V)`);
                        }
                        continue;
                    }
                }

                // Safety: budget lock
                if (auto.budgetKill && isPowerOn) {
                    const monthKwh = usage.monthly[usage.monthly.length - 1] || 0;
                    const currency = db.settings.currency;
                    const currencyFactor = exchangeRates[currency] || 1;
                    const rate = db.settings.baseRateBDT * currencyFactor;
                    const budget = db.settings.monthlyBudget * currencyFactor;
                    if (budget > 0 && monthKwh * rate >= budget) {
                        const success = await toggleDevice(device.id, false);
                        if (success) {
                            auto.mode = 'manual';
                            auto.standbyTimer = 0;
                            logActivity(device.id, 'budget_kill', 'Cut power: monthly budget reached');
                        }
                        continue;
                    }
                }

                // Safety: standby auto-kill
                if (isPowerOn && currentPower < 5) {
                    auto.standbyTimer = (Number(auto.standbyTimer) || 0) + deltaHours * 3600;
                    if (auto.standbyKill && auto.standbyTimer >= 600) {
                        const success = await toggleDevice(device.id, false);
                        if (success) {
                            auto.standbyTimer = 0;
                            auto.mode = 'manual';
                            logActivity(device.id, 'standby_kill', 'Cut power: idle in standby for 10+ minutes');
                        }
                        continue;
                    }
                } else {
                    auto.standbyTimer = 0;
                }

                // Persistent day / night operating modes.
                let targetState = isPowerOn;
                let modeReason = null;
                if (auto.mode === 'day') {
                    targetState = hour >= 8 && hour < 18;
                    modeReason = 'Day mode';
                } else if (auto.mode === 'night') {
                    targetState = hour >= 22 || hour < 6;
                    modeReason = 'Night mode';
                }

                if (targetState !== isPowerOn) {
                    const success = await toggleDevice(device.id, targetState);
                    if (success && modeReason) {
                        logActivity(device.id, 'mode', `${modeReason}: turned ${targetState ? 'ON' : 'OFF'}`);
                    }
                }
            } catch (error) {
                cycleHadError = true;
                markDeviceOffline(device.id, { code: 'NETWORK_ERROR' });
                logError(`Poll error for device ${device.id}:`, error.message);
            }

            await sleep(300);
        }

        markStateDirty();
        nextDelay = cycleHadError ? TUYA_ERROR_BACKOFF_MS : TUYA_POLL_INTERVAL_MS;
    } catch (error) {
        cycleHadError = true;
        nextDelay = TUYA_ERROR_BACKOFF_MS;
        logError('pollTuya loop crashed:', error);
    } finally {
        polling = false;
        pollTimer = setTimeout(pollTuya, nextDelay);
    }
}

// -----------------------------------------------------------------------------
// Error handler
// -----------------------------------------------------------------------------
app.use((err, req, res, next) => {
    if (err?.message === 'Origin not allowed by CORS') {
        return res.status(403).json({ success: false, error: 'Origin not allowed' });
    }
    logError('Unhandled route error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
});

// -----------------------------------------------------------------------------
// Startup / shutdown
// -----------------------------------------------------------------------------
initDB().then(() => {
    server = app.listen(PORT, '0.0.0.0', () => log(`Smart Hub v4 running on port ${PORT}`));
    updateExchangeRates();
    runTimeAutomations();
    pollTuya();
}).catch((error) => {
    logError('Failed to initialize database, exiting:', error);
    process.exit(1);
});

async function shutdown(signal) {
    log(`Received ${signal}, shutting down gracefully...`);
    if (pollTimer) clearTimeout(pollTimer);
    clearInterval(automationTimer);
    clearInterval(exchangeRateTimer);

    try {
        if (db) {
            stateDirty = true;
            await flushState();
        }
    } catch (error) {
        logError('Final state save failed:', error.message);
    }

    if (server) {
        await Promise.race([
            new Promise((resolve) => server.close(resolve)),
            sleep(5000),
        ]);
    }

    if (mongoClient) {
        try { await mongoClient.close(); }
        catch (error) { logError('Error closing Mongo connection:', error.message); }
    }

    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logError('Unhandled promise rejection:', reason));
