import { describe, expect, it, beforeEach, jest } from '@jest/globals'
import * as crypto from '../../../../src/Crypto'
import { verifyGlobalTxAccountChange } from '../../../../src/app/verifyGlobalTxReceipt'
import { ArchiverReceipt } from '../../../../src/dbstore/receipts'

jest.mock('../../../../src/Crypto', () => ({
  hashObj: jest.fn(),
}))

describe('verifyGlobalTxAccountChange', () => {
  const mockHashObj = jest.mocked(crypto.hashObj)

  const createReceipt = (): ArchiverReceipt => {
    return {
      signedReceipt: {
        tx: {
          address: 'network-account',
          addressHash: 'before-hash',
          afterStateHash: 'after-hash',
        },
      },
      beforeStates: [{ accountId: 'network-account', data: { value: 'before' } }],
      afterStates: [{ accountId: 'network-account', data: { value: 'after' } }],
      tx: { txId: 'tx-1', timestamp: 123 },
      cycle: 1,
      globalModification: true,
    } as ArchiverReceipt
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('accepts matching before- and after-state hashes', async () => {
    mockHashObj.mockReturnValueOnce('before-hash').mockReturnValueOnce('after-hash')
    const failedReasons: string[] = []
    const nestedCounterMessages: string[] = []

    const result = await verifyGlobalTxAccountChange(createReceipt(), failedReasons, nestedCounterMessages)

    expect(result).toBe(true)
    expect(failedReasons).toHaveLength(0)
    expect(nestedCounterMessages).toHaveLength(0)
  })

  it('rejects a missing after-state hash', async () => {
    const receipt = createReceipt()
    ;(receipt.signedReceipt as any).tx.afterStateHash = ''
    const failedReasons: string[] = []

    const result = await verifyGlobalTxAccountChange(receipt, failedReasons)

    expect(result).toBe(false)
    expect(failedReasons[0]).toContain('Missing afterStateHash')
  })

  it('rejects a before-state account for a different address', async () => {
    const receipt = createReceipt()
    receipt.beforeStates[0].accountId = 'another-account'
    const failedReasons: string[] = []

    const result = await verifyGlobalTxAccountChange(receipt, failedReasons)

    expect(result).toBe(false)
    expect(failedReasons[0]).toContain('Unexpected account found in before accounts')
  })

  it('rejects a mismatched before-state hash', async () => {
    mockHashObj.mockReturnValue('different-hash')
    const failedReasons: string[] = []

    const result = await verifyGlobalTxAccountChange(createReceipt(), failedReasons)

    expect(result).toBe(false)
    expect(failedReasons[0]).toContain('Account hash before does not match')
  })

  it('rejects an after-state account for a different address', async () => {
    const receipt = createReceipt()
    receipt.afterStates[0].accountId = 'another-account'
    mockHashObj.mockReturnValue('before-hash')
    const failedReasons: string[] = []

    const result = await verifyGlobalTxAccountChange(receipt, failedReasons)

    expect(result).toBe(false)
    expect(failedReasons[0]).toContain('Unexpected account found in accounts')
  })

  it('rejects a mismatched after-state hash', async () => {
    mockHashObj.mockReturnValueOnce('before-hash').mockReturnValueOnce('different-hash')
    const failedReasons: string[] = []

    const result = await verifyGlobalTxAccountChange(createReceipt(), failedReasons)

    expect(result).toBe(false)
    expect(failedReasons[0]).toContain('Account afterStateHash does not match')
  })

  it('skips before-state hash validation when addressHash is empty', async () => {
    const receipt = createReceipt()
    ;(receipt.signedReceipt as any).tx.addressHash = ''
    receipt.beforeStates[0].accountId = 'another-account'
    mockHashObj.mockReturnValue('after-hash')

    const result = await verifyGlobalTxAccountChange(receipt)

    expect(result).toBe(true)
    expect(mockHashObj).toHaveBeenCalledTimes(1)
  })

  it('returns false when the signed receipt is malformed', async () => {
    const receipt = createReceipt()
    ;(receipt as any).signedReceipt = null
    const failedReasons: string[] = []
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await verifyGlobalTxAccountChange(receipt, failedReasons)

    expect(result).toBe(false)
    expect(failedReasons[0]).toContain('Error while verifying global account change')
    consoleErrorSpy.mockRestore()
  })
})
