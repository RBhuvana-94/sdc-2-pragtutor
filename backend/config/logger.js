const winston = require('winston');
const axios = require('axios');

// Create Winston logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'livequiz-plus' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Logstash integration
const sendToLogstash = async (logData) => {
  const logstashUrl = process.env.LOGSTASH_URL || 'http://localhost:5000';
  
  try {
    await axios.post(logstashUrl, logData, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 1000
    });
  } catch (error) {
    // Silently fail if Logstash is not available
    if (process.env.NODE_ENV === 'development') {
      console.warn('Logstash unavailable:', error.message);
    }
  }
};

// Enhanced logging with Logstash
const enhancedLogger = {
  info: (message, meta = {}) => {
    const logData = {
      '@timestamp': new Date().toISOString(),
      level: 'info',
      message,
      ...meta
    };
    logger.info(message, meta);
    sendToLogstash(logData);
  },

  error: (message, meta = {}) => {
    const logData = {
      '@timestamp': new Date().toISOString(),
      level: 'error',
      message,
      ...meta
    };
    logger.error(message, meta);
    sendToLogstash(logData);
  },

  warn: (message, meta = {}) => {
    const logData = {
      '@timestamp': new Date().toISOString(),
      level: 'warn',
      message,
      ...meta
    };
    logger.warn(message, meta);
    sendToLogstash(logData);
  },

  debug: (message, meta = {}) => {
    logger.debug(message, meta);
  }
};

module.exports = enhancedLogger;

