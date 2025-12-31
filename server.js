const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== ПРОВЕРКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ ====================
console.log('🔧 Проверка переменных окружения...');

const requiredEnvVars = ['BOT_TOKEN', 'CHANNEL_ID', 'ADMIN_ID', 'FRONTEND_URL'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ ОШИБКА: Отсутствуют обязательные переменные окружения:');
  missingVars.forEach(varName => {
    console.error(`   - ${varName}`);
  });
  console.error('\n💡 Добавьте эти переменные в Railway Variables:');
  console.error('BOT_TOKEN=ваш_токен_бота_от_BotFather');
  console.error('CHANNEL_ID=-100ваш_id_канала');
  console.error('ADMIN_ID=ваш_telegram_id');
  console.error('FRONTEND_URL=https://ваш-фронтенд.railway.app');
  process.exit(1);
}

// ==================== КОНСТАНТЫ ИЗ ПЕРЕМЕННЫХ ОКРУЖЕНИЯ ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_ID = process.env.ADMIN_ID;
const FRONTEND_URL = process.env.FRONTEND_URL;
const BACKEND_URL = process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`;

// Google OAuth - опционально
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = `${BACKEND_URL}/auth/google/callback`;

console.log('🌐 Конфигурация сервера:');
console.log(`   Сервер запущен на порту: ${PORT}`);
console.log(`   Фронтенд: ${FRONTEND_URL}`);
console.log(`   Бэкенд: ${BACKEND_URL}`);
console.log(`   Google OAuth: ${GOOGLE_CLIENT_ID ? '✅ Настроен' : '❌ Не настроен'}`);

// ==================== ИНИЦИАЛИЗАЦИЯ TELEGRAM БОТА ====================
console.log('🤖 Инициализация Telegram бота...');
const bot = new TelegramBot(BOT_TOKEN, { 
  polling: true,
  webHook: false 
});

// ==================== НАСТРОЙКА СЕРВЕРА ====================
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ==================== ХРАНЕНИЕ ДАННЫХ ====================
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let users = {};

function loadData() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      users = JSON.parse(data);
      console.log(`✅ Загружено ${Object.keys(users).length} пользователей`);
    }
  } catch (error) {
    console.error('❌ Ошибка загрузки данных:', error.message);
    users = {};
  }
}

function saveData() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (error) {
    console.error('❌ Ошибка сохранения данных:', error.message);
  }
}

loadData();

// ==================== GOOGLE AUTH API ====================

// 1. Получить URL для авторизации Google
app.post('/api/auth/google/url', (req, res) => {
  try {
    const { userId, chatId } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'Требуется userId'
      });
    }
    
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({
        success: false,
        error: 'Google OAuth не настроен на сервере'
      });
    }
    
    // Создаем state для безопасности
    const state = Buffer.from(JSON.stringify({
      userId,
      chatId,
      timestamp: Date.now()
    })).toString('base64');
    
    // Создаем URL для Google OAuth
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/contacts.readonly',
      state: state,
      prompt: 'consent',
      access_type: 'offline',
      include_granted_scopes: 'true'
    });
    
    console.log(`🔗 Сгенерирован Google OAuth URL для пользователя ${userId}`);
    
    res.json({
      success: true,
      url: authUrl,
      state: state
    });
    
  } catch (error) {
    console.error('❌ Ошибка генерации Google URL:', error);
    res.status(500).json({
      success: false,
      error: 'Внутренняя ошибка сервера'
    });
  }
});

// 2. Callback для Google OAuth
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    
    if (error) {
      console.error('❌ Google OAuth ошибка:', error);
      return res.redirect(`${FRONTEND_URL}?google_error=${encodeURIComponent(error)}`);
    }
    
    if (!code || !state) {
      return res.redirect(`${FRONTEND_URL}?error=Отсутствует код или state`);
    }
    
    // Декодируем state
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    } catch (e) {
      return res.redirect(`${FRONTEND_URL}?error=Неверный state параметр`);
    }
    
    const { userId, chatId } = stateData;
    
    if (!userId || !chatId) {
      return res.redirect(`${FRONTEND_URL}?error=Неверные параметры пользователя`);
    }
    
    console.log(`🔄 Обмен кода на токен для пользователя ${userId}`);
    
    try {
      // Обмениваем код на токен доступа
      const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
        code: code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code'
      }, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      
      const accessToken = tokenResponse.data.access_token;
      
      if (!accessToken) {
        throw new Error('Не получен access token');
      }
      
      // Получаем контакты из Google
      console.log(`📞 Получение контактов для пользователя ${userId}`);
      
      const contactsResponse = await axios.get('https://people.googleapis.com/v1/people/me/connections', {
        params: {
          personFields: 'names,phoneNumbers',
          pageSize: 200
        },
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });
      
      const connections = contactsResponse.data.connections || [];
      const contacts = [];
      
      connections.forEach(contact => {
        if (contact.names && contact.names.length > 0 && contact.phoneNumbers && contact.phoneNumbers.length > 0) {
          const name = contact.names[0].displayName || 'Без имени';
          
          contact.phoneNumbers.forEach(phoneObj => {
            let phone = phoneObj.value || '';
            phone = phone.replace(/\D/g, '');
            
            if (phone.length >= 9) {
              contacts.push({
                name: name,
                phone: phone,
                rawName: [name],
                rawTel: [phone],
                source: 'google'
              });
            }
          });
        }
      });
      
      console.log(`✅ Получено ${contacts.length} контактов для пользователя ${userId}`);
      
      // Сохраняем данные пользователя
      users[userId] = {
        id: userId,
        chatId: chatId,
        firstName: 'Google User',
        hasContacts: true,
        contactsCount: contacts.length,
        lastContactUpload: new Date().toISOString(),
        approved: false,
        contacts: contacts,
        addedToChannel: false,
        importSource: 'google',
        contactsReceivedAt: new Date().toISOString()
      };
      
      saveData();
      
      // Уведомляем администратора
      await notifyAdminAboutContacts(userId, contacts.length, 'Google User', contacts, 'google');
      
      // Перенаправляем на фронтенд с успехом
      return res.redirect(`${FRONTEND_URL}/?userId=${userId}&chatId=${chatId}&google_success=true&contactsCount=${contacts.length}`);
      
    } catch (error) {
      console.error('❌ Ошибка получения контактов:', error.response?.data || error.message);
      return res.redirect(`${FRONTEND_URL}?google_error=${encodeURIComponent(error.message)}`);
    }
    
  } catch (error) {
    console.error('❌ Ошибка обработки Google callback:', error);
    return res.redirect(`${FRONTEND_URL}?error=${encodeURIComponent(error.message)}`);
  }
});

// ==================== ОСНОВНЫЕ API ENDPOINTS ====================

// Проверка статуса сервера
app.get('/api/status', (req, res) => {
  const pendingUsers = Object.values(users).filter(u => u.hasContacts && !u.approved).length;
  const approvedUsers = Object.values(users).filter(u => u.approved).length;
  
  res.json({
    status: 'online',
    service: 'Flower Market API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    usersCount: Object.keys(users).length,
    pendingUsers: pendingUsers,
    approvedUsers: approvedUsers,
    frontendUrl: FRONTEND_URL,
    backendUrl: BACKEND_URL,
    googleOAuth: !!GOOGLE_CLIENT_ID,
    botStatus: 'active'
  });
});

// Проверка статуса пользователя
app.get('/api/user/:userId/status', (req, res) => {
  try {
    const userId = req.params.userId;
    const user = users[userId];
    
    if (!user) {
      return res.json({
        success: true,
        hasContacts: false,
        approved: false,
        exists: false,
        message: 'Пользователь не найден'
      });
    }
    
    res.json({
      success: true,
      hasContacts: user.hasContacts || false,
      approved: user.approved || false,
      exists: true,
      firstName: user.firstName || 'User',
      contactsCount: user.contactsCount || 0,
      lastContactUpload: user.lastContactUpload,
      addedToChannel: user.addedToChannel || false,
      importSource: user.importSource || 'unknown',
      message: user.approved ? '✅ Доступ подтвержден' : '⏳ Ожидание подтверждения'
    });
    
  } catch (error) {
    console.error('❌ Ошибка проверки статуса:', error);
    res.status(500).json({
      success: false,
      error: 'Внутренняя ошибка сервера'
    });
  }
});

// Загрузка контактов (альтернативный метод)
app.post('/api/upload-contacts', async (req, res) => {
  console.log('📤 Получен запрос на загрузку контактов...');
  
  try {
    const { 
      userId, 
      chatId, 
      contacts, 
      firstName,
      importSource
    } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Требуется userId' 
      });
    }
    
    console.log(`📱 Получены контакты от пользователя ${userId}, количество: ${contacts?.length || 0}`);
    
    // Проверяем минимальное количество контактов
    if (!contacts || contacts.length < 3) {
      return res.status(400).json({
        success: false,
        error: `Требуется минимум 3 контакта. Вы предоставили: ${contacts?.length || 0}`
      });
    }
    
    // Сохраняем данные пользователя
    users[userId] = {
      id: userId,
      chatId: chatId || userId,
      firstName: firstName || 'User',
      hasContacts: true,
      contactsCount: contacts.length,
      lastContactUpload: new Date().toISOString(),
      approved: false,
      contacts: contacts,
      addedToChannel: false,
      importSource: importSource || 'unknown',
      contactsReceivedAt: new Date().toISOString()
    };
    
    saveData();
    
    // Уведомляем администратора
    await notifyAdminAboutContacts(userId, contacts.length, firstName, contacts, importSource);
    
    res.json({ 
      success: true, 
      message: '✅ Контакты успешно получены. Администратор получил уведомление.',
      timestamp: new Date().toISOString(),
      contactsCount: contacts.length,
      userId: userId
    });
    
  } catch (error) {
    console.error('❌ Ошибка загрузки контактов:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Внутренняя ошибка сервера'
    });
  }
});

// Тестовые контакты
app.post('/api/test-contacts', async (req, res) => {
  try {
    const { userId, chatId, firstName } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Требуется userId' 
      });
    }
    
    console.log(`🧪 Тестовые контакты для пользователя ${userId}`);
    
    // Генерируем тестовые контакты
    const testContacts = [
      {
        name: "Иван Иванов",
        phone: "555123456",
        rawName: ["Иван", "Иванов"],
        rawTel: ["555123456"],
        source: "test"
      },
      {
        name: "Мария Петрова",
        phone: "555654321",
        rawName: ["Мария", "Петрова"],
        rawTel: ["555654321"],
        source: "test"
      },
      {
        name: "Сергей Сидоров",
        phone: "555987654",
        rawName: ["Сергей", "Сидоров"],
        rawTel: ["555987654"],
        source: "test"
      }
    ];
    
    // Сохраняем данные пользователя
    users[userId] = {
      id: userId,
      chatId: chatId || userId,
      firstName: firstName || 'User',
      hasContacts: true,
      contactsCount: testContacts.length,
      lastContactUpload: new Date().toISOString(),
      approved: false,
      contacts: testContacts,
      addedToChannel: false,
      importSource: 'test',
      contactsReceivedAt: new Date().toISOString(),
      isTest: true
    };
    
    saveData();
    
    // Уведомляем администратора
    await notifyAdminAboutContacts(userId, testContacts.length, firstName, testContacts, 'test');
    
    res.json({ 
      success: true, 
      message: '✅ Тестовые контакты успешно сохранены',
      contactsCount: testContacts.length,
      isTest: true
    });
    
  } catch (error) {
    console.error('❌ Ошибка тестовых контактов:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Внутренняя ошибка сервера'
    });
  }
});

// Публикация объявления
app.post('/api/publish-media-group', async (req, res) => {
  console.log('🚀 Публикация объявления...');
  
  try {
    const { 
      userId, 
      chatId, 
      description, 
      price, 
      mediaFiles = [] 
    } = req.body;
    
    // Проверяем обязательные поля
    if (!description || !mediaFiles || mediaFiles.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Заполните все обязательные поля: описание и фото/видео'
      });
    }
    
    // Проверяем, подтвержден ли пользователь
    const user = users[userId];
    if (!user) {
      return res.status(403).json({
        success: false,
        error: 'Пользователь не найден. Сначала предоставьте контакты.'
      });
    }
    
    if (!user.approved) {
      return res.status(403).json({
        success: false,
        error: 'Ваши контакты еще не подтверждены администратором'
      });
    }
    
    console.log(`📤 Публикация объявления от пользователя ${userId}`);
    console.log(`📝 Описание: ${description}`);
    console.log(`💰 Цена: ${price || 'Договорная'}`);
    console.log(`📁 Файлов: ${mediaFiles.length}`);
    
    // Формируем подпись для поста
    const captionText = `
🌺 <b>Красивый букет</b> 🌸

<b>Описание:</b> ${description}

<b>Цена:</b> ${price || 'Договорная'}
<b>Контакты:</b> 👤 Контакты предоставлены администратору

#цветы #продажа #киргизия #доставка
    `.trim();
    
    try {
      // Публикуем медиафайлы
      const mediaGroup = [];
      
      for (let i = 0; i < mediaFiles.length && i < 10; i++) {
        const media = mediaFiles[i];
        const buffer = Buffer.from(media.data, 'base64');
        
        if (media.type?.startsWith('image/')) {
          mediaGroup.push({
            type: 'photo',
            media: buffer,
            caption: i === 0 ? captionText : '',
            parse_mode: 'HTML'
          });
        } else if (media.type?.startsWith('video/')) {
          mediaGroup.push({
            type: 'video',
            media: buffer,
            caption: i === 0 ? captionText : '',
            parse_mode: 'HTML'
          });
        }
      }
      
      // Отправляем в канал
      console.log(`📤 Отправка ${mediaGroup.length} медиафайлов в канал ${CHANNEL_ID}...`);
      const messages = await bot.sendMediaGroup(CHANNEL_ID, mediaGroup);
      
      // Создаем ссылку на пост
      const channelIdNum = CHANNEL_ID.toString().replace('-100', '');
      const postLink = `https://t.me/c/${channelIdNum}/${messages[0].message_id}`;
      
      console.log(`✅ Объявление опубликовано! Ссылка: ${postLink}`);
      
      // Уведомляем пользователя
      await bot.sendMessage(
        chatId || userId,
        `✅ <b>Ваше объявление успешно опубликовано!</b>\n\n` +
        `📊 Файлов: ${mediaFiles.length}\n` +
        `💵 Цена: ${price || 'Договорная'}\n\n` +
        `🔗 <a href="${postLink}">Смотреть объявление в канале</a>\n\n` +
        `Спасибо за использование Flower Market! 🌺`,
        { 
          parse_mode: 'HTML',
          disable_web_page_preview: true 
        }
      );
      
      res.json({
        success: true,
        postLink,
        mediaCount: mediaFiles.length,
        message: `✅ Объявление с ${mediaFiles.length} файлами опубликовано!`
      });
      
    } catch (telegramError) {
      console.error('❌ Ошибка Telegram при публикации:', telegramError.message);
      
      // Альтернативный метод - публикуем текстовое сообщение
      try {
        const textMessage = await bot.sendMessage(
          CHANNEL_ID,
          captionText,
          { parse_mode: 'HTML' }
        );
        
        res.json({
          success: true,
          message: '✅ Объявление опубликовано (текстовый формат)'
        });
      } catch (textError) {
        throw new Error(`Не удалось опубликовать: ${telegramError.message}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Общая ошибка публикации:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Внутренняя ошибка сервера'
    });
  }
});

// Подтверждение пользователя администратором
app.post('/api/approve-user/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const { adminId } = req.body;
    
    // Проверяем, что это администратор
    if (adminId.toString() !== ADMIN_ID.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Доступ запрещен'
      });
    }
    
    const user = users[userId];
    
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'Пользователь не найден'
      });
    }
    
    // Подтверждаем пользователя
    user.approved = true;
    user.approvedAt = new Date().toISOString();
    user.approvedBy = adminId;
    
    saveData();
    
    // Уведомляем пользователя
    await bot.sendMessage(
      user.chatId || userId,
      `✅ <b>Поздравляем!</b>\n\n` +
      `Ваши контакты подтверждены администратором.\n` +
      `Теперь вы можете создавать объявления в Flower Market!\n\n` +
      `🌺 <b>Создать первое объявление:</b>\n` +
      `${FRONTEND_URL}/?userId=${userId}&chatId=${user.chatId || userId}`,
      { parse_mode: 'HTML' }
    );
    
    res.json({
      success: true,
      message: `✅ Пользователь ${userId} подтвержден`,
      approvedAt: user.approvedAt
    });
    
  } catch (error) {
    console.error('❌ Ошибка подтверждения:', error);
    res.status(500).json({
      success: false,
      error: 'Внутренняя ошибка сервера'
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Главная страница (опционально)
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Flower Market Backend</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        h1 { color: #667eea; }
        .status { background: #f0f0f0; padding: 20px; border-radius: 10px; margin: 20px auto; max-width: 500px; }
      </style>
    </head>
    <body>
      <h1>🌺 Flower Market Backend</h1>
      <div class="status">
        <p><strong>Status:</strong> ✅ Online</p>
        <p><strong>Users:</strong> ${Object.keys(users).length}</p>
        <p><strong>Frontend:</strong> <a href="${FRONTEND_URL}">${FRONTEND_URL}</a></p>
      </div>
      <p>API endpoints are available at /api/*</p>
    </body>
    </html>
  `);
});

// ==================== TELEGRAM BOT FUNCTIONS ====================

// Команда /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const firstName = msg.from.first_name || 'Пользователь';
  
  console.log(`👤 /start от ${userId} (${firstName})`);
  
  if (!users[userId]) {
    users[userId] = {
      id: userId,
      chatId: chatId,
      firstName: firstName,
      firstSeen: new Date().toISOString(),
      hasContacts: false,
      approved: false,
      addedToChannel: false
    };
    saveData();
  }
  
  const user = users[userId];
  
  if (userId.toString() === ADMIN_ID.toString()) {
    const userCount = Object.keys(users).length;
    const pendingCount = Object.values(users).filter(u => u.hasContacts && !u.approved).length;
    const inChannelCount = Object.values(users).filter(u => u.addedToChannel).length;
    
    await bot.sendMessage(
      chatId,
      `👑 <b>Привет, администратор ${firstName}!</b>\n\n` +
      `📊 <b>Статистика:</b>\n` +
      `👥 Всего пользователей: ${userCount}\n` +
      `⏳ Ожидают подтверждения: ${pendingCount}\n` +
      `📢 В канале: ${inChannelCount}\n\n` +
      `🎯 <b>Быстрые действия:</b>\n` +
      `• /pending - список ожидающих подтверждения\n` +
      `• /users - все пользователи`,
      { parse_mode: 'HTML' }
    );
  } else if (user.approved) {
    await bot.sendMessage(
      chatId,
      `✅ <b>Привет, ${firstName}!</b>\n\n` +
      `Ваш доступ подтвержден!\n\n` +
      `Теперь вы можете создавать объявления:\n\n` +
      `🌺 <b>Создать объявление:</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🌺 СОЗДАТЬ ОБЪЯВЛЕНИЕ',
                url: `${FRONTEND_URL}/?userId=${userId}&chatId=${chatId}`
              }
            ]
          ]
        }
      }
    );
  } else if (user.hasContacts) {
    await bot.sendMessage(
      chatId,
      `⏳ <b>Привет, ${firstName}!</b>\n\n` +
      `Ваши контакты получены.\n` +
      `Администратор проверяет ваши контакты.\n\n` +
      `Обычно проверка занимает несколько минут.\n` +
      `Вы получите уведомление, когда вас подтвердят.`,
      { parse_mode: 'HTML' }
    );
  } else {
    await bot.sendMessage(
      chatId,
      `👋 <b>Привет, ${firstName}!</b>\n\n` +
      `Добро пожаловать в <b>Flower Market</b>!\n\n` +
      `Для создания объявлений нам нужны ваши контакты из телефонной книги.\n` +
      `Контакты будут отправлены администратору для проверки.\n\n` +
      `После подтверждения вы сможете публиковать объявления.\n\n` +
      `📱 <b>Добавить контакты:</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            {
              text: '📱 ДОБАВИТЬ КОНТАКТЫ',
              url: `${FRONTEND_URL}/?userId=${userId}&chatId=${chatId}`
            }
          ]]
        }
      }
    );
  }
});

// Команда для админа: просмотр ожидающих
bot.onText(/\/pending/, async (msg) => {
  const userId = msg.from.id;
  
  if (userId.toString() !== ADMIN_ID.toString()) {
    return bot.sendMessage(msg.chat.id, '❌ Доступ запрещен');
  }
  
  const pendingUsers = Object.values(users).filter(u => u.hasContacts && !u.approved);
  
  if (pendingUsers.length === 0) {
    return bot.sendMessage(msg.chat.id, '✅ Нет пользователей, ожидающих подтверждения');
  }
  
  let message = '⏳ <b>Пользователи, ожидающие подтверждения:</b>\n\n';
  
  pendingUsers.forEach((user, index) => {
    message += `${index + 1}. ${user.firstName}\n`;
    message += `   ID: <code>${user.id}</code>\n`;
    message += `   Контактов: ${user.contactsCount}\n`;
    message += `   Источник: ${user.importSource || 'неизвестно'}\n`;
    message += `   [Подтвердить](approve_${user.id})\n\n`;
  });
  
  bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

// Команда для админа: все пользователи
bot.onText(/\/users/, async (msg) => {
  const userId = msg.from.id;
  
  if (userId.toString() !== ADMIN_ID.toString()) {
    return bot.sendMessage(msg.chat.id, '❌ Доступ запрещен');
  }
  
  const allUsers = Object.values(users);
  
  if (allUsers.length === 0) {
    return bot.sendMessage(msg.chat.id, '👥 Нет пользователей');
  }
  
  let message = '👥 <b>Все пользователи:</b>\n\n';
  
  allUsers.forEach((user, index) => {
    message += `${index + 1}. ${user.firstName}\n`;
    message += `   ID: <code>${user.id}</code>\n`;
    message += `   Контакты: ${user.hasContacts ? '✅' : '❌'}\n`;
    message += `   Подтвержден: ${user.approved ? '✅' : '❌'}\n`;
    message += `   В канале: ${user.addedToChannel ? '✅' : '❌'}\n\n`;
  });
  
  bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

// Обработка callback-запросов от кнопок
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  
  console.log(`🔘 Callback от ${userId}: ${data}`);
  
  // Проверяем, что это администратор
  if (userId.toString() !== ADMIN_ID.toString()) {
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: '❌ У вас нет прав для этого действия',
      show_alert: true
    });
    return;
  }
  
  if (data.startsWith('approve_')) {
    const targetUserId = data.replace('approve_', '');
    
    try {
      const user = users[targetUserId];
      
      if (!user) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: '❌ Пользователь не найден',
          show_alert: true
        });
        return;
      }
      
      // Подтверждаем пользователя
      user.approved = true;
      user.approvedAt = new Date().toISOString();
      user.approvedBy = userId.toString();
      
      saveData();
      
      // Уведомляем пользователя
      await bot.sendMessage(
        user.chatId || targetUserId,
        `✅ <b>Поздравляем!</b>\n\n` +
        `Ваши контакты подтверждены администратором.\n` +
        `Теперь вы можете создавать объявления в Flower Market!\n\n` +
        `🌺 <b>Создать первое объявление:</b>\n` +
        `${FRONTEND_URL}/?userId=${targetUserId}&chatId=${user.chatId || targetUserId}`,
        { parse_mode: 'HTML' }
      );
      
      // Обновляем сообщение у администратора
      await bot.editMessageText(
        `✅ <b>Пользователь подтвержден</b>\n\n` +
        `👤 Пользователь: ${user.firstName || 'ID: ' + targetUserId}\n` +
        `🆔 ID: <code>${targetUserId}</code>\n` +
        `📅 Подтверждено: ${new Date().toLocaleString('ru-RU')}\n\n` +
        `Пользователь получил уведомление о подтверждении.`,
        {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          parse_mode: 'HTML'
        }
      );
      
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: '✅ Пользователь подтвержден',
        show_alert: true
      });
      
    } catch (error) {
      console.error('❌ Ошибка подтверждения:', error);
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: '❌ Ошибка при подтверждении',
        show_alert: true
      });
    }
  }
});

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

// Уведомление администратора о новых контактах
async function notifyAdminAboutContacts(userId, contactsCount, firstName, contacts, importSource) {
  try {
    let contactsText = '';
    if (contacts && contacts.length > 0) {
      contactsText = '\n\n<b>Первые 3 контакта:</b>\n';
      contacts.slice(0, 3).forEach((contact, index) => {
        const name = contact.name || contact.rawName?.join(' ') || 'Без имени';
        const phone = contact.phone || contact.rawTel?.[0] || 'Нет телефона';
        contactsText += `${index + 1}. ${name}: ${phone}\n`;
      });
      
      if (contacts.length > 3) {
        contactsText += `... и еще ${contacts.length - 3} контактов`;
      }
    }
    
    const sourceText = importSource ? `\n📱 Источник: ${importSource === 'google' ? 'Google Контакты' : importSource === 'test' ? 'Тестовые' : 'Ручной ввод'}` : '';
    
    const message = `📱 <b>НОВЫЕ КОНТАКТЫ</b>\n\n` +
      `👤 Пользователь: ${firstName || 'ID: ' + userId}\n` +
      `🆔 ID: <code>${userId}</code>\n` +
      `📊 Контактов: ${contactsCount}` +
      sourceText +
      `\n📅 Дата: ${new Date().toLocaleString('ru-RU')}` +
      contactsText +
      `\n\n🎯 <b>Действия:</b>`;
    
    // Отправляем сообщение с inline-кнопками
    await bot.sendMessage(ADMIN_ID, message, { 
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '✅ ПОДТВЕРДИТЬ ПОЛЬЗОВАТЕЛЯ',
              callback_data: `approve_${userId}`
            }
          ]
        ]
      }
    });
    
    console.log(`✅ Администратор уведомлен о ${contactsCount} контактах пользователя ${userId}`);
    
  } catch (error) {
    console.error('❌ Ошибка уведомления админа:', error.message);
  }
}

// ==================== ЗАПУСК СЕРВЕРА ====================

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('🌺 FLOWER MARKET BACKEND ЗАПУЩЕН');
  console.log('='.repeat(60));
  console.log(`📍 Порт: ${PORT}`);
  console.log(`🌐 Фронтенд: ${FRONTEND_URL}`);
  console.log(`🤖 Бот: активен`);
  console.log(`📢 Канал: ${CHANNEL_ID}`);
  console.log(`👑 Админ ID: ${ADMIN_ID}`);
  console.log(`🔐 Google OAuth: ${GOOGLE_CLIENT_ID ? '✅ Настроен' : '❌ Не настроен'}`);
  console.log('='.repeat(60));
  console.log('✅ API доступны:');
  console.log(`• GET  /api/status`);
  console.log(`• GET  /api/health`);
  console.log(`• GET  /api/user/:id/status`);
  console.log(`• POST /api/upload-contacts`);
  console.log(`• POST /api/test-contacts`);
  console.log(`• POST /api/publish-media-group`);
  console.log(`• POST /api/approve-user/:id`);
  console.log(`• POST /api/auth/google/url`);
  console.log(`• GET  /auth/google/callback`);
  console.log('='.repeat(60));
});

// Автосохранение каждые 30 секунд
setInterval(saveData, 30000);

// Обработка завершения
process.on('SIGINT', () => {
  console.log('\n💾 Сохраняю данные перед выходом...');
  bot.stopPolling();
  saveData();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n💾 Получен SIGTERM, сохраняю данные...');
  bot.stopPolling();
  saveData();
  process.exit(0);
});