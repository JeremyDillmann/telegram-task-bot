// bot.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// Proper bot initialization with webhook cleanup
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { 
  polling: false,
  filepath: false 
});

// Clean startup process
async function initBot() {
  try {
    // Clear any existing webhooks
    await bot.deleteWebHook();
    console.log('Webhook cleared');
    
    // Start polling
    await bot.startPolling();
    console.log('Bot polling started successfully');
    
    // Set bot commands for better UX
    await bot.setMyCommands([
      { command: 'list', description: 'Show your tasks' },
      { command: 'all', description: 'Show all tasks' },
      { command: 'help', description: 'Get help' }
    ]);
    
    return bot;
  } catch (err) {
    console.error('Failed to initialize bot:', err);
    process.exit(1);
  }
}

module.exports = { bot, initBot };