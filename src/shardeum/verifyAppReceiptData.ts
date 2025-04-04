import * as crypto from '../Crypto'
import { ArchiverReceipt, Receipt, SignedReceipt } from '../dbstore/receipts'
import { Utils as StringUtils } from '@shardeum-foundation/lib-types'
import { verifyPayload } from '../types/ajv/Helpers'
import { AJVSchemaEnum } from '../types/enum/AJVSchemaEnum'

export type ShardeumReceipt = object & {
  amountSpent: string
  readableReceipt: { status: number }
}

export const verifyAppReceiptData = async (
  receipt: ArchiverReceipt | Receipt,
  existingReceipt?: Receipt | null,
  failedReasons = [],
  nestedCounterMessages = []
): Promise<{ valid: boolean; needToSave: boolean }> => {
  let result = { valid: false, needToSave: false }
  const { appReceiptData } = receipt
  let globalReceiptValidationErrors // This is used to store the validation errors of the globalTxReceipt
  try {
    globalReceiptValidationErrors = verifyPayload(AJVSchemaEnum.GlobalTxReceipt, receipt?.signedReceipt)
  } catch (error) {
    globalReceiptValidationErrors = true
    failedReasons.push(
      `Invalid Global Tx Receipt error: ${error}. txId ${receipt.tx.txId} , cycle ${receipt.cycle} , timestamp ${receipt.tx.timestamp}`
    )
    nestedCounterMessages.push(
      `Invalid Global Tx Receipt error: ${error}. txId ${receipt.tx.txId} , cycle ${receipt.cycle} , timestamp ${receipt.tx.timestamp}`
    )
    return result
  }
  if (!globalReceiptValidationErrors) {
    return { valid: true, needToSave: true }
  }
  const signedReceipt = receipt.signedReceipt as SignedReceipt
  const newShardeumReceipt = appReceiptData.data as ShardeumReceipt
  if (!newShardeumReceipt.amountSpent || !newShardeumReceipt.readableReceipt) {
    failedReasons.push(`appReceiptData missing amountSpent or readableReceipt`)
    nestedCounterMessages.push(`appReceiptData missing amountSpent or readableReceipt`)
    return result
  }
  const { accountIDs, afterStateHashes, beforeStateHashes } = signedReceipt.proposal
  if (
    newShardeumReceipt.amountSpent === '0x0' &&
    newShardeumReceipt.readableReceipt.status === 0 &&
    afterStateHashes.length > 0
  ) {
    for (let i = 0; i < accountIDs.length; i++) {
      if (
        // eslint-disable-next-line security/detect-object-injection
        !beforeStateHashes[i] ||
        // eslint-disable-next-line security/detect-object-injection
        !afterStateHashes[i]
      ) {
        failedReasons.push(
          `The account state hash before or after is missing in the receipt! ${receipt.tx.txId} , ${receipt.cycle} , ${receipt.tx.timestamp}`
        )
        nestedCounterMessages.push(`The account state hash before or after is missing in the receipt!`)
      }
      if (
        // eslint-disable-next-line security/detect-object-injection
        beforeStateHashes[i] !==
        // eslint-disable-next-line security/detect-object-injection
        afterStateHashes[i]
      ) {
        failedReasons.push(
          `The receipt has 0 amountSpent and status 0 but has state updated accounts! ${receipt.tx.txId} , ${receipt.cycle} , ${receipt.tx.timestamp}`
        )
        nestedCounterMessages.push(
          `The receipt has 0 amountSpent and status 0 but has state updated accounts!`
        )
        break
      }
    }
  }
  result = { valid: true, needToSave: false }
  if (existingReceipt && existingReceipt.timestamp !== receipt.tx.timestamp) {
    const existingShardeumReceipt = existingReceipt.appReceiptData.data as ShardeumReceipt
    /**
     * E: existing receipt, N: new receipt, X: any value
     * E: status = 0, N: status = 1, E: amountSpent = 0, N: amountSpent = X, needToSave = true
     * E: status = 0, N: status = 1, E: amountSpent > 0, N: amountSpent > 0, needToSave = false (success and failed receipts with gas charged)
     * E: status = 0, N: status = 0, E: amountSpent = 0, N: amountSpent = 0, needToSave = false
     * E: status = 0, N: status = 0, E: amountSpent = 0, N: amountSpent > 0, needToSave = true
     * E: status = 0, N: status = 0, E: amountSpent > 0, N: amountSpent = 0, needToSave = false
     * E: status = 0, N: status = 0, E: amountSpent > 0, N: amountSpent > 0, needToSave = false (both failed receipts with gas charged)
     * E: status = 1, N: status = 0, E: amountSpent = X, N: amountSpent = X, needToSave = false
     * E: status = 1, N: status = 1, E: amountSpent = X, N: amountSpent = X, needToSave = false (duplicate success receipt)
     *
     **/
    // Added only logging of unexpected cases and needToSave = true cases ( check `else` condition )
    if (existingShardeumReceipt.readableReceipt.status === 0) {
      if (newShardeumReceipt.readableReceipt.status === 1) {
        if (existingShardeumReceipt.amountSpent !== '0x0') {
          failedReasons.push(
            `Success and failed receipts with gas charged`,
            StringUtils.safeStringify(existingReceipt),
            StringUtils.safeStringify(receipt)
          )
        } else result = { valid: true, needToSave: true } // Success receipt
      } else {
        if (existingShardeumReceipt.amountSpent !== '0x0' && newShardeumReceipt.amountSpent !== '0x0') {
          failedReasons.push(
            `Both failed receipts with gas charged`,
            StringUtils.safeStringify(existingReceipt),
            StringUtils.safeStringify(receipt)
          )
        } else if (newShardeumReceipt.amountSpent !== '0x0') {
          // Failed receipt with gas charged
          result = { valid: true, needToSave: true }
        }
      }
    } else if (newShardeumReceipt.readableReceipt.status === 1) {
      failedReasons.push(
        `Duplicate success receipt`,
        StringUtils.safeStringify(existingReceipt),
        StringUtils.safeStringify(receipt)
      )
    }
    // }
  } else result = { valid: true, needToSave: true }

  if (!validateAppReceiptData(appReceiptData, failedReasons, nestedCounterMessages)) {
    result = { valid: false, needToSave: false }
    return result
  }

  const calculatedAppReceiptDataHash = calculateAppReceiptDataHash(appReceiptData)

  if (calculatedAppReceiptDataHash !== signedReceipt.proposal.appReceiptDataHash) {
    failedReasons.push(
      `appReceiptData hash mismatch: ${calculatedAppReceiptDataHash} != ${signedReceipt.proposal.appReceiptDataHash}`
    )
    nestedCounterMessages.push(`appReceiptData hash mismatch`)
    result = { valid: false, needToSave: false }
  }
  return result
}
const validateAppReceiptData = (appReceiptData: any, failedReasons = [], nestedCounterMessages = []): boolean => {
  try {
    if (appReceiptData.data && appReceiptData.data.receipt) {
      if (appReceiptData.data.receipt.bitvector) {
        appReceiptData.data.receipt.bitvector = Uint8Array.from(
          Object.values(appReceiptData.data.receipt.bitvector)
        )
      }
      if (appReceiptData.data.receipt.logs && appReceiptData.data.receipt.logs.length > 0) {
        appReceiptData.data.receipt.logs = appReceiptData.data.receipt.logs.map((log) => {
          return log.map((log1) => {
            if (Array.isArray(log1)) {
              return log1.map((log2) => {
                log2 = Uint8Array.from(Object.values(log2))
                return log2
              })
            } else {
              log1 = Uint8Array.from(Object.values(log1))
              return log1
            }
          })
        })
      }
    }
    return true
  } catch (err) {
    console.error(`validateAppReceiptData error: ${err}`)
    failedReasons.push(`validateAppReceiptData error: ${err}`)
    nestedCounterMessages.push(`validateAppReceiptData error`)
    return false
  }
}

// Use validateAppReceiptData to ensure appReceiptData is valid before calculating its hash with calculateAppReceiptDataHash
const calculateAppReceiptDataHash = (appReceiptData: any): string => {
  return crypto.hashObj(appReceiptData)
}