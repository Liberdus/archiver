import { join } from 'path'
import { overrideDefaultConfig, config } from '../src/Config'
import * as Crypto from '../src/Crypto'
import * as Utils from '../src/Utils'
import * as Receipt from '../src/dbstore/receipts'
import { verifyAccountHash } from '../src/app/calculateAccountHash'
import { verifyAppReceiptData } from '../src/app/verifyAppReceiptData'
import { initAjvSchemas } from '../src/types/ajv/Helpers'
import { initializeSerialization } from '../src/utils/serialization/SchemaHelpers'

// Add the full receipt data here
const receipt: any = {}

const runProgram = async (): Promise<void> => {
  initAjvSchemas()
  initializeSerialization()
  // Override default config params from config file, env vars, and cli args
  const file = join(process.cwd(), 'archiver-config.json')
  overrideDefaultConfig(file)
  // Set crypto hash keys from config
  const hashKey = config.ARCHIVER_HASH_KEY
  Crypto.setCryptoHashKey(hashKey)

  // validate appReceiptData
  let result = validateReceiptData(receipt)
  if (!result) {
    console.error('Invalid receipt data')
    return
  }

  // verifyAppReceiptData
  const appReceiptDataResult = await verifyAppReceiptData(receipt)
  if (!appReceiptDataResult.valid) {
    console.error('Invalid app receipt data')
    return
  }

  // verifyAccountHash
  result = await verifyAccountHash(receipt)
  if (!result) {
    console.error('Invalid accounts data')
    return
  }
}

// Validate the ArchiverReceipt shape expected by the current Liberdus receipt validators.
const validateReceiptData = (receipt: Receipt.ArchiverReceipt): boolean => {
  let err = Utils.validateTypes(receipt, {
    tx: 'o',
    cycle: 'n',
    beforeStates: 'a?',
    afterStates: 'a?',
    appReceiptData: 'o?',
    signedReceipt: 'o',
    globalModification: 'b',
  })
  if (err) {
    console.error('Invalid receipt data', err)
    return false
  }
  err = Utils.validateTypes(receipt.tx, {
    originalTxData: 'o',
    txId: 's',
    timestamp: 'n',
  })
  if (err) {
    console.error('Invalid receipt tx data', err)
    return false
  }
  for (const account of receipt.beforeStates ?? []) {
    err = Utils.validateTypes(account, {
      accountId: 's',
      data: 'o',
      timestamp: 'n',
      hash: 's',
      isGlobal: 'b',
    })
    if (err) {
      console.error('Invalid receipt beforeStates data', err)
      return false
    }
  }
  for (const account of receipt.afterStates ?? []) {
    err = Utils.validateTypes(account, {
      accountId: 's',
      data: 'o',
      timestamp: 'n',
      hash: 's',
      isGlobal: 'b',
    })
    if (err) {
      console.error('Invalid receipt afterStates data', err)
      return false
    }
  }
  if (receipt.globalModification) {
    const globalTx = (receipt.signedReceipt as any).tx
    err = Utils.validateTypes(globalTx, {
      address: 's',
      addressHash: 's',
      afterStateHash: 's',
    })
    if (err) {
      console.error('Invalid global receipt transaction data', err)
      return false
    }
  } else {
    const signedReceipt = receipt.signedReceipt as Receipt.SignedReceipt
    err = Utils.validateTypes(signedReceipt, {
      proposal: 'o',
      proposalHash: 's',
      signaturePack: 'a',
      voteOffsets: 'a',
    })
    if (err) {
      console.error('Invalid signed receipt data', err)
      return false
    }
    err = Utils.validateTypes(signedReceipt.proposal, {
      applied: 'b',
      cant_preApply: 'b',
      accountIDs: 'a',
      beforeStateHashes: 'a',
      afterStateHashes: 'a',
      appReceiptDataHash: 's',
      txid: 's',
    })
    if (err) {
      console.error('Invalid signed receipt proposal data', err)
      return false
    }
  }

  return true
}

runProgram()
