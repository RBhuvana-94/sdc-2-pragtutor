const mongoose = require('mongoose');

const quizSchema = new mongoose.Schema({
  title: String,
  code: { type: String, unique: true },
  questions: [{
    text: String,
    options: [String],
    correct: Number,
    image: String
  }],
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  active: { type: Boolean, default: true },
  currentQuestionIndex: { type: Number, default: -1 },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  responses: [{
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    answers: [Number],
    score: Number,
    submitted: { type: Boolean, default: false }
  }],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Quiz', quizSchema);