// A memory fs that can be blanked out

const path = require('path')
const glob = require('fast-glob')

const MemoryFS = require('memory-fs')

const tmpMemFs = ({ srcDir }) => {
  let tmpfs

  const writeFile = (fs, filePath, contents) =>
    new Promise((resolve, reject) => {
      const absPath = path.join(srcDir, filePath)
      fs.mkdirpSync(path.dirname(absPath))
      fs.writeFile(absPath, contents, 'utf8', err => {
        if (err) reject(err)
        else resolve(absPath)
      })
    })

  const reset = async files => {
    const sourceFiles = await glob(path.join(srcDir, '**/*'))
    const changes = new Set(sourceFiles)

    tmpfs = new MemoryFS()

    if (files) {
      await Promise.all(
        Object.entries(files).map(([path, contents]) =>
          writeFile(tmpfs, path, contents)
        )
      ).then(paths => {
        paths.forEach(path => {
          changes.add(path)
        })
        return paths
      })
    }

    return [...changes]
  }

  tmpfs = new MemoryFS()

  const mfs = new Proxy(tmpfs, {
    get(target, key) {
      if (key === 'reset') {
        return reset
      }
      return tmpfs[key]
    },
  })

  return mfs
}

module.exports = tmpMemFs
