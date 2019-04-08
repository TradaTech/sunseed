const template = require("@babel/template");
const types = require("@babel/types");
let numberOfContracts = 0
let contractName = ""
let metadata = {}
let extendData = {}

function isMethod (node) {
  if (!node) return false
  const type = node.type
  if (type === 'ClassMethod' || type === 'ClassPrivateMethod') {
    return true
  }
  const valueType = node.value && node.value.type
  return valueType === 'FunctionExpression' ||
    valueType === 'ArrowFunctionExpression'
}

const SUPPORTED_TYPES = ['number', 'string', 'boolean', 'bigint', 'null', 'undefined',
  'function', 'array', 'map', 'set', 'date', 'regexp', 'promise']

function concatUnique (a, b) {
  if (!Array.isArray(a)) {
    a = [a]
  }
  if (!Array.isArray(b)) {
    b = [b]
  }
  const result = a.concat(b.filter(i => !a.includes(i)))

  for (let i = 0; i < result.length; i++) {
    if (!SUPPORTED_TYPES.includes(result[i])) {
      return 'any'
    }
  }

  if (result.length === 1) {
    return result[0]
  }

  return result
}
  
function getTypeName (node, insideUnion) {
  if (!node) return 'any'
  const ta = insideUnion ? node : node.typeAnnotation
  const tn = ta.type
  if (!tn) return 'any'

  let result
  if (tn === 'Identifier') {
    result = ta.name
  } else if (!tn.endsWith('TypeAnnotation')) {
    result = tn
  } else {
    result = tn.slice(0, tn.length - 14)
  }

  result = result.toLowerCase()

  // sanitize result

  if (result === 'void') {
    result = 'undefined'
  } else if (result === 'nullliteral') {
    result = 'null'
  } else if (result === 'generic') {
    const t = ta.id.name.toLowerCase()
    result = SUPPORTED_TYPES.includes(t) ? t : 'any'
  } else if (result === 'nullable') {
    result = concatUnique(['undefined', 'null'], getTypeName(ta))
  } else if (result === 'union') {
    result = []
    ta.types.forEach(ut => {
      result = concatUnique(result, getTypeName(ut, true))
    })
  } else if (!SUPPORTED_TYPES.includes(result)) {
    result = 'any'
  }
  return result !== 'any' && Array.isArray(result) ? result : [result]
}

function getTypeParams (params) {
  return params.map(p => {
    const item = p.left || p
    const param = {
      name: item.name,
      type: getTypeName(item.typeAnnotation)
    }
    if (p.right) {
      if (types.isNullLiteral(p.right)) {
        param.defaultValue = null
      } else if (types.isLiteral(p.right)) {
        param.defaultValue = p.right.value
      }
    }
    return param
  })
}
  
// const SYSTEM_DECORATORS = ['state', 'onReceived', 'transaction', 'view', 'pure', 'payable']
// const STATE_CHANGE_DECORATORS = ['transaction', 'view', 'pure', 'payable']
const METHOD_DECORATORS = ['transaction', 'view', 'pure', 'payable']
const PROPERTY_DECORATORS = ['state', 'pure']
const SYSTEM_DECORATORS = ['onReceived']
// const SPECIAL_MEMBERS = ['constructor', '__on_deployed', '__on_received']
  
module.exports = function ({ types: t }) {
  return {
    visitor: {
      ClassDeclaration: function(path) {
        new IceTea(t).classDeclaration(path);
      },
      Program: {
        exit(path) {
          new IceTea(t).exit(path.node);
        }
      }
    }
  }
}

class IceTea {
  constructor(types) {
    this.types = types
    this.__on_deployed = 0
    this.className = ""
    this.metadata = {}
  }

  classDeclaration(path) {
    const klass = path.node
    this.className = klass.id.name
    if(!metadata[this.className]) {
      metadata[this.className] = {}
    }
    this.metadata = metadata[this.className]
    if(klass.superClass) {
      extendData[this.className] = klass.superClass.name
    }

    const contracts = this.findDecorators(klass, "contract");
    numberOfContracts += contracts.length;
    const ctor = this.findConstructor(klass);
    if(ctor) {
      ctor.kind = "method";
      ctor.key.name = "__on_deployed";
      this.replaceSuper(ctor)
    }

    if(contracts.length > 0) {
      contractName = klass.id.name
      this.deleteDecorators(klass, contracts)
    }
    
    path.get('body.body').map(body => {
      if(['ClassProperty', 'ClassPrivateProperty'].includes(body.node.type)) {
        this.classProperty(body)
      } else if(['ClassMethod', 'ClassPrivateMethod'].includes(body.node.type)) {
        this.classMethod(body.node)
      }
    })
  }

  classProperty(path) {
    const { node } = path
    const decorators = node.decorators || []

    if(!decorators.every(decorator => {
      return PROPERTY_DECORATORS.includes(decorator.expression.name)
    })) {
      this.buildError('Only @state, @pure for property', node)
    }

    const states = this.findDecorators(node, "state");
    const name = node.key.name || ( '#' + node.key.id.name) // private property does not have key.name

    if(node.value) {
      const klassPath = path.parentPath.parentPath
      let onDeploy = this.findMethod(klassPath.node, '__on_deployed')
      if(!onDeploy) {
        // class noname is only used for valid syntax
        const fn = template.smart(`
          class noname {
            __on_deployed () {}
          }
        `)
        klassPath.node.body.body.unshift(...fn().body.body)
        onDeploy = klassPath.node.body.body[0]
        this.metadata['__on_deployed'] = {
          type: "ClassMethod",
          decorators: ["payable"]
        }
      }
      const fn = template.smart(`
        this.NAME = DEFAULT
      `)
      onDeploy.body.body.unshift(fn({
        NAME: name,
        DEFAULT: node.value
      }))

      // initialization is already added constructor
      if(states.length === 0) {
        path.remove()
      }
    }

    if(states.length > 0) {
      if(isMethod(node)) {
        this.buildError('function cannot be decorated as @state', node)
      }

      this.wrapState(path)

      if(!this.metadata[name]) {
        this.metadata[name] = {
          type: node.type,
          decorators: [...decorators.map(decorator => decorator.expression.name), 'view'],
          fieldType: getTypeName(node.typeAnnotation)
        }
      }
      return
    }

    if(!this.metadata[name]) {
      this.metadata[name] = {
        type: node.type,
        decorators: decorators.map(decorator => decorator.expression.name),
      }

      if(!isMethod(node)) {
        this.metadata[name]['fieldType'] = getTypeName(node.typeAnnotation)
        if(decorators.length === 0) {
          this.metadata[name]['decorators'].push('pure')
        }
      } else {
        this.metadata[name]['returnType'] = getTypeName(node.value.returnType)
        this.metadata[name]['params'] = getTypeParams(node.value.params)
        if(decorators.length === 0) {
          this.metadata[name]['decorators'].push('view')
        }
      }
    }
  }

  classMethod(klass) {
    const name = klass.key.name || ( '#' + klass.key.id.name)
    if(name === '__on_received') {
      this.buildError('__on_received cannot be specified directly.', klass)
    }
    if (name === '__on_deployed') {
      if(this.__on_deployed > 0) {
        this.buildError('__on_deployed cannot be specified directly.', klass)
      }
      this.__on_deployed += 1
    }
    if(name.startsWith('#')) {
      const payables = this.findDecorators(klass, 'payable')
      if(payables.length > 0) {
        this.buildError('Private function cannot be payable', klass)
      }
    }

    const decorators = klass.decorators || []
    if(!this.metadata[name]) {
      this.metadata[name] = {
        type: klass.type,
        decorators: decorators.map(decorator => decorator.expression.name),
        returnType: getTypeName(klass.returnType),
        params: getTypeParams(klass.params)
      }
      if(!this.metadata[name].decorators.some(decorator => {
        return METHOD_DECORATORS.includes(decorator);
      })) {
        this.metadata[name].decorators.push('view')
      }
    }

    const onreceives = this.findDecorators(klass, 'onReceived')
    if(onreceives.length > 0) {
      this.metadata['__on_received'] = klass.key.name
    }

    this.deleteDecorators(klass, this.findDecorators(klass, ...METHOD_DECORATORS, ...SYSTEM_DECORATORS))
  }

  exit(node) {
    if(numberOfContracts === 0) {
      this.buildError("Your smart contract does not have @contract.", node);
    }
    if (numberOfContracts > 1) {
      this.buildError("Your smart contract has more than one @contract.", node);
    }

    let name = contractName
    let parent = extendData[name]
    while(parent) {
      metadata[contractName] = {...metadata[parent], ...metadata[contractName]}
      name = parent
      parent = extendData[name]
    }

    this.appendNewCommand(node)
    this.appendMetadata(node)
    this.reset()
  }

  reset() {
    numberOfContracts = 0;
    contractName = ""
    metadata = {}
    extendData = {}
  }

  replaceSuper(ctor) {
    ctor.body.body = ctor.body.body.map(body => {
      if(!body.expression || body.expression.type !== 'CallExpression') {
        return body
      }
      if(body.expression.callee.type === 'Super') {
        const superTemplate = template.smart(`
				  super.__on_deployed(ARGUMENTS)
        `);
        body = superTemplate({
          ARGUMENTS: body.expression.arguments
        })
      }
      return body
    })
  }

  wrapState(path) {
    const { node } = path
    const name = node.key.name || ( '#' + node.key.id.name)
    const wrap = template.smart(`
      class noname {
        get NAME() {
          return this.getState("NAME", DEFAULT);
        }
        set NAME(value) {
          this.setState("NAME", value);
        }
      }
    `);
    path.replaceWithMultiple(wrap({
      NAME: name,
      DEFAULT: node.value
    }).body.body)
  }

  appendNewCommand(node) {
    const append = template.smart(`
      const __contract = new NAME();
    `)
    node.body.push(append({
      NAME: contractName
    }))
  }

  appendMetadata(node) {
    const meta = template.smart(`
      const __metadata = META
    `)
    node.body.push(meta({
      META: this.types.valueToNode(metadata[contractName])
    }))
  }

  findConstructor(klass) {
    return klass.body.body.filter(body => {
      return body.kind === "constructor";
    })[0];
  }

  findMethod(klass, ...names) {
    return klass.body.body.filter(body => {
      return body.type === "ClassMethod" && names.includes(body.key.name);
    })[0];
  }

  buildError(message, nodePath) {
    if (nodePath && nodePath.buildCodeFrameError) {
      throw nodePath.buildCodeFrameError(message);
    }
    throw new SyntaxError(message);
  }

  findDecorators(klass, ...names) {
    return (klass.decorators || []).filter(decorator => {
      return names.includes(decorator.expression.name);
    });
  }

  deleteDecorators(klass, decorators) {
    decorators.forEach(decorator => {
      const index = klass.decorators.indexOf(decorator);
      if (index >= 0) {
        klass.decorators.splice(index, 1);
      }
    });
  }
}