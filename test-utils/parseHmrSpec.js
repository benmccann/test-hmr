const { parse: parseHmrSpec } = require('./hmr-spec-parser')
const normalizeHtml = require('./normalizeHtml')

const emptyRegex = /^\s*$/

const isEmpty = text => emptyRegex.test(text)

const compileFileContent = ({ parts, conditions }) => {
  if (!parts.length) {
    return {}
  }
  const allLines = []
  const result = { '*': allLines }
  const all = conditions.map(cond => {
    const lines = []
    result[cond] = lines
    return lines
  })
  all.push(allLines)

  const pushAll = text => {
    all.forEach(lines => lines.push(text))
  }

  const pushCondition = (condition, text) => {
    if (!result[condition]) {
      result[condition] = []
    }
    result[condition].push(text)
  }

  for (const { condition, text } of parts) {
    if (condition != null) {
      pushCondition(condition, text)
    } else {
      pushAll(text)
    }
  }

  Object.keys(result).forEach(key => {
    result[key] = result[key].join('')
  })

  return result
}

const shiftFunctions = functions => ({ start, end }) => {
  const result = []
  if (functions) {
    let next
    while ((next = functions[0])) {
      const { index } = next
      if (index < start) {
        throw new Error('Sub handler must be in condition')
      }
      // if (index > to) { DEBUG DEBUG DEBUG
      if (index >= end) {
        break
      }
      const item = functions.shift()
      result.push(item)
    }
  }
  return result
}

const FunctionShifter = initialFunctions => {
  if (!initialFunctions) {
    return () => []
  }

  const functions = [...initialFunctions]

  const shift = shiftFunctions(functions)

  return shift
}

const splitSteps = (part, fns) => {
  const {
    text,
    content: { start, end },
  } = part
  const result = []
  let leftIndex = start
  fns.forEach(({ index, fn }) => {
    if (index > leftIndex) {
      result.push({
        text: text.substring(leftIndex - start, index - start),
      })
      leftIndex = index
    }
    result.push({
      sub: fn,
    })
  })
  if (leftIndex < end) {
    result.push({
      text: text.substring(leftIndex - start),
    })
  }

  // trim
  if (result[0] && result[0].text && isEmpty(result[0].text)) {
    result.shift()
  }
  if (result.length > 1) {
    const lastStep = result[result.length - 1]
    if (lastStep.text && isEmpty(lastStep.text)) {
      result.pop()
    }
  }

  return result
}

const compileSteps = (functions, { parts, conditions }) => {
  if (!parts.length) {
    return []
  }

  const shift = FunctionShifter(functions)

  const buckets = {}
  const all = conditions.map(cond => {
    const item = { condition: cond, lines: [] }
    buckets[cond] = item
    return item
  })

  const pushAll = part => {
    const { text } = part
    all.forEach(({ lines }) => lines.push(text))
    const fns = shift(part)
    if (fns.length > 0) {
      throw new Error('Sub functions must be inside a condition')
    }
  }

  const registerHook = (item, fn) => {
    if (!item.before) {
      item.before = fn
    } else if (!item.after) {
      item.after = fn
    } else {
      throw new Error(
        'Only two root level hooks are allowed (before and after)'
      )
    }
  }

  const pushCond = (cond, part) => {
    const item = getCond(cond)
    const fns = shift(part)
    if (fns.length > 0) {
      if (part.block === true) {
        if (item.steps) {
          throw new Error(
            'Only a single condition block can have sub functions steps'
          )
        }
        item.steps = splitSteps(part, fns)
        item.stepsIndex = item.lines.length
        // console.log(item)
      } else if (part.block === false) {
        fns.forEach(({ fn }) => {
          registerHook(item, fn)
        })
      } else {
        throw new Error('Invalid part: ' + JSON.stringify(part))
      }
    } else {
      item.lines.push(part.text)
    }
  }

  const getCond = condition => {
    if (!buckets[condition]) {
      buckets[condition] = {
        steps: [],
      }
    }
    return buckets[condition]
  }

  for (const part of parts) {
    const { condition } = part
    if (condition != null) {
      pushCond(condition, part)
    } else {
      pushAll(part)
    }
  }

  // --- assembling ---

  const linesToHtml = lines => {
    let html = lines.join('')
    html = normalizeHtml(html)
    return html
  }

  const spreadSteps = ({ lines, steps, stepsIndex }) => {
    if (!steps) {
      const html = linesToHtml(lines)
      return [{ html }]
    }
    const before = lines.slice(0, stepsIndex)
    const after = lines.slice(stepsIndex)
    const result = []
    for (const step of steps) {
      const { text, sub } = step
      if (sub) {
        result.push({ sub })
      } else if (text) {
        const lines = [...before, text, ...after]
        const html = linesToHtml(lines)
        result.push({ html })
      } else {
        throw new Error('Invalid step: ' + JSON.stringify(step))
      }
    }
    return result
  }

  const entries = conditions.map(cond => {
    const item = buckets[cond]
    const { before, after } = item
    const steps = spreadSteps(item)
    return [cond, { steps, before, after }]
  })

  return entries
}

const parseSpecString = (state, specString, functions) => {
  const result = {}
  const ast = parseHmrSpec(specString)

  {
    const specs = {}
    for (const file of ast.files) {
      specs[file.path] = compileFileContent(file.content)
    }
    result.specs = specs
  }

  if (ast.expectations) {
    result.expects = compileSteps(functions, ast.expectations)
    // console.log(JSON.stringify(result, false, 2))
  }

  return result
}

module.exports = {
  parseSpecString,
}