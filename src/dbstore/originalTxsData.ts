// import { Signature } from 'shardus-crypto-types'
import * as db from './sqlite3storage'
import { originalTxDataDatabase } from '.'
import * as Logger from '../Logger'
import { config } from '../Config'
import { DeSerializeFromJsonString, SerializeToJsonString } from '../utils/serialization'

export interface OriginalTxData {
  txId: string
  timestamp: number
  cycle: number
  originalTxData: object // eslint-disable-line @typescript-eslint/no-explicit-any
  // sign: Signature
}

type DbOriginalTxData = OriginalTxData & {
  originalTxData: string
  // sign: string
}

export interface OriginalTxDataCount {
  cycle: number
  originalTxDataCount: number
}

type DbOriginalTxDataCount = OriginalTxDataCount & {
  'COUNT(*)': number
}

export async function insertOriginalTxData(originalTxData: OriginalTxData): Promise<void> {

  try {

    // Define the table columns based on schema
    const columns = ['txId', 'timestamp', 'cycle', 'originalTxData'];

    // Construct the SQL query with placeholders
    const placeholders = `(${columns.map(() => '?').join(', ')})`;
    const sql = `INSERT OR REPLACE INTO originalTxsData (${columns.join(', ')}) VALUES ${placeholders}`;

    // Map the `originalTxData` object to match the columns
    const values = columns.map((column) =>
      typeof originalTxData[column] === 'object'
        ? SerializeToJsonString(originalTxData[column]) // Serialize objects to JSON
        : originalTxData[column]
    );

    // Execute the query directly (single-row insert)
    await db.run(originalTxDataDatabase, sql, values);

    if (config.VERBOSE) {
      Logger.mainLogger.debug('Successfully inserted OriginalTxData', originalTxData.txId);
    }
  } catch (err) {
    Logger.mainLogger.error(err);
    Logger.mainLogger.error(
      'Unable to insert OriginalTxData or it is already stored in the database',
      originalTxData.txId
    );
  }
}


export async function bulkInsertOriginalTxsData(originalTxsData: OriginalTxData[]): Promise<void> {

  try {
    
    // Define the table columns
    const columns = ['txId', 'timestamp', 'cycle', 'originalTxData'];

    // Construct the SQL query for bulk insertion with all placeholders
    const placeholders = originalTxsData.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
    const sql = `INSERT OR REPLACE INTO originalTxsData (${columns.join(', ')}) VALUES ${placeholders}`;

    // Flatten the `originalTxsData` array into a single list of values
    const values = originalTxsData.flatMap((txData) =>
      columns.map((column) =>
        typeof txData[column] === 'object'
          ? SerializeToJsonString(txData[column]) // Serialize objects to JSON
          : txData[column]
      )
    );

    // Execute the single query for all originalTxsData
    await db.run(originalTxDataDatabase, sql, values);

    if (config.VERBOSE) {
      Logger.mainLogger.debug('Successfully inserted OriginalTxsData', originalTxsData.length);
    }
  } catch (err) {
    Logger.mainLogger.error(err);
    Logger.mainLogger.error('Unable to bulk insert OriginalTxsData', originalTxsData.length);
  }
}



export async function queryOriginalTxDataCount(startCycle?: number, endCycle?: number): Promise<number> {
  let originalTxsData
  try {
    let sql = `SELECT COUNT(*) FROM originalTxsData`
    const values: number[] = []
    if (startCycle && endCycle) {
      sql += ` WHERE cycle BETWEEN ? AND ?`
      values.push(startCycle, endCycle)
    }
    originalTxsData = await db.get(originalTxDataDatabase, sql, values)
  } catch (e) {
    console.log(e)
  }
  if (config.VERBOSE) {
    Logger.mainLogger.debug('OriginalTxData count', originalTxsData)
  }
  return originalTxsData['COUNT(*)'] || 0
}

export async function queryOriginalTxsData(
  skip = 0,
  limit = 10,
  startCycle?: number,
  endCycle?: number
): Promise<OriginalTxData[]> {
  let originalTxsData: DbOriginalTxData[] = []
  if (!Number.isInteger(skip) || !Number.isInteger(limit)) {
    Logger.mainLogger.error('queryOriginalTxsData - Invalid skip or limit')
    return originalTxsData
  }
  try {
    let sql = `SELECT * FROM originalTxsData`
    const sqlSuffix = ` ORDER BY cycle ASC, timestamp ASC LIMIT ${limit} OFFSET ${skip}`
    const values: number[] = []
    if (startCycle && endCycle) {
      sql += ` WHERE cycle BETWEEN ? AND ?`
      values.push(startCycle, endCycle)
    }
    sql += sqlSuffix
    originalTxsData = (await db.all(originalTxDataDatabase, sql, values)) as DbOriginalTxData[]
    originalTxsData.forEach((originalTxData: DbOriginalTxData) => {
      if (originalTxData.originalTxData)
        originalTxData.originalTxData = DeSerializeFromJsonString(originalTxData.originalTxData)
      // if (originalTxData.sign) originalTxData.sign = DeSerializeFromJsonString(originalTxData.sign)
    })
  } catch (e) {
    console.log(e)
  }
  if (config.VERBOSE) {
    Logger.mainLogger.debug('OriginalTxData originalTxsData', originalTxsData)
  }
  return originalTxsData
}

export async function queryOriginalTxDataByTxId(txId: string, timestamp = 0): Promise<OriginalTxData> {
  try {
    const sql = `SELECT * FROM originalTxsData WHERE txId=?` + (timestamp ? ` AND timestamp=?` : '')
    const value = timestamp ? [txId, timestamp] : [txId]
    const originalTxData = (await db.get(originalTxDataDatabase, sql, value)) as DbOriginalTxData
    if (originalTxData) {
      if (originalTxData.originalTxData)
        originalTxData.originalTxData = DeSerializeFromJsonString(originalTxData.originalTxData)
      // if (originalTxData.sign) originalTxData.sign = DeSerializeFromJsonString(originalTxData.sign)
    }
    if (config.VERBOSE) {
      Logger.mainLogger.debug('OriginalTxData txId', originalTxData)
    }
    return originalTxData as OriginalTxData
  } catch (e) {
    console.log(e)
  }
  return null
}

export async function queryOriginalTxDataCountByCycles(
  start: number,
  end: number
): Promise<OriginalTxDataCount[]> {
  const originalTxsDataCount: OriginalTxDataCount[] = []
  let dbOriginalTxsDataCount: DbOriginalTxDataCount[] = []
  try {
    const sql = `SELECT cycle, COUNT(*) FROM originalTxsData GROUP BY cycle HAVING cycle BETWEEN ? AND ? ORDER BY cycle ASC`
    dbOriginalTxsDataCount = (await db.all(originalTxDataDatabase, sql, [
      start,
      end,
    ])) as DbOriginalTxDataCount[]
  } catch (e) {
    Logger.mainLogger.error(e)
  }
  if (config.VERBOSE) {
    Logger.mainLogger.debug('OriginalTxData count by cycle', dbOriginalTxsDataCount)
  }
  if (dbOriginalTxsDataCount.length > 0) {
    for (let i = 0; i < dbOriginalTxsDataCount.length; i++) {
      /* eslint-disable security/detect-object-injection */
      originalTxsDataCount.push({
        cycle: dbOriginalTxsDataCount[i].cycle,
        originalTxDataCount: dbOriginalTxsDataCount[i]['COUNT(*)'],
      })
      /* eslint-enable security/detect-object-injection */
    }
  }
  return originalTxsDataCount
}

export async function queryLatestOriginalTxs(count: number): Promise<OriginalTxData[]> {
  if (!Number.isInteger(count)) {
    Logger.mainLogger.error('queryLatestOriginalTxs - Invalid count value')
    return null
  }
  try {
    const sql = `SELECT * FROM originalTxsData ORDER BY cycle DESC, timestamp DESC LIMIT ${
      count ? count : 100
    }`
    const originalTxsData = (await db.all(originalTxDataDatabase, sql)) as DbOriginalTxData[]
    if (originalTxsData.length > 0) {
      originalTxsData.forEach((tx: DbOriginalTxData) => {
        if (tx.originalTxData) tx.originalTxData = DeSerializeFromJsonString(tx.originalTxData)
        // if (tx.sign) tx.sign = DeSerializeFromJsonString(tx.sign)
      })
    }
    if (config.VERBOSE) {
      Logger.mainLogger.debug('Latest Original-Tx: ', originalTxsData)
    }
    return originalTxsData
  } catch (e) {
    Logger.mainLogger.error(e)
    return null
  }
}
