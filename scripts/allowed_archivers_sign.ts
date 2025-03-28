import * as fs from 'fs'
import { join } from 'path'
import { Utils as StringUtils } from '@shardeum-foundation/lib-types'
import * as crypto from '@shardeum-foundation/lib-crypto-utils'
import { config, overrideDefaultConfig } from '../src/Config'

/**
 * Before running this script, make sure to update hash key and dev keys
 */
const configFile = join(process.cwd(), 'archiver-config.json')
overrideDefaultConfig(configFile)

crypto.init(config.ARCHIVER_HASH_KEY)
const devAccounts = [
  {
    publicKey: '',
    secretKey: '',
  },
]

interface ConfigData {
  allowedArchivers: string[]
}

interface SignaturePayload {
  allowedArchivers: string[]
}

async function generateSignature(): Promise<void> {
  try {
    // Read and parse config file
    const configData: ConfigData = StringUtils.safeJsonParse(
      fs.readFileSync('./allowed-archivers.json', 'utf8')
    )

    // Create payload
    const rawPayload: SignaturePayload = {
      allowedArchivers: configData.allowedArchivers,
    }
    const signatures = [] as crypto.Signature[]
    for (const devAccount of devAccounts) {
      const data = crypto.signObj({ ...rawPayload }, devAccount.secretKey, devAccount.publicKey)
      signatures.push(data.sign)
    }
    const allowedArchivers = {
      ...rawPayload,
      signatures,
    }
    console.log(allowedArchivers)
  } catch (error) {
    console.error('Error generating signature:', error)
    process.exit(1)
  }
}

// Execute if running directly
if (require.main === module) {
  generateSignature()
}
