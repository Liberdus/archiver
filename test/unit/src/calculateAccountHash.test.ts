import { expect, describe, it, beforeEach, jest } from '@jest/globals'
import * as crypto from '../../../src/Crypto'
import { calculateAccountHash, verifyNonGlobalTxAccountChange } from '../../../src/app/calculateAccountHash'
import { ArchiverReceipt } from '../../../src/dbstore/receipts'

jest.mock('../../../src/Crypto', () => ({
  hashObj: jest.fn(),
}))

describe('calculateAccountHash', () => {
  const mockHashObj = jest.mocked(crypto.hashObj)

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('blanks an existing hash, calculates, and stores the new hash', () => {
    mockHashObj.mockImplementation((account) => {
      expect(account).toEqual({ balance: '100', hash: '' })
      return 'calculated-hash'
    })
    const account = { balance: '100', hash: 'stale-hash' }

    expect(calculateAccountHash(account)).toBe('calculated-hash')
    expect(account.hash).toBe('calculated-hash')
  })

  it('rejects null account data', () => {
    expect(() => calculateAccountHash(null)).toThrow('Account data is null or undefined')
  })

  it('reports a hash-calculation failure', () => {
    mockHashObj.mockImplementation(() => {
      throw new Error('Hash calculation failed')
    })
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() => calculateAccountHash({ balance: '100' })).toThrow('Failed to calculate account hash')
    consoleErrorSpy.mockRestore()
  })
})

describe('verifyNonGlobalTxAccountChange', () => {
  const mockHashObj = jest.mocked(crypto.hashObj)

  const createReceipt = (): ArchiverReceipt => {
    return {
      tx: { txId: 'tx-1', timestamp: 123 },
      cycle: 1,
      signedReceipt: {
        proposal: {
          accountIDs: ['account-1'],
          beforeStateHashes: ['before-hash'],
          afterStateHashes: ['after-hash'],
        },
      },
      afterStates: [{ accountId: 'account-1', data: { balance: '100' } }],
      beforeStates: [],
      globalModification: false,
    } as ArchiverReceipt
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('accepts an after-state hash that matches the proposal', async () => {
    mockHashObj.mockReturnValue('after-hash')
    const failedReasons: string[] = []
    const nestedCounterMessages: string[] = []

    const result = await verifyNonGlobalTxAccountChange(createReceipt(), failedReasons, nestedCounterMessages)

    expect(result).toBe(true)
    expect(failedReasons).toHaveLength(0)
    expect(nestedCounterMessages).toHaveLength(0)
  })

  it('rejects a receipt whose account and after-state hash counts differ', async () => {
    const receipt = createReceipt()
    ;(receipt.signedReceipt as any).proposal.afterStateHashes = []
    const failedReasons: string[] = []

    const result = await verifyNonGlobalTxAccountChange(receipt, failedReasons)

    expect(result).toBe(false)
    expect(failedReasons[0]).toContain('Modified account count')
  })

  it('rejects a receipt whose before- and after-state hash counts differ', async () => {
    const receipt = createReceipt()
    ;(receipt.signedReceipt as any).proposal.beforeStateHashes = []
    const failedReasons: string[] = []

    const result = await verifyNonGlobalTxAccountChange(receipt, failedReasons)

    expect(result).toBe(false)
    expect(failedReasons[0]).toContain('Account state hash before and after count does not match')
  })

  it('rejects a missing after-state account', async () => {
    const receipt = createReceipt()
    receipt.afterStates = []
    const failedReasons: string[] = []

    const result = await verifyNonGlobalTxAccountChange(receipt, failedReasons)

    expect(result).toBe(false)
    expect(failedReasons[0]).toContain("Account not found in the receipt's afterStates")
  })

  it('rejects an after-state hash that does not match the proposal', async () => {
    mockHashObj.mockReturnValue('different-hash')
    const failedReasons: string[] = []

    const result = await verifyNonGlobalTxAccountChange(createReceipt(), failedReasons)

    expect(result).toBe(false)
    expect(failedReasons[0]).toContain('Account hash does not match')
  })
})
