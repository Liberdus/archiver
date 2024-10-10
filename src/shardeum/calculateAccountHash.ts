import * as crypto from '../Crypto'
import { ArchiverReceipt, SignedReceipt, Receipt } from '../dbstore/receipts'
import { verifyPayload } from '../types/ajv/Helpers'
import { AJVSchemaEnum } from '../types/enum/AJVSchemaEnum'
import { verifyGlobalTxAccountChange } from './verifyGlobalTxReceipt'

// Reference: https://github.com/Liberdus/server/blob/84f80564c45b06343df9bed4fe66a1628052a4cc/src/index.ts#L349
export const calculateAccountHash = (account: any): string => {
  account.hash = '' // Not sure this is really necessary
  account.hash = crypto.hashObj(account)
  return account.hash
}

/**
 * Verifies the validity of account changes in a non-global transaction by comparing
 * the provided receipt's account state hashes and account data.
 *
 * @param receipt - The receipt object containing transaction details and state information.
 *                  It can be of type `ArchiverReceipt` or `Receipt`.
 * @param failedReasons - An array to collect detailed error messages if the verification fails.
 *                        Defaults to an empty array.
 * @param nestedCounterMessages - An array to collect high-level error messages for nested counters
 *                                if the verification fails. Defaults to an empty array.
 * @returns A boolean indicating whether the account changes in the receipt are valid.
 *
 * ### Validation Steps:
 * 1. Ensures the number of modified accounts matches the number of after-state hashes.
 * 2. Ensures the number of before-state hashes matches the number of after-state hashes.
 * 3. Iterates through each account ID in the receipt:
 *    - Verifies that the account exists in the `afterStates` of the receipt.
 *    - Calculates the account-specific hash and compares it with the expected hash.
 */
export const verifyNonGlobalTxAccountChange = async (
  receipt: ArchiverReceipt | Receipt,
  failedReasons = [],
  nestedCounterMessages = []
): Promise<boolean> => {
  try {
    const signedReceipt = receipt.signedReceipt as SignedReceipt
    const { accountIDs, afterStateHashes, beforeStateHashes } = signedReceipt.proposal
    if (accountIDs.length !== afterStateHashes.length) {
      failedReasons.push(
        `Modified account count specified in the receipt and the actual updated account count does not match! ${receipt.tx.txId} , ${receipt.cycle} , ${receipt.tx.timestamp}`
      )
      nestedCounterMessages.push(
        `Modified account count specified in the receipt and the actual updated account count does not match!`
      )
      return false
    }
    if (beforeStateHashes.length !== afterStateHashes.length) {
      failedReasons.push(
        `Account state hash before and after count does not match! ${receipt.tx.txId} , ${receipt.cycle} , ${receipt.tx.timestamp}`
      )
      nestedCounterMessages.push(`Account state hash before and after count does not match!`)
      return false
    }
    for (const [index, accountId] of accountIDs.entries()) {
      const accountData = receipt.afterStates.find((acc) => acc.accountId === accountId)
      if (accountData === undefined) {
        failedReasons.push(
          `Account not found in the receipt's afterStates | Acc-ID: ${accountId}, txId: ${receipt.tx.txId}, Cycle: ${receipt.cycle}, timestamp: ${receipt.tx.timestamp}`
        )
        nestedCounterMessages.push(`Account not found in the receipt`)
        return false
      }
      const calculatedAccountHash = calculateAccountHash(accountData.data)
      // eslint-disable-next-line security/detect-object-injection
      const expectedAccountHash = afterStateHashes[index]
      if (calculatedAccountHash !== expectedAccountHash) {
        failedReasons.push(
          `Account hash does not match | Acc-ID: ${accountId}, txId: ${receipt.tx.txId}, Cycle: ${receipt.cycle}, timestamp: ${receipt.tx.timestamp}`
        )
        nestedCounterMessages.push(`Account hash does not match`)
        return false
      }
    }
    return true
  } catch (error) {
    console.error(`verifyNonGlobalTxAccountChange error`, error)
    failedReasons.push(
      `Error while verifying non global account change ${receipt.tx.txId} , ${receipt.cycle} , ${receipt.tx.timestamp}, ${error}`
    )
    nestedCounterMessages.push(`Error while verifying non global account change`)
    return false
  }
}

/**
 * Verifies the account hash for a given receipt. This function validates the receipt
 * against a schema and checks the account changes based on whether the receipt is global
 * or non-global. It also collects validation errors and messages for debugging purposes.
 *
 * @param receipt - The receipt object to be verified. It can be of type `ArchiverReceipt` or `Receipt`.
 * @param failedReasons - An optional array to store reasons for validation failure.
 * @param nestedCounterMessages - An optional array to store nested counter messages for debugging.
 * @returns A boolean indicating whether the account hash verification was successful.
 *
 * @throws Will catch and log any unexpected errors during the verification process.
 */
export const verifyAccountHash = async (
  receipt: ArchiverReceipt | Receipt,
  failedReasons = [],
  nestedCounterMessages = []
): Promise<boolean> => {
  try {
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
      return false
    }

    let result: boolean
    if (!globalReceiptValidationErrors) {
      result = await verifyGlobalTxAccountChange(receipt, failedReasons, nestedCounterMessages)
    } else {
      result = await verifyNonGlobalTxAccountChange(receipt, failedReasons, nestedCounterMessages)
    }

    if (!result) return false
    return true
  } catch (e) {
    console.error(`Error in verifyAccountHash`, e)
    failedReasons.push(`Error in verifyAccountHash ${e}`)
    nestedCounterMessages.push('Error in verifyAccountHash')
    return false
  }
}
