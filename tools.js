// tools.js
const tools = [
    {
      type: 'function',
      function: {
        name: 'createTasks',
        description: 'Create one or more new tasks. Extract all actionable items from the message.',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              description: 'Array of tasks to create',
              items: {
                type: 'object',
                properties: {
                  title: { 
                    type: 'string', 
                    description: 'Clear, concise task description. E.g., "Buy milk" not "We need to buy milk"' 
                  },
                  when_text: { 
                    type: 'string', 
                    description: 'When to do it: today, tomorrow, next week, etc. Leave empty if not specified.' 
                  },
                  where_text: { 
                    type: 'string', 
                    description: 'Location: DM, Rewe, Aldi, home, etc. Leave empty if not specified.' 
                  },
                  category: { 
                    type: 'string', 
                    enum: ['shopping', 'household', 'work', 'personal', 'general'],
                    description: 'Task category. Use shopping for anything to buy.' 
                  },
                  importance: {
                    type: 'string',
                    enum: ['urgent', 'normal', 'low'],
                    description: 'Task priority. Default to normal unless explicitly urgent.'
                  }
                },
                required: ['title']
              }
            }
          },
          required: ['tasks']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'listTasks',
        description: 'Show active tasks. Use when user asks what to do, what\'s on the list, etc.',
        parameters: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: ['personal', 'all'],
              description: 'personal = tasks for the asking user, all = everyone\'s tasks'
            }
          },
          required: ['scope']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'completeTasks',
        description: 'Mark tasks as done/complete/finished/bought',
        parameters: {
          type: 'object',
          properties: {
            taskIdentifiers: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keywords to identify tasks. E.g., ["milk", "toothbrush"]'
            }
          },
          required: ['taskIdentifiers']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'removeTasks',
        description: 'Delete/remove tasks from the list',
        parameters: {
          type: 'object',
          properties: {
            taskIdentifiers: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keywords to identify tasks to remove'
            }
          },
          required: ['taskIdentifiers']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'clearAllTasks',
        description: 'Clear/delete all active tasks. Use when user says "clear all", "delete everything", etc.',
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'editTask',
        description: 'Change/update/modify an existing task',
        parameters: {
          type: 'object',
          properties: {
            taskIdentifier: { 
              type: 'string', 
              description: 'Keywords to find the task' 
            },
            updates: {
              type: 'object',
              description: 'What to change',
              properties: {
                title: { type: 'string' },
                who: { type: 'string' },
                when_text: { type: 'string' },
                where_text: { type: 'string' },
                importance: { type: 'string', enum: ['urgent', 'normal', 'low'] }
              }
            }
          },
          required: ['taskIdentifier', 'updates']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'respond',
        description: 'Send a message when no other tool is needed. Use for greetings, clarifications, or when user input doesn\'t relate to tasks.',
        parameters: {
          type: 'object',
          properties: {
            message: { 
              type: 'string', 
              description: 'Brief response in grandma style. Max 10 words.' 
            }
          },
          required: ['message']
        }
      }
    }
  ];
  
  module.exports = tools;