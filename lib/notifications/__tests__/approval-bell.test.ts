import { describe, expect, it } from 'vitest'
import { shouldRingForApprovals } from '../approval-bell'

describe('shouldRingForApprovals', () => {
  it('rings when a higher approval id appears', () => {
    expect(
      shouldRingForApprovals({ latestApprovalId: 10, approvalsWaiting: 1 }, { latestApprovalId: 11, approvalsWaiting: 1 }),
    ).toBe(true)
  })

  it('stays quiet when nothing new arrived, even if the count moved', () => {
    expect(
      shouldRingForApprovals({ latestApprovalId: 11, approvalsWaiting: 2 }, { latestApprovalId: 11, approvalsWaiting: 1 }),
    ).toBe(false)
    expect(
      shouldRingForApprovals({ latestApprovalId: 11, approvalsWaiting: 1 }, { latestApprovalId: 11, approvalsWaiting: 1 }),
    ).toBe(false)
  })

  it('rings for the first approval after a period with none', () => {
    expect(
      shouldRingForApprovals({ latestApprovalId: null, approvalsWaiting: 0 }, { latestApprovalId: 5, approvalsWaiting: 1 }),
    ).toBe(true)
  })

  it('falls back to the count when no id is carried', () => {
    expect(
      shouldRingForApprovals({ latestApprovalId: null, approvalsWaiting: 0 }, { latestApprovalId: null, approvalsWaiting: 1 }),
    ).toBe(true)
    expect(
      shouldRingForApprovals({ latestApprovalId: null, approvalsWaiting: 1 }, { latestApprovalId: null, approvalsWaiting: 1 }),
    ).toBe(false)
  })

  it('does not ring when the last approval was settled and none replaced it', () => {
    expect(
      shouldRingForApprovals({ latestApprovalId: 11, approvalsWaiting: 1 }, { latestApprovalId: null, approvalsWaiting: 0 }),
    ).toBe(false)
  })
})
