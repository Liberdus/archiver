import * as crypto from '../Crypto'
import { ArchiverReceipt, Receipt, SignedReceipt } from '../dbstore/receipts'
import { Utils as StringUtils } from '@shardeum-foundation/lib-types'

export const verifyAppReceiptData = async (
  receipt: ArchiverReceipt | Receipt,
  existingReceipt?: Receipt | null,
  failedReasons = [],
  nestedCounterMessages = []
): Promise<{ valid: boolean; needToSave: boolean }> => {
  try {
    let result = { valid: true, needToSave: true }
    if (existingReceipt && existingReceipt.timestamp !== receipt.tx.timestamp) {
      failedReasons.push(
        'Found Duplicate Receipt',
        StringUtils.safeStringify(receipt),
        StringUtils.safeStringify(existingReceipt)
      )
      nestedCounterMessages.push('Found Duplicate Receipt')
    }
    if (receipt.globalModification) {
      // [TODO] Need appReceiptDataHash to be included in the global receipt, once included, verify the appReceiptData by comparing the hash of it
    } else {
      const signedReceipt = receipt.signedReceipt as SignedReceipt

      // Reference: https://github.com/Liberdus/server/blob/64f921ff10d5b1640a026cce9c2af92f67a82432/src/transactions/transfer.ts#L237
      const calculatedAppReceiptDataHash = crypto.hashObj(receipt.appReceiptData)
      if (calculatedAppReceiptDataHash !== signedReceipt.proposal.appReceiptDataHash) {
        failedReasons.push(
          `appReceiptData hash mismatch: ${calculatedAppReceiptDataHash} != ${signedReceipt.proposal.appReceiptDataHash}`
        )
        nestedCounterMessages.push(`appReceiptData hash mismatch`)
        result = { valid: false, needToSave: false }
      }
    }
    return result
  } catch (e) {
    console.error(`Error in verifyAppReceiptData`, e)
    failedReasons.push(`Error in verifyAppReceiptData ${e}`)
    nestedCounterMessages.push('Error in verifyAppReceiptData')
    return { valid: false, needToSave: false }
  }
}
