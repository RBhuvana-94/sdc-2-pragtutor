require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const User = require('./models/User');
const Quiz = require('./models/Quiz');
const { connectRedis, cache } = require('./config/redis');
const logger = require('./config/logger');
const {
  register,
  httpRequestDuration,
  httpRequestTotal,
  activeQuizzes,
  activeConnections,
  quizResponsesTotal
} = require('./config/metrics');
const { processBackgroundTask } = require('./services/backgroundTasks');

const JWT_SECRET = process.env.JWT_SECRET || 'livequiz-secret-2025';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const sanitizeQuestion = (question = {}, index = 0) => ({
  index,
  text: question.text || question.question || '',
  options: Array.isArray(question.options) ? question.options : [],
  image: question.image || null
});

const buildLeaderboard = (quizDoc) => {
  if (!quizDoc || !Array.isArray(quizDoc.responses)) return [];
  return quizDoc.responses
    .map(response => ({
      studentId: response.studentId?._id?.toString() || response.studentId?.toString(),
      name: response.studentId?.name || 'Anonymous',
      score: response.score || 0
    }))
    .sort((a, b) => b.score - a.score);
};

const getUserFromToken = async (token) => {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return await User.findById(decoded.id).select('name role points');
  } catch (error) {
    return null;
  }
};


const emitLiveScoreboard = async (quizDoc) => {
  const populated = await Quiz.findById(quizDoc._id).populate('responses.studentId', 'name');
  const leaderboard = buildLeaderboard(populated);
  // Send to teacher room only
  io.to(`${populated.code}:teacher`).emit('scoreboardUpdated', { code: populated.code, leaderboard });
  await cache.del(`leaderboard:${populated.code}`);
  return leaderboard;
};

const broadcastQuizSync = async (code) => {
  const quiz = await Quiz.findOne({ code }).select('title questions active currentQuestionIndex');
  if (!quiz) return;

  const teacherPayload = {
    code,
    title: quiz.title,
    questions: quiz.questions,
    active: quiz.active,
    currentQuestionIndex: quiz.currentQuestionIndex || -1
  };
  io.to(`${code}:teacher`).emit('quizData', teacherPayload);

  const studentPayload = {
    code,
    title: quiz.title,
    questions: quiz.questions.map((q, i) => sanitizeQuestion(q, i)),
    active: quiz.active
  };
  io.to(`${code}:student`).emit('quizData', studentPayload);
};

// Create logs directory
if (!fs.existsSync('./logs')) fs.mkdirSync('./logs');
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/uploads', express.static('uploads'));

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// (Monitoring endpoint inserted later after authenticateToken is defined)

// Request logging and metrics middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route ? req.route.path : req.path;
    httpRequestDuration.observe({ method: req.method, route, status: res.statusCode }, duration);
    httpRequestTotal.inc({ method: req.method, route, status: res.statusCode });
    logger.info('HTTP Request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration
    });
  });
  next();
});

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/livequiz')
  .then(() => {
    logger.info('MongoDB Connected');
  })
  .catch(err => {
    logger.error('MongoDB Connection Error', { error: err.message });
  });

// Connect to Redis (optional - app works without it)
connectRedis().then((client) => {
  if (client) {
    logger.info('Redis connection initialized');
  } else {
    logger.info('Running without Redis cache (app will work fine, just slower)');
  }
}).catch(() => {
  logger.info('Redis not available - app continues without cache');
});

// JWT Authentication middleware
const authenticateToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: "No token" });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
};

// Monitoring API - returns JSON-friendly metrics and basic health checks
app.get('/api/monitoring', authenticateToken, async (req, res) => {
  try {
    // Only teachers may access monitoring dashboard
    if (!req.user || req.user.role !== 'teacher') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get metrics as JSON from prom-client register
    const metrics = await register.getMetricsAsJSON();

    // Basic health checks: MongoDB connection state and Redis
    const mongooseState = mongoose.connection ? mongoose.connection.readyState : 0; // 1 = connected
    let redisConnected = false;
    try {
      const client = getRedisClient();
      redisConnected = !!(client && client.isOpen);
    } catch (e) {
      redisConnected = false;
    }

    const health = {
      pid: process.pid,
      uptime_seconds: process.uptime(),
      memory: process.memoryUsage(),
      node_version: process.version,
      mongo_readyState: mongooseState,
      redis_connected: redisConnected
    };

    res.json({ metrics, health });
  } catch (error) {
    logger.error('Monitoring endpoint error', { error: error.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== AUTHENTICATION ENDPOINTS ====================

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    let { name, email, password, role } = req.body;
    if (!email || !password || !role) {
      return res.status(400).json({ error: "Name, email, password and role are required" });
    }

    role = role.toLowerCase();
    if (!['teacher', 'student'].includes(role)) {
      return res.status(400).json({ error: "Invalid role selected" });
    }

    email = email.trim().toLowerCase();
    const gmailPattern = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;
    if (!gmailPattern.test(email)) {
      return res.status(400).json({ error: "Email must be a valid Gmail address" });
    }
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: "Email already exists" });
    }

    const user = new User({ name, email, password, role, points: 0, badges: [] });
    await user.save();
    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET);
    
    logger.info('User registered', { userId: user._id, email, role });
    res.json({ success: true, token, user: { name: user.name, role: user.role } });
  } catch (e) {
    logger.error('Registration failed', { error: e.message });
    res.status(500).json({ error: "Unable to register user" });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = email?.trim().toLowerCase();
    const gmailPattern = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;
    if (!gmailPattern.test(normalizedEmail)) {
      return res.status(400).json({ error: "Email must be a valid Gmail address" });
    }
    const user = await User.findOne({ email: normalizedEmail });
    if (!user || !(await user.comparePassword(password))) {
      logger.warn('Login failed', { email });
      return res.status(400).json({ error: "Wrong credentials" });
    }
    
    user.lastLogin = new Date();
    await user.save();
    
    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET);
    
    logger.info('User logged in', { userId: user._id, email, role: user.role });
    res.json({ success: true, token, user: { name: user.name, role: user.role } });
  } catch (e) {
    logger.error('Login error', { error: e.message });
    res.status(500).json({ error: "Server error" });
  }
});

// Get current user
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    // Try cache first
    const cacheKey = `user:${req.user.id}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const user = await User.findById(req.user.id).select('name email role points badges');
    if (user) {
      await cache.set(cacheKey, user, 300); // Cache for 5 minutes
    }
    res.json(user);
  } catch (error) {
    logger.error('Get user error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== QUIZ ENDPOINTS ====================

// Create quiz
app.post('/api/quiz/create', authenticateToken, upload.array('images'), async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: "Only teachers" });
  
  try {
    const questions = JSON.parse(req.body.questions).map((q, i) => ({
      ...q,
      image: req.files?.[i] ? '/uploads/' + req.files[i].filename : null
    }));
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const quiz = new Quiz({ 
      title: req.body.title, 
      questions, 
      code, 
      teacherId: req.user.id, 
      active: true,
      currentQuestionIndex: -1 // Quiz not started yet
    });
    await quiz.save();
    
    // Process quiz start in background
    processBackgroundTask('START_QUIZ', { quizId: quiz._id }).catch(err => {
      logger.error('Background task error', { error: err.message });
    });
    
    // Update active quizzes metric
    activeQuizzes.inc();
    
    io.emit('newLiveQuiz', { code, title: quiz.title });
    
    logger.info('Quiz created', { quizId: quiz._id, code, teacherId: req.user.id });
    res.json({ success: true, code });
  } catch (error) {
    logger.error('Quiz creation error', { error: error.message });
    res.status(500).json({ error: "Failed to create quiz" });
  }
});

// Join quiz
app.post('/api/join/quiz', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    
    // Try cache first
    const cacheKey = `quiz:${code}`;
    let quiz = await cache.get(cacheKey);
    
    if (!quiz) {
      const dbQuiz = await Quiz.findOne({ code, active: true });
      if (!dbQuiz) return res.status(404).json({ error: "Quiz not found or closed" });

      // Determine if this student has already submitted
      const response = dbQuiz.responses.find(r => r.studentId.toString() === req.user.id);
      const hasSubmitted = response && response.answers &&
        response.answers.length === dbQuiz.questions.length &&
        response.answers.every(a => a !== undefined && a !== null);

      quiz = {
        id: dbQuiz._id,
        title: dbQuiz.title,
        questions: dbQuiz.questions,
        active: dbQuiz.active,
        hasSubmitted,
        myScore: response ? response.score || 0 : 0
      };
      await cache.set(cacheKey, quiz, 7200);
    }
    
    const dbQuiz2 = await Quiz.findById(quiz.id);
    if (!dbQuiz2.participants.includes(req.user.id)) {
      dbQuiz2.participants.push(req.user.id);
      await dbQuiz2.save();
      // Invalidate cache
      await cache.del(cacheKey);
    }

    // Compute per-user submission state from DB (do NOT trust cached quiz for
    // user-specific flags). This ensures joining via the quiz card or code
    // always returns the correct hasSubmitted/myScore values.
    const userResponse = dbQuiz2.responses.find(r => r.studentId.toString() === req.user.id);
    const computedHasSubmitted = !!(userResponse && (
      userResponse.submitted === true || (
        Array.isArray(userResponse.answers) &&
        userResponse.answers.length === dbQuiz2.questions.length &&
        userResponse.answers.every(a => a !== undefined && a !== null)
      )
    ));
    const computedMyScore = userResponse ? (userResponse.score || 0) : 0;

    logger.info('User joined quiz', { userId: req.user.id, quizCode: code, hasSubmitted: computedHasSubmitted });
    res.json({ success: true, quizId: quiz.id, title: quiz.title, hasSubmitted: computedHasSubmitted, myScore: computedMyScore });
  } catch (error) {
    logger.error('Join quiz error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

// Submit answer - accepts all answers at once
app.post('/api/quiz/:code/answer', authenticateToken, async (req, res) => {
  try {
    const { answers } = req.body; // Expect array of all answers
    // Load quiz to compute score and check existing response
    const quiz = await Quiz.findOne({ code: req.params.code, active: true });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    if (!quiz.active) return res.status(400).json({ error: "Quiz is not active" });

    if (!Array.isArray(answers)) return res.status(400).json({ error: "Answers must be an array" });

    // Compute score based on current quiz questions
    let score = 0;
    quiz.questions.forEach((q, i) => {
      if (answers[i] !== undefined && answers[i] === q.correct) score++;
    });

    // Attempt atomic update of an existing unsubmitted response
    const mongoose = require('mongoose');
    const studentObjectId = new mongoose.Types.ObjectId(req.user.id);

    // Determine previous score if any (read-before-update to compute delta)
    const existingResp = quiz.responses.find(r => r.studentId.toString() === req.user.id);
    const previousScoreFromDb = existingResp ? (existingResp.score || 0) : 0;

    // First, try to update an existing response for this student only if it's not submitted
    const updated = await Quiz.findOneAndUpdate(
      { code: req.params.code, active: true, 'responses.studentId': studentObjectId, 'responses.submitted': { $ne: true } },
      { $set: { 'responses.$.answers': answers, 'responses.$.score': score, 'responses.$.submitted': true } },
      { new: true }
    );

    let resultingQuiz = null;
    let previousScore = 0;

    if (updated) {
      // Successfully updated existing unsubmitted response
      resultingQuiz = updated;
      previousScore = previousScoreFromDb;
    } else {
      // No existing unsubmitted response found — try to insert a new response only
      const pushed = await Quiz.findOneAndUpdate(
        { code: req.params.code, active: true, 'responses.studentId': { $ne: studentObjectId } },
        { $push: { responses: { studentId: studentObjectId, answers, score, submitted: true } } },
        { new: true }
      );

      if (pushed) {
        resultingQuiz = pushed;
        previousScore = 0;
      } else {
        // Either a submitted response already exists, or a concurrent request won.
        return res.status(400).json({ error: "You have already submitted your answers" });
      }
    }

    // Populate student names for leaderboard
    await resultingQuiz.populate('responses.studentId', 'name');

    // Build fresh leaderboard for immediate return/emit
    const leaderboard = buildLeaderboard(resultingQuiz);

    // Invalidate cache
    await cache.del(`quiz:${req.params.code}`);
    await cache.del(`leaderboard:${req.params.code}`);

    const scoreDelta = score - previousScore;
    if (scoreDelta !== 0) {
      await User.findByIdAndUpdate(req.user.id, { $inc: { points: scoreDelta } });
    }

    // Emit updated leaderboard and response counts to teacher and students
    io.to(`${req.params.code}:teacher`).emit('scoreboardUpdated', { code: req.params.code, leaderboard });
    io.to(`${req.params.code}:student`).emit('scoreboardUpdated', { code: req.params.code, leaderboard });

    // Also send short answerReceived + responseCountUpdated events
    const user = await User.findById(req.user.id).select('name');
    const studentName = user ? user.name : 'Anonymous';
    io.to(`${req.params.code}:teacher`).emit('answerReceived', { 
      userId: req.user.id, 
      studentName: studentName,
      score 
    });
    const responseCount = resultingQuiz.responses.length;
    io.to(`${req.params.code}:student`).emit('responseCountUpdated', { 
      count: responseCount 
    });
    io.to(`${req.params.code}:teacher`).emit('responseCountUpdated', { 
      count: responseCount 
    });

    quizResponsesTotal.inc({ quiz_code: req.params.code });

    logger.info('Answer submitted', { userId: req.user.id, quizCode: req.params.code, score });
    res.json({ success: true, score, submitted: true, leaderboard });
  } catch (error) {
    logger.error('Submit answer error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

// Get live quizzes (only active ones)
app.get('/api/quiz/live', async (req, res) => {
  try {
    // Try cache first
    const cached = await cache.get('live_quizzes');
    if (cached) {
      return res.json(cached);
    }

    // Only get ACTIVE quizzes (not ended)
    const live = await Quiz.find({ active: true })
      .select('title code participants teacherId')
      .populate('teacherId', 'name');

    const result = live.map(q => ({
      title: q.title,
      code: q.code,
      teacher: q.teacherId?.name || 'Unknown',
      players: q.participants.length
    }));

    await cache.set('live_quizzes', result, 5); // Cache for 5 seconds
    res.json(result);
  } catch (error) {
    logger.error('Get live quizzes error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

// Get quiz data with current question index
app.get('/api/quiz/:code/data', authenticateToken, async (req, res) => {
  try {
    const quiz = await Quiz.findOne({ code: req.params.code });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    
    // For students, only return if quiz is active or they participated
    if (req.user.role === 'student') {
      if (!quiz.active && !quiz.participants.includes(req.user.id)) {
        return res.status(403).json({ error: "Quiz not available" });
      }
      
      // Check if student already submitted
      // Check if student already submitted
// Check if student already submitted
const response = quiz.responses.find(r => r.studentId.toString() === req.user.id);
const hasSubmitted = response && response.answers &&
  response.answers.length === quiz.questions.length &&
  response.answers.every(a => a !== undefined && a !== null);

// 🚫 If submitted, DO NOT send questions again
if (hasSubmitted) {
  return res.json({
    title: quiz.title,
    hasSubmitted: true,
    myScore: response.score,
    message: "You have already submitted the quiz."
  });
}


      
      // If not submitted → allow
      res.json({
        title: quiz.title,
        questions: quiz.questions,
        active: quiz.active,
        currentQuestionIndex: quiz.currentQuestionIndex || -1,
        hasSubmitted: false,
        myScore: null
      });
      return;
    }
    
    // For teachers, verify ownership
    if (req.user.role === 'teacher' && quiz.teacherId.toString() !== req.user.id) {
      return res.status(403).json({ error: "Access denied" });
    }
    
    res.json({
      title: quiz.title,
      questions: quiz.questions,
      active: quiz.active,
      currentQuestionIndex: quiz.currentQuestionIndex || -1
    });
  } catch (error) {
    logger.error('Get quiz data error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});


// Get quiz participants
app.get('/api/quiz/:code/participants', authenticateToken, async (req, res) => {
  try {
    const code = req.params.code;
    const room = io.sockets.adapter.rooms.get(`${code}:student`);
    const activeIds = [];
    if (room) {
      for (const socketId of room) {
        const info = socketUsers.get(socketId);
        if (info && info.role === 'student' && info.userId) {
          activeIds.push(info.userId);
        }
      }
    }

    if (activeIds.length === 0) return res.json([]);

    const users = await User.find({ _id: { $in: activeIds } }).select('name');
    const list = users.map(u => ({ id: u._id.toString(), name: u.name }));
    res.json(list);
  } catch (error) {
    logger.error('Get participants error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

// Start quiz - sends all questions at once
app.post('/api/quiz/:code/start', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: "Only teachers" });
  
  try {
    const quiz = await Quiz.findOne({ code: req.params.code, teacherId: req.user.id });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    
    if (quiz.questions.length === 0) {
      return res.status(400).json({ error: "Quiz must have at least one question" });
    }
    
    // Mark quiz as started (active) and set currentQuestionIndex to indicate quiz is live
    quiz.active = true;
    quiz.currentQuestionIndex = 0; // Set to 0 to indicate quiz has started
    await quiz.save();
    await cache.del(`quiz:${req.params.code}`);
    
    // Send ALL questions to all students at once
    const allQuestions = quiz.questions.map((q, i) => ({
      index: i,
      text: q.text,
      options: q.options,
      image: q.image || null
    }));
    
    // Broadcast to student room
    io.to(`${req.params.code}:student`).emit('quizStarted', { 
      code: req.params.code,
      title: quiz.title,
      questions: allQuestions,
      active: true
    });
    
    // Notify teacher room
    io.to(`${req.params.code}:teacher`).emit('quizStarted', {
      code: req.params.code,
      questions: allQuestions
    });
    
    // Update participant count
    const studentRoom = io.sockets.adapter.rooms.get(`${req.params.code}:student`);
    const participantCount = studentRoom ? studentRoom.size : 0;
    io.to(`${req.params.code}:teacher`).emit('participantCountUpdated', { 
      count: participantCount,
      participants: participantCount
    });
    
    // Emit quiz live status for dashboards
    io.emit('quizStatusChanged', { code: req.params.code, active: true });
    
    logger.info('Quiz started - all questions sent', { 
      code: req.params.code,
      questionCount: allQuestions.length
    });
    
    res.json({ success: true, questions: allQuestions });
  } catch (error) {
    logger.error('Start quiz error', { error: error.message });
    console.error('❌ Error starting quiz:', error);
    const knownErrors = ['Quiz not found', 'Invalid question index'];
    const status = knownErrors.includes(error.message) ? 400 : 500;
    res.status(status).json({ error: error.message || "Server error" });
  }
});

// Add question to quiz
app.post('/api/quiz/:code/question', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: "Only teachers" });
  
  try {
    const quiz = await Quiz.findOne({ code: req.params.code, teacherId: req.user.id });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    
    // Check for duplicate question (same text)
    const duplicate = quiz.questions.find(q => 
      (q.text || q.question) === (req.body.text || req.body.question)
    );
    if (duplicate) {
      return res.status(400).json({ error: "Question already exists" });
    }
    
    quiz.questions.push(req.body);
    await quiz.save();
    await cache.del(`quiz:${req.params.code}`);
    
    const newQuestionIndex = quiz.questions.length - 1;
    const questionPayload = {
      ...req.body,
      index: newQuestionIndex
    };
    
    // Broadcast to teacher room only (students get all questions when quiz starts)
    io.to(`${req.params.code}:teacher`).emit('questionUpdated', { 
      type: 'added', 
      question: questionPayload 
    });

    await broadcastQuizSync(req.params.code);
    
    logger.info('Question added', { quizCode: req.params.code, questionIndex: newQuestionIndex });
    res.json({ success: true, question: questionPayload });
  } catch (error) {
    logger.error('Add question error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

// Update question in quiz
app.put('/api/quiz/:code/question/:index', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: "Only teachers" });
  
  try {
    const quiz = await Quiz.findOne({ code: req.params.code, teacherId: req.user.id });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    
    const index = parseInt(req.params.index);
    if (index < 0 || index >= quiz.questions.length) {
      return res.status(400).json({ error: "Invalid question index" });
    }
    
    quiz.questions[index] = req.body;
    await quiz.save();
    await cache.del(`quiz:${req.params.code}`);
    
    // Broadcast to teacher room only
    io.to(`${req.params.code}:teacher`).emit('questionUpdated', { 
      type: 'updated', 
      questionIndex: index, 
      question: req.body 
    });

    await broadcastQuizSync(req.params.code);
    
    logger.info('Question updated', { quizCode: req.params.code, questionIndex: index });
    res.json({ success: true });
  } catch (error) {
    logger.error('Update question error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

// Delete question from quiz
app.delete('/api/quiz/:code/question/:index', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: "Only teachers" });
  
  try {
    const quiz = await Quiz.findOne({ code: req.params.code, teacherId: req.user.id });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    
    const index = parseInt(req.params.index);
    if (index < 0 || index >= quiz.questions.length) {
      return res.status(400).json({ error: "Invalid question index" });
    }
    
    quiz.questions.splice(index, 1);
    // Adjust currentQuestionIndex if needed
    if (quiz.currentQuestionIndex >= index) {
      quiz.currentQuestionIndex = Math.max(-1, quiz.currentQuestionIndex - 1);
    }
    await quiz.save();
    await cache.del(`quiz:${req.params.code}`);
    
    // Broadcast to teacher room only
    io.to(`${req.params.code}:teacher`).emit('questionUpdated', { 
      type: 'deleted', 
      questionIndex: index 
    });

    await broadcastQuizSync(req.params.code);
    
    logger.info('Question deleted', { quizCode: req.params.code, questionIndex: index });
    res.json({ success: true });
  } catch (error) {
    logger.error('Delete question error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

// End quiz and compile results
app.post('/api/quiz/:code/end', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: "Only teachers" });
  
  try {
    const quiz = await Quiz.findOne({ code: req.params.code, teacherId: req.user.id });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    
    quiz.active = false;
    quiz.currentQuestionIndex = -1;
    await quiz.save();
    
    // Invalidate caches
    await cache.del(`quiz:${req.params.code}`);
    await cache.del('live_quizzes');
    await cache.del(`leaderboard:${req.params.code}`);
    
    // Process results in background
    processBackgroundTask('COMPILE_RESULTS', { quizId: quiz._id }).catch(err => {
      logger.error('Background task error', { error: err.message });
    });
    
    activeQuizzes.dec();
    
    // Broadcast to all connected clients
    io.to(`${req.params.code}:student`).emit('quizEnded');
    io.to(`${req.params.code}:teacher`).emit('quizEnded');
    io.emit('quizStatusChanged', { code: req.params.code, active: false });
    
    logger.info('Quiz ended', { quizCode: req.params.code, teacherId: req.user.id });
    res.json({ success: true });
  } catch (error) {
    logger.error('End quiz error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

// Get quiz leaderboard
app.get('/api/quiz/:code/leaderboard', authenticateToken, async (req, res) => {
  try {
    const cacheKey = `leaderboard:${req.params.code}`;
    const bypassCache = req.query.nocache === '1';

    if (!bypassCache) {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
    }

    const quiz = await Quiz.findOne({ code: req.params.code }).populate('responses.studentId', 'name');
    if (!quiz) return res.json([]);

    const board = quiz.responses
      .map(r => ({ name: r.studentId?.name || "Anonymous", score: r.score }))
      .sort((a, b) => b.score - a.score);

    await cache.set(cacheKey, board, 300); // Cache for 5 minutes
    res.json(board);
  } catch (error) {
    logger.error('Get leaderboard error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== TEACHER ENDPOINTS ====================

app.get('/api/teacher/dashboard', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: "Access denied" });
  
  try {
    const cacheKey = `teacher_dashboard:${req.user.id}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const totalQuizzes = await Quiz.countDocuments({ teacherId: req.user.id });
    const totalResponses = await Quiz.aggregate([
      { $match: { teacherId: req.user.id } },
      { $unwind: "$responses" },
      { $count: "total" }
    ]);
    
    const result = { totalQuizzes, totalResponses: totalResponses[0]?.total || 0 };
    await cache.set(cacheKey, result, 60); // Cache for 1 minute
    res.json(result);
  } catch (error) {
    logger.error('Teacher dashboard error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

app.get('/api/teacher/leaderboard', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: "Access denied" });
  
  try {
    const cached = await cache.get('global_leaderboard');
    if (cached) {
      return res.json(cached);
    }

    const top = await User.find({ role: 'student' }).sort({ points: -1 }).limit(10).select('name points');
    await cache.set('global_leaderboard', top, 300); // Cache for 5 minutes
    res.json(top);
  } catch (error) {
    logger.error('Get leaderboard error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

app.get('/api/teacher/recentQuizzes', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: "Access denied" });
  
  try {
    const quizzes = await Quiz.find({ teacherId: req.user.id })
      .select('title code questions participants active createdAt currentQuestionIndex responses')
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('responses.studentId', 'name');
    
    const formatted = quizzes.map(q => ({
      _id: q._id,
      title: q.title,
      code: q.code,
      questions: q.questions,
      participants: q.participants,
      active: q.active,
      createdAt: q.createdAt,
      currentQuestionIndex: q.currentQuestionIndex,
      leaderboard: buildLeaderboard(q)
    }));

    res.json(formatted);
  } catch (error) {
    logger.error('Get recent quizzes error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

// Get teacher's active quizzes
app.get('/api/teacher/activeQuizzes', authenticateToken, async (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: "Access denied" });
  
  try {
    const quizzes = await Quiz.find({ teacherId: req.user.id, active: true })
      .select('title code participants currentQuestionIndex')
      .populate('participants', 'name')
      .sort({ createdAt: -1 });
    
    const result = quizzes.map(q => ({
      title: q.title,
      code: q.code,
      players: q.participants.length,
      currentQuestionIndex: q.currentQuestionIndex || -1
    }));
    
    res.json(result);
  } catch (error) {
    logger.error('Get active quizzes error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== STUDENT ENDPOINTS ====================

app.get('/api/student/leaderboard', authenticateToken, async (req, res) => {
  try {
    const cached = await cache.get('global_leaderboard');
    if (cached) {
      return res.json(cached);
    }

    const top = await User.find({ role: 'student' }).sort({ points: -1 }).limit(20).select('name points');
    await cache.set('global_leaderboard', top, 300);
    res.json(top);
  } catch (error) {
    logger.error('Get leaderboard error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

app.get('/api/student/recentQuizzes', authenticateToken, async (req, res) => {
  try {
    const quizzes = await Quiz.find({ participants: req.user.id })
      .select('title code questions participants active createdAt responses')
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('responses.studentId', 'name');

    const formatted = quizzes.map(q => {
      const leaderboard = buildLeaderboard(q);
      const myEntry = leaderboard.find(entry => entry.studentId === req.user.id);
      return {
        _id: q._id,
        title: q.title,
        code: q.code,
        questions: q.questions,
        participants: q.participants,
        active: q.active,
        createdAt: q.createdAt,
        leaderboard,
        myScore: myEntry ? myEntry.score : 0
      };
    });

    res.json(formatted);
  } catch (error) {
    logger.error('Get recent quizzes error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

app.get('/api/student/badges', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json(user.badges || []);
  } catch (error) {
    logger.error('Get badges error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

app.get('/api/student/points', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({ points: user.points || 0 });
  } catch (error) {
    logger.error('Get points error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

app.get('/api/student/stats', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    // Rank calculation
    const all = await User.find({ role: 'student' }).sort({ points: -1 });
    const rank = all.findIndex(u => u._id.toString() === req.user.id) + 1;

    // Last quiz
    const lastQuiz = await Quiz.findOne({ participants: req.user.id })
      .sort({ createdAt: -1 });

    let lastData = {
      title: lastQuiz ? lastQuiz.title : "No quiz played yet",
      score: lastQuiz ? lastQuiz.responses.find(r => r.studentId.toString() === req.user.id)?.score || 0 : "–",
      total: lastQuiz ? lastQuiz.questions.length : "–"
    };

    res.json({
      name: user.name,
      points: user.points,
      badges: user.badges,
      rank,
      lastQuiz: lastData
    });
  } catch (error) {
    logger.error('Get stats error', { error: error.message });
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== WEBSOCKET REAL-TIME ====================

// Single broadcastQuestionToRoom function
const broadcastQuestionToRoom = async (code, questionIndex, onlyToSocket = false) => {
  const quiz = await Quiz.findOne({ code });
  if (!quiz) throw new Error('Quiz not found');
  if (questionIndex < 0 || questionIndex >= quiz.questions.length) {
    throw new Error('Invalid question index');
  }

  // Update quiz current question
  quiz.currentQuestionIndex = questionIndex;
  await quiz.save();
  await cache.del(`quiz:${code}`);

  const questionPayload = {
    index: questionIndex,
    text: quiz.questions[questionIndex].text,
    options: quiz.questions[questionIndex].options
  };

  // Send to room or only to one socket
  if (onlyToSocket) {
    return questionPayload;
  } else {
    io.to(code).emit('questionUpdated', questionPayload);
    return questionPayload;
  }
};

// Store socket user mapping
const socketUsers = new Map();

io.on('connection', (socket) => {
  activeConnections.inc();
  logger.info('Socket connected', { socketId: socket.id });

  socket.on('disconnect', async () => {
    activeConnections.dec();
    const userInfo = socketUsers.get(socket.id);
    if (userInfo) {
      socketUsers.delete(socket.id);
      // Update participant count for teacher room
      if (userInfo.role === 'student' && userInfo.code) {
        await updateParticipantCount(userInfo.code);
      }
    }
    logger.info('Socket disconnected', { socketId: socket.id });
  });

  // Helper function to update participant count
  const updateParticipantCount = async (code) => {
    try {
      const studentRoom = io.sockets.adapter.rooms.get(`${code}:student`);
      const participantCount = studentRoom ? studentRoom.size : 0;

      io.to(`${code}:teacher`).emit('participantCountUpdated', { 
        count: participantCount,
        participants: participantCount
      });

      const activeIds = [];
      if (studentRoom) {
        for (const socketId of studentRoom) {
          const info = socketUsers.get(socketId);
          if (info && info.role === 'student' && info.userId) {
            activeIds.push(info.userId);
          }
        }
      }
      const users = activeIds.length > 0 
        ? await User.find({ _id: { $in: activeIds } }).select('name')
        : [];
      const liveList = users.map(u => ({ id: u._id.toString(), name: u.name }));
      io.to(`${code}:teacher`).emit('participantsListUpdated', { participants: liveList });
    } catch (error) {
      logger.error('Error updating participant count', { error: error.message });
    }
  };

  // --- Student or Teacher joins a quiz room ---
  socket.on('joinQuizRoom', async ({ code, token }) => {
    try {
      if (!code) return;
      const user = await getUserFromToken(token);
      if (!user) return socket.emit('roomJoinError', { error: 'Invalid token' });

      const quiz = await Quiz.findOne({ code });
      if (!quiz) return socket.emit('roomJoinError', { error: 'Quiz not found' });

      // Store user info for this socket
      socketUsers.set(socket.id, { userId: user._id, role: user.role, code });

      // Join role-specific room
      if (user.role === 'teacher') {
        // Verify teacher owns this quiz
        if (quiz.teacherId.toString() !== user._id.toString()) {
          return socket.emit('roomJoinError', { error: 'Access denied' });
        }
        socket.join(`${code}:teacher`);
        
        // Send quiz data to teacher
        const questions = quiz.questions.map((q, i) => ({
          index: i,
          text: q.text,
          options: q.options,
          image: q.image || null,
          correct: q.correct
        }));
        
        socket.emit('quizData', { 
          code, 
          title: quiz.title, 
          questions, 
          active: quiz.active,
          currentQuestionIndex: quiz.currentQuestionIndex || -1
        });
        
        // Send initial participant count
        await updateParticipantCount(code);
        
        // Load and send leaderboard
        const leaderboard = buildLeaderboard(await Quiz.findById(quiz._id).populate('responses.studentId', 'name'));
        socket.emit('scoreboardUpdated', { code, leaderboard });
        
      } else if (user.role === 'student') {
        socket.join(`${code}:student`);
        
        // Check if student already submitted
        const response = quiz.responses.find(r => r.studentId.toString() === user._id.toString());
        const hasSubmitted = response && (
          response.submitted === true || (
            Array.isArray(response.answers) &&
            response.answers.length === quiz.questions.length &&
            response.answers.every(a => a !== undefined && a !== null)
          )
        );
        
        if (hasSubmitted) {
          // Student already submitted, send submitted state
          socket.emit('alreadySubmitted', {
            code,
            title: quiz.title,
            score: response.score,
            totalQuestions: quiz.questions.length
          });
        } else if (quiz.active && quiz.currentQuestionIndex >= 0) {
          // Quiz is active, send all questions
          const questions = quiz.questions.map((q, i) => ({
            index: i,
            text: q.text,
            options: q.options,
            image: q.image || null
          }));
          
          socket.emit('quizStarted', {
            code,
            title: quiz.title,
            questions,
            active: true
          });
        } else {
          // Quiz not started yet
          socket.emit('quizData', {
            code,
            title: quiz.title,
            questions: [],
            active: false
          });
        }
        
        // Update participant count
        await updateParticipantCount(code);
      }

      socket.emit('roomJoined', { code, role: user.role });

    } catch (error) {
      logger.error('joinQuizRoom failed', { error: error.message });
      socket.emit('roomJoinError', { error: 'Unable to join room' });
    }
  });

    // --- Student explicitly leaves a quiz room (page unload / navigation) ---
    socket.on('leaveQuizRoom', async ({ code, token } = {}) => {
      try {
        const info = socketUsers.get(socket.id);
        const roomCode = code || (info && info.code);
        if (!roomCode) return;

        // Remove this socket's mapping and ensure it leaves the student room
        socket.leave(`${roomCode}:student`);
        socketUsers.delete(socket.id);

        // Update participant count for teachers
        await updateParticipantCount(roomCode);
        logger.info('Socket left quiz room', { socketId: socket.id, code: roomCode });
      } catch (error) {
        logger.error('leaveQuizRoom failed', { error: error.message });
      }
    });


  // --- Teacher broadcasts question (deprecated - quiz starts with all questions) ---
  socket.on('teacherQuestion', async ({ code, questionIndex = 0, token }) => {
    try {
      const user = await getUserFromToken(token);
      if (!user || user.role !== 'teacher') {
        return socket.emit('actionRejected', { error: 'Unauthorized' });
      }

      const payload = await broadcastQuestionToRoom(code, questionIndex);
      logger.info('Teacher broadcasted question', { code, questionIndex, teacherId: user._id });
      socket.emit('questionBroadcasted', { question: payload });
    } catch (error) {
      logger.error('teacherQuestion failed', { error: error.message });
      socket.emit('actionRejected', { error: 'Unable to broadcast question' });
    }
  });

  // --- Teacher ends quiz ---
  socket.on('endQuiz', async ({ code, token }) => {
    try {
      const user = await getUserFromToken(token);
      if (!user || user.role !== 'teacher') {
        return socket.emit('actionRejected', { error: 'Unauthorized' });
      }

      const quiz = await Quiz.findOne({ code, teacherId: user._id });
      if (!quiz) return socket.emit('actionRejected', { error: 'Quiz not found' });

      if (quiz.active) {
        quiz.active = false;
        quiz.currentQuestionIndex = -1;
        await quiz.save();
        await cache.del(`quiz:${code}`);
        await cache.del('live_quizzes');

        io.to(`${code}:student`).emit('quizEnded');
        io.to(`${code}:teacher`).emit('quizEnded');
        io.emit('quizStatusChanged', { code, active: false });

        logger.info('Quiz ended via socket', { code, teacherId: user._id });
      }
    } catch (error) {
      logger.error('Socket endQuiz failed', { error: error.message });
      socket.emit('actionRejected', { error: 'Unable to end quiz' });
    }
  });

  socket.on('submitAnswer', ({ code, questionIndex, userId }) => {
    logger.info('Answer socket event received', { code, questionIndex, userId });
  });
});


app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`LiveQuiz+ Server Started`, { port: PORT });
  console.log(`LiveQuiz+ → http://localhost:${PORT}`);
});
