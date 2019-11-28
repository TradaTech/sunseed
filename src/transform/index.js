const url = require('url')
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const babelParser = require('@babel/parser')
const traverse = require('@babel/traverse').default
const { plugins, isHttp, isNodeModule, isWhitelistModule } = require('../common')
const resolveExternal = require('../external')
const importToRequire = require('../import2require')
const babelify = require('./babelify')

/**
 * transform bundle library with contract source
 * @param {string} src - contract source require external library
 * @param {string} context - for recursive require
 * @param {Object} project - support icetea-studio (does not use fs)
 * @param {Object} options - bundle module config
 */
exports.transform = async (src, context = '/', project = null, options = {}) => {
  src = await babelify(src, [importToRequire])
  const parsed = babelParser.parse(src, {
    sourceType: 'module',
    plugins
  })
  const requires = {}

  traverse(parsed, {
    CallExpression: ({ node }) => {
      if (!node || node.callee.name !== 'require') {
        return
      }
      const arguments_ = node.arguments
      if (arguments_.length !== 1 || arguments_[0].type !== 'StringLiteral') {
        return
      }
      const value = arguments_[0].value
      requires[value] = value
    }
  })

  await Promise.all(Object.keys(requires).map(async value => {
    if (isWhitelistModule(value) || (options.remote && options.remote[value])) {
      delete requires[value]
      return
    }
    if (isHttp(value)) {
      if (!['.js', '.json'].includes(path.extname(value))) {
        throw new Error('"require" supports only .js and .json files.')
      }
      const data = (await axios.get(value)).data
      if (typeof data === 'string') {
        requires[value] = await exports.transform(data, value, null, options)
      } else {
        requires[value] = data
      }
      return
    }
    if (isHttp(context)) {
      if (isNodeModule(value)) {
        throw new Error('Cannot use node_modules in remote URL.')
      }
      if (!['.js', '.json'].includes(path.extname(value))) {
        throw new Error('"require" supports only .js and .json files.')
      }
      const data = (await axios.get(url.URL(value, context))).data
      if (typeof data === 'string') {
        // try to parse json string
        requires[value] = await exports.transform(data, url.URL(value, context), null, options)
      } else {
        requires[value] = data
      }
      return
    }

    // if you want to use bundle instead of blockchain node_modules
    const localFlag = '@local'
    let moduleName = value
    if (moduleName.endsWith(localFlag)) {
      moduleName = moduleName.slice(0, -localFlag.length)
    }

    let filePath
    if (isNodeModule(moduleName)) {
      filePath = require.resolve(`${moduleName}`) // to ignore webpack warning
    } else {
      if (project) {
        filePath = path.join(context, value)
      } else {
        filePath = require.resolve(`${path.resolve(context, value)}`)
      }
    }

    if (!['.js', '.json'].includes(path.extname(filePath))) {
      throw new Error('"require" supports only .js and .json files.')
    }
    let data
    if (project) {
      data = project.getFile(filePath).getData().toString()
    } else {
      data = fs.readFileSync(filePath).toString()
    }
    try {
      data = JSON.parse(data)
      requires[value] = data
    } catch (err) {
      if (err instanceof SyntaxError) {
        requires[value] = await exports.transform(data, path.dirname(filePath), project, options)
      } else {
        throw err
      }
    }
  }))

  if (Object.keys(requires).length === 0) {
    return src
  }

  // first, preprocess
  src = await babelify(src, [resolveExternal(requires)])
  if (src.endsWith(';')) {
    src = src.slice(0, -1) // for redundancy Semicolon
  }
  return src
}

exports.babelify = babelify
