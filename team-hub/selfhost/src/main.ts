import { loadConfig } from './config'
import { createHub } from './server'

/**
 * Process entry point. Configuration is read and reported once, then the hub
 * starts; a missing setting that makes the service unusable stops the process
 * instead of leaving it half working.
 */
async function main(): Promise<void> {
  const report = loadConfig(process.env)
  for (const line of report.report) console.log('[config] ' + line)
  if (report.errors.length > 0) {
    for (const error of report.errors) console.error('[config] ' + error)
    console.error('[config] refusing to start with ' + report.errors.length + ' configuration error(s)')
    process.exitCode = 1
    return
  }

  const hub = await createHub({ config: report.config })
  const address = await hub.listen()
  console.log(
    '[hub] listening on ' +
      address.url +
      ' (protocol 1.0.0, database ' +
      report.config.databasePath +
      ', sweep interval ' +
      report.config.sweepIntervalMs +
      ' ms)',
  )

  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    console.log('[hub] ' + signal + ' received, shutting down')
    await hub.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => {
    console.error('[hub] unhandled rejection', reason)
  })
}

await main()
