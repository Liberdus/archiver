import * as NodeList from '../NodeList'
import * as Crypto from '../Crypto'
import * as State from '../State'
import * as Logger from '../Logger'
import { P2P as P2PTypes, StateManager } from '@shardeum-foundation/lib-types'
import { getJson, postJson } from '../P2P'
import { profilerInstance } from '../profiler/profiler'
import { nestedCountersInstance } from '../profiler/nestedCounters'
import * as cycleDataCache from '../cache/cycleRecordsCache'
import * as ServiceQueue from '../ServiceQueue'

import {
  clearDataSenders,
  dataSenders,
  nodesPerConsensusGroup,
  nodesPerEdge,
  subscribeConsensorsByConsensusRadius,
  unsubscribeDataSender,
} from './Data'
import * as Utils from '../Utils'
import { config } from '../Config'
import fetch from 'node-fetch'
import { getAdjacentLeftAndRightArchivers, sendDataToAdjacentArchivers, DataType } from './GossipData'
import { cleanOldOriginalTxsMap, cleanOldReceiptsMap, storeCycleData } from './Collector'
import { clearServingValidatorsInterval, initServingValidatorsInterval } from './AccountDataProvider'
import { Signature, hexstring } from '@shardeum-foundation/lib-crypto-utils'
import { handleLostArchivers } from '../LostArchivers'
import ShardFunctions from '../ShardFunctions'
import { RequestDataType, queryFromArchivers } from '../API'
import { stringifyReduce } from '../profiler/StringifyReduce'
import { addCyclesToCache } from '../cache/cycleRecordsCache'
import { queryLatestCycleRecords } from '../dbstore/cycles'
import { updateGlobalNetworkAccount } from '../GlobalAccount'
import { syncTxList } from '../sync-v2'

export interface ArchiverCycleResponse {
  cycleInfo: P2PTypes.CycleCreatorTypes.CycleData[]
  sign: Signature
}

interface ConsensorCycleResponse {
  newestCycle: P2PTypes.CycleCreatorTypes.CycleData
}

export let currentCycleDuration = 0
let currentCycleCounter = -1
let currentCycleMarker = '0'.repeat(32)
export let lastProcessedMetaData = -1
export const CycleChain: Map<
  P2PTypes.CycleCreatorTypes.CycleData['counter'],
  P2PTypes.CycleCreatorTypes.CycleData
> = new Map()
export const removedAndApopedNodes = []
export let cycleRecordWithShutDownMode = null as P2PTypes.CycleCreatorTypes.CycleRecord | null
export let currentNetworkMode: P2PTypes.ModesTypes.Record['mode'] = 'forming'
export const shardValuesByCycle = new Map<number, StateManager.shardFunctionTypes.CycleShardData>()

export async function processCycles(cycles: P2PTypes.CycleCreatorTypes.CycleData[]): Promise<void> {
  if (profilerInstance) profilerInstance.profileSectionStart('process_cycle', false)
  try {
    if (nestedCountersInstance) nestedCountersInstance.countEvent('cycle', 'process', 1)
    for (const cycle of cycles) {
      // Logger.mainLogger.debug('Current cycle counter', currentCycleCounter)
      // Skip if already processed [TODO] make this check more secure
      if (cycle.counter <= currentCycleCounter) continue
      Logger.mainLogger.debug(new Date(), 'New Cycle received', cycle.counter)

      // Update currentCycle state
      currentCycleDuration = cycle.duration * 1000
      currentCycleCounter = cycle.counter

      // Update NodeList from cycle info
      updateNodeList(cycle)
      updateNetworkTxsList(cycle)
      updateShardValues(cycle)
      changeNetworkMode(cycle.mode)
      getAdjacentLeftAndRightArchivers()
      handleLostArchivers(cycle)

      await addCyclesToCache(cycles)
      await storeCycleData([cycle])

      Logger.mainLogger.debug(`Processed cycle ${cycle.counter}`)

      if (State.isActive) {
        sendDataToAdjacentArchivers(DataType.CYCLE, [cycle])
        // Check the archivers reputaion in every new cycle & record the status
        recordArchiversReputation()
      }
      await updateGlobalNetworkAccount(cycle.counter)

      if (currentNetworkMode === 'shutdown') {
        Logger.mainLogger.debug(Date.now(), `❌ Shutdown Cycle Record received at Cycle #: ${cycle.counter}`)
        await Utils.sleep(currentCycleDuration)
        NodeList.clearNodeLists()
        await clearDataSenders()
        setShutdownCycleRecord(cycle)
        NodeList.toggleFirstNode()
      }
      // Clean receipts/originalTxs cache that are older than <maxCyclesShardDataToKeep> minutes
      const cleanupTimestamp = (cycle.start - config.maxCyclesShardDataToKeep * 60) * 1000
      cleanOldOriginalTxsMap(cleanupTimestamp)
      cleanOldReceiptsMap(cleanupTimestamp)
      cleanShardCycleData(cycle.counter - config.maxCyclesShardDataToKeep)
    }
  } finally {
    if (profilerInstance) profilerInstance.profileSectionEnd('process_cycle', false)
  }
}

export function getCurrentCycleCounter(): number {
  return currentCycleCounter
}

export function getCurrentCycleMarker(): hexstring {
  return currentCycleMarker
}

export function setCurrentCycleDuration(duration: number): void {
  currentCycleDuration = duration * 1000
}

export function setCurrentCycleCounter(value: number): void {
  currentCycleCounter = value
}

export function setCurrentCycleMarker(value: hexstring): void {
  currentCycleMarker = value
}

export function setLastProcessedMetaDataCounter(value: number): void {
  lastProcessedMetaData = value
}

export function changeNetworkMode(newMode: P2PTypes.ModesTypes.Record['mode']): void {
  if (newMode === currentNetworkMode) return
  // If the network mode is changed from restore to processing, clear the serving validators interval
  if (currentNetworkMode === 'restore' && newMode === 'processing') clearServingValidatorsInterval()
  if ((currentNetworkMode === 'restart' || currentNetworkMode === 'recovery') && newMode === 'restore') {
    NodeList.changeNodeListInRestore()
    initServingValidatorsInterval()
  }
  if (cycleRecordWithShutDownMode && newMode !== 'shutdown') {
    cycleRecordWithShutDownMode = null
  }
  currentNetworkMode = newMode
}

export function computeCycleMarker(fields: P2PTypes.CycleCreatorTypes.CycleRecord): string {
  const cycleMarker = Crypto.hashObj(fields)
  return cycleMarker
}

// validation of cycle record against previous marker
export function validateCycle(
  prev: P2PTypes.CycleCreatorTypes.CycleData,
  next: P2PTypes.CycleCreatorTypes.CycleData
): boolean {
  const previousRecordWithoutMarker: P2PTypes.CycleCreatorTypes.CycleData = { ...prev }
  delete previousRecordWithoutMarker.marker
  const prevMarker = computeCycleMarker(previousRecordWithoutMarker)
  return next.previous === prevMarker
}

export const validateCycleData = (cycleRecord: P2PTypes.CycleCreatorTypes.CycleData): boolean => {
  const err = Utils.validateTypes(cycleRecord, {
    activated: 'a',
    activatedPublicKeys: 'a',
    active: 'n',
    apoptosized: 'a',
    archiverListHash: 's',
    counter: 'n',
    desired: 'n',
    duration: 'n',
    expired: 'n',
    joined: 'a',
    joinedArchivers: 'a',
    joinedConsensors: 'a',
    leavingArchivers: 'a',
    lost: 'a',
    lostSyncing: 'a',
    marker: 's',
    maxSyncTime: 'n',
    mode: 's',
    networkConfigHash: 's',
    networkId: 's',
    nodeListHash: 's',
    previous: 's',
    refreshedArchivers: 'a',
    refreshedConsensors: 'a',
    refuted: 'a',
    removed: 'a',
    returned: 'a',
    standbyAdd: 'a',
    standbyNodeListHash: 's',
    standbyRemove: 'a',
    start: 'n',
    syncing: 'n',
    target: 'n',
    archiversAtShutdown: 'a?',
    lostArchivers: 'a',
    refutedArchivers: 'a',
    removedArchivers: 'a',
  })
  if (err) {
    Logger.mainLogger.error('Invalid Cycle Record', err)
    return false
  }
  const cycleRecordWithoutMarker = { ...cycleRecord }
  delete cycleRecordWithoutMarker.marker
  if (computeCycleMarker(cycleRecordWithoutMarker) !== cycleRecord.marker) {
    Logger.mainLogger.error('Invalid Cycle Record: cycle marker does not match with the computed marker')
    return false
  }
  return true
}

export function setShutdownCycleRecord(cycleRecord: P2PTypes.CycleCreatorTypes.CycleData): void {
  cycleRecordWithShutDownMode = cycleRecord
}

interface P2PNode {
  publicKey: string
  externalIp: string
  externalPort: number
  internalIp: string
  internalPort: number
  address: string
  joinRequestTimestamp: number
  activeTimestamp: number
}

export interface JoinedConsensor extends P2PNode {
  id: string
  cycleJoined: string
}

function updateNodeList(cycle: P2PTypes.CycleCreatorTypes.CycleData): void {
  const {
    joinedConsensors,
    activatedPublicKeys,
    removed,
    appRemoved,
    apoptosized,
    joinedArchivers,
    leavingArchivers,
    refreshedConsensors,
    refreshedArchivers,
    standbyAdd,
    standbyRemove,
    lostAfterSelection,
  } = cycle

  const consensorInfos = joinedConsensors.map((jc) => ({
    ip: jc.externalIp,
    port: jc.externalPort,
    publicKey: jc.publicKey,
    id: jc.id,
  }))

  const refreshedConsensorInfos = refreshedConsensors.map((jc) => ({
    ip: jc.externalIp,
    port: jc.externalPort,
    publicKey: jc.publicKey,
    id: jc.id,
  }))

  NodeList.addNodes(NodeList.NodeStatus.SYNCING, consensorInfos)

  NodeList.setStatus(NodeList.NodeStatus.ACTIVE, activatedPublicKeys)

  NodeList.refreshNodes(NodeList.NodeStatus.ACTIVE, refreshedConsensorInfos)

  if (standbyAdd.length > 0) {
    const standbyNodeList: NodeList.ConsensusNodeInfo[] = standbyAdd.map((joinRequest) => ({
      publicKey: joinRequest.nodeInfo.publicKey,
      ip: joinRequest.nodeInfo.externalIp,
      port: joinRequest.nodeInfo.externalPort,
    }))
    NodeList.addStandbyNodes(standbyNodeList)
  }

  if (standbyRemove.length > 0) {
    NodeList.removeStandbyNodes(standbyRemove)
  }

  const removedConsensusNodes: NodeList.ConsensusNodeInfo[] = []

  const removedPks = [...removed, ...appRemoved].reduce((keys: string[], id) => {
    const nodeInfo = NodeList.getNodeInfoById(id)
    if (nodeInfo) {
      removedConsensusNodes.push(nodeInfo)
      keys.push(nodeInfo.publicKey)
    }
    return keys
  }, [])
  NodeList.removeNodes(removedPks)

  const apoptosizedConsensusNodes: NodeList.ConsensusNodeInfo[] = []

  const apoptosizedPks = apoptosized.reduce((keys: string[], id) => {
    const nodeInfo = NodeList.getNodeInfoById(id)
    if (nodeInfo) {
      apoptosizedConsensusNodes.push(nodeInfo)
      keys.push(nodeInfo.publicKey)
    }
    return keys
  }, [])
  NodeList.removeNodes(apoptosizedPks)

  const lostAfterSelectionConsensusNodes: NodeList.ConsensusNodeInfo[] = []
  const lostAfterSelectionPks = lostAfterSelection.reduce((keys: string[], id) => {
    const nodeInfo = NodeList.getNodeInfoById(id)
    if (nodeInfo) {
      lostAfterSelectionConsensusNodes.push(nodeInfo)
      keys.push(nodeInfo.publicKey)
    }
    return keys
  }, [])
  NodeList.removeNodes(lostAfterSelectionPks)

  for (const joinedArchiver of joinedArchivers) {
    State.addArchiver(joinedArchiver)
  }

  for (const refreshedArchiver of refreshedArchivers) {
    State.addArchiver(refreshedArchiver)
  }

  for (const leavingArchiver of leavingArchivers) {
    State.removeActiveArchiver(leavingArchiver.publicKey)
  }

  const nodesToUnsubscribed = [...apoptosizedPks, ...removedPks]
  if (nodesToUnsubscribed.length > 0) {
    for (const key of nodesToUnsubscribed) {
      if (dataSenders.has(key)) unsubscribeDataSender(key)
    }
  }
  if (removedConsensusNodes.length > 0 || apoptosizedConsensusNodes.length > 0) {
    removedAndApopedNodes.push({
      cycle: cycle.counter,
      removed: removedConsensusNodes,
      apoptosized: apoptosizedConsensusNodes,
      lostAfterSelection: lostAfterSelectionConsensusNodes,
    })
    while (removedAndApopedNodes.length > 10) {
      removedAndApopedNodes.shift()
    }
  }
  NodeList.realUpdatedTimes.set('/nodelist', Date.now())
  NodeList.realUpdatedTimes.set('/full-nodelist', Date.now())
  // To pick nodes only when the archiver is active
  if (State.isActive) {
    subscribeConsensorsByConsensusRadius()
  }
}

async function updateNetworkTxsList(cycle: P2PTypes.CycleCreatorTypes.CycleData): Promise<void> {
  const {
    txadd,
    txremove
  } = cycle

  ServiceQueue.addTxs(txadd)
  ServiceQueue.removeTxs(txremove)

  const calculatedTxListHash = ServiceQueue.getNetworkTxsListHash()

  if (calculatedTxListHash !== cycle.txlisthash) {
    console.error('txList hash from cycle record does not match the calculated txList hash')
    const syncTxListResult = await syncTxList(NodeList.getActiveList())

    syncTxListResult.match(
      (txList) => {
        Logger.mainLogger.debug("Successfully synced txList from validators"), 
        ServiceQueue.setTxList(txList)
      },
      (error) => {
        Logger.mainLogger.error("Failed to synchronize transaction list:", error.message);
      }
    );
  }
}

export async function fetchCycleRecords(
  start: number,
  end: number
): Promise<P2PTypes.CycleCreatorTypes.CycleData[]> {
  const response = (await queryFromArchivers(RequestDataType.CYCLE, { start, end })) as ArchiverCycleResponse
  if (response) return response.cycleInfo
  return []
}

export async function getNewestCycleFromConsensors(
  activeNodes: NodeList.ConsensusNodeInfo[]
): Promise<P2PTypes.CycleCreatorTypes.CycleData> {
  const queryFn = async (node: NodeList.ConsensusNodeInfo): Promise<P2PTypes.CycleCreatorTypes.CycleData> => {
    const response = (await getJson(
      `http://${node.ip}:${node.port}/sync-newest-cycle`
    )) as ConsensorCycleResponse

    if (response.newestCycle) {
      return response.newestCycle as P2PTypes.CycleCreatorTypes.CycleData
    }

    return null
  }
  const newestCycle = await Utils.robustQuery(activeNodes, queryFn)
  return newestCycle.value
}

export async function getNewestCycleFromArchivers(): Promise<P2PTypes.CycleCreatorTypes.CycleData> {
  const activeArchivers = Utils.getRandomItemFromArr(State.activeArchivers, 0, 5)

  const data = {
    count: 1,
    sender: config.ARCHIVER_PUBLIC_KEY,
  }
  Crypto.sign(data)

  const queryFn = async (
    node: NodeList.ConsensusNodeInfo
  ): Promise<P2PTypes.CycleCreatorTypes.CycleData[]> => {
    const response = (await postJson(
      `http://${node.ip}:${node.port}/cycleinfo`,
      data
    )) as ArchiverCycleResponse
    return response.cycleInfo
  }
  const cycleInfo = await Utils.robustQuery(activeArchivers, queryFn)
  return cycleInfo.value[0]
}

export async function recordArchiversReputation(): Promise<void> {
  const activeArchivers = [...State.activeArchivers]

  const promises = activeArchivers.map((archiver) =>
    fetch(`http://${archiver.ip}:${archiver.port}/cycleinfo/1`, {
      method: 'get',
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    }).then((res) => res.json())
  )

  Promise.allSettled(promises)
    .then((responses) => {
      let i = 0
      for (const response of responses) {
        // eslint-disable-next-line security/detect-object-injection
        const archiver = activeArchivers[i]
        if (response.status === 'fulfilled') {
          const res = response.value
          if (res && res.cycleInfo && res.cycleInfo.length > 0) {
            const cycleRecord = res.cycleInfo[0]
            // Set the archiver's reputation to 'up' if it is still 10 cycles behind or has higher than our current cycle
            if (cycleRecord.counter - currentCycleCounter >= -10) {
              State.archiversReputation.set(archiver.publicKey, 'up')
            } else {
              Logger.mainLogger.debug(
                `Archiver  ${archiver.ip}:${archiver.port} has fallen behind the latest cycle`
              )
              State.archiversReputation.set(archiver.publicKey, 'down')
            }
          } else {
            Logger.mainLogger.debug(`Archiver is not responding correctly ${archiver.ip}:${archiver.port}`)
            State.archiversReputation.set(archiver.publicKey, 'down')
          }
        } else {
          Logger.mainLogger.debug(`Archiver is not responding ${archiver.ip}:${archiver.port}`)
          State.archiversReputation.set(archiver.publicKey, 'down')
        }
        i++
      }
    })
    .catch((error) => {
      // Handle any errors that occurred
      console.error(error)
    })
  if (config.VERBOSE) Logger.mainLogger.debug('Active archivers status', State.archiversReputation)
}

// This is called once per cycle to update to calculate the necessary shard values.
function updateShardValues(cycle: P2PTypes.CycleCreatorTypes.CycleData): void {
  const cycleShardData = {} as StateManager.shardFunctionTypes.CycleShardData

  // todo get current cycle..  store this by cycle?
  cycleShardData.nodeShardDataMap = new Map()
  cycleShardData.parititionShardDataMap = new Map()
  cycleShardData.nodes = NodeList.activeListByIdSorted as unknown as P2PTypes.NodeListTypes.Node[]
  cycleShardData.cycleNumber = cycle.counter
  cycleShardData.partitionsToSkip = new Map()
  cycleShardData.hasCompleteData = false

  if (cycleShardData.nodes.length === 0) {
    return // no active nodes so stop calculating values
  }
  cycleShardData.timestamp = cycle.start * 1000
  cycleShardData.timestampEndCycle = (cycle.start + cycle.duration) * 1000

  // save this per cycle?
  cycleShardData.shardGlobals = ShardFunctions.calculateShardGlobals(
    cycleShardData.nodes.length,
    nodesPerConsensusGroup,
    nodesPerEdge
  )

  if (profilerInstance)
    profilerInstance.profileSectionStart('updateShardValues_computePartitionShardDataMap1') //13ms, #:60
  // partition shard data
  ShardFunctions.computePartitionShardDataMap(
    cycleShardData.shardGlobals,
    cycleShardData.parititionShardDataMap,
    0,
    cycleShardData.shardGlobals.numPartitions
  )
  if (profilerInstance) profilerInstance.profileSectionEnd('updateShardValues_computePartitionShardDataMap1')

  if (profilerInstance)
    profilerInstance.profileSectionStart('updateShardValues_computePartitionShardDataMap2') //37ms, #:60
  // generate limited data for all nodes data for all nodes.
  ShardFunctions.computeNodePartitionDataMap(
    cycleShardData.shardGlobals,
    cycleShardData.nodeShardDataMap,
    cycleShardData.nodes,
    cycleShardData.parititionShardDataMap,
    cycleShardData.nodes,
    false
  )
  if (profilerInstance) profilerInstance.profileSectionEnd('updateShardValues_computePartitionShardDataMap2')

  if (profilerInstance) profilerInstance.profileSectionStart('updateShardValues_computeNodePartitionData') //22ms, #:60
  if (profilerInstance) profilerInstance.profileSectionEnd('updateShardValues_computeNodePartitionData')

  if (profilerInstance) profilerInstance.profileSectionStart('updateShardValues_computeNodePartitionDataMap2') //232ms, #:60
  // generate lightweight data for all active nodes  (note that last parameter is false to specify the lightweight data)
  const fullDataForDebug = true // Set this to false for performance reasons!!! setting it to true saves us from having to recalculate stuff when we dump logs.
  ShardFunctions.computeNodePartitionDataMap(
    cycleShardData.shardGlobals,
    cycleShardData.nodeShardDataMap,
    cycleShardData.nodes,
    cycleShardData.parititionShardDataMap,
    cycleShardData.nodes,
    fullDataForDebug
  )
  if (profilerInstance) profilerInstance.profileSectionEnd('updateShardValues_computeNodePartitionDataMap2')

  // console.log('cycleShardData', cycleShardData.cycleNumber)
  // console.dir(cycleShardData, { depth: null })
  const list = cycleShardData.nodes.map((n) => n['ip'] + ':' + n['port'])
  Logger.mainLogger.debug('cycleShardData', cycleShardData.cycleNumber, list.length, stringifyReduce(list))
  shardValuesByCycle.set(cycleShardData.cycleNumber, cycleShardData)
}

export const cleanShardCycleData = (cycleNumber: number): void => {
  for (const [key] of shardValuesByCycle) {
    if (key < cycleNumber) {
      shardValuesByCycle.delete(key)
    }
  }
}

export async function getLatestCycleRecords(count: number): Promise<ArchiverCycleResponse> {
  if (config.cycleRecordsCache.enabled) {
    return await cycleDataCache.getLatestCycleRecordsFromCache(count)
  }
  const cycleInfo = await queryLatestCycleRecords(count)
  return Crypto.sign({ cycleInfo })
}
