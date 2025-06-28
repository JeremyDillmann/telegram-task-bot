// grandma-bot.js
require('dotenv').config();
const OpenAI = require('openai');
const { bot, initBot } = require('./bot');
const { db } = require('./db');
const tools = require('./tools');
const handlers = require('./handlers');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Simple conversation memory
const conversations = new Map();

function remember(userId, role, content) {
  if (!conversations.has(userId)) {
    conversations.set(userId, []);
  }
  const history = conversations.get(userId);
  history.push({ role, content: content || '' });
  if (history.length > 10) history.shift();
}

// Main message handler
bot.on('message', async (msg) => {
  if (msg.from.is_bot || !msg.text) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const person = msg.from.first_name || msg.from.username || 'child';

  try {
    bot.sendChatAction(chatId, 'typing');
    
    remember(userId, 'user', msg.text);
    
    const messages = [
      { 
        role: 'system', 
        content: 'You are a terse grandma. Max 10 words. Be direct. No emojis.' 
      },
      ...(conversations.get(userId) || [])
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: messages,
      tools: tools,
      tool_choice: 'auto',
      temperature: 0.3
    });

    const message = response.choices[0].message;
    
    if (message.content) {
      remember(userId, 'assistant', message.content);
    }

    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);
        
        console.log(`Calling ${functionName}:`, functionArgs);
        
        if (handlers[functionName]) {
          await handlers[functionName](functionArgs, person, chatId);
        }
      }
    } else if (message.content) {
      bot.sendMessage(chatId, message.content);
    }

  } catch (error) {
    console.error('Error:', error);
    bot.sendMessage(chatId, "Error. Try again.");
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await bot.stopPolling();
  db.close();
  process.exit(0);
});

// Start bot
async function start() {
  try {
    await initBot();
    console.log('Grandma Bot is ready!');
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();