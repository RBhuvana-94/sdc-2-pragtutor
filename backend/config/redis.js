const redis = require('redis');
const logger = require('./logger');

let redisClient = null;

const connectRedis = async () => {
  try {
    // Check if Redis URL is provided
    if (!process.env.REDIS_URL && !process.env.REDIS_REQUIRED) {
      logger.info('Redis not configured - running without cache (app will work fine)');
      return null;
    }

    redisClient = redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379'
    });

    redisClient.on('error', (err) => {
      logger.warn('Redis Client Error (app continues without cache)', { error: err.message });
      redisClient = null; // Set to null so cache functions return gracefully
    });

    redisClient.on('connect', () => {
      logger.info('Redis Client Connected');
    });

    await redisClient.connect();
    return redisClient;
  } catch (error) {
    logger.warn('Redis Connection Failed (app continues without cache)', { error: error.message });
    redisClient = null;
    return null;
  }
};

const getRedisClient = () => redisClient;

// Cache helpers
const cache = {
  async get(key) {
    if (!redisClient) return null;
    try {
      const data = await redisClient.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error('Redis GET Error', { key, error: error.message });
      return null;
    }
  },

  async set(key, value, ttl = 3600) {
    if (!redisClient) return false;
    try {
      await redisClient.setEx(key, ttl, JSON.stringify(value));
      return true;
    } catch (error) {
      logger.error('Redis SET Error', { key, error: error.message });
      return false;
    }
  },

  async del(key) {
    if (!redisClient) return false;
    try {
      await redisClient.del(key);
      return true;
    } catch (error) {
      logger.error('Redis DEL Error', { key, error: error.message });
      return false;
    }
  },

  async exists(key) {
    if (!redisClient) return false;
    try {
      return await redisClient.exists(key) === 1;
    } catch (error) {
      logger.error('Redis EXISTS Error', { key, error: error.message });
      return false;
    }
  }
};

module.exports = { connectRedis, getRedisClient, cache };

