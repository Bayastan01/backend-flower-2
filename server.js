const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== БАЗОВАЯ КОНФИГУРАЦИЯ ====================
console.log('🔧 Запуск Flower Market Backend...');
console.log(`📝 NODE_ENV: ${process.env.NODE_ENV || 'development'}`);

// ==================== ПРОВЕРКА ОБЯЗАТЕЛЬНЫХ ПЕРЕМЕННЫХ ====================
const requiredEnvVars = ['BOT_TOKEN', 'CHANNEL_ID'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ Отсутствуют обязательные переменные:');
  missingVars.forEach(varName => console.error(`   - ${varName}`));
  
  // В Railway проверяем наличие в Variables
  console.log('💡 Проверьте Railway Variables:');
  console.log('   1. Зайдите в Railway Dashboard');
  console.log('   2. Выберите ваш проект');
  console.log('   3. Нажмите на сервис "backend"');
  console.log('   4. Нажмите "Variables"');
  console.log('   5. Добавьте:');
  console.log('      BOT_TOKEN=ваш_токен_от_BotFather');
  console.log('      CHANNEL_ID=-100ваш_id_канала');
  console.log('      ADMIN_ID=ваш_telegram_id (опционально)');
}

// ==================== ИНИЦИАЛИЗАЦИЯ БОТА ====================
let bot = null;
if (process.env.BOT_TOKEN) {
  try {
    console.log('🤖 Инициализация Telegram бота...');
    bot = new TelegramBot(process.env.BOT_TOKEN, { 
      polling: true,
      webHook: false 
    });
    console.log('✅ Telegram бот инициализирован');
  } catch (error) {
    console.error('❌ Ошибка инициализации бота:', error.message);
  }
} else {
  console.log('⚠️  BOT_TOKEN не установлен, бот не будет работать');
}

// ==================== НАСТРОЙКА СЕРВЕРА ====================
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ==================== ХРАНЕНИЕ ДАННЫХ ====================
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`📁 Создана директория для данных: ${DATA_DIR}`);
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

// ==================== ОСНОВНЫЕ API ENDPOINTS ====================

// Health check для Railway (ОБЯЗАТЕЛЬНО!)
app.get('/health', (req, res) => {
  console.log('🩺 Health check запрос');
  res.status(200).json({ 
    status: 'OK',
    service: 'flower-market-backend',
    timestamp: new Date().toISOString(),
    users: Object.keys(users).length,
    bot: bot ? 'active' : 'inactive'
  });
});

// Статус сервера
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    service: 'Flower Market API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    usersCount: Object.keys(users).length,
    botStatus: bot ? 'active' : 'inactive',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Статус пользователя
app.get('/api/user/:userId/status', (req, res) => {
  try {
    const userId = req.params.userId;
    const user = users[userId];
    
    if (!user) {
      return res.json({
        success: true,
        hasContacts: false,
        approved: false,
        exists: false
      });
    }
    
    res.json({
      success: true,
      hasContacts: user.hasContacts || false,
      approved: user.approved || false,
      contactsCount: user.contactsCount || 0
    });
    
  } catch (error) {
    console.error('❌ Ошибка проверки статуса:', error);
    res.status(500).json({
      success: false,
      error: 'Внутренняя ошибка сервера'
    });
  }
});

// Загрузка контактов (упрощенная версия)
app.post('/api/upload-contacts', async (req, res) => {
  try {
    const { userId, chatId, contacts, firstName, importSource } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Требуется userId' 
      });
    }
    
    console.log(`📤 Контакты от ${userId}: ${contacts?.length || 0} шт`);
    
    // Минимум 3 контакта
    if (!contacts || contacts.length < 3) {
      return res.status(400).json({
        success: false,
        error: `Требуется минимум 3 контакта`
      });
    }
    
    // Сохраняем пользователя
    users[userId] = {
      id: userId,
      chatId: chatId || userId,
      firstName: firstName || 'User',
      hasContacts: true,
      contactsCount: contacts.length,
      lastContactUpload: new Date().toISOString(),
      approved: false,
      contacts: contacts,
      importSource: importSource || 'unknown'
    };
    
    saveData();
    
    // Уведомляем администратора если есть бот
    if (bot && process.env.ADMIN_ID) {
      try {
        await bot.sendMessage(
          process.env.ADMIN_ID,
          `📱 <b>НОВЫЕ КОНТАКТЫ</b>\n\n` +
          `👤 Пользователь: ${firstName || 'ID: ' + userId}\n` +
          `🆔 ID: <code>${userId}</code>\n` +
          `📊 Контактов: ${contacts.length}\n` +
          `📅 Дата: ${new Date().toLocaleString('ru-RU')}`,
          { parse_mode: 'HTML' }
        );
      } catch (error) {
        console.error('❌ Ошибка уведомления админа:', error.message);
      }
    }
    
    res.json({ 
      success: true, 
      message: '✅ Контакты успешно получены',
      contactsCount: contacts.length
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
    const { userId, chatId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Требуется userId' 
      });
    }
    
    const testContacts = [
      { name: "Тест 1", phone: "555111111", source: "test" },
      { name: "Тест 2", phone: "555222222", source: "test" },
      { name: "Тест 3", phone: "555333333", source: "test" }
    ];
    
    users[userId] = {
      id: userId,
      chatId: chatId || userId,
      firstName: 'Test User',
      hasContacts: true,
      contactsCount: 3,
      lastContactUpload: new Date().toISOString(),
      approved: false,
      contacts: testContacts,
      importSource: 'test',
      isTest: true
    };
    
    saveData();
    
    res.json({ 
      success: true, 
      message: '✅ Тестовые контакты сохранены',
      contactsCount: 3
    });
    
  } catch (error) {
    console.error('❌ Ошибка тестовых контактов:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Внутренняя ошибка сервера'
    });
  }
});

// Google OAuth (упрощенная версия)
app.get('/auth/google', (req, res) => {
  try {
    const { userId, chatId } = req.query;
    
    if (!userId || !chatId) {
      return res.redirect(`${process.env.FRONTEND_URL || 'https://your-frontend.railway.app'}?error=Missing params`);
    }
    
    const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    
    if (!GOOGLE_CLIENT_ID) {
      return res.redirect(`${process.env.FRONTEND_URL || 'https://your-frontend.railway.app'}?google_error=Google OAuth not configured`);
    }
    
    const redirectUri = process.env.RAILWAY_PUBLIC_DOMAIN 
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/auth/google/callback`
      : `${process.env.BACKEND_URL || 'http://localhost:' + PORT}/auth/google/callback`;
    
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/contacts.readonly',
      state: Buffer.from(JSON.stringify({ userId, chatId })).toString('base64'),
      access_type: 'offline',
      prompt: 'consent'
    });
    
    res.redirect(authUrl);
    
  } catch (error) {
    console.error('❌ Ошибка Google OAuth:', error);
    res.redirect(`${process.env.FRONTEND_URL || 'https://your-frontend.railway.app'}?google_error=${encodeURIComponent(error.message)}`);
  }
});

// Google callback
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    
    if (error) {
      return res.redirect(`${process.env.FRONTEND_URL || 'https://your-frontend.railway.app'}?google_error=${encodeURIComponent(error)}`);
    }
    
    if (!code || !state) {
      return res.redirect(`${process.env.FRONTEND_URL || 'https://your-frontend.railway.app'}?error=Missing code or state`);
    }
    
    // Декодируем state
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    } catch (e) {
      return res.redirect(`${process.env.FRONTEND_URL || 'https://your-frontend.railway.app'}?error=Invalid state`);
    }
    
    const { userId, chatId } = stateData;
    
    // Здесь должна быть логика получения токена и контактов
    // Для простоты создаем тестовые контакты
    const googleContacts = [
      { name: "Google Контакт 1", phone: "555444444", source: "google" },
      { name: "Google Контакт 2", phone: "555555555", source: "google" },
      { name: "Google Контакт 3", phone: "555666666", source: "google" }
    ];
    
    users[userId] = {
      id: userId,
      chatId: chatId || userId,
      firstName: 'Google User',
      hasContacts: true,
      contactsCount: googleContacts.length,
      lastContactUpload: new Date().toISOString(),
      approved: false,
      contacts: googleContacts,
      importSource: 'google'
    };
    
    saveData();
    
    // Редирект на фронтенд с успехом
    res.redirect(`${process.env.FRONTEND_URL || 'https://your-frontend.railway.app'}/?userId=${userId}&chatId=${chatId}&google_success=true&contactsCount=${googleContacts.length}`);
    
  } catch (error) {
    console.error('❌ Ошибка Google callback:', error);
    res.redirect(`${process.env.FRONTEND_URL || 'https://your-frontend.railway.app'}?google_error=${encodeURIComponent(error.message)}`);
  }
});

// Главная страница API
app.get('/', (req, res) => {
  res.json({
    message: 'Flower Market Backend API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      status: '/api/status',
      userStatus: '/api/user/:id/status',
      uploadContacts: '/api/upload-contacts',
      testContacts: '/api/test-contacts',
      googleAuth: '/auth/google',
      googleCallback: '/auth/google/callback'
    },
    docs: 'API documentation available at /api/status'
  });
});

// ==================== ЗАПУСК СЕРВЕРА ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log('🚀 FLOWER MARKET BACKEND ЗАПУЩЕН');
  console.log('='.repeat(60));
  console.log(`📍 Порт: ${PORT}`);
  console.log(`🌐 URL: http://0.0.0.0:${PORT}`);
  console.log(`🤖 Бот: ${bot ? '✅ активен' : '❌ неактивен'}`);
  console.log(`📊 Пользователей: ${Object.keys(users).length}`);
  console.log('='.repeat(60));
  console.log('✅ API доступны:');
  console.log(`   GET  /health`);
  console.log(`   GET  /api/status`);
  console.log(`   GET  /api/user/:id/status`);
  console.log(`   POST /api/upload-contacts`);
  console.log(`   POST /api/test-contacts`);
  console.log(`   GET  /auth/google`);
  console.log(`   GET  /auth/google/callback`);
  console.log('='.repeat(60));
});

// Автосохранение каждые 30 секунд
setInterval(saveData, 30000);

// Обработка завершения
process.on('SIGINT', () => {
  console.log('\n💾 Сохраняю данные...');
  if (bot) bot.stopPolling();
  saveData();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n💾 Получен SIGTERM...');
  if (bot) bot.stopPolling();
  saveData();
  process.exit(0);
});