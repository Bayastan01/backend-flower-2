// server.js - Flower Market Backend
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// Настройки CORS
app.use(cors({
    origin: ['https://telegram.me', 'https://web.telegram.org', 'http://localhost:3000'],
    credentials: true
}));

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Папка для временных файлов
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// ==================== НАСТРОЙКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ ====================
const BOT_TOKEN = process.env.BOT_TOKEN || 'ВАШ_BOT_TOKEN';
const CHANNEL_ID = process.env.CHANNEL_ID || '@ВАШ_КАНАЛ';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || 'ВАШ_ADMIN_ID';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'ВАШ_CLIENT_ID';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'ВАШ_CLIENT_SECRET';
const BASE_URL = process.env.BASE_URL || `https://${process.env.RAILWAY_STATIC_URL || `localhost:${port}`}`;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Проверка обязательных переменных
const requiredEnvVars = ['BOT_TOKEN', 'CHANNEL_ID', 'ADMIN_CHAT_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar] || process.env[envVar].includes('ВАШ')) {
        console.error(`❌ ОШИБКА: Переменная ${envVar} не настроена!`);
        console.error(`   Задайте её в файле .env или настройках хостинга`);
        process.exit(1);
    }
}

console.log('✅ Все переменные окружения загружены');

// ==================== ИНИЦИАЛИЗАЦИЯ ТЕЛЕГРАМ БОТА ====================
const bot = new Telegraf(BOT_TOKEN);

// Хранилище данных (в продакшене используйте базу данных)
const usersDB = new Map();
const pendingContacts = new Map();

// ==================== GOOGLE OAuth НАСТРОЙКА ====================
const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/auth/google/callback`
);

const people = google.people({
    version: 'v1',
    auth: oauth2Client
});

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
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: white;
                    text-align: center;
                }
                .container {
                    max-width: 600px;
                    padding: 40px;
                    background: rgba(255,255,255,0.1);
                    backdrop-filter: blur(10px);
                    border-radius: 20px;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                }
                h1 {
                    font-size: 2.5em;
                    margin-bottom: 20px;
                }
                p {
                    font-size: 1.2em;
                    margin-bottom: 30px;
                    opacity: 0.9;
                }
                .btn {
                    display: inline-block;
                    background: white;
                    color: #667eea;
                    padding: 15px 30px;
                    border-radius: 12px;
                    text-decoration: none;
                    font-weight: bold;
                    font-size: 1.1em;
                    transition: transform 0.3s, box-shadow 0.3s;
                }
                .btn:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 10px 30px rgba(0,0,0,0.2);
                }
                .icon {
                    font-size: 4em;
                    margin-bottom: 20px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="icon">🌺</div>
                <h1>Flower Market</h1>
                <p>Платформа для продажи цветов в Telegram</p>
                <p>Для начала работы откройте через Telegram бота</p>
                <a href="https://t.me/flower_market_bot" class="btn">Открыть в Telegram</a>
            </div>
        </body>
        </html>
    `);
});

// Статус сервера
app.get('/api/status', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Flower Market API работает',
        timestamp: new Date().toISOString(),
        users: usersDB.size
    });
});

// ==================== GOOGLE OAuth РОУТЫ ====================

// Начало авторизации через Google
app.get('/auth/google', (req, res) => {
    const { userId, chatId, redirect = 'contacts' } = req.query;
    
    if (!userId || !chatId) {
        return res.status(400).send('Не указаны userId и chatId');
    }
    
    // Сохраняем данные в сессии (временное хранилище)
    const state = crypto.randomBytes(16).toString('hex');
    pendingContacts.set(state, { userId, chatId, redirect });
    
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/contacts.readonly'
        ],
        state: state,
        prompt: 'consent'
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
                        body { font-family: sans-serif; padding: 40px; text-align: center; }
                        .error { color: #d32f2f; margin: 20px 0; }
                        .btn { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #667eea; color: white; text-decoration: none; border-radius: 8px; }
                    </style>
                </head>
                <body>
                    <h1>❌ Ошибка авторизации</h1>
                    <div class="error">${error}</div>
                    <a href="/" class="btn">Вернуться на главную</a>
                </body>
                </html>
            `);
        }
        
        // Проверяем state
        const sessionData = pendingContacts.get(state);
        if (!sessionData) {
            throw new Error('Сессия устарела или не найдена');
        }
        
        const { userId, chatId, redirect } = sessionData;
        
        // Получаем токены
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        
        console.log(`✅ Получены токены для userId: ${userId}`);
        
        // Получаем информацию о пользователе
        const userInfo = await google.oauth2('v2').userinfo.get({ auth: oauth2Client });
        const { name, email } = userInfo.data;
        
        // Сохраняем пользователя
        if (!usersDB.has(userId)) {
            usersDB.set(userId, {
                id: userId,
                chatId,
                googleTokens: tokens,
                googleInfo: { name, email },
                contacts: [],
                hasContacts: false,
                createdAt: new Date()
            });
        } else {
            const user = usersDB.get(userId);
            user.googleTokens = tokens;
            user.googleInfo = { name, email };
        }
        
        // Удаляем временные данные
        pendingContacts.delete(state);
        
        // Перенаправляем на страницу контактов
        const redirectUrl = `${BASE_URL}/contacts.html?userId=${userId}&chatId=${chatId}`;
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Успешная авторизация</title>
                <meta http-equiv="refresh" content="2;url=${redirectUrl}">
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
                    }
                    .container { padding: 40px; }
                    .icon { font-size: 4em; margin-bottom: 20px; }
                    h1 { margin-bottom: 20px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="icon">✅</div>
                    <h1>Авторизация успешна!</h1>
                    <p>Импортируем ваши контакты...</p>
                    <p>Перенаправление через 2 секунды</p>
                </div>
                <script>
                    setTimeout(() => {
                        window.location.href = '${redirectUrl}';
                    }, 2000);
                </script>
            </body>
            </html>
        `);
        
    } catch (error) {
        console.error('❌ Ошибка обработки Google callback:', error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Ошибка</title>
                <style>
                    body { font-family: sans-serif; padding: 40px; text-align: center; }
                    .error { color: #d32f2f; margin: 20px 0; }
                    .btn { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #667eea; color: white; text-decoration: none; border-radius: 8px; }
                </style>
            </head>
            <body>
                <h1>❌ Ошибка</h1>
                <div class="error">${error.message}</div>
                <a href="/" class="btn">Вернуться на главную</a>
            </body>
            </html>
        `);
    }
});

// ==================== API ДЛЯ РАБОТЫ С КОНТАКТАМИ ====================

// Получение контактов из Google
app.post('/api/get-google-contacts', async (req, res) => {
    try {
        const { userId, accessToken } = req.body;
        
        if (!userId || !accessToken) {
            return res.status(400).json({ 
                success: false, 
                error: 'Требуется userId и accessToken' 
            });
        }
        
        const user = usersDB.get(userId.toString());
        if (!user) {
            return res.status(404).json({ 
                success: false, 
                error: 'Пользователь не найден' 
            });
        }
        
        // Устанавливаем токен
        oauth2Client.setCredentials({ access_token: accessToken });
        
        // Получаем контакты
        let allContacts = [];
        let pageToken = null;
        let totalContacts = 0;
        
        do {
            const response = await people.people.connections.list({
                resourceName: 'people/me',
                pageSize: 100,
                pageToken: pageToken || undefined,
                personFields: 'names,phoneNumbers,emailAddresses'
            });
            
            const connections = response.data.connections || [];
            allContacts = allContacts.concat(connections);
            totalContacts = response.data.totalPeople || connections.length;
            pageToken = response.data.nextPageToken;
            
            console.log(`📥 Загружено ${allContacts.length} из ${totalContacts} контактов`);
            
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
                        rawName: contact.names.map(n => n.displayName || ''),
                        rawTel: contact.phoneNumbers?.map(p => p.value) || [],
                        source: 'google'
                    });
                }
            }
        });
        
        console.log(`✅ Отформатировано ${formattedContacts.length} контактов`);
        
        // Сохраняем контакты пользователя
        user.contacts = formattedContacts;
        user.hasContacts = formattedContacts.length > 0;
        user.contactsImportedAt = new Date();
        
        res.json({
            success: true,
            contacts: formattedContacts,
            count: formattedContacts.length,
            message: `Найдено ${formattedContacts.length} контактов`
        });
        
    } catch (error) {
        console.error('❌ Ошибка получения контактов Google:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            message: 'Ошибка при получении контактов из Google'
        });
    }
});

// Загрузка контактов (любым методом)
app.post('/api/upload-contacts', async (req, res) => {
    try {
        const { userId, chatId, contacts, importSource = 'unknown' } = req.body;
        
        if (!userId || !contacts || !Array.isArray(contacts)) {
            return res.status(400).json({
                success: false,
                error: 'Требуется userId и массив контактов'
            });
        }
        
        console.log(`📤 Получены контакты от ${userId}, источник: ${importSource}, количество: ${contacts.length}`);
        
        // Сохраняем контакты пользователя
        let user = usersDB.get(userId.toString());
        if (!user) {
            user = {
                id: userId.toString(),
                chatId: chatId || userId.toString(),
                contacts: [],
                hasContacts: false,
                createdAt: new Date()
            };
            usersDB.set(userId.toString(), user);
        }
        
        user.contacts = contacts;
        user.hasContacts = true;
        user.contactsImportedAt = new Date();
        user.importSource = importSource;
        
        // Отправляем уведомление администратору
        try {
            await bot.telegram.sendMessage(
                ADMIN_CHAT_ID,
                `📞 НОВЫЕ КОНТАКТЫ ОТ ПОЛЬЗОВАТЕЛЯ\n\n` +
                `👤 Пользователь: ${userId}\n` +
                `📊 Контактов: ${contacts.length}\n` +
                `📱 Источник: ${importSource}\n` +
                `⏰ Время: ${new Date().toLocaleString('ru-RU')}\n\n` +
                `Примеры контактов:\n` +
                contacts.slice(0, 5).map((c, i) => 
                    `${i+1}. ${c.name}: ${c.phone || c.phones?.[0] || 'нет телефона'}`
                ).join('\n'),
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
                                    text: '👀 Посмотреть все контакты',
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
        }
        
        res.json({
            success: true,
            message: `Контакты успешно сохранены (${contacts.length} контактов)`,
            count: contacts.length,
            userId: userId
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

// Проверка статуса контактов пользователя
app.get('/api/user/:userId/status', (req, res) => {
    try {
        const { userId } = req.params;
        
        const user = usersDB.get(userId);
        
        if (!user) {
            return res.json({
                hasContacts: false,
                contactsCount: 0,
                message: 'Пользователь не найден'
            });
        }
        
        res.json({
            hasContacts: user.hasContacts || false,
            contactsCount: user.contacts?.length || 0,
            importedAt: user.contactsImportedAt,
            importSource: user.importSource,
            canPost: user.approved || false,
            approvedAt: user.approvedAt
        });
        
    } catch (error) {
        console.error('❌ Ошибка проверки статуса:', error);
        res.status(500).json({
            hasContacts: false,
            contactsCount: 0,
            error: error.message
        });
    }
});

// ==================== API ДЛЯ ПУБЛИКАЦИИ ОБЪЯВЛЕНИЙ ====================

// Публикация медиа-группы
app.post('/api/publish-media-group', async (req, res) => {
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
        
        // Проверяем, подтвержден ли пользователь администратором
        if (!user.approved) {
            return res.status(403).json({
                success: false,
                error: 'Ваш аккаунт еще не подтвержден администратором. Ожидайте подтверждения.'
            });
        }
        
        // Проверяем наличие контактов
        if (!user.hasContacts || !user.contacts || user.contacts.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Контакты не загружены. Сначала загрузите контакты через Google.'
            });
        }
        
        // Проверяем обязательные поля
        if (!description || !city || !freshness) {
            return res.status(400).json({
                success: false,
                error: 'Заполните все обязательные поля: описание, город, свежесть'
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
        const tempFiles = [];
        
        for (let i = 0; i < Math.min(mediaFiles.length, 10); i++) {
            const media = mediaFiles[i];
            
            if (!media.data || !media.type) {
                console.warn(`⚠️ Пропущен файл ${i}: нет данных или типа`);
                continue;
            }
            
            try {
                // Декодируем base64
                const buffer = Buffer.from(media.data, 'base64');
                
                // Сохраняем временный файл
                const filename = `temp_${Date.now()}_${i}_${media.name || 'file'}`;
                const filepath = path.join(tempDir, filename);
                
                fs.writeFileSync(filepath, buffer);
                tempFiles.push(filepath);
                
                // Определяем тип медиа
                const isVideo = media.type.startsWith('video/');
                const mediaType = isVideo ? 'video' : 'photo';
                
                mediaGroup.push({
                    type: mediaType,
                    media: { source: filepath },
                    caption: i === 0 ? formatCaption({
                        description,
                        price,
                        contacts,
                        freshness,
                        city,
                        district,
                        address,
                        hashtags,
                        userId
                    }) : ''
                });
                
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
            
            // Отправляем уведомление пользователю
            if (user.chatId) {
                try {
                    const messageLink = `https://t.me/c/${CHANNEL_ID.replace('@', '').replace('-', '_')}/${sentMessages[0].message_id}`;
                    
                    await bot.telegram.sendMessage(
                        user.chatId,
                        `✅ <b>Ваше объявление опубликовано!</b>\n\n` +
                        `📊 <b>Статистика:</b>\n` +
                        `• Файлов: ${mediaGroup.length}\n` +
                        `• Город: ${city}\n` +
                        `• Свежесть: ${freshness}\n` +
                        `• Цена: ${price}\n\n` +
                        `<a href="${messageLink}">↗️ Перейти к объявлению</a>\n\n` +
                        `<i>Объявление активно 7 дней. Для редактирования обратитесь к администратору.</i>`,
                        {
                            parse_mode: 'HTML',
                            disable_web_page_preview: true
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
                    `👤 Пользователь: ${userId}\n` +
                    `📊 Файлов: ${mediaGroup.length}\n` +
                    `📍 Город: ${city}\n` +
                    `💵 Цена: ${price}\n` +
                    `🌺 Свежесть: ${freshness}\n\n` +
                    `📝 Описание:\n${description.substring(0, 200)}...`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: '👁️ Посмотреть объявление',
                                        url: `https://t.me/c/${CHANNEL_ID.replace('@', '').replace('-', '_')}/${sentMessages[0].message_id}`
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
            
            // Увеличиваем счетчик публикаций пользователя
            user.postsCount = (user.postsCount || 0) + 1;
            user.lastPostAt = new Date();
            
            res.json({
                success: true,
                message: `Объявление успешно опубликовано с ${mediaGroup.length} файлами`,
                mediaCount: mediaGroup.length,
                messageId: sentMessages[0]?.message_id,
                channel: CHANNEL_ID
            });
            
        } catch (telegramError) {
            console.error('❌ Ошибка отправки в Telegram:', telegramError);
            
            // Пытаемся отправить текстовое сообщение об ошибке
            try {
                await bot.telegram.sendMessage(
                    CHANNEL_ID,
                    formatCaption({
                        description,
                        price,
                        contacts,
                        freshness,
                        city,
                        district,
                        address,
                        hashtags,
                        userId,
                        error: true
                    }),
                    { parse_mode: 'HTML' }
                );
                
                res.json({
                    success: true,
                    message: 'Текст объявления опубликован (без файлов)',
                    mediaCount: 0,
                    error: telegramError.message
                });
                
            } catch (textError) {
                throw new Error(`Не удалось отправить ни медиа, ни текст: ${telegramError.message}`);
            }
        }
        
        // Очищаем временные файлы
        setTimeout(() => {
            tempFiles.forEach(filepath => {
                try {
                    if (fs.existsSync(filepath)) {
                        fs.unlinkSync(filepath);
                    }
                } catch (cleanupError) {
                    console.error('❌ Ошибка удаления временного файла:', cleanupError);
                }
            });
        }, 30000);
        
    } catch (error) {
        console.error('❌ Ошибка публикации:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            message: 'Ошибка при публикации объявления'
        });
    }
});

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
        userId,
        error = false
    } = data;
    
    let caption = '';
    
    if (error) {
        caption += `⚠️ <b>Объявление (ошибка загрузки файлов)</b>\n\n`;
    }
    
    caption += `🌺 <b>Цветы на продажу</b>\n\n`;
    
    if (description) {
        caption += `📝 <b>Описание:</b>\n${description}\n\n`;
    }
    
    if (freshness) {
        caption += `🕒 <b>Свежесть:</b> ${freshness}\n`;
    }
    
    caption += `💰 <b>Цена:</b> ${price}\n`;
    caption += `📍 <b>Локация:</b> ${city}`;
    
    if (district) {
        caption += `, ${district}`;
    }
    
    if (address) {
        caption += `\n🏠 <b>Адрес:</b> ${address}`;
    }
    
    caption += `\n\n📞 <b>Контакты:</b> ${contacts}\n`;
    
    if (hashtags) {
        caption += `\n${hashtags}\n`;
    }
    
    caption += `\n──────────────\n`;
    caption += `<i>ID: ${userId?.substring(0, 8)}... | Flower Market 🌸</i>`;
    
    return caption;
}

// ==================== ТЕЛЕГРАМ БОТ КОМАНДЫ ====================

// Команда /start
bot.start(async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    
    console.log(`👋 Новый пользователь: @${ctx.from.username || 'без username'} (${userId})`);
    
    // Сохраняем пользователя
    if (!usersDB.has(userId)) {
        usersDB.set(userId, {
            id: userId,
            chatId: chatId,
            username: ctx.from.username,
            firstName: ctx.from.first_name,
            lastName: ctx.from.last_name,
            contacts: [],
            hasContacts: false,
            approved: false,
            createdAt: new Date()
        });
    }
    
    // Создаем уникальную ссылку для пользователя
    const webAppUrl = `${BASE_URL}/index.html?userId=${userId}&chatId=${chatId}`;
    
    await ctx.reply(
        `🌸 <b>Добро пожаловать в Flower Market!</b>\n\n` +
        `Здесь вы можете разместить объявление о продаже цветов с фото и видео в одном посте.\n\n` +
        `<b>📋 Требования для публикации:</b>\n` +
        `1. Авторизация через Google\n` +
        `2. Импорт ваших контактов (минимум 3 контакта)\n` +
        `3. Подтверждение администратором\n` +
        `4. Создание объявления\n\n` +
        `<i>Контакты нужны для проверки надежности продавцов. Мы не передаем их третьим лицам.</i>`,
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '🌐 Перейти на сайт',
                            web_app: { url: webAppUrl }
                        }
                    ],
                    [
                        {
                            text: '📞 Связаться с администратором',
                            url: `https://t.me/${ADMIN_CHAT_ID.replace('@', '')}`
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
        `🆘 <b>Помощь по использованию Flower Market</b>\n\n` +
        `<b>Основные команды:</b>\n` +
        `/start - Начать работу с ботом\n` +
        `/status - Проверить статус аккаунта\n` +
        `/help - Показать это сообщение\n\n` +
        `<b>Процесс публикации:</b>\n` +
        `1. Нажмите "Перейти на сайт"\n` +
        `2. Авторизуйтесь через Google\n` +
        `3. Импортируйте контакты\n` +
        `4. Дождитесь подтверждения\n` +
        `5. Создайте объявление\n\n` +
        `<b>Поддержка:</b> @${ADMIN_CHAT_ID.replace('@', '')}`,
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
    
    let statusMessage = `📊 <b>Статус вашего аккаунта</b>\n\n`;
    
    statusMessage += `👤 <b>Пользователь:</b> ${user.firstName || ''} ${user.lastName || ''}\n`;
    statusMessage += `🆔 <b>ID:</b> ${user.id}\n`;
    
    if (user.googleInfo) {
        statusMessage += `🔐 <b>Google:</b> ${user.googleInfo.email}\n`;
    }
    
    statusMessage += `\n📞 <b>Контакты:</b> `;
    
    if (user.hasContacts) {
        statusMessage += `✅ Загружено (${user.contacts?.length || 0} контактов)\n`;
        statusMessage += `📅 <b>Импортированы:</b> ${user.contactsImportedAt?.toLocaleDateString('ru-RU') || 'неизвестно'}\n`;
    } else {
        statusMessage += `❌ Не загружены\n`;
    }
    
    statusMessage += `\n✅ <b>Подтверждение:</b> `;
    
    if (user.approved) {
        statusMessage += `✅ Подтвержден администратором\n`;
        statusMessage += `📅 <b>Подтвержден:</b> ${user.approvedAt?.toLocaleDateString('ru-RU') || 'неизвестно'}\n`;
        statusMessage += `📊 <b>Опубликовано объявлений:</b> ${user.postsCount || 0}\n`;
    } else {
        statusMessage += `⏳ Ожидает подтверждения\n`;
        statusMessage += `<i>Администратор получил ваши контакты и скоро примет решение.</i>\n`;
    }
    
    if (user.hasContacts && !user.approved) {
        statusMessage += `\n⚠️ <b>Важно:</b> Вы загрузили контакты, но еще не подтверждены. `;
        statusMessage += `Обычно это занимает до 24 часов.\n`;
    }
    
    if (!user.hasContacts) {
        statusMessage += `\n🔗 <b>Следующий шаг:</b> Перейдите на сайт через кнопку ниже чтобы загрузить контакты.`;
        
        const webAppUrl = `${BASE_URL}/index.html?userId=${userId}&chatId=${user.chatId}`;
        
        await ctx.reply(statusMessage, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '🌐 Перейти на сайт для загрузки контактов',
                            web_app: { url: webAppUrl }
                        }
                    ]
                ]
            }
        });
    } else {
        await ctx.reply(statusMessage, { parse_mode: 'HTML' });
    }
});

// Обработка callback-запросов (кнопки администратора)
bot.on('callback_query', async (ctx) => {
    try {
        const callbackData = ctx.callbackQuery.data;
        const [action, userId] = callbackData.split(':');
        
        if (!action || !userId) return;
        
        const user = usersDB.get(userId);
        
        if (!user) {
            return ctx.answerCbQuery('❌ Пользователь не найден');
        }
        
        switch (action) {
            case 'approve_user':
                // Подтверждение пользователя
                user.approved = true;
                user.approvedAt = new Date();
                
                // Уведомляем администратора
                await ctx.editMessageText(
                    `✅ <b>ПОЛЬЗОВАТЕЛЬ ПОДТВЕРЖДЕН</b>\n\n` +
                    `👤 Пользователь: ${userId}\n` +
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
                            `📋 <b>Что дальше?</b>\n` +
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
                break;
                
            case 'reject_user':
                // Отклонение пользователя
                user.rejected = true;
                user.rejectedAt = new Date();
                user.rejectedBy = ctx.from.username || ctx.from.first_name;
                
                await ctx.editMessageText(
                    `❌ <b>ПОЛЬЗОВАТЕЛЬ ОТКЛОНЕН</b>\n\n` +
                    `👤 Пользователь: ${userId}\n` +
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
                            `<b>Возможные причины:</b>\n` +
                            `• Недостаточно контактов\n` +
                            `• Подозрительная активность\n` +
                            `• Нарушение правил\n\n` +
                            `Если вы считаете это ошибкой, свяжитесь с администратором: @${ADMIN_CHAT_ID.replace('@', '')}`,
                            { parse_mode: 'HTML' }
                        );
                    } catch (userError) {
                        console.error('❌ Ошибка уведомления пользователя:', userError);
                    }
                }
                
                await ctx.answerCbQuery('❌ Пользователь отклонен');
                break;
                
            case 'view_contacts':
                // Просмотр контактов пользователя
                if (!user.contacts || user.contacts.length === 0) {
                    return ctx.answerCbQuery('❌ У пользователя нет контактов');
                }
                
                let contactsText = `📞 <b>КОНТАКТЫ ПОЛЬЗОВАТЕЛЯ ${userId}</b>\n\n`;
                contactsText += `📊 Всего: ${user.contacts.length}\n`;
                contactsText += `📱 Источник: ${user.importSource || 'неизвестно'}\n`;
                contactsText += `📅 Дата: ${user.contactsImportedAt?.toLocaleString('ru-RU') || 'неизвестно'}\n\n`;
                
                // Показываем первые 10 контактов
                user.contacts.slice(0, 10).forEach((contact, index) => {
                    contactsText += `<b>${index + 1}.</b> ${contact.name}\n`;
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
                
                if (user.contacts.length > 10) {
                    contactsText += `... и еще ${user.contacts.length - 10} контактов\n`;
                }
                
                await ctx.reply(contactsText, {
                    parse_mode: 'HTML',
                    reply_to_message_id: ctx.callbackQuery.message?.message_id
                });
                
                await ctx.answerCbQuery('📞 Контакты показаны');
                break;
                
            case 'user_info':
                // Информация о пользователе
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
                break;
                
            default:
                await ctx.answerCbQuery('❌ Неизвестное действие');
        }
        
    } catch (error) {
        console.error('❌ Ошибка обработки callback:', error);
        ctx.answerCbQuery('❌ Ошибка обработки запроса');
    }
});

// ==================== ЗАПУСК СЕРВЕРА ====================

async function startServer() {
    try {
        // Запускаем бота
        await bot.launch();
        console.log('🤖 Telegram бот запущен');
        
        // Запускаем сервер
        app.listen(port, () => {
            console.log(`🚀 Сервер запущен на порту ${port}`);
            console.log(`🌐 URL: ${BASE_URL}`);
            console.log(`📢 Канал: ${CHANNEL_ID}`);
            console.log(`👮 Админ: ${ADMIN_CHAT_ID}`);
            console.log(`📊 Пользователей: ${usersDB.size}`);
        });
        
        // Обработка остановки
        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));
        
    } catch (error) {
        console.error('❌ Ошибка запуска сервера:', error);
        process.exit(1);
    }
}

// Запускаем сервер
startServer();