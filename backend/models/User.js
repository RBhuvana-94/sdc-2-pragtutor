const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  name: { type: String, default: "User" },
  role: { type: String, enum: ['teacher', 'student'], required: true, lowercase: true },
  points: { type: Number, default: 0 },
  badges: [{ type: String }],
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date }
});

userSchema.pre('save', async function () {
  if (this.isModified('password')) this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.comparePassword = function (pass) {
  return bcrypt.compare(pass, this.password);
};

module.exports = mongoose.model('User', userSchema);