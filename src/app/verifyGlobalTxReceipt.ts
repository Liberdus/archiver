import type { P2P } from '@shardus/lib-types'
import { ArchiverReceipt, Receipt } from '../dbstore/receipts'
import { calculateAccountHash } from './calculateAccountHash'

/**
 * Verifies the account hash in a global transaction receipt
 *
 * This function validates that the account hashes in a receipt match the calculated
 * hashes of the account data. It verifies that the receipt has the required state
 * copies, that each state copy belongs to the global account, and that its calculated
 * hash matches the corresponding hash in the global transaction.
 *
 * @param receipt - The transaction receipt to verify
 * @param failedReasons - Array to collect failure reasons if verification fails
 * @param nestedCounterMessages - Array to collect counter messages for metrics
 * @returns boolean - True if verification passes, false otherwise
 */
export const verifyGlobalTxAccountChange = async (
  receipt: ArchiverReceipt | Receipt,
  failedReasons = [],
  nestedCounterMessages = []
): Promise<boolean> => {
  try {
    const signedReceipt = receipt.signedReceipt as P2P.GlobalAccountsTypes.GlobalTxReceipt
    const { address, addressHash, afterStateHash } = signedReceipt.tx
    // Maybe we can move this to verifyGlobalTx
    if (afterStateHash === '') {
      failedReasons.push(
        `Missing afterStateHash in globalModification tx - ${address} , ${receipt.tx.txId} , ${receipt.cycle} , ${receipt.tx.timestamp}`
      )
      nestedCounterMessages.push(`Missing afterStateHash in globalModification tx`)
      return false
    }
    if (!receipt.afterStates || receipt.afterStates.length === 0) {
      failedReasons.push(
        `Network account after state not found ${receipt.tx.txId} , ${receipt.cycle} , ${receipt.tx.timestamp}`
      )
      nestedCounterMessages.push(`Network account after state not found`)
      return false
    }
    if (addressHash !== '') {
      if (!receipt.beforeStates || receipt.beforeStates.length === 0) {
        failedReasons.push(
          `Network account before state not found ${receipt.tx.txId} , ${receipt.cycle} , ${receipt.tx.timestamp}`
        )
        nestedCounterMessages.push(`Network account before state not found`)
        return false
      }
      for (const account of receipt.beforeStates) {
        if (account.accountId !== address) {
          failedReasons.push(
            `Unexpected account found in before accounts ${receipt.tx.txId} , ${receipt.cycle} , ${receipt.tx.timestamp}`
          )
          nestedCounterMessages.push(`Unexpected account found in before accounts`)
          return false
        }
        const expectedAccountHash = addressHash
        const calculatedAccountHash = calculateAccountHash(account.data)
        if (expectedAccountHash !== calculatedAccountHash) {
          failedReasons.push(
            `Account hash before does not match in globalModification tx - ${account.accountId} , ${receipt.tx.txId} , ${receipt.cycle} , ${receipt.tx.timestamp}`
          )
          nestedCounterMessages.push(`Account hash before does not match in globalModification tx`)
          return false
        }
      }
    }
    for (const account of receipt.afterStates) {
      if (account.accountId !== address) {
        failedReasons.push(
          `Unexpected account found in accounts ${receipt.tx.txId} , ${receipt.cycle} , ${receipt.tx.timestamp}`
        )
        nestedCounterMessages.push(`Unexpected account found in accounts`)
        return false
      }

      const calculatedAfterStateHash = calculateAccountHash(account.data)

      if (calculatedAfterStateHash !== afterStateHash) {
        failedReasons.push(
          `Account afterStateHash does not match in globalModification tx - ${account.accountId} , ${receipt.tx.txId} , ${receipt.cycle} , ${receipt.tx.timestamp}`
        )
        nestedCounterMessages.push(`Account afterStateHash does not match in globalModification tx`)
        return false
      }
    }
    return true
  } catch (error) {
    console.error(`verifyGlobalTxAccountChange error`, error)
    failedReasons.push(
      `Error while verifying global account change ${receipt.tx.txId} , ${receipt.cycle} , ${receipt.tx.timestamp}, ${error}`
    )
    nestedCounterMessages.push(`Error while verifying global account change`)
    return false
  }
}
