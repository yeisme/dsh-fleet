/**
 * Self-contained demo showing how a personal Agent Bot connects to dsh-fleet,
 * reports work progress, requests human approval from DSH UI, and finishes cleanly.
 *
 * Run against a local DSH instance:
 *   node examples/demo-bot.mjs
 *   DSH_FLEET_URL=http://127.0.0.1:3081 BOT_ID=release-bot node examples/demo-bot.mjs
 */
import { FleetBotClient } from '../lib/sdk/bot-client.js'

const bot = new FleetBotClient({
  baseUrl: process.env.DSH_FLEET_URL ?? 'http://127.0.0.1:3081',
  id: process.env.BOT_ID ?? 'demo-release-bot',
  name: 'demo-release-bot',
  kind: 'release-agent',
  workspaceLabel: 'External Bots',
})

let interrupted = false

bot.onPrompt(async () => {
  await bot.setStatus('working', { summary: 'Received new instruction from DSH' })
  await bot.pushText('assistant', 'Instruction acknowledged.')
})

bot.onInterrupt(async () => {
  interrupted = true
  await bot.setStatus('idle', { summary: 'Interrupted by operator' })
  await bot.stop()
})

const shutdown = () => {
  bot.stop().finally(() => process.exit(0))
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

async function main() {
  const startedAt = Date.now()
  await bot.start()
  console.log(`Connected to dsh-fleet as ${bot.paneId} (callback: ${bot.callbackUrl})`)

  await bot.setStatus('working', { summary: 'Running pre-release checks' })
  await bot.pushWork(
    'Ran pre-release checks (2/2 passed)',
    [
      { verb: 'test', object: 'unit suite', outcome: 'ok', ms: 420 },
      { verb: 'build', object: 'production bundle', outcome: 'ok', ms: 610 },
    ],
    1280,
  )

  console.log('Waiting for approval in DSH UI...')
  const answer = await bot.requestApproval(
    'Pre-release checks passed. Proceed to deploy v1.2.0 to staging? (y/n)',
    { timeoutMs: 5 * 60_000 },
  )

  if (interrupted) return

  const approved = /^y(es)?$/i.test(answer.text.trim())
  if (approved) {
    await bot.setStatus('working', { summary: 'Deploying v1.2.0 to staging' })
    await bot.pushWork(
      'Deployed v1.2.0 to staging',
      [{ verb: 'deploy', object: 'staging-cluster', outcome: 'ok', ms: 850 }],
      null,
    )
    await bot.pushFinal('Deployed v1.2.0 to staging successfully.', 'done', Date.now() - startedAt)
    await bot.setStatus('done', { summary: 'Deployed v1.2.0 to staging' })
  } else {
    await bot.pushFinal('Deployment cancelled by operator.', 'cancelled', Date.now() - startedAt)
    await bot.setStatus('done', { summary: 'Deployment cancelled' })
  }

  await bot.stop()
  console.log('Demo bot finished cleanly.')
}

main().catch(async (error) => {
  console.error(`Demo bot failed: ${error.message}`)
  await bot.stop()
  process.exit(1)
})
