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

  suggestTasks({ timeAvailable, count, context }, person, chatId) {
    try {
      // Get user's tasks
      const stmt = db.prepare(`
        SELECT * FROM tasks 
        WHERE completed = 0 AND who = ? 
        ORDER BY importance DESC, category
      `);
      const tasks = stmt.all(person);
      
      if (tasks.length === 0) {
        bot.sendMessage(chatId, "No tasks to suggest.");
        return;
      }
      
      // Simple suggestion logic
      let suggestions = [];
      
      if (timeAvailable && timeAvailable <= 10) {
        // Quick tasks
        suggestions = tasks.filter(t => 
          t.title.toLowerCase().includes('sort') ||
          t.title.toLowerCase().includes('find') ||
          t.title.toLowerCase().includes('quick') ||
          t.category === 'general'
        ).slice(0, count || 3);
      } else if (timeAvailable && timeAvailable <= 30) {
        // Medium tasks
        suggestions = tasks.filter(t => 
          t.category === 'household' ||
          t.category === 'shopping'
        ).slice(0, count || 3);
      } else {
        // Just pick top priority
        suggestions = tasks.slice(0, count || 3);
      }
      
      if (suggestions.length === 0) {
        suggestions = tasks.slice(0, count || 3);
      }
      
      let message = `Do these:\n`;
      suggestions.forEach((task, i) => {
        message += `${i + 1}. ${task.title}\n`;
      });
      
      bot.sendMessage(chatId, message.trim());
    } catch (err) {
      console.error('Suggest error:', err);
      bot.sendMessage(chatId, "Can't suggest now.");
    }
  },

  editTask({ taskIdentifier, updates }, person, chatId) {
    try {
      // First find the task
      const findStmt = db.prepare(`
        SELECT * FROM tasks 
        WHERE completed = 0 AND who = ? AND title LIKE ?
        LIMIT 1
      `);
      
      const task = findStmt.get(person, `%${taskIdentifier}%`);
      
      if (!task) {
        bot.sendMessage(chatId, "Can't find that task.");
        return;
      }
      
      // Build update query
      const updateFields = [];
      const params = [];
      
      if (updates.newTitle) {
        updateFields.push('title = ?');
        params.push(updates.newTitle);
      }
      if (updates.newWhen !== undefined) {
        updateFields.push('when_text = ?');
        params.push(updates.newWhen || null);
      }
      if (updates.newWhere !== undefined) {
        updateFields.push('where_text = ?');
        params.push(updates.newWhere || null);
      }
      if (updates.newCategory) {
        updateFields.push('category = ?');
        params.push(updates.newCategory);
      }
      if (updates.newImportance) {
        updateFields.push('importance = ?');
        params.push(updates.newImportance);
      }
      
      if (updateFields.length === 0) {
        bot.sendMessage(chatId, "Nothing to change.");
        return;
      }
      
      // Add the WHERE clause params
      params.push(task.id);
      
      const updateStmt = db.prepare(`
        UPDATE tasks 
        SET ${updateFields.join(', ')}
        WHERE id = ?
      `);
      
      const result = updateStmt.run(...params);
      
      if (result.changes > 0) {
        bot.sendMessage(chatId, "Updated.");
      } else {
        bot.sendMessage(chatId, "Couldn't update.");
      }
    } catch (err) {
      console.error('Edit error:', err);
      bot.sendMessage(chatId, "Error updating.");
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

  deleteTasks({ taskIdentifiers }, person, chatId) {
    try {
      let deleted = 0;
      
      for (const identifier of taskIdentifiers) {
        const stmt = db.prepare(`
          DELETE FROM tasks 
          WHERE completed = 0 AND who = ? AND title LIKE ?
        `);
        
        const result = stmt.run(person, `%${identifier}%`);
        
        if (result.changes > 0) deleted++;
      }
      
      if (deleted === 0) {
        bot.sendMessage(chatId, "Nothing found.");
      } else if (deleted === 1) {
        bot.sendMessage(chatId, "Deleted.");
      } else {
        bot.sendMessage(chatId, `Deleted ${deleted} tasks.`);
      }
    } catch (err) {
      console.error('Delete error:', err);
      bot.sendMessage(chatId, "Couldn't delete.");
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