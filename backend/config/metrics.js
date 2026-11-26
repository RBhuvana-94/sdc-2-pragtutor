const promClient = require('prom-client');

// Create a Registry to register the metrics
const register = new promClient.Registry();

// Add default metrics (CPU, memory, etc.)
promClient.collectDefaultMetrics({ register });

// Custom metrics
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5]
});

const httpRequestTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status']
});

const activeQuizzes = new promClient.Gauge({
  name: 'active_quizzes_total',
  help: 'Number of active quizzes'
});

const activeConnections = new promClient.Gauge({
  name: 'websocket_connections_total',
  help: 'Number of active WebSocket connections'
});

const quizResponsesTotal = new promClient.Counter({
  name: 'quiz_responses_total',
  help: 'Total number of quiz responses',
  labelNames: ['quiz_code']
});

const backgroundTaskDuration = new promClient.Histogram({
  name: 'background_task_duration_seconds',
  help: 'Duration of background tasks in seconds',
  labelNames: ['task_type'],
  buckets: [1, 5, 10, 30, 60]
});

const cacheHits = new promClient.Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits',
  labelNames: ['cache_key']
});

const cacheMisses = new promClient.Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses',
  labelNames: ['cache_key']
});

// Register all metrics
register.registerMetric(httpRequestDuration);
register.registerMetric(httpRequestTotal);
register.registerMetric(activeQuizzes);
register.registerMetric(activeConnections);
register.registerMetric(quizResponsesTotal);
register.registerMetric(backgroundTaskDuration);
register.registerMetric(cacheHits);
register.registerMetric(cacheMisses);

module.exports = {
  register,
  httpRequestDuration,
  httpRequestTotal,
  activeQuizzes,
  activeConnections,
  quizResponsesTotal,
  backgroundTaskDuration,
  cacheHits,
  cacheMisses
};

