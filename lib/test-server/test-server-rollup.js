/* eslint-env node, mocha */

const debug = require('debug')('test-hmr:test-server:rollup')

const path = require('path')
const proxyquire = require('proxyquire')
const express = require('express')

const { noop, asyncNoop, pipe, realpath } = require('../util')

const virtualFs = require('./virtual-fs')

const HOST = 'localhost'

const devServer = ({ contentBase, vfs }) => {
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
  }

  const sendError = (res, error) => {
    if (error.code === 'ENOENT') {
      res.sendStatus(404)
    } else {
      res.status(500).send(JSON.stringify(error))
    }
  }

  const send = (res, file) => {
    vfs.stat(file, (err, stats) => {
      if (err) {
        sendError(res, err)
      } else if (stats.isDirectory()) {
        send(res, path.join(file + '/index.html'))
      } else {
        vfs.readFile(file, 'utf8', (err, contents) => {
          if (err) {
            sendError(res, err)
          } else {
            const ext = path.extname(file)
            const mime = mimeTypes[ext]
            if (mime) {
              res.set({ 'Content-Type': mime })
            }
            res.send(contents)
          }
        })
      }
    })
  }

  const app = express()

  app.get('*', (req, res) => {
    const file = path.resolve(path.join(contentBase, req.path))
    send(res, file)
  })

  app.close = noop

  return app
}

const resolveAppPath = arg => (typeof arg === 'string' ? { appPath: arg } : arg)

const makeAppPathAbsolute = async args => ({
  ...args,
  appPath: await realpath(args.appPath),
})

const resolveArgs = pipe(
  resolveAppPath,
  makeAppPathAbsolute
)

const requireRollupConfig = path => {
  const before = { ...process.env }
  process.env.NODE_ENV = 'test'
  process.env.ROLLUP_WATCH = '1'
  const req = require('esm')(module)
  const config = req(path).default
  Object.assign(process.env, before)
  return config
}

const start = async arg => {
  const {
    appPath,
    quiet = false, // TODO implement quiet
    srcPath = path.join(appPath, 'src'),
  } = await resolveArgs(arg)

  const rollupConfigPath = `${appPath}/rollup.config.js`
  const rollupConfig = requireRollupConfig(rollupConfigPath)

  const findHotPlugin = rollupConfig => {
    const plugins = rollupConfig.plugins.filter(Boolean)
    const svelteHotPlugin =
      plugins.find(({ name, _setFs }) => name === 'svelte' && _setFs) ||
      plugins.find(({ name }) => name === 'svelte')
    const hotPlugin = plugins.find(({ name }) => name === 'hmr')
    return {
      hotPlugin,
      svelteHotPlugin,
    }
  }

  const { hotPlugin, svelteHotPlugin } = findHotPlugin(rollupConfig)

  if (!svelteHotPlugin) {
    throw new Error(
      `Failed to find svelte plugin (config: ${rollupConfigPath})`
    )
  }

  const vfs = virtualFs.withFsWatch({
    srcDir: srcPath,
  })

  svelteHotPlugin._setFs(vfs)

  const rollup = proxyquire
    .noCallThru()
    .load(`${appPath}/node_modules/rollup/dist/rollup.js`, {
      fs: vfs,
    })

  const watchOptions = {
    ...rollupConfig,
    watch: {
      ...rollupConfig.watch,
      chokidar: false,
    },
  }
  const watcher = rollup.watch(watchOptions)

  watcher.on('event', event => {
    if (event.code === 'BUNDLE_END') {
      if (!quiet) {
        // eslint-disable-next-line no-console
        console.debug('Compiled in %sms', event.duration)
      }
      notifyEmitted()
    } else if (event.code === 'ERROR') {
      notifyError(event.error)
    }
  })

  let emitListeners = []
  const onceEmitted = () =>
    new Promise((resolve, reject) => {
      emitListeners.push({ resolve, reject })
    })

  const notifyEmitted = () => {
    debug('notifyEmitted')
    const listeners = emitListeners
    emitListeners = []
    for (const { resolve } of listeners) {
      resolve({})
    }
  }

  const notifyError = error => {
    debug('notifyError', error)
    const listeners = emitListeners
    emitListeners = []
    for (const { reject } of listeners) {
      reject(error)
    }
  }

  const inSrc = file =>
    file ? path.join(appPath, 'src', file) : path.join(appPath, 'src')

  const writeFile = (filePath, contents) => {
    debug("writeFile('%s', '%h')", filePath, contents)
    const srcPath = inSrc(filePath)
    if (contents && contents.rm) {
      // TODO implement delete (not easy with current virtual fs layout)
      return Promise.resolve(srcPath)
    } else {
      return new Promise((resolve, reject) => {
        vfs.out.mkdirpSync(path.dirname(srcPath))
        vfs.out.writeFile(srcPath, contents, 'utf8', err => {
          if (err) reject(err)
          else resolve(srcPath)
        })
      })
    }
  }

  const throwCompilationErrors = ([compilation]) => {
    const { errors } = compilation
    if (errors && errors.length > 0) {
      const err = new Error(errors[0])
      err.name = 'CompileError'
      throw err
    }
    return compilation
  }

  const writeFiles = async files => {
    debug('writeFiles(%k)', files)
    const paths = await Promise.all(
      Object.entries(files).map(([path, contents]) => writeFile(path, contents))
    )
    await Promise.all([onceEmitted(), vfs.notify(paths)]).then(
      throwCompilationErrors
    )
  }

  const reset = async files => {
    debug('reset: enter')
    await vfs.reset(files)
    const compilation = await onceEmitted()
    throwCompilationErrors([compilation])
    debug('reset: leave')
  }

  const contentBase =
    rollupConfig.output.dir || path.dirname(rollupConfig.output.file)

  const server = devServer({ vfs, contentBase })

  let httpServer
  let doClose = async () => {
    doClose = asyncNoop
    httpServer.close()
    watcher.close()
    if (hotPlugin) {
      hotPlugin._close()
    }
    await server.close()
  }

  const close = () => doClose()

  let baseUrl
  const listen = () =>
    new Promise((resolve, reject) => {
      httpServer = server.listen(0, HOST, function(err) {
        const { address, port } = this.address()
        // eslint-disable-next-line no-console
        console.info(
          `[Test HMR] Rollup test server listening at http://${address}:${port}`
        )
        baseUrl = `http://${address}:${port}`
        if (err) reject(err)
        else resolve()
      })
    })

  await Promise.all([onceEmitted(), listen()])

  debug('started')

  return {
    get baseUrl() {
      return baseUrl
    },
    close,
    reset,
    writeFiles,
  }
}

const init = options => ({
  start: () => start(options),
  defaultConfig: {
    hmrReadyMessage: '[HMR] Enabled',
    hmrDoneMessage: '[HMR] Up to date',
    hmrNothingChangedMessage: '[HMR] Nothing changed',
    hmrCompileErrorMessage: null,
  },
})

module.exports = init