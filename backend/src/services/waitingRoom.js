// Core waiting-room logic.
//
// Two kinds of helpers live here:
//   1. Pure policy functions (no DB) - timing, classification, channel names. These are what the
//      unit tests exercise and what the socket/REST layers share, so a join is evaluated
//      identically over HTTP and Socket.IO.
//   2. Thin RoomMember flows (ensure/admit/reject/list) used by the routes and sockets. Keeping
//      them beside the policy keeps the "which channel/status should this student be in" rule in
//      one place.
//
// Channel model:
//   participants -> room.code            (live polls, leaderboard, participation)
//   viewers      -> viewers:<room.code>  (waiting room and rejected students; read-only)
//
// Admission model:
//   Waiting room OFF -> every join is admitted immediately.
//   Waiting room ON  -> every join waits in the lobby, whatever the policy. Attendance is still
//                       classified from the student's ARRIVAL time (on_time / late) so the teacher
//                       sees the right tag and a slow approval never changes the outcome.
//   automatic policy -> the first Admit All admits only on-time students (in join order) and then
//                       switches the room to manual for the rest of the session.
//   manual policy    -> every student waits for an individual admit/reject or a filtered Admit All.
import Room from '../models/Room.js'
import RoomMember from '../models/RoomMember.js'
import User from '../models/User.js'

export const DEFAULT_GRACE_MINUTES = 5
export const DEFAULT_LATE_PENALTY_SP = 0

// Attendance outcomes that count as a "late strike" for the 3-strike rule.
export const LATE_STATUSES = ['late']

export const participantsChannel = (roomCode) => String(roomCode || '')
export const viewersChannel = (roomCode) => `viewers:${String(roomCode || '')}`

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

// Grace is stored in minutes but may be fractional (seconds mode in the UI sends e.g. 0.5 for
// 30s). Round to microseconds so float division noise never leaks into comparisons.
function clampMinutes(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n * 1e6) / 1e6))
}

function toDate(value) {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function isWaitingRoomEnabled(room) {
  return !!room?.settings?.waitingRoomEnabled
}

export function getWaitingPolicy(room) {
  return room?.settings?.waitingRoomPolicy === 'manual' ? 'manual' : 'automatic'
}

export function getAttendanceSettings(room) {
  const s = room?.settings || {}
  return {
    scheduledStartAt: toDate(s.scheduledStartAt),
    graceMinutes: clampMinutes(s.graceMinutes, 0, 120, DEFAULT_GRACE_MINUTES),
    latePenaltySp: clampInt(s.latePenaltySp, 0, 1000, DEFAULT_LATE_PENALTY_SP)
  }
}

// Minutes from the scheduled start to `at`, counting only time AFTER the grace period.
// 0 for anyone on time (or before the start). Used for the ledger's lateMinutes field.
export function computeLateMinutes({ room, at = new Date() }) {
  const { scheduledStartAt, graceMinutes } = getAttendanceSettings(room)
  const when = toDate(at) || new Date()
  if (!scheduledStartAt) return 0
  const diffMin = (when.getTime() - scheduledStartAt.getTime()) / 60000
  if (diffMin <= graceMinutes) return 0
  return Math.max(0, Math.ceil(diffMin - graceMinutes))
}

// Classification for a join/admission time. No scheduled start = on_time (a room that never set a
// schedule should not invent lateness).
export function computeAttendanceStatus({ room, at = new Date() }) {
  const { scheduledStartAt, graceMinutes } = getAttendanceSettings(room)
  const when = toDate(at) || new Date()
  if (!scheduledStartAt) return 'on_time'
  const diffMin = (when.getTime() - scheduledStartAt.getTime()) / 60000
  return diffMin <= graceMinutes ? 'on_time' : 'late'
}

// The moment a student actually arrived. Attendance is judged on this, never on when the teacher
// got round to admitting them: a waiting room must not mark an on-time student late just because
// the teacher was slow to click Admit. Rejoining keeps joinedAt/admittedAt, so a network
// disconnect cannot shift the classification either.
export function attendanceReferenceTime({ member = null, at = new Date() } = {}) {
  return (
    toDate(member?.admittedAt) ||
    toDate(member?.waitingRequestedAt) ||
    toDate(member?.joinedAt) ||
    toDate(at) ||
    new Date()
  )
}

// Derived attendance for an admitted member. Once an outcome is stamped (not 'pending') it is
// sticky: a reconnect or a late page load must not silently turn an on-time student into late.
export function attendanceForMember({ room, member, at = new Date() }) {
  const stamped = member?.attendanceStatus
  if (stamped && stamped !== 'pending') return stamped
  return computeAttendanceStatus({ room, at: attendanceReferenceTime({ member, at }) })
}

const spText = (n) => `${n} SP`

function joinNotification({ room, state, enabled, attendanceStatus, arrivalStatus }) {
  if (state === 'rejected') return 'Your request to join this room was declined by the teacher.'
  if (state === 'waiting') {
    // Every enabled room parks new students here, automatic or manual. The copy is intentionally
    // the same in both policies: the student is held until the teacher (or Admit All) lets them in.
    return 'We have let the host know you are in the meeting. Keep this tab open and you will join automatically.'
  }
  // Consequences mirror attendanceLedger.penaltyForStatus (late 1x) and its 3-strike rule.
  const { scheduledStartAt, latePenaltySp } = getAttendanceSettings(room)
  if (attendanceStatus === 'late') {
    const cost = latePenaltySp > 0 ? ` and costs ${spText(latePenaltySp)}` : ''
    return `You joined late. This is recorded in your attendance${cost}. Every 3rd late arrival in a row also counts as a strike.`
  }
  if (arrivalStatus === 'late') {
    // Automatic Admit All only admits on-time arrivals, so an admitted late student normally came
    // through an individual manual admit. Keep the notice accurate for that path.
    const cost = latePenaltySp > 0 ? ` and costs ${spText(latePenaltySp)}` : ''
    return `You joined late. This is recorded in your attendance${cost}.`
  }
  if (scheduledStartAt) return 'You joined on time. You can take part in every poll.'
  return enabled ? 'You are in the room.' : ''
}

// Decide what a student's state should be RIGHT NOW.
//
// Returns:
//   { enabled, policy, state, admitted, waitingRoom, arrivalStatus, attendanceStatus, lateMinutes,
//     notification }
//
// `state` is the persisted admission state ('admitted' | 'waiting' | 'rejected'); `waitingRoom` is
// true whenever the waiting room is enabled and the student is not currently a live participant.
//
// Admission policy (only when the waiting room is enabled):
//   automatic -> every join waits; the teacher's first Admit All admits on-time students and turns
//                the policy manual.
//   manual    -> every join waits for an individual decision or a filtered Admit All.
export function evaluateJoin({ room, member = null, at = new Date() }) {
  const enabled = isWaitingRoomEnabled(room)
  const policy = getWaitingPolicy(room)
  const stored = member?.admissionStatus
  // Classification for the moment the student actually arrived. Drives both the admission decision
  // and (via attendanceForMember) the stamped outcome.
  const arrivalStatus = computeAttendanceStatus({ room, at: attendanceReferenceTime({ member, at }) })

  let state
  if (!enabled) {
    state = 'admitted'
  } else if (stored === 'rejected') {
    state = 'rejected'
  } else if (stored === 'admitted') {
    state = 'admitted'
  } else if (stored === 'waiting') {
    // Everyone waits until the teacher acts. A reconnect must not promote a waiting student.
    state = 'waiting'
  } else if (member) {
    // Legacy membership row (field absent) predates the waiting room: treat as admitted.
    state = 'admitted'
  } else {
    state = 'waiting'
  }

  const admitted = state === 'admitted'
  const attendanceStatus = !admitted
    ? (state === 'rejected' ? 'excused' : 'pending')
    : attendanceForMember({ room, member, at })
  const lateMinutes = admitted ? computeLateMinutes({ room, at: attendanceReferenceTime({ member, at }) }) : 0

  return {
    enabled,
    policy,
    state,
    admitted,
    waitingRoom: enabled ? !admitted : false,
    arrivalStatus,
    attendanceStatus,
    lateMinutes,
    notification: joinNotification({ room, state, enabled, attendanceStatus, arrivalStatus })
  }
}

// ---------------------------------------------------------------------------------------------
// RoomMember flows (DB)
// ---------------------------------------------------------------------------------------------

// Create or refresh this student's membership row. Safe to call on every REST join AND socket
// join: it is idempotent and never demotes an already-admitted student.
export async function ensureRoomMember({ room, studentId, at = new Date() }) {
  const roomId = room._id
  let member = await RoomMember.findOne({ roomId, studentId })
  const now = toDate(at) || new Date()

  if (!member) {
    const evaluation = evaluateJoin({ room, member: null, at: now })
    member = await RoomMember.create({
      roomId,
      studentId,
      joinedAt: now,
      waitingRequestedAt: evaluation.state === 'waiting' ? now : null,
      admissionStatus: evaluation.state,
      admittedAt: evaluation.state === 'admitted' ? now : null,
      attendanceStatus: evaluation.attendanceStatus,
      attendanceMarkedAt: evaluation.state === 'admitted' ? now : null
    })
    // Became waiting on this call -> the teacher's lobby chime fires once (not on every rejoin).
    return {
      member,
      evaluation: evaluateJoin({ room, member, at: now }),
      becameWaiting: evaluation.state === 'waiting'
    }
  }

  const evaluation = evaluateJoin({ room, member, at: now })
  // Only a transition INTO waiting counts; a student already waiting who reconnects must not chime.
  const becameWaiting = evaluation.state === 'waiting' && member.admissionStatus !== 'waiting'
  const patch = {}

  // Rejoin after a leave: clear the marker but keep the original joinedAt / admittedAt / stamped
  // attendance, so the student walks straight back into the state they left.
  if (member.leftAt) patch.leftAt = null

  // Auto-promote (the teacher just turned the waiting room off).
  if (evaluation.state === 'admitted' && member.admissionStatus !== 'admitted') {
    patch.admissionStatus = 'admitted'
    // Arrival time, not "right now": a slow manual approval must not turn an on-time student late.
    patch.admittedAt = attendanceReferenceTime({ member, at: now })
    patch.attendanceStatus = attendanceForMember({ room, member, at: now })
    patch.attendanceMarkedAt = now
  } else if (member.admissionStatus === 'admitted' && (!member.attendanceStatus || member.attendanceStatus === 'pending')) {
    // Backfill attendance for members admitted before this feature existed.
    patch.attendanceStatus = evaluation.attendanceStatus
    patch.attendanceMarkedAt = now
  }

  if (Object.keys(patch).length) {
    member = await RoomMember.findByIdAndUpdate(member._id, { $set: patch }, { new: true })
  }
  return { member, evaluation: evaluateJoin({ room, member, at: now }), becameWaiting }
}

// Teacher admits one waiting student. Attendance is stamped at the student's ARRIVAL time (when
// they asked to join), not when the teacher clicked Admit - otherwise a slow approval would mark
// an on-time student late through no fault of their own.
export async function admitRoomMember({ room, studentId, admittedBy = null, at = new Date() }) {
  const now = toDate(at) || new Date()
  const existing = await RoomMember.findOne({ roomId: room._id, studentId })
  if (!existing) return null

  const arrivalAt = attendanceReferenceTime({ member: existing, at: now })
  const attendanceStatus = existing.attendanceStatus && existing.attendanceStatus !== 'pending'
    ? existing.attendanceStatus
    : computeAttendanceStatus({ room, at: arrivalAt })

  const member = await RoomMember.findOneAndUpdate(
    { roomId: room._id, studentId },
    {
      $set: {
        admissionStatus: 'admitted',
        admittedAt: existing.admittedAt || arrivalAt,
        leftAt: null,
        admittedBy,
        attendanceStatus,
        attendanceMarkedAt: now
      }
    },
    { new: true }
  )
  return { member, evaluation: evaluateJoin({ room, member, at: now }) }
}

// Teacher rejects a waiting student. They stay connected in the viewers channel but can never post
// responses; the ledger marks the attempt 'excused' (0 penalty).
export async function rejectRoomMember({ room, studentId, rejectedBy = null, at = new Date() }) {
  const now = toDate(at) || new Date()
  const member = await RoomMember.findOneAndUpdate(
    { roomId: room._id, studentId },
    {
      $set: {
        admissionStatus: 'rejected',
        admittedBy: rejectedBy || null,
        attendanceStatus: 'excused',
        attendanceMarkedAt: now
      }
    },
    { new: true }
  )
  if (!member) return null
  return { member, evaluation: evaluateJoin({ room, member, at: now }) }
}

// Admit every waiting student the teacher asked for.
//
//   automatic -> ignores the supplied IDs: admits only students whose ARRIVAL was on_time, in join
//                order, then persists waitingRoomPolicy: 'manual' so everyone who arrives later
//                keeps waiting for an explicit decision.
//   manual    -> admits exactly the supplied IDs (the currently visible/filtered lobby rows). If no
//                IDs are supplied, admits the whole waiting list.
//
// Returns the admitted members plus the (possibly switched) policy.
export async function admitWaitingMembers({ room, studentIds = null, admittedBy = null, at = new Date() }) {
  const now = toDate(at) || new Date()
  const policy = getWaitingPolicy(room)
  const ids = Array.isArray(studentIds)
    ? studentIds.map((id) => String(id)).filter(Boolean)
    : null

  const query = { roomId: room._id, admissionStatus: 'waiting', leftAt: null }
  if (policy === 'manual' && ids) query.studentId = { $in: ids }

  const waiting = await RoomMember.find(query).sort({ waitingRequestedAt: 1, joinedAt: 1 })
  const eligible = policy === 'automatic'
    ? waiting.filter((member) => computeAttendanceStatus({
      room,
      at: attendanceReferenceTime({ member, at: now })
    }) === 'on_time')
    : waiting

  const admitted = []
  for (const member of eligible) {
    const result = await admitRoomMember({ room, studentId: member.studentId, admittedBy, at: now })
    if (result) admitted.push(result)
  }

  let nextPolicy = policy
  if (policy === 'automatic') {
    // The first Admit All hands control to the teacher for the rest of this session.
    await Room.updateOne(
      { _id: room._id },
      { $set: { 'settings.waitingRoomPolicy': 'manual' } }
    )
    nextPolicy = 'manual'
  }

  return {
    admitted,
    skipped: Math.max(0, waiting.length - admitted.length),
    policy: nextPolicy,
    policySwitched: nextPolicy !== policy
  }
}

// Attach name/email/enrollment to member rows without a populate() that would null out studentId
// when a user document no longer exists. Missing profiles keep the raw ObjectId, and the view
// helpers fall back to 'Student' for the display name.
async function withStudentProfiles(members) {
  if (!members.length) return members
  const ids = [...new Set(members.map((m) => String(m.studentId?._id || m.studentId)).filter(Boolean))]
  const users = await User.find({ _id: { $in: ids } }).select('name email enrollmentNumber').lean()
  const byId = new Map(users.map((u) => [String(u._id), u]))
  return members.map((m) => {
    const key = String(m.studentId?._id || m.studentId)
    const profile = byId.get(key)
    return profile ? { ...m, studentId: profile } : m
  })
}

export async function listWaitingMembers(roomId) {
  const members = await RoomMember.find({ roomId, admissionStatus: 'waiting', leftAt: null })
    .sort({ waitingRequestedAt: 1, joinedAt: 1 })
    .lean()
  return withStudentProfiles(members)
}

// Waiting-list row for the teacher UI. The tag comes from the ARRIVAL time, so it is stable even
// while the student is still waiting (attendanceStatus itself stays 'pending' until admitted).
export function waitingMemberView(room, member, { at = new Date() } = {}) {
  const arrivalAt = attendanceReferenceTime({ member, at })
  const stamped = member?.attendanceStatus
  return {
    studentId: member.studentId?._id || member.studentId,
    name: member.studentId?.name || 'Student',
    email: member.studentId?.email || '',
    enrollmentNumber: member.studentId?.enrollmentNumber || '',
    requestedAt: member.waitingRequestedAt || member.joinedAt || null,
    attendanceStatus: stamped && stamped !== 'pending'
      ? stamped
      : computeAttendanceStatus({ room, at: arrivalAt }),
    lateMinutes: computeLateMinutes({ room, at: arrivalAt })
  }
}

// Admitted students only, in join order, for the clickable participants list. Waiting and rejected
// students are deliberately excluded.
export async function listParticipantMembers(roomId) {
  const members = await RoomMember.find({
    roomId,
    leftAt: null,
    $or: [{ admissionStatus: 'admitted' }, { admissionStatus: { $exists: false } }, { admissionStatus: null }]
  })
    .sort({ joinedAt: 1, admittedAt: 1 })
    .lean()
  return withStudentProfiles(members)
}

export function participantView(room, member, { at = new Date() } = {}) {
  return {
    studentId: member.studentId?._id || member.studentId,
    name: member.studentId?.name || 'Student',
    email: member.studentId?.email || '',
    enrollmentNumber: member.studentId?.enrollmentNumber || '',
    joinedAt: member.joinedAt || null,
    admittedAt: member.admittedAt || member.joinedAt || null,
    attendanceStatus: attendanceForMember({ room, member, at })
  }
}

export async function countParticipants(roomId) {
  // A member with no admissionStatus predates the feature and is a participant. `leftAt: null`
  // matches both an unset marker and legacy docs where the field does not exist, so students who
  // have left stop counting without breaking older rows.
  return RoomMember.countDocuments({
    roomId,
    leftAt: null,
    $or: [{ admissionStatus: 'admitted' }, { admissionStatus: { $exists: false } }, { admissionStatus: null }]
  })
}

export async function countWaiting(roomId) {
  return RoomMember.countDocuments({ roomId, admissionStatus: 'waiting', leftAt: null })
}
