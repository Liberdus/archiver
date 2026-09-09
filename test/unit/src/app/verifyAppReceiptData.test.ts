import * as crypto from '../../../../src/Crypto'
import { verifyAppReceiptData } from '../../../../src/app/verifyAppReceiptData'
import { ArchiverReceipt, Receipt } from '../../../../src/dbstore/receipts'

jest.mock('../../../../src/Crypto', () => ({
  hashObj: jest.fn(),
}))

jest.mock('@shardus/lib-types', () => ({
  Utils: {
    safeStringify: jest.fn((obj) => JSON.stringify(obj)),
  },
}))

describe('verifyAppReceiptData', () => {
  const mockHashObj = jest.mocked(crypto.hashObj)

  const createReceipt = (globalModification = false): ArchiverReceipt => {
    return {
      tx: { txId: 'test-tx-id', timestamp: 123456789, originalTxData: {} },
      cycle: 1,
      signedReceipt: {
        proposal: {
          accountIDs: [],
          beforeStateHashes: [],
          afterStateHashes: [],
          appReceiptDataHash: 'calculated-hash',
          applied: false,
          cant_preApply: false,
          txid: 'test-tx-id',
        },
        proposalHash: 'hash',
        signaturePack: [],
        voteOffsets: [],
      },
      appReceiptData: {
        data: { arbitrary: 'application data' },
      },
      globalModification,
    } as ArchiverReceipt
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('accepts a non-global receipt whose application-data hash matches the proposal', async () => {
    mockHashObj.mockReturnValue('calculated-hash')

    const result = await verifyAppReceiptData(createReceipt())

    expect(result).toEqual({ valid: true, needToSave: true })
    expect(mockHashObj).toHaveBeenCalledWith({
      data: { arbitrary: 'application data' },
    })
  })

  it('rejects a non-global receipt whose application-data hash does not match the proposal', async () => {
    mockHashObj.mockReturnValue('different-hash')
    const failedReasons: string[] = []
    const nestedCounterMessages: string[] = []

    const result = await verifyAppReceiptData(createReceipt(), null, failedReasons, nestedCounterMessages)

    expect(result).toEqual({
      valid: false,
      needToSave: false,
    })
    expect(failedReasons[0]).toContain('appReceiptData hash mismatch')
    expect(nestedCounterMessages).toEqual(['appReceiptData hash mismatch'])
  })

  it('does not hash global receipts because they do not include an application-data hash', async () => {
    const result = await verifyAppReceiptData(createReceipt(true))

    expect(result).toEqual({ valid: true, needToSave: true })
    expect(mockHashObj).not.toHaveBeenCalled()
  })

  it('records duplicate-receipt diagnostics without rejecting a matching receipt', async () => {
    mockHashObj.mockReturnValue('calculated-hash')
    const failedReasons: string[] = []
    const nestedCounterMessages: string[] = []
    const existingReceipt = { timestamp: 122 } as Receipt

    const result = await verifyAppReceiptData(createReceipt(), existingReceipt, failedReasons, nestedCounterMessages)

    expect(result).toEqual({
      valid: true,
      needToSave: true,
    })
    expect(failedReasons[0]).toBe('Found Duplicate Receipt')
    expect(nestedCounterMessages).toEqual(['Found Duplicate Receipt'])
  })

  it('returns an invalid result when a non-global receipt has no proposal', async () => {
    mockHashObj.mockReturnValue('calculated-hash')
    const receipt = createReceipt()
    delete (receipt as any).signedReceipt
    const failedReasons: string[] = []
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await verifyAppReceiptData(receipt, null, failedReasons)

    expect(result).toEqual({
      valid: false,
      needToSave: false,
    })
    expect(failedReasons[0]).toContain('Error in verifyAppReceiptData')
    consoleErrorSpy.mockRestore()
  })
})
