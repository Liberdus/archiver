import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import * as core from '@shardus/lib-crypto-utils'
import { Utils as StringUtils } from '@shardus/lib-types'
import * as crypto from '../../../../src/Crypto'
import { calculateAccountHash, verifyNonGlobalTxAccountChange } from '../../../../src/app/calculateAccountHash'
import { ArchiverReceipt } from '../../../../src/dbstore/receipts'

describe('calculateAccountHash', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('blanks an existing hash, calculates, and stores the new hash', () => {
    const hashObjSpy = jest.spyOn(crypto, 'hashObj').mockImplementation((account) => {
      expect(account).toEqual({ balance: '100', hash: '' })
      return 'calculated-hash'
    })
    const account = { balance: '100', hash: 'stale-hash' }

    expect(calculateAccountHash(account)).toBe('calculated-hash')
    expect(account.hash).toBe('calculated-hash')
    expect(hashObjSpy).toHaveBeenCalledTimes(1)
  })

  it('matches the Liberdus server algorithm on a realistic account', () => {
    core.init('69fa4195670576c0160d660c3be36556ff8d504725be8a59b5a96509e0c994bc')
    core.setCustomStringifier(StringUtils.safeStringify, 'shardus_safeStringify')

    const account: any = {
      id: 'a1b2c3',
      type: 'UserAccount',
      data: { balance: '1000', toll: null },
      timestamp: 1757404800000,
      hash: 'stale-hash-from-the-wire',
    }

    // Keep this in sync with Liberdus/server @84f8056 src/index.ts:349.
    const serverSide: any = { ...account }
    serverSide.hash = ''
    serverSide.hash = core.hashObj(serverSide)

    expect(calculateAccountHash({ ...account })).toBe(serverSide.hash)
  })

  it('rejects null account data', () => {
    expect(() => calculateAccountHash(null)).toThrow('Account data is null or undefined')
  })

  it('reports a hash-calculation failure', () => {
    jest.spyOn(crypto, 'hashObj').mockImplementation(() => {
      throw new Error('Hash calculation failed')
    })
    jest.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() => calculateAccountHash({ balance: '100' })).toThrow('Failed to calculate account hash')
  })
})

describe('verifyNonGlobalTxAccountChange', () => {
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

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('accepts an after-state hash that matches the proposal', async () => {
    jest.spyOn(crypto, 'hashObj').mockReturnValue('after-hash')
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
    jest.spyOn(crypto, 'hashObj').mockReturnValue('different-hash')
    const failedReasons: string[] = []

    const result = await verifyNonGlobalTxAccountChange(createReceipt(), failedReasons)

    expect(result).toBe(false)
    expect(failedReasons[0]).toContain('Account hash does not match')
  })
})
