const { existsSync } = require('fs')
const util = require('util')
const trammel = util.promisify(require('trammel'))
const byteSize = require('byte-size')
const clipboardy = require('clipboardy')
const ipfsClient = require('ipfs-http-client')
const updateCloudflareDnslink = require('dnslink-cloudflare')
const ora = require('ora')
const chalk = require('chalk')
const doOpen = require('open')
const _ = require('lodash')
const fp = require('lodash/fp')

const { logError } = require('./src/logging')

const httpGatewayUrl = require('./src/gateway')
const { setupPinata } = require('./src/pinata')

const white = chalk.whiteBright

function guessedPath() {
  // prettier-ignore
  const guesses = [
    '_site',         // jekyll, hakyll, eleventy
    'site',          // forgot which
    'public',        // gatsby, hugo
    'dist',          // nuxt
    'output',        // pelican
    'out',           // hexo
    'build',         // create-react-app, metalsmith, middleman
    'website/build', // docusaurus
    'docs',          // many others
  ]

  return fp.filter(existsSync)(guesses)[0]
}

function guessPathIfEmpty(publicPath) {
  let result
  const spinner = ora()

  if (_.isEmpty(publicPath)) {
    spinner.info(
      `🤔  No ${white('path')} argument specified. Looking for common ones…`
    )
    result = guessedPath()
    if (result) {
      spinner.succeed(
        `📂  Found local ${chalk.blue(result)} directory. Deploying that.`
      )
      return result
    } else {
      spinner.fail(
        `🔮  Couldn't guess what to deploy. Please specify a ${white('path')}.`
      )
      return undefined
    }
  } else {
    return publicPath
  }
}

async function openUrl(url) {
  const spinner = ora()
  spinner.start('🏄  Opening web browser…')
  const childProcess = await doOpen(url)
  spinner.succeed('🏄  Opened web browser (call with -O to disable.)')
  return childProcess
}

async function updateCloudflareDns(siteDomain, { apiEmail, apiKey }, hash) {
  const spinner = ora()

  spinner.start(`📡  Beaming new hash to DNS provider ${white('Cloudflare')}…`)
  if (fp.some(_.isEmpty)([siteDomain, apiEmail, apiKey])) {
    spinner.fail('💔  Missing arguments for Cloudflare API.')
    spinner.warn('🧐  Check if these environment variables are present:')
    logError(`
      IPFS_DEPLOY_SITE_DOMAIN
      IPFS_DEPLOY_CLOUDFLARE__API_EMAIL
      IPFS_DEPLOY_CLOUDFLARE__API_KEY

      You can put them in a .env file if you want and they will be picked up.
    `)
  } else {
    try {
      const api = {
        email: apiEmail,
        key: apiKey,
      }

      const opts = {
        record: siteDomain,
        zone: siteDomain,
        link: `/ipfs/${hash}`,
      }

      const content = await updateCloudflareDnslink(api, opts)
      spinner.succeed('🙌  SUCCESS!')
      spinner.info(`🔄  Updated DNS TXT ${white(opts.record)} to:`)
      spinner.info(`🔗  ${white(content)}`)
    } catch (e) {
      spinner.fail("💔  Updating Cloudflare DNS didn't work.")
      logError(e)
    }

    return siteDomain
  }
}

async function showSize(path) {
  const spinner = ora()
  spinner.start(`📦  Calculating size of ${chalk.blue(path)}…`)
  try {
    const size = await trammel(path, {
      stopOnError: true,
      type: 'raw',
    })
    const kibi = byteSize(size, { units: 'iec' })
    const readableSize = `${kibi.value} ${kibi.unit}`
    spinner.succeed(`🚚  ${chalk.blue(path)} weighs ${readableSize}.`)
    return readableSize
  } catch (e) {
    spinner.fail("⚖  Couldn't calculate website size.")
    logError(e)
    return undefined
  }
}

async function addToInfura(publicDirPath) {
  const spinner = ora()

  const infuraClient = ipfsClient({
    host: 'ipfs.infura.io',
    port: '5001',
    protocol: 'https',
  })

  try {
    spinner.start(
      `📠  Uploading and pinning via https to ${white('infura.io')}…`
    )
    const response = await infuraClient.addFromFs(publicDirPath, {
      recursive: true,
    })
    spinner.succeed("📌  It's pinned to Infura now with hash:")
    const hash = response[response.length - 1].hash
    spinner.info(`🔗  ${hash}`)
    return hash
  } catch (e) {
    spinner.fail("💔  Uploading to Infura didn't work.")
    logError(e)
    return undefined
  }
}

function copyUrlToClipboard(url) {
  const spinner = ora()
  spinner.start('📋  Copying HTTP gateway URL to clipboard…')
  try {
    clipboardy.writeSync(url)
    spinner.succeed('📋  Copied HTTP gateway URL to clipboard:')
    spinner.info(`🔗  ${chalk.green(url)}`)
    return url
  } catch (e) {
    spinner.fail('⚠️  Could not copy URL to clipboard.')
    logError(e)
    return undefined
  }
}

async function deploy({
  publicDirPath,
  copyHttpGatewayUrlToClipboard = false,
  open = false,
  remotePinners = ['infura'],
  dnsProviders = [],
  siteDomain,
  credentials = {
    cloudflare: {
      apiEmail,
      apiKey,
    },
    pinata: {
      apiKey,
      secretApiKey,
    },
  },
} = {}) {
  publicDirPath = guessPathIfEmpty(publicDirPath)

  if (!publicDirPath) {
    return undefined
  }

  const readableSize = await showSize(publicDirPath)

  if (!readableSize) {
    return undefined
  }

  let successfulRemotePinners = []
  let pinnedHashes = {}

  if (remotePinners.includes('infura')) {
    const infuraHash = await addToInfura(publicDirPath)
    if (infuraHash) {
      successfulRemotePinners = successfulRemotePinners.concat(['infura'])
      Object.assign(pinnedHashes, { infuraHash })
    }
  }

  if (remotePinners.includes('pinata')) {
    const addToPinata = setupPinata(credentials.pinata)
    const pinataHash = await addToPinata(publicDirPath, {
      name: siteDomain || __dirname,
    })

    if (pinataHash) {
      successfulRemotePinners = successfulRemotePinners.concat(['pinata'])
      Object.assign(pinnedHashes, { pinataHash })
    }
  }

  if (successfulRemotePinners.length > 0) {
    const pinnedHash = Object.values(pinnedHashes)[0]
    const isEqual = hash => hash === pinnedHash
    if (!fp.every(isEqual)(Object.values(pinnedHashes))) {
      const spinner = ora()
      spinner.fail('≠  Found inconsistency in pinned hashes:')
      logError(pinnedHashes)
      return undefined
    }

    const gatewayUrl = httpGatewayUrl(pinnedHash, successfulRemotePinners[0])

    if (copyHttpGatewayUrlToClipboard) {
      copyUrlToClipboard(gatewayUrl)
    }

    if (dnsProviders.includes('cloudflare')) {
      await updateCloudflareDns(siteDomain, credentials.cloudflare, pinnedHash)
    }

    if (open && _.isEmpty(dnsProviders)) {
      await openUrl(gatewayUrl)
    }
    if (open && !_.isEmpty(dnsProviders)) {
      await openUrl(`https://${siteDomain}`)
    }
    return pinnedHash
  } else {
    logError('Failed to deploy.')
    return undefined
  }
}

module.exports = deploy
