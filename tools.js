// tools.js
const tools = [
    {
      type: 'function',
      function: {
        name: 'createTasks',
        description: 'Create new tasks ONLY when user explicitly wants to add tasks. NOT for questions or requests for suggestions.',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  when_text: { type: 'string' },
                  where_text: { type: 'string' },
                  category: { 
                    type: 'string', 
                    enum: ['shopping', 'household', 'work', 'personal', 'general'] 
                  },
                  importance: { 
                    type: 'string', 
                    enum: ['urgent', 'normal', 'low'] 
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
        description: 'Show current tasks when user asks to see their list',
        parameters: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: ['personal', 'all']
            }
          },
          required: ['scope']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'suggestTasks',
        description: 'Suggest which tasks to do based on available time or context. Use when user asks for suggestions, recommendations, or what to do in X minutes.',
        parameters: {
          type: 'object',
          properties: {
            timeAvailable: { 
              type: 'number',
              description: 'Minutes available (if mentioned)'
            },
            count: {
              type: 'number',
              description: 'How many suggestions requested'
            },
            context: {
              type: 'string',
              description: 'Any context like location or mood'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'editTask',
        description: 'Edit or update an existing task. Use when user wants to change, rename, or modify a task.',
        parameters: {
          type: 'object',
          properties: {
            taskIdentifier: { 
              type: 'string',
              description: 'Part of the current task title to identify it'
            },
            updates: {
              type: 'object',
              properties: {
                newTitle: { type: 'string' },
                newWhen: { type: 'string' },
                newWhere: { type: 'string' },
                newCategory: { 
                  type: 'string',
                  enum: ['shopping', 'household', 'work', 'personal', 'general']
                },
                newImportance: {
                  type: 'string',
                  enum: ['urgent', 'normal', 'low']
                }
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
        name: 'completeTasks',
        description: 'Mark tasks as done',
        parameters: {
          type: 'object',
          properties: {
            taskIdentifiers: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['taskIdentifiers']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'deleteTasks',
        description: 'Delete tasks without completing them. Use when user wants to remove or delete tasks.',
        parameters: {
          type: 'object',
          properties: {
            taskIdentifiers: {
              type: 'array',
              items: { type: 'string' }
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
        description: 'Clear all tasks',
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'respond',
        description: 'General response when no task operation needed',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string' }
          },
          required: ['message']
        }
      }
    }
  ];
  
  module.exports = tools;