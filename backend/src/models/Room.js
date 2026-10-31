import mongoose from 'mongoose'

const roomSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Room name is required'],
    trim: true,
    maxlength: [200, 'Room name cannot exceed 200 characters']
  },
  teacher: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  code: {
    type: String,
    unique: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  endedAt: {
    type: Date,
    default: null
  },
  currentQuestion: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Question'
  },
  settings: {
    showResultsImmediately: { type: Boolean, default: true },
    requireCorrectAnswer: { type: Boolean, default: false },
    // Video mode: 'normal' = live mic + transcript (default); 'video' = YouTube link, tab-audio transcript
    mode: { type: String, enum: ['normal', 'video'], default: 'normal' },
    videoUrl: { type: String, default: '' },
    // Quiz settings
    timeToAnswer: { type: Number, default: 30 },
    points: { type: Number, default: 100 },
    segmentTime: { type: Number, default: 2 },
    questionsPerSegment: { type: Number, default: 2 },
    difficulty: { type: String, default: 'medium' },
    questionProvider: { type: String, default: 'minimax' },
    questionTypeMix: {
      MCQ: { type: Number, default: 50 },
      TF: { type: Number, default: 30 },
      MSQ: { type: Number, default: 20 }
    },
    // Anonymous leaderboard. When ON, students see only an anonymised top-N board (every row
    // 'Anonymous #<rank>', no self-highlight); the teacher sees real names for the BOTTOM
    // anonymityPercent% of the class (the lowest scorers) and 'Anonymous #<rank>' for everyone else.
    // OFF = names shown as normal (default).
    anonymousLeaderboard: { type: Boolean, default: false },
    anonymityPercent: { type: Number, default: 20, min: 0, max: 100 },
    // Only meaningful while anonymousLeaderboard is ON. When the teacher turns this ON, students ALSO
    // see the real names of the bottom anonymityPercent% (the same lowest-scorer slice the teacher
    // sees) appended to their masked top-N board. OFF (default) = students see only the masked top-N.
    revealBottomToStudents: { type: Boolean, default: false },
    // --- Waiting room & attendance ---------------------------------------------------------
    // When OFF (default) every student who has the code joins the live session directly, exactly
    // as before. When ON, every join waits in the lobby until the teacher (or Admit All) admits it.
    waitingRoomEnabled: { type: Boolean, default: false },
    // 'automatic' = the first Admit All admits only on-time arrivals, then switches to manual;
    // 'manual'    = every student waits for an individual decision or a filtered Admit All.
    waitingRoomPolicy: { type: String, enum: ['automatic', 'manual'], default: 'automatic' },
    // Play a subtle chime on the teacher's device when a student enters the waiting room.
    waitingRoomChime: { type: Boolean, default: true },
    // Planned class start. Drives on_time / late classification at arrival time.
    scheduledStartAt: { type: Date, default: null },
    // Minutes after scheduledStartAt that still count as on time. May be fractional: the settings
    // dialog's seconds mode stores e.g. 0.5 for 30s.
    graceMinutes: { type: Number, default: 5, min: 0, max: 120 },
    // SP penalty applied by the attendance ledger for a late arrival (absent = 3x).
    latePenaltySp: { type: Number, default: 0, min: 0, max: 1000 }
  },
  // Set once when the room ends and the attendance ledger has been processed. Makes end-of-room
  // processing idempotent (a second end/recovery run is a no-op).
  attendanceProcessedAt: { type: Date, default: null }
}, {
  timestamps: true
})

// Generate unique room code before saving
roomSchema.pre('save', function(next) {
  if (!this.code) {
    this.code = generateRoomCode()
  }
  next()
})

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

// Static method to find by code
roomSchema.statics.findByCode = function(code) {
  return this.findOne({ code: code.toUpperCase() })
}

// Teacher dashboards and access checks query rooms by teacher; index avoids a COLLSCAN.
roomSchema.index({ teacher: 1, createdAt: -1 })

const Room = mongoose.model('Room', roomSchema)

export default Room