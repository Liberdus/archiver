import { readFileSync, writeFileSync } from 'fs'
import * as path from 'path'
import { join } from 'path'
import { overrideDefaultConfig, config } from '../src/Config'
import * as Crypto from '../src/Crypto'
import * as dbstore from '../src/dbstore'
import * as CycleDB from '../src/dbstore/cycles'
import { startSaving } from '../src/saveConsoleOutput'
import * as Logger from '../src/Logger'
import { P2P } from '@shardeum-foundation/lib-types'
import { addSigListeners } from '../src/State'
import { computeCycleMarker } from '../src/Data/Cycles'
import { Utils as StringUtils, P2P as P2PTypes } from '@shardeum-foundation/lib-types'
import { initAjvSchemas } from '../src/types/ajv/Helpers'
import { initializeSerialization } from '../src/utils/serialization/SchemaHelpers'

const archiversAtShutdown = [
  {
    ip: '127.0.0.1',
    port: 4000,
    publicKey: '758b1c119412298802cd28dbfa394cdfeecc4074492d60844cc192d632d84de3',
  },
  {
    ip: '127.0.0.1',
    port: 4001,
    publicKey: 'e8a5c26b9e2c3c31eb7c7d73eaed9484374c16d983ce95f3ab18a62521964a94',
  },
  {
    ip: '127.0.0.1',
    port: 4002,
    publicKey: '9426b64e675cad739d69526bf7e27f3f304a8a03dca508a9180f01e9269ce447',
  },
]

export interface NodeInitTxData {
  publicKey: string
  nodeId: string
  startTime: number
}

export interface NodeRewardTxData {
  publicKey: string
  nodeId: string
  endTime: number
}

interface Tx {
  cycle: number
  hash: string
  priority: number
  subQueueKey?: string
  txData: NodeInitTxData | NodeRewardTxData
  type: string
}

interface TransactionEntry {
  hash: string
  tx: Tx
}

interface BuildTxListResult {
  txList: TransactionEntry[]
  newTxAdd: Tx[]
}

const runProgram = async (): Promise<void> => {
  initAjvSchemas()
  initializeSerialization()

  // Override default config params from config file, env vars, and cli args
  const file = join(process.cwd(), 'archiver-config.json')
  overrideDefaultConfig(file)

  // Set crypto hash keys from config
  const hashKey = config.ARCHIVER_HASH_KEY
  if (!hashKey) {
    throw new Error('ARCHIVER_HASH_KEY is required')
  }
  Crypto.setCryptoHashKey(hashKey)

  // Initialize logger
  let logsConfig
  try {
    logsConfig = StringUtils.safeJsonParse(readFileSync(path.resolve(__dirname, '../archiver-log.json'), 'utf8'))
  } catch (err) {
    console.log('Failed to parse archiver log file:', err)
  }
  const logDir = `${config.ARCHIVER_LOGS}/${config.ARCHIVER_IP}_${config.ARCHIVER_PORT}`
  const baseDir = '.'
  logsConfig.dir = logDir
  Logger.initLogger(baseDir, logsConfig)
  if (logsConfig.saveConsoleOutput) {
    startSaving(join(baseDir, logsConfig.dir))
  }

  await dbstore.initializeDB(config)
  addSigListeners()

  let latestCycles = await CycleDB.queryLatestCycleRecords(1)
  let latestCycleRecord = latestCycles[0]
  console.log('latestCycleRecord before', latestCycleRecord)

  console.log(`Building txList by replaying cycles backwards from ${latestCycleRecord.counter}...`)

  const { txList, newTxAdd } = await buildTxList(latestCycleRecord)
  const txListHash = Crypto.hashObj(txList)

  // Save the txList
  const txListPath = path.join(__dirname, '..', 'tx-list-restore.json')
  console.log(`Writing ${txList.length} entries to ${txListPath}...`)
  writeFileSync(txListPath, JSON.stringify(txList, null, 2), 'utf8')

  // Create the shutdown cycle record
  const shutdownCycleRecord = {
    ...latestCycleRecord,
    counter: latestCycleRecord.counter + 1,
    start: latestCycleRecord.start + latestCycleRecord.duration,
    mode: 'shutdown' as P2P.ModesTypes.Record['mode'],
    removed: ['all'],
    archiversAtShutdown: archiversAtShutdown.map((archiver) => {
      return { ...archiver, curvePk: Crypto.getOrCreateCurvePk(archiver.publicKey) }
    }),
    previous: latestCycleRecord.marker,
    lostArchivers: [],
    refutedArchivers: [],
    removedArchivers: [],
    standbyAdd: [],
    standbyRemove: [],
    txlisthash: txListHash,
    txadd: newTxAdd,
    txremove: [],
  }

  // Remove the old marker and compute the new one
  delete shutdownCycleRecord.marker
  const marker = computeCycleMarker(shutdownCycleRecord)
  shutdownCycleRecord.marker = marker

  // console.log('shutdownCycleRecord', shutdownCycleRecord)
  await CycleDB.insertCycle({
    counter: shutdownCycleRecord.counter,
    cycleMarker: shutdownCycleRecord.marker,
    cycleRecord: shutdownCycleRecord,
  })

  latestCycles = await CycleDB.queryLatestCycleRecords(1)
  latestCycleRecord = latestCycles[0]
  console.log('latestCycleRecord after', latestCycleRecord)

  await dbstore.closeDatabase()
}

/**
 * Rebuilds the transaction list by replaying cycles backwards and adding shutdown rewards.
 *
 * This function:
 * 1. Replays cycles backwards from the given cycle
 * 2. Reconstructs the txList by applying txadd/txremove operations
 * 3. Verifies the txlisthash at each step
 * 4. Adds nodeReward transactions for all active nodes in the shutdown cycle
 *
 * @param cycle - The cycle to start replaying from
 * @returns Object containing the complete txList and the new txadd entries for shutdown
 */
async function buildTxList(cycle: P2PTypes.CycleCreatorTypes.CycleData): Promise<BuildTxListResult> {
  const txList: TransactionEntry[] = []
  const txRemoveSet = new Set<string>()

  const currentTxListHash = cycle.txlisthash

  // Replay cycles backwards to reconstruct the txList
  let cycleCounter = cycle.counter
  for (; cycleCounter >= 0; cycleCounter--) {
    const cycleData =
      cycleCounter === cycle.counter ? { cycleRecord: cycle } : await CycleDB.queryCycleByCounter(cycleCounter)
    const cycleRecord: P2PTypes.CycleCreatorTypes.CycleData | undefined = cycleData?.cycleRecord

    if (!cycleRecord) {
      console.warn(`No cycle record found for counter ${cycleCounter}, stopping replay.`)
      break
    }

    console.log(
      `Processing cycle ${cycleCounter}: txlisthash=${cycleRecord.txlisthash}, txadd=${cycleRecord.txadd?.length || 0}, txremove=${cycleRecord.txremove?.length || 0}`
    )

    // Apply txadd: add transactions that were added in this cycle
    if (Array.isArray(cycleRecord.txadd)) {
      for (const tx of cycleRecord.txadd) {
        // Skip if this transaction was removed in a later cycle
        if (txRemoveSet.has(tx.hash)) {
          continue
        }

        // Remove signature from txData for consistency
        const txDataWithoutSign: NodeInitTxData | NodeRewardTxData = { ...tx.txData }
        if ('sign' in txDataWithoutSign) {
          delete txDataWithoutSign.sign
        }

        const entry: TransactionEntry = {
          hash: tx.hash,
          tx: {
            cycle: tx.cycle,
            hash: tx.hash,
            priority: tx.priority,
            ...(tx.subQueueKey && { subQueueKey: tx.subQueueKey }),
            txData: txDataWithoutSign,
            type: tx.type,
          },
        }

        sortedInsert(txList, entry)
      }
    }

    // Record txremove hash; so that we don't add its entry in the txList while replaying
    if (Array.isArray(cycleRecord.txremove)) {
      for (const tx of cycleRecord.txremove) {
        txRemoveSet.add(tx.txHash)
      }
    }

    // Verify hash against txlisthash
    const computedHash = Crypto.hashObj(txList)
    if (computedHash !== currentTxListHash) {
      console.warn(
        `txlisthash mismatch at cycle ${cycleCounter}: stored=${cycleRecord.txlisthash}, computed=${computedHash}`
      )
    } else {
      console.info(`Found matching txlisthash at cycle ${cycleCounter}: ${computedHash}`)
      break
    }
  }

  console.info(`Replayed cycles from ${cycle.counter} down to ${cycleCounter}. txList length: ${txList.length}`)
  console.dir(txList, { depth: null })

  // Create nodeReward transactions for all active nodes at shutdown
  const shutdownCycleNumber = cycle.counter + 1
  const shutdownTimestamp = cycle.start + cycle.duration
  const activeNodes = await getActiveNodesAtCycle(cycle)

  const newTxAddEntries: TransactionEntry[] = []
  for (const [nodeId, publicKey] of activeNodes) {
    const rewardTxData: NodeRewardTxData = {
      publicKey,
      nodeId,
      endTime: shutdownTimestamp,
    }
    const txHash = Crypto.hashObj(rewardTxData)

    const entry: TransactionEntry = {
      hash: nodeId,
      tx: {
        cycle: shutdownCycleNumber,
        hash: txHash,
        priority: 0,
        subQueueKey: publicKey,
        txData: rewardTxData,
        type: 'nodeReward',
      },
    }

    sortedInsert(txList, entry)
    sortedInsert(newTxAddEntries, entry)
  }

  // Extract just the Tx objects for the cycle record
  const newTxAdd: Tx[] = newTxAddEntries.map((entry) => entry.tx)

  console.info(
    `Added ${newTxAdd.length} nodeReward transactions for shutdown cycle. Final txList length: ${txList.length}`
  )
  console.dir(txList, { depth: null })

  return { txList, newTxAdd }
}

/**
 * Insert into txList using exactly the same ordering as ServiceQueue.sortedInsert:
 * - sort by cycle ASC
 * - for same cycle: priority DESC
 * - for same cycle & priority: hash ASC
 */
function sortedInsert(list: TransactionEntry[], entry: TransactionEntry): void {
  const index = list.findIndex(
    (item) =>
      item.tx.cycle > entry.tx.cycle ||
      (item.tx.cycle === entry.tx.cycle && item.tx.priority < entry.tx.priority) ||
      (item.tx.cycle === entry.tx.cycle && item.tx.priority === entry.tx.priority && item.hash > entry.hash)
  )
  if (index === -1) {
    list.push(entry)
  } else {
    list.splice(index, 0, entry)
  }
}

/**
 * Returns all active nodes at the given cycle
 * @param cycle - The cycle to compute active nodes for
 * @returns Map of public keys to node IDs for all active nodes
 */
async function getActiveNodesAtCycle(
  cycle: P2PTypes.CycleCreatorTypes.CycleData
): Promise<Map<P2PTypes.NodeListTypes.Node['id'], P2PTypes.NodeListTypes.Node['publicKey']>> {
  const activeNodesCount = cycle.active
  console.log(`Total active nodes at cycle ${cycle.counter}: ${activeNodesCount}`)

  const activeNodesMap = new Map<P2PTypes.NodeListTypes.Node['id'], P2PTypes.NodeListTypes.Node['publicKey']>()
  const removedNodeIds = new Set<P2PTypes.NodeListTypes.Node['id']>()

  // For about 5 cycles after current cycle, track the unrewarded nodes for removed nodes
  const numUnrewardedCycles = 5
  const rewardedNodeIds = new Set<P2PTypes.NodeListTypes.Node['id']>()
  const unRewardedNodeIds = new Set<P2PTypes.NodeListTypes.Node['id']>()
  const unRewardedNodesMap = new Map<P2PTypes.NodeListTypes.Node['id'], P2PTypes.NodeListTypes.Node['publicKey']>()

  for (const tx of cycle.txadd) {
    if (tx.type === 'nodeReward') {
      rewardedNodeIds.add(tx.txData.nodeId)
    }
  }

  // Replay backwards to find all active nodes
  let cycleCounter = cycle.counter - 1
  for (; cycleCounter >= 0; cycleCounter--) {
    const cycleData = await CycleDB.queryCycleByCounter(cycleCounter)
    const cycleRecord: P2PTypes.CycleCreatorTypes.CycleData | undefined = cycleData?.cycleRecord

    if (!cycleRecord) {
      console.warn(`No cycle record found for counter ${cycleCounter}, stopping active node search.`)
      break
    }

    // Add activated nodes from this cycle to the active set
    for (let i = 0; i < cycleRecord.activated.length; i++) {
      const nodeId = cycleRecord.activated[i]
      const nodePubKey = cycleRecord.activatedPublicKeys[i]
      if (rewardedNodeIds.has(nodeId)) {
        continue
      }
      if (unRewardedNodeIds.has(nodeId)) {
        unRewardedNodesMap.set(nodeId, nodePubKey)
        unRewardedNodeIds.delete(nodeId)
      }
      if (removedNodeIds.has(nodeId)) {
        continue
      }
      if (activeNodesMap.size !== activeNodesCount) {
        activeNodesMap.set(nodeId, nodePubKey)
      }
    }

    // Stop if we've found all expected active nodes
    if (activeNodesMap.size === activeNodesCount && unRewardedNodeIds.size === 0) {
      break
    }

    // Add removed nodes from this cycle to the exclusion set
    for (const nodeId of cycleRecord.removed) {
      removedNodeIds.add(nodeId)
      // If the removed node was unrewarded, add it to the unrewarded set
      if (!rewardedNodeIds.add(nodeId) && cycle.counter - cycleCounter <= numUnrewardedCycles) {
        unRewardedNodeIds.add(nodeId)
      }
    }
    for (const nodeId of cycleRecord.apoptosized) {
      removedNodeIds.add(nodeId)
    }
    for (const nodeId of cycleRecord.appRemoved) {
      removedNodeIds.add(nodeId)
    }

    for (const tx of cycleRecord.txadd) {
      if (tx.type === 'nodeReward') {
        rewardedNodeIds.add(tx.txData.nodeId)
      }
    }
  }

  // Add unrewarded nodes to the active set
  for (const [nodeId, publicKey] of unRewardedNodesMap) {
    activeNodesMap.set(nodeId, publicKey)
  }

  console.log(`Found ${activeNodesMap.size} active nodes at cycle ${cycle.counter}:`)
  for (const [nodeId, publicKey] of activeNodesMap) {
    console.log(`  Node ID: ${nodeId}, Public Key: ${publicKey}`)
  }

  return activeNodesMap
}

runProgram()
