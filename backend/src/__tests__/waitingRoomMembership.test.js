// Membership-flow tests for the waiting room. These hit the in-memory MongoDB because the bug they
// cover lives in the persistence, not the pure policy:
//
//   1. Every student who joins an enabled room waits - automatic and manual alike - until the
//      teacher (or Admit All) lets them in.
//   2. Leaving must NOT delete the membership row, so a rejoin restores the same admission and
//      timestamp instead of looking like a brand-new arrival.
//   3. An admit must stamp attendance from when the student arrived, not from when the teacher
//      clicked Admit, otherwise a slow teacher marks on-time students late.
//   4. Automatic Admit All admits only on-time arrivals in join order and then turns the room
//      manual; manual Admit All admits exactly the filtered IDs the teacher sent.
//   5. Participant counts/lists must ignore waiting and departed members.
import mongoose from 'mongoose'
import Room from '../models/Room.js'
import RoomMember from '../models/RoomMember.js'
import {
  ensureRoomMember,
  admitRoomMember,
  admitWaitingMembers,
  listWaitingMembers,
  waitingMemberView,
  listParticipantMembers,
  countParticipants,
  countWaiting
} from '../services/waitingRoom.js'

const oid = () => new mongoose.Types.ObjectId()
const BASE = new Date('2026-10-01T09:00:00.000Z')
const min = (m) => new Date(BASE.getTime() + m * 60000)

let scheduledRoom

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URL, { dbName: 'waitingRoomMembershipTest' })
})

afterAll(async () => {
  await mongoose.connection.dropDatabase()
  await mongoose.disconnect()
})

beforeEach(async () => {
  await Promise.all([Room.deleteMany({}), RoomMember.deleteMany({})])
  scheduledRoom = await Room.create({
    name: 'Manual Room',
    code: 'MANUAL',
    teacher: oid(),
    isActive: true,
    settings: {
      waitingRoomEnabled: true,
      waitingRoomPolicy: 'manual',
      scheduledStartAt: BASE,
      graceMinutes: 5,
      latePenaltySp: 10
    }
  })
})

describe('holding every join', () => {
  it('manual policy parks on-time and late students in the lobby', async () => {
    const onTime = await ensureRoomMember({ room: scheduledRoom, studentId: oid(), at: min(0) })
    expect(onTime.member.admissionStatus).toBe('waiting')
    expect(onTime.evaluation.admitted).toBe(false)
    expect(onTime.member.attendanceStatus).toBe('pending')

    const late = await ensureRoomMember({ room: scheduledRoom, studentId: oid(), at: min(30) })
    expect(late.member.admissionStatus).toBe('waiting')
    expect(late.evaluation.admitted).toBe(false)
  })

  it('automatic policy parks every new student too', async () => {
    const room = await Room.create({
      name: 'Auto Room', code: 'AUTO', teacher: oid(),
      settings: { waitingRoomEnabled: true, waitingRoomPolicy: 'automatic', scheduledStartAt: BASE, graceMinutes: 5 }
    })
    const onTime = await ensureRoomMember({ room, studentId: oid(), at: min(0) })
    expect(onTime.member.admissionStatus).toBe('waiting')
    expect(onTime.becameWaiting).toBe(true)
  })
})

describe('teacher chime trigger', () => {
  it('flags only the join that moves a student into the waiting room', async () => {
    const studentId = oid()
    const first = await ensureRoomMember({ room: scheduledRoom, studentId, at: min(0) })
    expect(first.becameWaiting).toBe(true)

    // A reconnect while already waiting is not a new arrival, so it must not chime again.
    const reconnect = await ensureRoomMember({ room: scheduledRoom, studentId, at: min(5) })
    expect(reconnect.becameWaiting).toBe(false)
  })

  it('defaults the per-room chime to on', async () => {
    expect(scheduledRoom.settings.waitingRoomChime).toBe(true)
  })
})

describe('rejoin after leaving', () => {
  it('restores the same admitted state and attendance instead of re-evaluating', async () => {
    const studentId = oid()
    // Admitted on time early in the session, then they navigated away / their tab closed.
    await RoomMember.create({
      roomId: scheduledRoom._id,
      studentId,
      joinedAt: min(0),
      admittedAt: min(0),
      admissionStatus: 'admitted',
      attendanceStatus: 'on_time',
      attendanceMarkedAt: min(0),
      leftAt: min(10)
    })
    // They come back 80 minutes after the start.
    const { member, evaluation } = await ensureRoomMember({
      room: scheduledRoom,
      studentId,
      at: min(80)
    })

    expect(member.leftAt).toBeNull()
    expect(member.admissionStatus).toBe('admitted')
    expect(evaluation.state).toBe('admitted')
    expect(evaluation.admitted).toBe(true)
    expect(evaluation.waitingRoom).toBe(false)
    // Sticky: a reconnect must never turn an on-time arrival into late.
    expect(member.attendanceStatus).toBe('on_time')
    expect(evaluation.attendanceStatus).toBe('on_time')
    // The original arrival is preserved, so late minutes stay based on it.
    expect(member.joinedAt.getTime()).toBe(min(0).getTime())
    expect(member.admittedAt.getTime()).toBe(min(0).getTime())
  })

  it('a waiting student who reconnects stays in the lobby', async () => {
    const studentId = oid()
    await ensureRoomMember({ room: scheduledRoom, studentId, at: min(2) })
    const { member, evaluation } = await ensureRoomMember({ room: scheduledRoom, studentId, at: min(30) })
    expect(member.admissionStatus).toBe('waiting')
    expect(evaluation.state).toBe('waiting')
  })

  it('does not leave a lingering leftAt marker to keep them out of the participant count', async () => {
    const studentId = oid()
    await RoomMember.create({
      roomId: scheduledRoom._id,
      studentId,
      joinedAt: min(0),
      admissionStatus: 'admitted',
      attendanceStatus: 'on_time',
      leftAt: min(5)
    })
    expect(await countParticipants(scheduledRoom._id)).toBe(0)

    await ensureRoomMember({ room: scheduledRoom, studentId, at: min(20) })
    expect(await countParticipants(scheduledRoom._id)).toBe(1)
  })
})

describe('manual admission attendance', () => {
  it('marks an on-time arrival on time even when the teacher admits them much later', async () => {
    const studentId = oid()
    await RoomMember.create({
      roomId: scheduledRoom._id,
      studentId,
      joinedAt: min(2), // inside the 5-minute grace
      waitingRequestedAt: min(2),
      admissionStatus: 'waiting',
      attendanceStatus: 'pending'
    })

    const { member, evaluation } = await admitRoomMember({
      room: scheduledRoom,
      studentId,
      at: min(45) // teacher was busy
    })

    expect(member.admissionStatus).toBe('admitted')
    expect(member.attendanceStatus).toBe('on_time')
    expect(evaluation.attendanceStatus).toBe('on_time')
    // admittedAt records when they actually arrived, not when the teacher clicked.
    expect(member.admittedAt.getTime()).toBe(min(2).getTime())
    expect(evaluation.lateMinutes).toBe(0)
  })

  it('still classifies a genuinely late arrival as late', async () => {
    const studentId = oid()
    await RoomMember.create({
      roomId: scheduledRoom._id,
      studentId,
      joinedAt: min(10), // past grace
      waitingRequestedAt: min(10),
      admissionStatus: 'waiting',
      attendanceStatus: 'pending'
    })

    const { member } = await admitRoomMember({ room: scheduledRoom, studentId, at: min(30) })
    expect(member.attendanceStatus).toBe('late')
  })
})

describe('Admit All', () => {
  it('automatic admits only on-time arrivals in join order, then switches to manual', async () => {
    const room = await Room.create({
      name: 'Auto Room', code: 'AUTO2', teacher: oid(),
      settings: { waitingRoomEnabled: true, waitingRoomPolicy: 'automatic', scheduledStartAt: BASE, graceMinutes: 5 }
    })
    const early = oid()
    const late = oid()
    const slightlyLateButInsideGrace = oid()
    await ensureRoomMember({ room, studentId: early, at: min(1) })
    await ensureRoomMember({ room, studentId: late, at: min(20) })
    await ensureRoomMember({ room, studentId: slightlyLateButInsideGrace, at: min(4) })

    const result = await admitWaitingMembers({ room })
    expect(result.policySwitched).toBe(true)
    expect(result.policy).toBe('manual')
    expect(result.admitted.map((a) => String(a.member.studentId))).toEqual([String(early), String(slightlyLateButInsideGrace)])

    // Late student is still waiting; the on-time pair were admitted.
    const waitingIds = (await listWaitingMembers(room._id)).map((m) => String(m.studentId._id || m.studentId))
    expect(waitingIds).toEqual([String(late)])
    expect(await countParticipants(room._id)).toBe(2)

    // The switch is persisted so later joins keep waiting.
    const stored = await Room.findById(room._id)
    expect(stored.settings.waitingRoomPolicy).toBe('manual')
  })

  it('manual admits exactly the filtered student IDs it is given', async () => {
    const a = oid()
    const b = oid()
    const c = oid()
    await ensureRoomMember({ room: scheduledRoom, studentId: a, at: min(1) })
    await ensureRoomMember({ room: scheduledRoom, studentId: b, at: min(2) })
    await ensureRoomMember({ room: scheduledRoom, studentId: c, at: min(3) })

    const result = await admitWaitingMembers({
      room: scheduledRoom,
      studentIds: [String(a), String(c)]
    })

    expect(result.policySwitched).toBe(false)
    const admittedIds = result.admitted.map((r) => String(r.member.studentId)).sort()
    expect(admittedIds).toEqual([String(a), String(c)].sort())
    expect(await countParticipants(scheduledRoom._id)).toBe(2)
    expect(await countWaiting(scheduledRoom._id)).toBe(1)
  })
})

describe('waiting and participant views', () => {
  it('tags waiting students from their arrival time', async () => {
    const onTime = oid()
    const late = oid()
    await ensureRoomMember({ room: scheduledRoom, studentId: onTime, at: min(2) })
    await ensureRoomMember({ room: scheduledRoom, studentId: late, at: min(10) })

    const waiting = await listWaitingMembers(scheduledRoom._id)
    const views = waiting.map((m) => waitingMemberView(scheduledRoom, m))
    expect(views.map((v) => v.attendanceStatus)).toEqual(['on_time', 'late'])
    expect(views[0].requestedAt).toEqual(min(2))
  })

  it('lists admitted students in join order and excludes waiting students', async () => {
    const room = await Room.create({
      name: 'Mix Room', code: 'MIX', teacher: oid(),
      settings: { waitingRoomEnabled: true, waitingRoomPolicy: 'manual', scheduledStartAt: BASE, graceMinutes: 5 }
    })
    const first = oid()
    const waiting = oid()
    const second = oid()
    await ensureRoomMember({ room, studentId: first, at: min(1) })
    await ensureRoomMember({ room, studentId: waiting, at: min(2) })
    await ensureRoomMember({ room, studentId: second, at: min(3) })
    await admitRoomMember({ room, studentId: first, at: min(10) })
    await admitRoomMember({ room, studentId: second, at: min(11) })

    const participants = await listParticipantMembers(room._id)
    expect(participants.map((m) => String(m.studentId._id || m.studentId))).toEqual([String(first), String(second)])
  })

  it('participant counts exclude members who left but keep legacy rows without leftAt', async () => {
    const roomId = scheduledRoom._id
    await RoomMember.create({
      roomId, studentId: oid(), admissionStatus: 'admitted', joinedAt: min(0), leftAt: min(5)
    })
    await RoomMember.create({
      roomId, studentId: oid(), admissionStatus: 'admitted', joinedAt: min(0), leftAt: null
    })
    // Legacy row: field absent entirely.
    await RoomMember.collection.insertOne({
      roomId, studentId: oid(), joinedAt: min(0), admissionStatus: 'admitted'
    })
    await RoomMember.create({
      roomId, studentId: oid(), admissionStatus: 'waiting', joinedAt: min(0), leftAt: null
    })

    expect(await countParticipants(roomId)).toBe(2) // admitted + legacy
    expect(await countWaiting(roomId)).toBe(1)
  })
})
