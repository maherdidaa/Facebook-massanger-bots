// ============================================================
// server.js - Facebook Messenger API (Full Stack)
// ملف واحد للباك إند - جاهز للنشر على Render
// ============================================================

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ===================== الإعدادات =====================
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(64).toString('hex');
const ENCRYPTION_KEY = crypto.scryptSync(
    process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex'),
    'fb-messenger-v3-salt',
    32
);

// Facebook API
const FB_PAGE_ID = process.env.FB_PAGE_ID || '';
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN || '';
const FB_API_VERSION = 'v22.0';

// ===================== مسارات =====================
const DATA_DIR = path.join(__dirname, 'data');
const LOGS_DIR = path.join(__dirname, 'logs');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.enc');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// ===================== سجلات =====================
const logStream = fs.createWriteStream(path.join(LOGS_DIR, 'app.log'), { flags: 'a' });

function log(level, msg, meta = {}) {
    const t = new Date().toISOString();
    const line = JSON.stringify({ t, level, msg, ...meta }) + '\n';
    logStream.write(line);
    if (NODE_ENV !== 'production') console.log(`[${t}] [${level}] ${msg}`);
}

// ===================== تشفير =====================
function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    let enc = cipher.update(text, 'utf8', 'hex');
    enc += cipher.final('hex');
    return iv.toString('hex') + ':' + cipher.getAuthTag().toString('hex') + ':' + enc;
}

function decrypt(text) {
    try {
        const p = text.split(':');
        const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(p[0], 'hex'));
        decipher.setAuthTag(Buffer.from(p[1], 'hex'));
        let dec = decipher.update(p.slice(2).join(':'), 'hex', 'utf8');
        dec += decipher.final('utf8');
        return dec;
    } catch { return null; }
}

// ===================== Facebook API =====================
const fbClient = axios.create({
    baseURL: `https://graph.facebook.com/${FB_API_VERSION}`,
    timeout: 30000,
    headers: { 'Content-Type': 'application/json' }
});

async function fbGetConversations(limit = 50) {
    const { data } = await fbClient.get(`/${FB_PAGE_ID}/conversations`, {
        params: {
            access_token: FB_ACCESS_TOKEN,
            fields: 'id,participants{id,name},messages.limit(1){message,created_time},updated_time,message_count',
            limit: Math.min(limit, 100)
        }
    });
    return data;
}

async function fbSendMessage(recipientId, text) {
    const { data } = await fbClient.post(`/${FB_PAGE_ID}/messages`, {
        recipient: { id: recipientId },
        messaging_type: 'RESPONSE',
        message: { text }
    }, { params: { access_token: FB_ACCESS_TOKEN } });
    return data;
}

// ===================== Anti-Ban =====================
const limits = { sent: 0, start: Date.now(), max: 40 };
function checkLimit() {
    if (Date.now() - limits.start > 3600000) { limits.sent = 0; limits.start = Date.now(); }
    if (limits.sent >= limits.max) throw new Error(`حد الإرسال: ${limits.max}/ساعة`);
}
function recordSend() { checkLimit(); limits.sent++; }

// ===================== Express =====================
const app = express();

// أمان
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));

// Rate limit
app.use(rateLimit({
    windowMs: 15 * 60 * 1000, max: 200,
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'طلبات كثيرة' } }
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// جلسات
app.use(session({
    secret: SESSION_SECRET, resave: false, saveUninitialized: false,
    cookie: { secure: NODE_ENV === 'production', httpOnly: true, maxAge: 86400000, sameSite: 'strict' }
}));

// ===================== الملفات الثابتة (الواجهة) =====================
app.use(express.static(PUBLIC_DIR));

// ===================== API Routes =====================

// تسجيل الدخول
app.post('/api/login', (req, res) => {
    try {
        const { cookies } = req.body;
        if (!cookies || !cookies.includes('=')) {
            return res.status(400).json({ success: false, error: 'الكوكيز غير صالحة' });
        }

        const parsed = {};
        cookies.split(';').forEach(p => {
            const i = p.indexOf('=');
            if (i > 0) parsed[p.slice(0, i).trim()] = p.slice(i + 1).trim();
        });

        if (!parsed.c_user || !parsed.xs) {
            return res.status(400).json({
                success: false,
                error: `ناقص: c_user, xs. الموجود: ${Object.keys(parsed).join(', ')}`
            });
        }

        const data = { raw: cookies, parsed, userId: parsed.c_user, time: Date.now() };
        fs.writeFileSync(SESSIONS_FILE, encrypt(JSON.stringify(data)));
        req.session.userId = parsed.c_user;
        req.session.authenticated = true;

        log('info', 'تسجيل دخول', { user: parsed.c_user.slice(0,6)+'...' });
        res.json({ success: true, data: { message: '✅ تم تسجيل الدخول', cookiesCount: Object.keys(parsed).length } });

    } catch (err) {
        log('error', 'فشل تسجيل الدخول', { error: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
});

// جلب المراسلين
app.get('/api/contacts', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;

        // 1. Graph API
        if (FB_PAGE_ID && FB_ACCESS_TOKEN) {
            try {
                const result = await fbGetConversations(limit);
                const contacts = (result.data || []).map(conv => ({
                    id: conv.id,
                    threadId: conv.id?.replace('t_', ''),
                    participants: (conv.participants?.data || [])
                        .filter(p => p.id !== FB_PAGE_ID)
                        .map(p => ({ psid: p.id, name: p.name })),
                    lastMessage: conv.messages?.data?.[0]?.message || null,
                    lastActivity: conv.updated_time,
                    messageCount: conv.message_count || 0
                })).filter(c => c.participants.length > 0);

                log('info', `جلب ${contacts.length} مراسل`);
                return res.json({ success: true, data: { contacts, source: 'graph_api', total: contacts.length } });
            } catch (apiErr) {
                log('warn', 'فشل Graph API', { error: apiErr.message });
            }
        }

        // 2. Web Scraping
        if (req.session?.authenticated && fs.existsSync(SESSIONS_FILE)) {
            try {
                const enc = fs.readFileSync(SESSIONS_FILE, 'utf8');
                const dec = decrypt(enc);
                if (dec) {
                    const s = JSON.parse(dec);
                    const resp = await axios.get('https://www.facebook.com/messages', {
                        headers: {
                            'Cookie': s.raw,
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': 'text/html'
                        },
                        timeout: 20000
                    });

                    const html = resp.data;
                    const contacts = [];
                    const seen = new Set();
                    const re = /"name":"([^"]+)","first_name":"([^"]+)","id":"(\d+)"/g;
                    let m;
                    while ((m = re.exec(html)) !== null) {
                        if (!seen.has(m[3]) && m[3] !== s.userId) {
                            seen.add(m[3]);
                            contacts.push({ id: m[3], participants: [{ psid: m[3], name: m[1] }], source: 'scraped' });
                        }
                    }

                    if (contacts.length > 0) {
                        log('info', `جلب ${contacts.length} مراسل عبر Scraping`);
                        return res.json({ success: true, data: { contacts: contacts.slice(0, limit), source: 'scraped', total: contacts.length } });
                    }
                }
            } catch (scrapeErr) {
                log('warn', 'فشل Scraping', { error: scrapeErr.message });
            }
        }

        // 3. بيانات تجريبية
        if (NODE_ENV !== 'production') {
            const demo = [
                { id: 'demo_1', participants: [{ psid: '1001', name: 'أحمد محمد' }], lastMessage: 'مرحبا 👋', messageCount: 5 },
                { id: 'demo_2', participants: [{ psid: '1002', name: 'سارة علي' }], lastMessage: 'تمام شكراً', messageCount: 3 },
                { id: 'demo_3', participants: [{ psid: '1003', name: 'محمد خالد' }], lastMessage: 'بالتوفيق', messageCount: 8 },
                { id: 'demo_4', participants: [{ psid: '1004', name: 'نور أحمد' }], lastMessage: 'تم الاستلام', messageCount: 2 },
                { id: 'demo_5', participants: [{ psid: '1005', name: 'عمر حسن' }], lastMessage: 'شكراً جزيلاً', messageCount: 12 }
            ];
            return res.json({ success: true, data: { contacts: demo, source: 'demo', total: 5, note: '⚠️ بيانات تجريبية' } });
        }

        res.status(400).json({ success: false, error: 'لا يوجد مصدر للمراسلين. سجل الدخول بالكوكيز أو اربط API' });
    } catch (err) {
        log('error', 'فشل جلب المراسلين', { error: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
});

// إرسال رسالة
app.post('/api/send', async (req, res) => {
    try {
        const { recipientId, message } = req.body;
        if (!recipientId || !message) return res.status(400).json({ success: false, error: 'بيانات ناقصة' });

        if (!FB_PAGE_ID || !FB_ACCESS_TOKEN) {
            return res.status(400).json({ success: false, error: 'API غير مهيأ. أضف FB_PAGE_ID و FB_ACCESS_TOKEN' });
        }

        checkLimit();
        const result = await fbSendMessage(recipientId, message);
        recordSend();

        res.json({ success: true, data: { messageId: result.message_id, recipientId }, limits: { ...limits } });
    } catch (err) {
        res.status(err.message.includes('حد الإرسال') ? 429 : 500).json({ success: false, error: err.message });
    }
});

// إرسال جماعي
app.post('/api/broadcast', async (req, res) => {
    try {
        const { contacts, message } = req.body;
        if (!contacts?.length || !message) return res.status(400).json({ success: false, error: 'بيانات ناقصة' });

        if (!FB_PAGE_ID || !FB_ACCESS_TOKEN) {
            return res.status(400).json({ success: false, error: 'API غير مهيأ. أضف FB_PAGE_ID و FB_ACCESS_TOKEN' });
        }

        if (contacts.length > 50) return res.status(400).json({ success: false, error: 'الحد 50 مراسلاً' });

        const results = { sent: [], failed: [] };

        for (let i = 0; i < contacts.length; i++) {
            try {
                checkLimit();
                const c = contacts[i];
                const msg = message.replace(/\{name\}/g, c.name || 'العميل');
                const r = await fbSendMessage(c.psid || c.id, msg);
                results.sent.push({ id: c.psid || c.id, name: c.name, messageId: r.message_id });
                recordSend();
            } catch (err) {
                results.failed.push({ id: contacts[i].psid || contacts[i].id, name: contacts[i].name, error: err.message });
            }
            if (i < contacts.length - 1) await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
        }

        res.json({ success: true, data: { ...results, total: contacts.length, limits: { ...limits } } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// الحالة
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        data: {
            authenticated: !!req.session?.authenticated,
            userId: req.session?.userId,
            apiConfigured: !!(FB_PAGE_ID && FB_ACCESS_TOKEN),
            limits: { sent: limits.sent, max: limits.max, remaining: limits.max - limits.sent }
        }
    });
});

// خروج
app.post('/api/logout', (req, res) => {
    if (fs.existsSync(SESSIONS_FILE)) fs.unlinkSync(SESSIONS_FILE);
    req.session.destroy();
    res.json({ success: true, data: { message: 'تم تسجيل الخروج' } });
});

// ===================== الخطأ =====================
app.use((err, req, res, _next) => {
    log('error', 'Unhandled', { error: err.message });
    res.status(500).json({ success: false, error: NODE_ENV === 'production' ? 'خطأ داخلي' : err.message });
});

// ===================== التشغيل =====================
app.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(50));
    console.log('  🚀 Facebook Messenger API v3');
    console.log('  ' + '='.repeat(50));
    console.log(`  📡  http://0.0.0.0:${PORT}`);
    console.log(`  🔧  البيئة: ${NODE_ENV}`);
    console.log(`  📁  الواجهة: ${PUBLIC_DIR}/index.html`);
    console.log(`  📌  API: ${FB_PAGE_ID ? '✅ مهيأ' : '⚠️ غير مهيأ'}`);
    console.log('  ' + '='.repeat(50) + '\n');
});
