const axios = require('axios');
const logger = require('../config/logger');
const { backgroundTaskDuration } = require('../config/metrics');
const Quiz = require('../models/Quiz');
const User = require('../models/User');
const { cache } = require('../config/redis');

// Simulate background task processing (in production, this would use Celery)
const processBackgroundTask = async (taskType, taskData) => {
  const startTime = Date.now();
  
  try {
    logger.info(`Background task started: ${taskType}`, taskData);

    switch (taskType) {
      case 'START_QUIZ':
        await startQuizTask(taskData);
        break;
      case 'COMPILE_RESULTS':
        await compileResultsTask(taskData);
        break;
      case 'UPDATE_LEADERBOARD':
        await updateLeaderboardTask();
        break;
      default:
        logger.warn(`Unknown task type: ${taskType}`);
    }

    const duration = (Date.now() - startTime) / 1000;
    backgroundTaskDuration.observe({ task_type: taskType }, duration);
    logger.info(`Background task completed: ${taskType}`, { duration });

    // In production, call Celery API
    if (process.env.CELERY_API_URL) {
      await axios.post(`${process.env.CELERY_API_URL}/tasks`, {
        type: taskType,
        data: taskData
      });
    }
  } catch (error) {
    logger.error(`Background task failed: ${taskType}`, {
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
};

const startQuizTask = async ({ quizId }) => {
  // Simulate processing time
  await new Promise(resolve => setTimeout(resolve, 500));
  
  const quiz = await Quiz.findById(quizId);
  if (!quiz) throw new Error('Quiz not found');

  // Cache quiz data for fast access
  await cache.set(`quiz:${quiz.code}`, {
    id: quiz._id,
    title: quiz.title,
    questions: quiz.questions,
    active: quiz.active
  }, 7200); // 2 hours

  logger.info('Quiz started and cached', { quizCode: quiz.code });
};

const compileResultsTask = async ({ quizId }) => {
  // Simulate processing time
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const quiz = await Quiz.findById(quizId).populate('responses.studentId', 'name');
  if (!quiz) throw new Error('Quiz not found');

  // Calculate leaderboard
  const leaderboard = quiz.responses
    .map(r => ({
      name: r.studentId?.name || 'Anonymous',
      score: r.score,
      studentId: r.studentId?._id
    }))
    .sort((a, b) => b.score - a.score);

  // Cache leaderboard
  await cache.set(`leaderboard:${quiz.code}`, leaderboard, 3600);
  
  logger.info('Results compiled and cached', { quizCode: quiz.code });
};

const updateLeaderboardTask = async () => {
  // Simulate processing time
  await new Promise(resolve => setTimeout(resolve, 800));
  
  const topUsers = await User.find({ role: 'student' })
    .sort({ points: -1 })
    .limit(20)
    .select('name points');

  // Cache global leaderboard
  await cache.set('global_leaderboard', topUsers, 300); // 5 minutes

  logger.info('Global leaderboard updated', { count: topUsers.length });
};

module.exports = { processBackgroundTask };

