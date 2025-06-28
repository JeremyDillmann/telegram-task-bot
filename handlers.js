// handlers.js
const { bot } = require('./bot');
const { db } = require('./db');

const handlers = {
  createTasks({ tasks }, person, chatId) {
    try {
      let added = 0;
      const stmt = db.prepare(`
        INSERT INTO tasks (title, who, when_text, where_text, importance, category, createdBy, createdAt) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      for (const task of tasks) {
        try {
          stmt.run(
            task.title,
            person,
            task.when_text || null,
            task.where_text || null,
            task.importance || 'normal',
            task.category || 'general',
            person,
            new Date().toISOString()
          );
          added++;
        } catch (err) {
          console.log('Skipping duplicate task');
        }
      }
      
      if (added === 1) {
        bot.sendMessage(chatId, "Got it.");
      } else if (added > 1) {
        bot.sendMessage(chatId, `Added ${added} tasks.`);
      } else {
        bot.sendMessage(chatId, "Already have those.");
      }
    } catch (err) {
      console.error('Create error:', err);
      bot.sendMessage(chatId, "Couldn't save.");
    }
  },

  listTasks({ scope }, person, chatId) {
    try {
      let query = 'SELECT * FROM tasks WHERE completed = 0';
      const params = [];
      
      if (scope === 'personal') {
        query += ' AND who = ?';
        params.push(person);
      }
      
      query += ' ORDER BY importance DESC, category';
      
      const stmt = db.prepare(query);
      const tasks = stmt.all(...params);
      
      if (tasks.length === 0) {
        bot.sendMessage(chatId, "Nothing to do.");
        return;
      }
      
      let message = '';
      let currentCategory = '';
      
      tasks.forEach(task => {
        const cat = task.importance === 'urgent' ? 'URGENT' : task.category.toUpperCase();
        if (cat !== currentCategory) {
          message += `\n${cat}:\n`;
          currentCategory = cat;
        }
        
        const parts = [task.title, task.who];
        if (task.when_text) parts.push(task.when_text);
        if (task.where_text) parts.push(task.where_text);
        
        message += `${parts.join(' | ')}\n`;
      });
      
      bot.sendMessage(chatId, message.trim());
    } catch (err) {
      console.error('List error:', err);
      bot.sendMessage(chatId, "Can't get list.");
    }
  },

  completeTasks({ taskIdentifiers }, person, chatId) {
    try {
      let completed = 0;
      
      for (const identifier of taskIdentifiers) {
        const stmt = db.prepare(`
          UPDATE tasks 
          SET completed = 1, completedAt = ?, completedBy = ? 
          WHERE completed = 0 AND who = ? AND title LIKE ?
        `);
        
        const result = stmt.run(
          new Date().toISOString(),
          person,
          person,
          `%${identifier}%`
        );
        
        if (result.changes > 0) completed++;
      }
      
      if (completed === 0) {
        bot.sendMessage(chatId, "Nothing found.");
      } else {
        bot.sendMessage(chatId, "Done.");
      }
    } catch (err) {
      console.error('Complete error:', err);
      bot.sendMessage(chatId, "Couldn't complete.");
    }
  },

  clearAllTasks(args, person, chatId) {
    try {
      const stmt = db.prepare(`
        UPDATE tasks 
        SET completed = 1, completedAt = ?, completedBy = ? 
        WHERE completed = 0 AND who = ?
      `);
      
      const result = stmt.run(
        new Date().toISOString(),
        person,
        person
      );
      
      bot.sendMessage(chatId, `Cleared ${result.changes} tasks.`);
    } catch (err) {
      console.error('Clear error:', err);
      bot.sendMessage(chatId, "Couldn't clear.");
    }
  },

  respond({ message }, person, chatId) {
    bot.sendMessage(chatId, message);
  }
};

module.exports = handlers;