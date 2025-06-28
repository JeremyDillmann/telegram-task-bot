// bot.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// Create bot instance (don't start polling yet)
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { 
  polling: false 
});

// Initialize bot with proper error handling
async function initBot() {
  try {
    // Clear any existing webhooks
    await bot.deleteWebHook();
    console.log('Webhook cleared');
    
    // Start polling
    await bot.startPolling();
    console.log('Bot polling started successfully');
    
    return bot;
  } catch (err) {
    console.error('Failed to initialize bot:', err);
    process.exit(1);
  }
}

module.exports = { bot, initBot };