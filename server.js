// server.js - Flower Market Backend для Railway
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const NodeCache = require('node-cache');

const app = express();
const port = process.env.PORT || 3000;

// Настройки CORS
app.use(cors({
    origin: ['https://telegram.me', 'https://web.telegram.org', 'https://*.railway.app'],
    credentials: true
}));

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Кэш для хранения данных
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

// Папка для временных файлов
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// ==================== НАСТРОЙКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN ? 
    `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 
    (process.env.BASE_URL || `http://localhost:${port}`);

// Проверка обязательных переменных
const requiredEnvVars = ['BOT_TOKEN', 'CHANNEL_ID', 'ADMIN_CHAT_ID'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
    console.error('❌ ОШИБКА: Не настроены переменные окружения:');
    missingVars.forEach(varName => console.error(`   - ${varName}`));
    console.error('\nЗадайте их в Railway Dashboard:');
    console.error('   Settings → Variables → New Variable');
    process.exit(1);
}

console.log('✅ Переменные окружения загружены');
console.log(`   Bot: ${BOT_TOKEN ? '✅' : '❌'}`);
console.log(`   Channel: ${CHANNEL_ID}`);
console.log(`   Admin: ${ADMIN_CHAT_ID}`);
console.log(`   Google Client ID: ${GOOGLE_CLIENT_ID ? '✅' : '❌ (опционально)'}`);
console.log(`   URL: ${BASE_URL}`);

// ==================== ИНИЦИАЛИЗАЦИЯ ТЕЛЕГРАМ БОТА ====================
const bot = new Telegraf(BOT_TOKEN);

// Хранилище данных (в памяти, для продакшена используйте Redis или БД)
const usersDB = new Map();
const pendingAuth = new Map();

// ==================== GOOGLE OAuth НАСТРОЙКА ====================
let oauth2Client = null;
let googlePeople = null;

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    try {
        oauth2Client = new google.auth.OAuth2(
            GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET,
            `${BASE_URL}/auth/google/callback`
        );

        googlePeople = google.people({
            version: 'v1',
            auth: oauth2Client
        });
        
        console.log('✅ Google OAuth настроен');
    } catch (error) {
        console.warn('⚠️ Google OAuth не настроен, контакты через Google будут недоступны:', error.message);
    }
} else {
    console.warn('⚠️ GOOGLE_CLIENT_ID или GOOGLE_CLIENT_SECRET не установлены. Google импорт будет недоступен.');
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

// Форматирование подписи для объявления
function formatCaption(data) {
    const {
        description,
        price = 'Договорная',
        contacts = 'Контакты в комментариях',
        freshness,
        city,
        district = '',
        address = '',
        hashtags = '',
        userId
    } = data;
    
    let caption = '';
    
    caption += `🌺 <b>ЦВЕТЫ НА ПРОДАЖУ</b>\n\n`;
    
    if (description) {
        caption += `📝 <b>Описание:</b>\n${description}\n\n`;
    }
    
    caption += `📍 <b>Локация:</b> ${city}`;
    if (district) caption += `, ${district}`;
    if (address) caption += `\n🏠 <b>Адрес:</b> ${address}`;
    
    caption += `\n🕒 <b>Свежесть:</b> ${freshness}`;
    caption += `\n💰 <b>Цена:</b> ${price}`;
    caption += `\n📞 <b>Контакты:</b> ${contacts}`;
    
    if (hashtags) {
        caption += `\n\n${hashtags}`;
    }
    
    caption += `\n\n──────────────\n`;
    caption += `<i>ID: ${userId?.substring(0, 8)}... | Flower Market 🌸</i>`;
    
    return caption;
}

// Сохранение пользователя
function saveUser(user) {
    usersDB.set(user.id, user);
    cache.set(`user_${user.id}`, user, 3600); // Кэшируем на 1 час
    
    // Также сохраняем в файл для persistence
    const dbPath = path.join(__dirname, 'users.json');
    const usersArray = Array.from(usersDB.values());
    fs.writeFileSync(dbPath, JSON.stringify(usersArray, null, 2));
    
    return user;
}

// Загрузка пользователей из файла
function loadUsersFromFile() {
    try {
        const dbPath = path.join(__dirname, 'users.json');
        if (fs.existsSync(dbPath)) {
            const usersArray = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
            usersArray.forEach(user => {
                usersDB.set(user.id, user);
                cache.set(`user_${user.id}`, user);
            });
            console.log(`✅ Загружено ${usersArray.length} пользователей из файла`);
        }
    } catch (error) {
        console.warn('⚠️ Не удалось загрузить пользователей из файла:', error.message);
    }
}

// Получение контактов из Google
async function fetchGoogleContacts(accessToken, userId) {
    try {
        if (!oauth2Client || !googlePeople) {
            throw new Error('Google API не настроен');
        }
        
        oauth2Client.setCredentials({ access_token: accessToken });
        
        let allContacts = [];
        let pageToken = null;
        
        do {
            const response = await googlePeople.people.connections.list({
                resourceName: 'people/me',
                pageSize: 100,
                pageToken: pageToken || undefined,
                personFields: 'names,phoneNumbers,emailAddresses'
            });
            
            const connections = response.data.connections || [];
            allContacts = allContacts.concat(connections);
            pageToken = response.data.nextPageToken;
            
            console.log(`📥 Загружено ${allContacts.length} контактов для пользователя ${userId}`);
            
        } while (pageToken);
        
        // Форматируем контакты
        const formattedContacts = [];
        allContacts.forEach(contact => {
            if (contact.names && contact.names.length > 0) {
                const name = contact.names[0].displayName || 'Без имени';
                
                // Извлекаем телефоны
                const phones = (contact.phoneNumbers || [])
                    .map(p => p.value || '')
                    .filter(p => p.replace(/\D/g, '').length >= 10);
                
                // Извлекаем email
                const emails = (contact.emailAddresses || [])
                    .map(e => e.value || '')
                    .filter(e => e.includes('@'));
                
                if (phones.length > 0 || emails.length > 0) {
                    formattedContacts.push({
                        name,
                        phones,
                        emails,
                        source: 'google'
                    });
                }
            }
        });
        
        console.log(`✅ Отформатировано ${formattedContacts.length} контактов для пользователя ${userId}`);
        
        return formattedContacts;
        
    } catch (error) {
        console.error('❌ Ошибка получения контактов Google:', error);
        throw error;
    }
}

// ==================== РОУТЫ API ====================

// Главная страница
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Flower Market</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: white;
                    text-align: center;
                    padding: 20px;
                }
                .container {
                    max-width: 800px;
                    width: 100%;
                    padding: 40px;
                    background: rgba(255,255,255,0.1);
                    backdrop-filter: blur(10px);
                    border-radius: 24px;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                }
                h1 {
                    font-size: 2.8em;
                    margin-bottom: 20px;
                    color: white;
                    text-shadow: 0 2px 10px rgba(0,0,0,0.2);
                }
                p {
                    font-size: 1.2em;
                    margin-bottom: 30px;
                    opacity: 0.95;
                    line-height: 1.6;
                }
                .status {
                    background: rgba(255,255,255,0.15);
                    border-radius: 16px;
                    padding: 25px;
                    margin: 25px 0;
                    text-align: left;
                }
                .status h3 {
                    margin-bottom: 15px;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }
                .status-item {
                    margin: 12px 0;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px 0;
                    border-bottom: 1px solid rgba(255,255,255,0.1);
                }
                .btn {
                    display: inline-block;
                    background: white;
                    color: #667eea;
                    padding: 16px 32px;
                    border-radius: 16px;
                    text-decoration: none;
                    font-weight: bold;
                    font-size: 1.1em;
                    transition: all 0.3s ease;
                    margin: 10px;
                    border: 2px solid transparent;
                }
                .btn:hover {
                    transform: translateY(-3px);
                    box-shadow: 0 10px 30px rgba(0,0,0,0.3);
                    border-color: #667eea;
                }
                .btn-telegram {
                    background: #0088cc;
                    color: white;
                }
                .icon {
                    font-size: 4em;
                    margin-bottom: 20px;
                    animation: float 3s ease-in-out infinite;
                }
                @keyframes float {
                    0%, 100% { transform: translateY(0); }
                    50% { transform: translateY(-10px); }
                }
                .endpoints {
                    background: rgba(255,255,255,0.1);
                    border-radius: 12px;
                    padding: 20px;
                    margin: 25px 0;
                    text-align: left;
                    font-family: monospace;
                    font-size: 0.9em;
                }
                .endpoint {
                    margin: 8px 0;
                    padding: 10px;
                    background: rgba(255,255,255,0.05);
                    border-radius: 8px;
                    display: flex;
                    align-items: center;
                }
                .method {
                    display: inline-block;
                    padding: 4px 8px;
                    border-radius: 6px;
                    font-weight: bold;
                    margin-right: 15px;
                    min-width: 60px;
                    text-align: center;
                }
                .get { background: #10b981; color: white; }
                .post { background: #3b82f6; color: white; }
                .timestamp {
                    font-size: 0.9em;
                    opacity: 0.8;
                    margin-top: 20px;
                }
                @media (max-width: 768px) {
                    .container { padding: 25px; }
                    h1 { font-size: 2.2em; }
                    .btn { display: block; margin: 10px 0; }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="icon">🌺</div>
                <h1>Flower Market Backend</h1>
                <p>Платформа для продажи цветов в Telegram<br>Серверная часть работает стабильно</p>
                
                <div class="status">
                    <h3><span>📊</span> Статус системы</h3>
                    <div class="status-item">
                        <span>Сервер:</span>
                        <strong style="color: #10b981;">🟢 Работает</strong>
                    </div>
                    <div class="status-item">
                        <span>Пользователей:</span>
                        <strong>${usersDB.size}</strong>
                    </div>
                    <div class="status-item">
                        <span>Telegram Бот:</span>
                        <strong>${BOT_TOKEN ? '🟢 Активен' : '🔴 Ошибка'}</strong>
                    </div>
                    <div class="status-item">
                        <span>Google API:</span>
                        <strong>${GOOGLE_CLIENT_ID ? '🟢 Настроен' : '🟡 Опционально'}</strong>
                    </div>
                </div>
                
                <div class="endpoints">
                    <h3><span>🔌</span> Доступные API эндпоинты:</h3>
                    <div class="endpoint">
                        <span class="method get">GET</span>
                        <span>/health</span>
                    </div>
                    <div class="endpoint">
                        <span class="method get">GET</span>
                        <span>/api/status</span>
                    </div>
                    <div class="endpoint">
                        <span class="method get">GET</span>
                        <span>/api/user/:id/status</span>
                    </div>
                    <div class="endpoint">
                        <span class="method post">POST</span>
                        <span>/api/upload-contacts</span>
                    </div>
                    <div class="endpoint">
                        <span class="method post">POST</span>
                        <span>/api/publish-media-group</span>
                    </div>
                </div>
                
                <div style="margin: 30px 0;">
                    <a href="https://t.me/flower_market_kg_bot" class="btn btn-telegram" target="_blank">
                        <span style="font-size: 1.2em; margin-right: 10px;">🤖</span>
                        Открыть Telegram Бота
                    </a>
                    <a href="${BASE_URL}/health" class="btn" target="_blank">
                        <span style="font-size: 1.2em; margin-right: 10px;">🩺</span>
                        Health Check
                    </a>
                </div>
                
                <div class="timestamp">
                    Обновлено: ${new Date().toLocaleString('ru-RU')}<br>
                    URL: ${BASE_URL}
                </div>
            </div>
        </body>
        </html>
    `);
});

// Health check для Railway
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        service: 'flower-market-backend',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        users: usersDB.size,
        environment: process.env.NODE_ENV || 'development'
    });
});

// Статус сервера
app.get('/api/status', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Flower Market API работает',
        timestamp: new Date().toISOString(),
        users: usersDB.size,
        version: '1.0.0',
        endpoints: [
            'GET  /health',
            'GET  /api/status',
            'GET  /api/user/:id/status',
            'POST /api/upload-contacts',
            'POST /api/publish-media-group',
            'GET  /auth/google',
            'GET  /auth/google/callback'
        ]
    });
});

// ==================== GOOGLE OAuth РОУТЫ ====================

// Начало авторизации через Google
app.get('/auth/google', (req, res) => {
    if (!oauth2Client) {
        return res.status(503).send(`
            <!DOCTYPE html>
            <html>
            <head><title>Ошибка</title><style>body{font-family:sans-serif;padding:40px;text-align:center;}</style></head>
            <body>
                <h1>❌ Google API не настроен</h1>
                <p>Администратор не настроил интеграцию с Google</p>
                <p>Пожалуйста, используйте другие методы импорта контактов</p>
                <a href="/">На главную</a>
            </body>
            </html>
        `);
    }
    
    const { userId, chatId, redirect = 'contacts' } = req.query;
    
    if (!userId || !chatId) {
        return res.status(400).send('Не указаны userId и chatId');
    }
    
    // Сохраняем данные в сессии
    const state = crypto.randomBytes(16).toString('hex');
    pendingAuth.set(state, { userId, chatId, redirect, timestamp: Date.now() });
    
    // Очищаем старые сессии (старше 10 минут)
    for (const [key, data] of pendingAuth.entries()) {
        if (Date.now() - data.timestamp > 10 * 60 * 1000) {
            pendingAuth.delete(key);
        }
    }
    
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/contacts.readonly'
        ],
        state: state,
        prompt: 'consent',
        include_granted_scopes: true
    });
    
    console.log(`🔐 Начало авторизации Google для userId: ${userId}`);
    res.redirect(authUrl);
});

// Callback от Google OAuth
app.get('/auth/google/callback', async (req, res) => {
    try {
        const { code, state, error } = req.query;
        
        if (error) {
            console.error('❌ Ошибка авторизации Google:', error);
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Ошибка авторизации</title>
                    <style>
                        body {
                            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                            background: linear-gradient(135deg, #ff6b6b 0%, #ee5a52 100%);
                            height: 100vh;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            color: white;
                            text-align: center;
                            padding: 20px;
                        }
                        .container { max-width: 500px; padding: 40px; }
                        h1 { margin-bottom: 20px; }
                        .btn {
                            display: inline-block;
                            margin-top: 20px;
                            padding: 12px 24px;
                            background: white;
                            color: #ff6b6b;
                            text-decoration: none;
                            border-radius: 12px;
                            font-weight: bold;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>❌ Ошибка авторизации</h1>
                        <p>${error === 'access_denied' ? 'Вы отказались от предоставления доступа' : error}</p>
                        <a href="/" class="btn">Вернуться на главную</a>
                    </div>
                </body>
                </html>
            `);
        }
        
        // Проверяем state
        const sessionData = pendingAuth.get(state);
        if (!sessionData) {
            throw new Error('Сессия устарела или не найдена. Попробуйте снова.');
        }
        
        const { userId, chatId, redirect } = sessionData;
        
        // Получаем токены
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        
        console.log(`✅ Получены токены для userId: ${userId}`);
        
        // Получаем информацию о пользователе
        const userInfo = await google.oauth2('v2').userinfo.get({ auth: oauth2Client });
        const { name, email } = userInfo.data;
        
        // Получаем контакты
        const contacts = await fetchGoogleContacts(tokens.access_token, userId);
        
        // Сохраняем пользователя
        let user = usersDB.get(userId) || {
            id: userId.toString(),
            chatId: chatId,
            username: null,
            firstName: null,
            lastName: null,
            contacts: [],
            hasContacts: false,
            approved: false,
            createdAt: new Date()
        };
        
        user.googleTokens = tokens;
        user.googleInfo = { name, email };
        user.contacts = contacts;
        user.hasContacts = contacts.length > 0;
        user.contactsImportedAt = new Date();
        user.importSource = 'google';
        
        saveUser(user);
        
        // Удаляем временные данные
        pendingAuth.delete(state);
        
        // Отправляем уведомление администратору
        if (contacts.length > 0) {
            try {
                await bot.telegram.sendMessage(
                    ADMIN_CHAT_ID,
                    `✅ НОВЫЙ ПОЛЬЗОВАТЕЛЬ ЧЕРЕЗ GOOGLE\n\n` +
                    `👤 Имя: ${name}\n` +
                    `📧 Email: ${email}\n` +
                    `🆔 ID: ${userId}\n` +
                    `📞 Контактов: ${contacts.length}\n\n` +
                    `Для подтверждения нажмите кнопку ниже:`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: '✅ Подтвердить пользователя',
                                        callback_data: `approve_user:${userId}`
                                    },
                                    {
                                        text: '❌ Отклонить',
                                        callback_data: `reject_user:${userId}`
                                    }
                                ]
                            ]
                        }
                    }
                );
            } catch (botError) {
                console.error('❌ Ошибка отправки уведомления:', botError);
            }
        }
        
        // Перенаправляем на страницу успеха
        const successUrl = `${BASE_URL}/index.html?userId=${userId}&chatId=${chatId}&googleSuccess=true`;
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Успешная авторизация</title>
                <meta http-equiv="refresh" content="3;url=${successUrl}">
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                        background: linear-gradient(135deg, #34c759 0%, #28a745 100%);
                        height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        color: white;
                        text-align: center;
                        padding: 20px;
                    }
                    .container { max-width: 600px; padding: 40px; }
                    .icon { 
                        font-size: 5em; 
                        margin-bottom: 20px;
                        animation: bounce 1s ease infinite;
                    }
                    @keyframes bounce {
                        0%, 100% { transform: translateY(0); }
                        50% { transform: translateY(-20px); }
                    }
                    h1 { margin-bottom: 20px; font-size: 2.5em; }
                    p { margin-bottom: 10px; font-size: 1.1em; opacity: 0.9; }
                    .stats {
                        background: rgba(255,255,255,0.15);
                        border-radius: 16px;
                        padding: 20px;
                        margin: 25px 0;
                        text-align: center;
                    }
                    .loader {
                        display: inline-block;
                        width: 50px;
                        height: 50px;
                        border: 5px solid rgba(255,255,255,0.3);
                        border-radius: 50%;
                        border-top-color: white;
                        animation: spin 1s ease-in-out infinite;
                        margin: 20px auto;
                    }
                    @keyframes spin {
                        to { transform: rotate(360deg); }
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="icon">✅</div>
                    <h1>Авторизация успешна!</h1>
                    <div class="stats">
                        <p><strong>👤 Имя:</strong> ${name}</p>
                        <p><strong>📧 Email:</strong> ${email}</p>
                        <p><strong>📞 Контактов импортировано:</strong> ${contacts.length}</p>
                    </div>
                    <p>Администратор получил уведомление о вашей заявке.</p>
                    <p>Ожидайте подтверждения (обычно до 24 часов).</p>
                    <p>Перенаправление на сайт через 3 секунды...</p>
                    <div class="loader"></div>
                </div>
                <script>
                    setTimeout(() => {
                        window.location.href = '${successUrl}';
                    }, 3000);
                </script>
            </body>
            </html>
        `);
        
    } catch (error) {
        console.error('❌ Ошибка обработки Google callback:', error);
        
        const errorPage = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Ошибка</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                        background: linear-gradient(135deg, #ff6b6b 0%, #ee5a52 100%);
                        height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        color: white;
                        text-align: center;
                        padding: 20px;
                    }
                    .container { max-width: 600px; padding: 40px; }
                    h1 { margin-bottom: 20px; }
                    .error-details {
                        background: rgba(255,255,255,0.1);
                        border-radius: 12px;
                        padding: 20px;
                        margin: 20px 0;
                        text-align: left;
                        font-family: monospace;
                        font-size: 0.9em;
                        overflow-wrap: break-word;
                    }
                    .btn {
                        display: inline-block;
                        margin-top: 20px;
                        padding: 12px 24px;
                        background: white;
                        color: #ff6b6b;
                        text-decoration: none;
                        border-radius: 12px;
                        font-weight: bold;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>❌ Ошибка при авторизации</h1>
                    <p>${error.message}</p>
                    <div class="error-details">
                        ${error.stack || 'Нет дополнительной информации'}
                    </div>
                    <a href="/" class="btn">Вернуться на главную</a>
                </div>
            </body>
            </html>
        `;
        
        res.status(500).send(errorPage);
    }
});

// ==================== API ДЛЯ РАБОТЫ С КОНТАКТАМИ ====================

// Загрузка контактов
app.post('/api/upload-contacts', async (req, res) => {
    try {
        const { userId, chatId, contacts, firstName = 'Пользователь', importSource = 'manual' } = req.body;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'Требуется userId'
            });
        }
        
        if (!contacts || !Array.isArray(contacts)) {
            return res.status(400).json({
                success: false,
                error: 'Требуется массив contacts'
            });
        }
        
        console.log(`📤 Получены контакты от ${userId} (${firstName}): ${contacts.length} шт, источник: ${importSource}`);
        
        // Проверяем минимальное количество контактов
        if (contacts.length < 3) {
            return res.status(400).json({
                success: false,
                error: 'Требуется минимум 3 контакта'
            });
        }
        
        // Находим или создаем пользователя
        let user = usersDB.get(userId.toString());
        if (!user) {
            user = {
                id: userId.toString(),
                chatId: chatId || userId.toString(),
                firstName: firstName,
                contacts: [],
                hasContacts: false,
                approved: false,
                createdAt: new Date()
            };
        }
        
        // Сохраняем контакты
        user.contacts = contacts;
        user.hasContacts = true;
        user.contactsImportedAt = new Date();
        user.importSource = importSource;
        user.firstName = firstName || user.firstName;
        
        saveUser(user);
        
        // Отправляем уведомление администратору
        try {
            await bot.telegram.sendMessage(
                ADMIN_CHAT_ID,
                `📞 НОВЫЕ КОНТАКТЫ ОТ ПОЛЬЗОВАТЕЛЯ\n\n` +
                `👤 Пользователь: ${firstName}\n` +
                `🆔 ID: ${userId}\n` +
                `📊 Контактов: ${contacts.length}\n` +
                `📱 Источник: ${importSource}\n` +
                `⏰ Время: ${new Date().toLocaleString('ru-RU')}\n\n` +
                `Для подтверждения нажмите кнопку ниже:`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '✅ Подтвердить пользователя',
                                    callback_data: `approve_user:${userId}`
                                },
                                {
                                    text: '❌ Отклонить',
                                    callback_data: `reject_user:${userId}`
                                }
                            ],
                            [
                                {
                                    text: '👀 Посмотреть контакты',
                                    callback_data: `view_contacts:${userId}`
                                }
                            ]
                        ]
                    }
                }
            );
            
            console.log(`✅ Уведомление отправлено администратору для userId: ${userId}`);
            
        } catch (botError) {
            console.error('❌ Ошибка отправки уведомления:', botError);
            // Не прерываем выполнение если не удалось отправить уведомление
        }
        
        res.json({
            success: true,
            message: `Контакты успешно сохранены (${contacts.length} контактов)`,
            count: contacts.length,
            userId: userId,
            approved: user.approved || false
        });
        
    } catch (error) {
        console.error('❌ Ошибка загрузки контактов:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            message: 'Ошибка при сохранении контактов'
        });
    }
});

// Проверка статуса пользователя
app.get('/api/user/:userId/status', (req, res) => {
    try {
        const { userId } = req.params;
        
        const user = usersDB.get(userId);
        
        if (!user) {
            return res.json({
                hasContacts: false,
                contactsCount: 0,
                approved: false,
                message: 'Пользователь не найден. Сначала загрузите контакты.'
            });
        }
        
        res.json({
            hasContacts: user.hasContacts || false,
            contactsCount: user.contacts?.length || 0,
            approved: user.approved || false,
            importedAt: user.contactsImportedAt,
            importSource: user.importSource,
            firstName: user.firstName,
            googleConnected: !!user.googleInfo,
            postsCount: user.postsCount || 0,
            lastPostAt: user.lastPostAt,
            message: user.approved ? 
                'Аккаунт подтвержден. Можете создавать объявления.' : 
                'Ожидайте подтверждения администратором.'
        });
        
    } catch (error) {
        console.error('❌ Ошибка проверки статуса:', error);
        res.status(500).json({
            hasContacts: false,
            contactsCount: 0,
            approved: false,
            error: error.message
        });
    }
});

// ==================== API ДЛЯ ПУБЛИКАЦИИ ОБЪЯВЛЕНИЙ ====================

// Публикация медиа-группы
app.post('/api/publish-media-group', async (req, res) => {
    let tempFiles = [];
    
    try {
        const {
            userId,
            chatId,
            description,
            price,
            contacts,
            freshness,
            city,
            district,
            address,
            hashtags,
            mediaFiles = []
        } = req.body;
        
        console.log(`📤 Запрос на публикацию от userId: ${userId}`);
        
        // Проверяем пользователя
        const user = usersDB.get(userId.toString());
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'Пользователь не найден. Сначала загрузите контакты.'
            });
        }
        
        // Проверяем, подтвержден ли пользователь
        if (!user.approved) {
            return res.status(403).json({
                success: false,
                error: 'Ваш аккаунт еще не подтвержден администратором. Ожидайте подтверждения.'
            });
        }
        
        // Проверяем наличие контактов
        if (!user.hasContacts) {
            return res.status(400).json({
                success: false,
                error: 'Контакты не загружены. Сначала загрузите контакты.'
            });
        }
        
        // Проверяем обязательные поля
        const errors = [];
        if (!description) errors.push('описание');
        if (!city) errors.push('город');
        if (!freshness) errors.push('свежесть');
        
        if (errors.length > 0) {
            return res.status(400).json({
                success: false,
                error: `Заполните обязательные поля: ${errors.join(', ')}`
            });
        }
        
        // Проверяем медиафайлы
        if (mediaFiles.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Добавьте хотя бы одно фото или видео'
            });
        }
        
        if (mediaFiles.length > 10) {
            return res.status(400).json({
                success: false,
                error: 'Максимум 10 файлов за раз'
            });
        }
        
        console.log(`📷 Обработка ${mediaFiles.length} медиафайлов...`);
        
        // Подготавливаем медиа для Telegram
        const mediaGroup = [];
        
        for (let i = 0; i < Math.min(mediaFiles.length, 10); i++) {
            const media = mediaFiles[i];
            
            if (!media.data || !media.type) {
                console.warn(`⚠️ Пропущен файл ${i}: нет данных или типа`);
                continue;
            }
            
            try {
                // Проверяем тип файла
                const isImage = media.type.startsWith('image/');
                const isVideo = media.type.startsWith('video/');
                
                if (!isImage && !isVideo) {
                    console.warn(`⚠️ Пропущен файл ${i}: не поддерживаемый тип ${media.type}`);
                    continue;
                }
                
                // Декодируем base64
                const base64Data = media.data.split(',')[1] || media.data;
                const buffer = Buffer.from(base64Data, 'base64');
                
                // Сохраняем временный файл
                const ext = isImage ? '.jpg' : '.mp4';
                const filename = `temp_${Date.now()}_${i}${ext}`;
                const filepath = path.join(tempDir, filename);
                
                fs.writeFileSync(filepath, buffer);
                tempFiles.push(filepath);
                
                // Добавляем в медиагруппу
                if (isImage) {
                    mediaGroup.push({
                        type: 'photo',
                        media: { source: filepath },
                        caption: i === 0 ? formatCaption({
                            description,
                            price: price || 'Договорная',
                            contacts: contacts || 'Контакты в комментариях',
                            freshness,
                            city,
                            district,
                            address,
                            hashtags: hashtags || '#цветы #продажа',
                            userId
                        }) : undefined
                    });
                } else {
                    mediaGroup.push({
                        type: 'video',
                        media: { source: filepath },
                        caption: i === 0 ? formatCaption({
                            description,
                            price: price || 'Договорная',
                            contacts: contacts || 'Контакты в комментариях',
                            freshness,
                            city,
                            district,
                            address,
                            hashtags: hashtags || '#цветы #продажа',
                            userId
                        }) : undefined
                    });
                }
                
                console.log(`✅ Файл ${i} подготовлен: ${media.type}, ${Math.round(buffer.length / 1024)}KB`);
                
            } catch (error) {
                console.error(`❌ Ошибка обработки файла ${i}:`, error);
                continue;
            }
        }
        
        if (mediaGroup.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Не удалось обработать ни один файл'
            });
        }
        
        console.log(`📤 Отправляем ${mediaGroup.length} файлов в канал ${CHANNEL_ID}...`);
        
        // Отправляем в канал
        let sentMessages;
        try {
            if (mediaGroup.length === 1) {
                // Одиночное фото/видео
                const media = mediaGroup[0];
                if (media.type === 'photo') {
                    sentMessages = await bot.telegram.sendPhoto(
                        CHANNEL_ID,
                        { source: media.media.source },
                        {
                            caption: media.caption,
                            parse_mode: 'HTML'
                        }
                    );
                } else {
                    sentMessages = await bot.telegram.sendVideo(
                        CHANNEL_ID,
                        { source: media.media.source },
                        {
                            caption: media.caption,
                            parse_mode: 'HTML'
                        }
                    );
                }
                sentMessages = [sentMessages];
            } else {
                // Медиагруппа
                sentMessages = await bot.telegram.sendMediaGroup(
                    CHANNEL_ID,
                    mediaGroup.map(m => ({
                        type: m.type,
                        media: m.media.source,
                        ...(m.caption && { caption: m.caption }),
                        parse_mode: 'HTML'
                    }))
                );
            }
            
            console.log(`✅ Объявление опубликовано! Сообщений: ${sentMessages.length}`);
            
            // Обновляем статистику пользователя
            user.postsCount = (user.postsCount || 0) + 1;
            user.lastPostAt = new Date();
            saveUser(user);
            
            // Отправляем уведомление пользователю
            if (user.chatId) {
                try {
                    const messageLink = `https://t.me/c/${CHANNEL_ID.replace('@', '').replace('-100', '').replace('-', '_')}/${sentMessages[0].message_id}`;
                    
                    await bot.telegram.sendMessage(
                        user.chatId,
                        `✅ <b>ВАШЕ ОБЪЯВЛЕНИЕ ОПУБЛИКОВАНО!</b>\n\n` +
                        `📊 <b>Статистика:</b>\n` +
                        `• Файлов: ${mediaGroup.length}\n` +
                        `• Город: ${city}\n` +
                        `• Свежесть: ${freshness}\n` +
                        `• Цена: ${price || 'Договорная'}\n\n` +
                        `<a href="${messageLink}">↗️ Перейти к объявлению</a>\n\n` +
                        `<i>Объявление активно 7 дней. Для редактирования обратитесь к администратору.</i>`,
                        {
                            parse_mode: 'HTML',
                            disable_web_page_preview: true,
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        {
                                            text: '📝 Создать еще объявление',
                                            web_app: { url: `${BASE_URL}/index.html?userId=${userId}&chatId=${user.chatId}` }
                                        }
                                    ]
                                ]
                            }
                        }
                    );
                    
                } catch (userNotifyError) {
                    console.error('❌ Ошибка уведомления пользователя:', userNotifyError);
                }
            }
            
            // Отправляем уведомление администратору
            try {
                await bot.telegram.sendMessage(
                    ADMIN_CHAT_ID,
                    `📢 НОВОЕ ОБЪЯВЛЕНИЕ ОПУБЛИКОВАНО\n\n` +
                    `👤 Пользователь: ${user.firstName || userId}\n` +
                    `📊 Файлов: ${mediaGroup.length}\n` +
                    `📍 Город: ${city}\n` +
                    `💵 Цена: ${price || 'Договорная'}\n` +
                    `🌺 Свежесть: ${freshness}\n\n` +
                    `📝 Описание:\n${description.substring(0, 200)}...`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: '👁️ Посмотреть объявление',
                                        url: `https://t.me/c/${CHANNEL_ID.replace('@', '').replace('-100', '').replace('-', '_')}/${sentMessages[0].message_id}`
                                    }
                                ],
                                [
                                    {
                                        text: '👤 Инфо о пользователе',
                                        callback_data: `user_info:${userId}`
                                    }
                                ]
                            ]
                        }
                    }
                );
                
            } catch (adminNotifyError) {
                console.error('❌ Ошибка уведомления администратора:', adminNotifyError);
            }
            
            res.json({
                success: true,
                message: `Объявление успешно опубликовано с ${mediaGroup.length} файлами`,
                mediaCount: mediaGroup.length,
                messageId: sentMessages[0]?.message_id,
                channel: CHANNEL_ID,
                link: `https://t.me/c/${CHANNEL_ID.replace('@', '').replace('-100', '').replace('-', '_')}/${sentMessages[0].message_id}`
            });
            
        } catch (telegramError) {
            console.error('❌ Ошибка отправки в Telegram:', telegramError);
            
            // Пытаемся отправить текстовое сообщение об ошибке
            try {
                const textMessage = await bot.telegram.sendMessage(
                    CHANNEL_ID,
                    formatCaption({
                        description,
                        price: price || 'Договорная',
                        contacts: contacts || 'Контакты в комментариях',
                        freshness,
                        city,
                        district,
                        address,
                        hashtags: hashtags || '#цветы #продажа',
                        userId,
                        error: true
                    }),
                    { parse_mode: 'HTML' }
                );
                
                // Обновляем статистику пользователя
                user.postsCount = (user.postsCount || 0) + 1;
                user.lastPostAt = new Date();
                saveUser(user);
                
                res.json({
                    success: true,
                    message: 'Текст объявления опубликован (без файлов)',
                    mediaCount: 0,
                    messageId: textMessage.message_id,
                    error: telegramError.message
                });
                
            } catch (textError) {
                throw new Error(`Не удалось отправить ни медиа, ни текст: ${telegramError.message}`);
            }
        }
        
    } catch (error) {
        console.error('❌ Ошибка публикации:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            message: 'Ошибка при публикации объявления'
        });
    } finally {
        // Очищаем временные файлы через 30 секунд
        setTimeout(() => {
            tempFiles.forEach(filepath => {
                try {
                    if (fs.existsSync(filepath)) {
                        fs.unlinkSync(filepath);
                        console.log(`🧹 Удален временный файл: ${filepath}`);
                    }
                } catch (cleanupError) {
                    console.error('❌ Ошибка удаления временного файла:', cleanupError);
                }
            });
        }, 30000);
    }
});

// ==================== ТЕЛЕГРАМ БОТ КОМАНДЫ ====================

// Команда /start
bot.start(async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const username = ctx.from.username;
    const firstName = ctx.from.first_name;
    const lastName = ctx.from.last_name;
    
    console.log(`👋 Новый пользователь: @${username || 'без username'} (${userId})`);
    
    // Сохраняем пользователя
    let user = usersDB.get(userId);
    if (!user) {
        user = {
            id: userId,
            chatId: chatId,
            username: username,
            firstName: firstName,
            lastName: lastName,
            contacts: [],
            hasContacts: false,
            approved: false,
            createdAt: new Date()
        };
        saveUser(user);
    } else {
        // Обновляем информацию
        user.username = username;
        user.firstName = firstName;
        user.lastName = lastName;
        user.chatId = chatId;
        saveUser(user);
    }
    
    // Создаем уникальную ссылку для пользователя
    const webAppUrl = `${BASE_URL}/index.html?userId=${userId}&chatId=${chatId}`;
    const googleAuthUrl = `${BASE_URL}/auth/google?userId=${userId}&chatId=${chatId}`;
    
    await ctx.reply(
        `🌸 <b>ДОБРО ПОЖАЛОВАТЬ В FLOWER MARKET!</b>\n\n` +
        `Здесь вы можете разместить объявление о продаже цветов с фото и видео в одном посте.\n\n` +
        `<b>📋 ТРЕБОВАНИЯ ДЛЯ ПУБЛИКАЦИИ:</b>\n` +
        `1. 📞 Импорт ваших контактов (минимум 3 контакта)\n` +
        `2. ✅ Подтверждение администратором\n` +
        `3. 📝 Создание объявления\n\n` +
        `<i>Контакты нужны для проверки надежности продавцов. Мы не передаем их третьим лицам.</i>\n\n` +
        `<b>Ваш статус:</b>\n` +
        `• Контакты: ${user.hasContacts ? '✅ Загружены' : '❌ Не загружены'}\n` +
        `• Подтверждение: ${user.approved ? '✅ Подтвержден' : '⏳ Ожидает'}\n` +
        `• Объявлений: ${user.postsCount || 0}`,
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '🌐 Перейти на сайт',
                            web_app: { url: webAppUrl }
                        }
                    ]
                ]
            }
        }
    );
});

// Команда /help
bot.help((ctx) => {
    ctx.reply(
        `🆘 <b>ПОМОЩЬ ПО ИСПОЛЬЗОВАНИЮ FLOWER MARKET</b>\n\n` +
        `<b>ОСНОВНЫЕ КОМАНДЫ:</b>\n` +
        `/start - Начать работу с ботом\n` +
        `/status - Проверить статус аккаунта\n` +
        `/help - Показать это сообщение\n\n` +
        `<b>ПРОЦЕСС ПУБЛИКАЦИИ:</b>\n` +
        `1. Нажмите "Перейти на сайт"\n` +
        `2. Импортируйте контакты\n` +
        `3. Дождитесь подтверждения\n` +
        `4. Создайте объявление\n\n` +
        `<b>ПОДДЕРЖКА:</b> Свяжитесь с администратором`,
        { parse_mode: 'HTML' }
    );
});

// Команда /status
bot.command('status', async (ctx) => {
    const userId = ctx.from.id.toString();
    const user = usersDB.get(userId);
    
    if (!user) {
        return ctx.reply(
            `❌ Вы еще не начинали работу с ботом. Используйте /start чтобы начать.`,
            { parse_mode: 'HTML' }
        );
    }
    
    let statusMessage = `📊 <b>СТАТУС ВАШЕГО АККАУНТА</b>\n\n`;
    
    statusMessage += `👤 <b>Пользователь:</b> ${user.firstName || ''} ${user.lastName || ''}\n`;
    statusMessage += `🆔 <b>ID:</b> ${user.id}\n`;
    
    if (user.googleInfo) {
        statusMessage += `🔐 <b>Google:</b> ${user.googleInfo.email}\n`;
    }
    
    statusMessage += `\n📞 <b>Контакты:</b> `;
    
    if (user.hasContacts) {
        statusMessage += `✅ Загружены (${user.contacts?.length || 0} контактов)\n`;
        statusMessage += `📅 <b>Импортированы:</b> ${user.contactsImportedAt?.toLocaleDateString('ru-RU') || 'неизвестно'}\n`;
    } else {
        statusMessage += `❌ Не загружены\n`;
    }
    
    statusMessage += `\n✅ <b>Подтверждение:</b> `;
    
    if (user.approved) {
        statusMessage += `✅ Подтвержден администратором\n`;
        statusMessage += `📅 <b>Подтвержден:</b> ${user.approvedAt?.toLocaleDateString('ru-RU') || 'неизвестно'}\n`;
        statusMessage += `📊 <b>Опубликовано объявлений:</b> ${user.postsCount || 0}\n`;
        if (user.lastPostAt) {
            statusMessage += `📅 <b>Последний пост:</b> ${user.lastPostAt.toLocaleDateString('ru-RU')}\n`;
        }
    } else {
        statusMessage += `⏳ Ожидает подтверждения\n`;
        statusMessage += `<i>Администратор получил ваши контакты и скоро примет решение.</i>\n`;
    }
    
    const webAppUrl = `${BASE_URL}/index.html?userId=${userId}&chatId=${user.chatId}`;
    
    if (!user.hasContacts) {
        statusMessage += `\n🔗 <b>Следующий шаг:</b> Перейдите на сайт чтобы загрузить контакты.`;
        
        await ctx.reply(statusMessage, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '🌐 Загрузить контакты',
                            web_app: { url: webAppUrl }
                        }
                    ]
                ]
            }
        });
    } else if (!user.approved) {
        statusMessage += `\n⏳ <b>Ожидайте подтверждения.</b> Обычно это занимает до 24 часов.`;
        
        await ctx.reply(statusMessage, { parse_mode: 'HTML' });
    } else {
        statusMessage += `\n🎉 <b>Вы можете создавать объявления!</b>`;
        
        await ctx.reply(statusMessage, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '📝 Создать объявление',
                            web_app: { url: webAppUrl }
                        }
                    ]
                ]
            }
        });
    }
});

// Обработка callback-запросов (кнопки администратора)
bot.on('callback_query', async (ctx) => {
    try {
        const callbackData = ctx.callbackQuery.data;
        
        // Логируем callback
        console.log(`🔄 Callback от ${ctx.from.username || ctx.from.id}: ${callbackData}`);
        
        if (callbackData.startsWith('approve_user:')) {
            const userId = callbackData.split(':')[1];
            const user = usersDB.get(userId);
            
            if (!user) {
                return ctx.answerCbQuery('❌ Пользователь не найден');
            }
            
            // Подтверждение пользователя
            user.approved = true;
            user.approvedAt = new Date();
            user.approvedBy = ctx.from.username || ctx.from.first_name;
            saveUser(user);
            
            // Уведомляем администратора
            await ctx.editMessageText(
                `✅ <b>ПОЛЬЗОВАТЕЛЬ ПОДТВЕРЖДЕН</b>\n\n` +
                `👤 Пользователь: ${user.firstName || userId}\n` +
                `🆔 ID: ${userId}\n` +
                `📊 Контактов: ${user.contacts?.length || 0}\n` +
                `✅ Подтвержден: ${new Date().toLocaleString('ru-RU')}\n` +
                `👮 Подтвердил: @${ctx.from.username || ctx.from.first_name}`,
                { parse_mode: 'HTML' }
            );
            
            // Уведомляем пользователя
            if (user.chatId) {
                try {
                    const webAppUrl = `${BASE_URL}/index.html?userId=${userId}&chatId=${user.chatId}`;
                    
                    await bot.telegram.sendMessage(
                        user.chatId,
                        `🎉 <b>ВАШ АККАУНТ ПОДТВЕРЖДЕН!</b>\n\n` +
                        `Теперь вы можете создавать объявления о продаже цветов.\n\n` +
                        `<b>📋 ЧТО ДАЛЬШЕ?</b>\n` +
                        `1. Нажмите кнопку ниже\n` +
                        `2. Создайте объявление с фото/видео\n` +
                        `3. Опубликуйте в канале\n\n` +
                        `<i>Ваше объявление будет размещено в канале @${CHANNEL_ID.replace('@', '')}</i>`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        {
                                            text: '📝 Создать объявление',
                                            web_app: { url: webAppUrl }
                                        }
                                    ]
                                ]
                            }
                        }
                    );
                    
                } catch (userError) {
                    console.error('❌ Ошибка уведомления пользователя:', userError);
                }
            }
            
            await ctx.answerCbQuery('✅ Пользователь подтвержден');
            
        } else if (callbackData.startsWith('reject_user:')) {
            const userId = callbackData.split(':')[1];
            const user = usersDB.get(userId);
            
            if (!user) {
                return ctx.answerCbQuery('❌ Пользователь не найден');
            }
            
            // Отклонение пользователя
            user.rejected = true;
            user.rejectedAt = new Date();
            user.rejectedBy = ctx.from.username || ctx.from.first_name;
            saveUser(user);
            
            await ctx.editMessageText(
                `❌ <b>ПОЛЬЗОВАТЕЛЬ ОТКЛОНЕН</b>\n\n` +
                `👤 Пользователь: ${user.firstName || userId}\n` +
                `🆔 ID: ${userId}\n` +
                `📅 Отклонен: ${new Date().toLocaleString('ru-RU')}\n` +
                `👮 Отклонил: @${ctx.from.username || ctx.from.first_name}`,
                { parse_mode: 'HTML' }
            );
            
            // Уведомляем пользователя
            if (user.chatId) {
                try {
                    await bot.telegram.sendMessage(
                        user.chatId,
                        `❌ <b>ВАША ЗАЯВКА ОТКЛОНЕНА</b>\n\n` +
                        `К сожалению, администратор отклонил вашу заявку на публикацию объявлений.\n\n` +
                        `<b>ВОЗМОЖНЫЕ ПРИЧИНЫ:</b>\n` +
                        `• Недостаточно контактов\n` +
                        `• Подозрительная активность\n` +
                        `• Нарушение правил\n\n` +
                        `Если вы считаете это ошибкой, свяжитесь с администратором.`,
                        { parse_mode: 'HTML' }
                    );
                } catch (userError) {
                    console.error('❌ Ошибка уведомления пользователя:', userError);
                }
            }
            
            await ctx.answerCbQuery('❌ Пользователь отклонен');
            
        } else if (callbackData.startsWith('view_contacts:')) {
            const userId = callbackData.split(':')[1];
            const user = usersDB.get(userId);
            
            if (!user) {
                return ctx.answerCbQuery('❌ Пользователь не найден');
            }
            
            if (!user.contacts || user.contacts.length === 0) {
                return ctx.answerCbQuery('❌ У пользователя нет контактов');
            }
            
            let contactsText = `📞 <b>КОНТАКТЫ ПОЛЬЗОВАТЕЛЯ ${user.firstName || userId}</b>\n\n`;
            contactsText += `📊 Всего: ${user.contacts.length}\n`;
            contactsText += `📱 Источник: ${user.importSource || 'неизвестно'}\n`;
            contactsText += `📅 Дата: ${user.contactsImportedAt?.toLocaleString('ru-RU') || 'неизвестно'}\n\n`;
            
            // Показываем первые 5 контактов
            user.contacts.slice(0, 5).forEach((contact, index) => {
                contactsText += `<b>${index + 1}.</b> ${contact.name || 'Без имени'}\n`;
                if (contact.phone) {
                    contactsText += `   📱 ${contact.phone}\n`;
                }
                if (contact.phones && contact.phones.length > 0) {
                    contact.phones.forEach(phone => {
                        contactsText += `   📱 ${phone}\n`;
                    });
                }
                if (contact.emails && contact.emails.length > 0) {
                    contact.emails.forEach(email => {
                        contactsText += `   📧 ${email}\n`;
                    });
                }
                contactsText += '\n';
            });
            
            if (user.contacts.length > 5) {
                contactsText += `... и еще ${user.contacts.length - 5} контактов\n`;
            }
            
            await ctx.reply(contactsText, {
                parse_mode: 'HTML',
                reply_to_message_id: ctx.callbackQuery.message?.message_id
            });
            
            await ctx.answerCbQuery('📞 Контакты показаны');
            
        } else if (callbackData.startsWith('user_info:')) {
            const userId = callbackData.split(':')[1];
            const user = usersDB.get(userId);
            
            if (!user) {
                return ctx.answerCbQuery('❌ Пользователь не найден');
            }
            
            let userInfo = `👤 <b>ИНФОРМАЦИЯ О ПОЛЬЗОВАТЕЛЕ</b>\n\n`;
            userInfo += `🆔 <b>ID:</b> ${user.id}\n`;
            userInfo += `💬 <b>Chat ID:</b> ${user.chatId}\n`;
            
            if (user.username) {
                userInfo += `👤 <b>Username:</b> @${user.username}\n`;
            }
            
            if (user.firstName || user.lastName) {
                userInfo += `👥 <b>Имя:</b> ${user.firstName || ''} ${user.lastName || ''}\n`;
            }
            
            if (user.googleInfo) {
                userInfo += `🔐 <b>Google:</b> ${user.googleInfo.email}\n`;
                userInfo += `📛 <b>Имя в Google:</b> ${user.googleInfo.name}\n`;
            }
            
            userInfo += `\n📅 <b>Зарегистрирован:</b> ${user.createdAt?.toLocaleString('ru-RU') || 'неизвестно'}\n`;
            
            userInfo += `\n📊 <b>Статистика:</b>\n`;
            userInfo += `• Контактов: ${user.contacts?.length || 0}\n`;
            userInfo += `• Опубликовано: ${user.postsCount || 0}\n`;
            userInfo += `• Подтвержден: ${user.approved ? '✅ Да' : '❌ Нет'}\n`;
            
            if (user.approved && user.approvedAt) {
                userInfo += `• Дата подтверждения: ${user.approvedAt.toLocaleString('ru-RU')}\n`;
            }
            
            if (user.lastPostAt) {
                userInfo += `• Последний пост: ${user.lastPostAt.toLocaleString('ru-RU')}\n`;
            }
            
            await ctx.reply(userInfo, {
                parse_mode: 'HTML',
                reply_to_message_id: ctx.callbackQuery.message?.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '📞 Посмотреть контакты',
                                callback_data: `view_contacts:${userId}`
                            }
                        ],
                        !user.approved ? [
                            {
                                text: '✅ Подтвердить',
                                callback_data: `approve_user:${userId}`
                            },
                            {
                                text: '❌ Отклонить',
                                callback_data: `reject_user:${userId}`
                            }
                        ] : []
                    ]
                }
            });
            
            await ctx.answerCbQuery('👤 Информация о пользователе');
            
        } else {
            console.log(`⚠️ Неизвестный callback: ${callbackData}`);
            await ctx.answerCbQuery('❌ Неизвестная команда');
        }
        
    } catch (error) {
        console.error('❌ Ошибка обработки callback:', error);
        ctx.answerCbQuery('❌ Ошибка обработки запроса');
    }
});

// Обработка текстовых сообщений
bot.on('text', async (ctx) => {
    // Логируем текстовые сообщения
    console.log(`💬 Сообщение от ${ctx.from.username || ctx.from.id}: ${ctx.message.text.substring(0, 50)}...`);
    
    // Если сообщение начинается с /, это команда - пропускаем
    if (ctx.message.text.startsWith('/')) {
        return;
    }
    
    // Простой ответ на текстовые сообщения
    await ctx.reply(
        `Привет! Я бот Flower Market 🌸\n\n` +
        `Используйте команды:\n` +
        `/start - Начать работу\n` +
        `/status - Проверить статус\n` +
        `/help - Помощь\n\n` +
        `Или нажмите кнопку "Перейти на сайт" в меню /start`,
        {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '🚀 Начать',
                            callback_data: 'start_over'
                        }
                    ]
                ]
            }
        }
    );
});

// Обработка команды "start_over" из callback
bot.action('start_over', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
        'Выберите команду:\n/start - Начать работу\n/status - Проверить статус\n/help - Помощь',
        { reply_to_message_id: ctx.callbackQuery.message.message_id }
    );
});

// ==================== ЗАПУСК СЕРВЕРА ====================

async function startServer() {
    try {
        console.log('🚀 ЗАПУСК FLOWER MARKET BACKEND...');
        console.log('========================================');
        
        // Загружаем пользователей из файла
        loadUsersFromFile();
        
        // Настройка для Railway (Webhook)
        if (process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production') {
            const webhookUrl = `${BASE_URL}/bot${BOT_TOKEN}`;
            
            console.log(`🌐 Настройка вебхука для Railway...`);
            console.log(`   URL: ${webhookUrl}`);
            
            // Удаляем старый вебхук если есть
            try {
                await bot.telegram.deleteWebhook();
                console.log('✅ Старый вебхук удален');
            } catch (error) {
                console.log('ℹ️ Старого вебхука не было');
            }
            
            // Устанавливаем вебхук
            await bot.telegram.setWebhook(webhookUrl);
            
            // Настраиваем express для обработки вебхука
            app.use(bot.webhookCallback(`/bot${BOT_TOKEN}`));
            
            console.log('✅ Вебхук установлен');
            console.log('🤖 Бот запущен в режиме Webhook');
            
        } else {
            // Локальная разработка - используем polling
            await bot.launch();
            console.log('🤖 Бот запущен в режиме Polling');
        }
        
        // Запуск сервера
        app.listen(port, () => {
            console.log(`✅ Сервер запущен на порту ${port}`);
            console.log(`🌐 URL: ${BASE_URL}`);
            console.log(`📢 Канал: ${CHANNEL_ID}`);
            console.log(`👮 Админ: ${ADMIN_CHAT_ID}`);
            console.log(`📊 Пользователей: ${usersDB.size}`);
            console.log('========================================');
            console.log('✅ API доступны:');
            console.log('   GET  /');
            console.log('   GET  /health');
            console.log('   GET  /api/status');
            console.log('   GET  /api/user/:id/status');
            console.log('   POST /api/upload-contacts');
            console.log('   POST /api/publish-media-group');
            console.log('   GET  /auth/google');
            console.log('   GET  /auth/google/callback');
            console.log('========================================');
            console.log('🚀 Система готова к работе!');
        });
        
        // Graceful shutdown
        process.once('SIGINT', async () => {
            console.log('\n🛑 Остановка по SIGINT...');
            await bot.stop();
            console.log('✅ Бот остановлен');
            
            // Сохраняем пользователей в файл
            const usersArray = Array.from(usersDB.values());
            fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(usersArray, null, 2));
            console.log('✅ Пользователи сохранены');
            
            process.exit(0);
        });
        
        process.once('SIGTERM', async () => {
            console.log('\n🛑 Остановка по SIGTERM...');
            await bot.stop();
            console.log('✅ Бот остановлен');
            
            // Сохраняем пользователей в файл
            const usersArray = Array.from(usersDB.values());
            fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(usersArray, null, 2));
            console.log('✅ Пользователи сохранены');
            
            process.exit(0);
        });
        
    } catch (error) {
        console.error('❌ Ошибка запуска сервера:', error);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
}

// Запускаем сервер
startServer();