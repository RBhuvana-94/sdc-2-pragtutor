#!/usr/bin/env node
// Usage: node create_test_quiz.js <teacherId>
// Creates a simple active quiz for testing and prints the quiz code.

const mongoose = require('mongoose');
const Quiz = require('../models/Quiz');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/livequiz';

async function main() {
  const teacherId = process.argv[2];
  if (!teacherId) {
    console.error('Usage: node create_test_quiz.js <teacherId>');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const quiz = new Quiz({
    title: 'E2E Test Quiz ' + Date.now(),
    questions: [
      { text: '2 + 2 = ?', options: ['1','2','3','4'], correct: 3 },
      { text: 'Capital of Spain?', options: ['Paris','Madrid','Berlin','Rome'], correct: 1 }
    ],
    code,
    teacherId,
    active: true,
    currentQuestionIndex: 0
  });

  await quiz.save();
  console.log('Created quiz code:', code);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
