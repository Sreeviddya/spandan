import React from 'react'
import { render, screen } from '@testing-library/react'
import AttendanceStreakCard from '../components/AttendanceStreakCard'

const summary = (currentLateStreak, extra = {}) => ({
  currentLateStreak,
  strikeEvery: 3,
  live: false,
  ...extra
})

describe('AttendanceStreakCard', () => {
  it('shows a clear meter at zero', () => {
    render(<AttendanceStreakCard attendance={summary(0)} />)
    expect(screen.getByRole('progressbar', { name: 'Consecutive late arrivals' })).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByText(/No late arrivals in a row/)).toBeInTheDocument()
    expect(screen.getByText(/Three late arrivals in a row trigger a strike/)).toBeInTheDocument()
  })

  it('warns how many more late arrivals trigger the strike', () => {
    render(<AttendanceStreakCard attendance={summary(2)} />)
    expect(screen.getByRole('progressbar', { name: 'Consecutive late arrivals' })).toHaveAttribute('aria-valuenow', '2')
    expect(screen.getByText(/2 of 3 late arrivals in a row/)).toBeInTheDocument()
    expect(screen.getByText(/1 more consecutive late arrival triggers a strike/)).toBeInTheDocument()
  })

  it('shows the strike consequence at three in a row', () => {
    render(<AttendanceStreakCard attendance={summary(3)} />)
    expect(screen.getByRole('progressbar', { name: 'Consecutive late arrivals' })).toHaveAttribute('aria-valuenow', '3')
    expect(screen.getByText(/3 consecutive late arrivals — strike/)).toBeInTheDocument()
    expect(screen.getByText(/average SP and one day of attendance minutes are forfeited/)).toBeInTheDocument()
  })

  it('keeps a longer streak capped at the 0-3 meter', () => {
    render(<AttendanceStreakCard attendance={summary(5)} />)
    expect(screen.getByRole('progressbar', { name: 'Consecutive late arrivals' })).toHaveAttribute('aria-valuenow', '3')
    expect(screen.getByText(/5 consecutive late arrivals — strike/)).toBeInTheDocument()
  })

  it('notes when the count includes a room still in progress', () => {
    render(<AttendanceStreakCard attendance={summary(1, { live: true })} />)
    expect(screen.getByText(/still in progress/)).toBeInTheDocument()
  })

  it('shows the SP balance and attendance minutes out of the 3600 baseline', () => {
    render(<AttendanceStreakCard attendance={summary(0, {
      spBalance: 1250,
      averageSp: 125,
      attendanceMinutes: 1740,
      attendanceTargetMinutes: 3600,
      attendanceDayMinutes: 60
    })} />)
    expect(screen.getByText('1,250 SP')).toBeInTheDocument()
    expect(screen.getByText('1,740 / 3,600')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: /Attendance minutes/ })).toHaveAttribute('aria-valuenow', '1740')
    // The per-tile explainer lines were removed; the tiles stay value-only.
    expect(screen.queryByText(/SP at risk/)).not.toBeInTheDocument()
    expect(screen.queryByText(/A strike removes/)).not.toBeInTheDocument()
  })

  it('lets attendance climb above the 3600 baseline', () => {
    render(<AttendanceStreakCard attendance={summary(0, {
      attendanceMinutes: 4000,
      attendanceTargetMinutes: 3600
    })} />)
    expect(screen.getByText('4,000 / 3,600')).toBeInTheDocument()
    expect(screen.queryByText(/above the 3,600 min mark/)).not.toBeInTheDocument()
  })

  it('shows local SP and attendance balances without a mirror label', () => {
    render(<AttendanceStreakCard attendance={summary(1, {
      spBalance: 640,
      attendanceMinutes: 1500,
      attendanceTargetMinutes: 3600,
      averageSp: 123
    })} />)
    expect(screen.getByText('640 SP')).toBeInTheDocument()
    expect(screen.getByText('1,500 / 3,600')).toBeInTheDocument()
    expect(screen.queryByText(/Spurti/)).not.toBeInTheDocument()
    expect(screen.queryByText('Local data')).not.toBeInTheDocument()
    expect(screen.queryByText(/SP per attended session/)).not.toBeInTheDocument()
  })

  it('always explains the local strike consequence', () => {
    render(<AttendanceStreakCard attendance={summary(3, { attendanceMinutes: 2000 })} />)
    expect(screen.getByText(/average SP and one day of attendance minutes are forfeited/)).toBeInTheDocument()
    expect(screen.queryByText(/Spurti/)).not.toBeInTheDocument()
  })
})
