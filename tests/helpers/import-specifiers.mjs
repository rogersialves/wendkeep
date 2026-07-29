import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit);
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      walkAst(value, visit);
    }
  }
}

function literalSpecifier(node, kind) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
  }
  return `<dynamic:${kind}>`;
}

function staticMemberName(member) {
  if (!member?.computed) {
    return member?.property?.type === 'Identifier' ? member.property.name : null;
  }
  if (member.property?.type === 'Literal') return member.property.value;
  if (member.property?.type === 'TemplateLiteral' && member.property.expressions.length === 0) {
    return member.property.quasis[0]?.value.cooked ?? member.property.quasis[0]?.value.raw;
  }
  return undefined;
}

const ALIAS_KINDS = new Set([
  'require',
  'module',
  'global',
  'loader',
  'process',
  'builtin-module-factory',
  'require-factory',
  'reflect',
  'function',
  'function-prototype',
  'function-call',
  'function-apply',
  'dynamic',
]);

function memberLoaderKind(baseKind, name) {
  if (baseKind === 'dynamic') return 'dynamic';
  if (baseKind === 'module') {
    if (name === 'require') return 'require';
    if (name === 'constructor') return 'loader';
    return name === undefined ? 'dynamic' : null;
  }
  if (baseKind === 'global') {
    if (name === 'require') return 'require';
    if (name === 'process') return 'process';
    if (name === 'Reflect') return 'reflect';
    if (name === 'Function') return 'function';
    return name === undefined ? 'dynamic' : null;
  }
  if (baseKind === 'process') {
    if (name === 'mainModule') return 'module';
    if (name === 'getBuiltinModule') return 'builtin-module-factory';
    return name === undefined ? 'dynamic' : null;
  }
  if (baseKind === 'builtin-module-factory') {
    return name === undefined || ['bind', 'call', 'apply'].includes(name) ? 'dynamic' : null;
  }
  if (baseKind === 'loader') {
    if (name === '_load') return 'require';
    if (name === 'createRequire') return 'require-factory';
    if (name === 'default' || name === 'Module') return 'loader';
    return name === undefined ? 'dynamic' : null;
  }
  if (baseKind === 'reflect') {
    if (name === 'apply') return 'require-reflect-apply';
    return name === undefined ? 'dynamic' : null;
  }
  if (baseKind === 'function') {
    if (name === 'prototype') return 'function-prototype';
    return name === undefined ? 'dynamic' : null;
  }
  if (baseKind === 'function-prototype') {
    if (name === 'call') return 'function-call';
    if (name === 'apply') return 'function-apply';
    return name === undefined ? 'dynamic' : null;
  }
  if (baseKind === 'function-call' || baseKind === 'function-apply') {
    if (name === 'call') return `require-${baseKind}-call`;
    if (name === 'apply') return `require-${baseKind}-apply`;
    if (name === 'bind') return 'dynamic';
    return name === undefined ? 'dynamic' : null;
  }
  if (baseKind === 'require') {
    if (name === 'bind') return 'require-bind';
    if (name === 'call') return 'require-call';
    if (name === 'apply') return 'require-apply';
  }
  if (typeof baseKind === 'string' && baseKind.startsWith('require-')) {
    return name === undefined || ['bind', 'call', 'apply'].includes(name) ? 'dynamic' : null;
  }
  return null;
}

function potentialLoaderKind(kind) {
  return kind === 'require' || kind === 'dynamic' || kind?.startsWith('require-');
}

function staticArrayElements(node) {
  return node?.type === 'ArrayExpression' ? node.elements : null;
}

function higherOrderInvocation(node, calleeKind) {
  if (calleeKind === 'require-reflect-apply') {
    return {
      target: node.arguments[0],
      receiver: node.arguments[1],
      arguments: staticArrayElements(node.arguments[2]),
    };
  }
  if (calleeKind === 'require-function-call-call') {
    return {
      target: node.arguments[0],
      receiver: node.arguments[1],
      arguments: node.arguments.slice(2),
    };
  }
  if (calleeKind === 'require-function-apply-call') {
    return {
      target: node.arguments[0],
      receiver: node.arguments[1],
      arguments: staticArrayElements(node.arguments[2]),
    };
  }
  if (calleeKind === 'require-function-call-apply'
    || calleeKind === 'require-function-apply-apply') {
    const invocationArguments = staticArrayElements(node.arguments[1]);
    return {
      target: node.arguments[0],
      receiver: invocationArguments?.[0],
      arguments: calleeKind === 'require-function-call-apply'
        ? invocationArguments?.slice(1) ?? null
        : staticArrayElements(invocationArguments?.[1]),
    };
  }
  return null;
}

function higherOrderLoaderSpecifier(node, aliases, calleeKind) {
  const invocation = higherOrderInvocation(node, calleeKind);
  if (!invocation) return undefined;

  const targetKind = expressionLoaderKind(invocation.target, aliases);
  if (targetKind === 'require-factory') return '<dynamic:require>';
  if (targetKind === 'builtin-module-factory') {
    const moduleName = staticStringValue(invocation.arguments?.[0]);
    return moduleName === null || moduleName === 'module' || moduleName === 'node:module'
      ? '<dynamic:require>'
      : null;
  }
  if (potentialLoaderKind(targetKind)) {
    if (targetKind !== 'require') return '<dynamic:require>';
    if (isModuleBuiltinSpecifier(invocation.arguments?.[0])) return '<dynamic:require>';
    return invocation.arguments
      ? literalSpecifier(invocation.arguments[0], 'require')
      : '<dynamic:require>';
  }
  if (targetKind !== 'function-call' && targetKind !== 'function-apply') return null;

  const receiverKind = expressionLoaderKind(invocation.receiver, aliases);
  if (receiverKind === 'function-call' || receiverKind === 'function-apply') {
    return '<dynamic:require>';
  }
  if (receiverKind === 'builtin-module-factory' || receiverKind === 'require-factory') {
    return '<dynamic:require>';
  }
  if (!potentialLoaderKind(receiverKind)) return null;
  if (receiverKind !== 'require' || !invocation.arguments) return '<dynamic:require>';
  const argumentNode = targetKind === 'function-call'
    ? invocation.arguments[1]
    : invocation.arguments[1]?.type === 'ArrayExpression'
      ? invocation.arguments[1].elements[0]
      : null;
  if (isModuleBuiltinSpecifier(argumentNode)) return '<dynamic:require>';
  return literalSpecifier(argumentNode, 'require');
}

function staticStringValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
  }
  return null;
}

function isModuleBuiltinSpecifier(node) {
  const specifier = staticStringValue(node);
  return specifier === 'module' || specifier === 'node:module';
}

function expressionLoaderKind(node, aliases) {
  if (!node) return null;
  if (node.type === 'ChainExpression') return expressionLoaderKind(node.expression, aliases);
  if (node.type === 'Identifier') return aliases.get(node.name) ?? null;
  if (node.type === 'SequenceExpression') {
    return expressionLoaderKind(node.expressions.at(-1), aliases);
  }
  if (node.type === 'AssignmentExpression') return expressionLoaderKind(node.right, aliases);
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
    const branches = node.type === 'ConditionalExpression'
      ? [node.consequent, node.alternate]
      : [node.left, node.right];
    const kinds = branches.map((branch) => expressionLoaderKind(branch, aliases));
    if (kinds[0] && kinds[0] === kinds[1]) return kinds[0];
    return kinds.some(Boolean) ? 'dynamic' : null;
  }
  if (node.type === 'MemberExpression') {
    const name = staticMemberName(node);
    if (node.object?.type === 'Identifier' && node.object.name === 'process') {
      if (name === 'mainModule') return 'global';
      if (name === undefined) return 'dynamic';
    }
    return memberLoaderKind(expressionLoaderKind(node.object, aliases), name);
  }
  if (node.type === 'CallExpression') {
    const calleeKind = expressionLoaderKind(node.callee, aliases);
    if (calleeKind === 'require-bind') return 'require';
    if (calleeKind === 'require-factory') return 'require';
    if (calleeKind === 'require' && isModuleBuiltinSpecifier(node.arguments[0])) return 'loader';
    if (calleeKind === 'require-call' && isModuleBuiltinSpecifier(node.arguments[1])) return 'loader';
    if (calleeKind === 'builtin-module-factory'
      && isModuleBuiltinSpecifier(node.arguments[0])) return 'loader';
  }
  return null;
}

function patternPropertyName(property) {
  if (!property?.computed && property?.key?.type === 'Identifier') return property.key.name;
  if (property?.key?.type === 'Literal') return property.key.value;
  if (property?.key?.type === 'TemplateLiteral' && property.key.expressions.length === 0) {
    return property.key.quasis[0]?.value.cooked ?? property.key.quasis[0]?.value.raw;
  }
  return undefined;
}

function setAlias(aliases, name, kind) {
  const normalizedKind = typeof kind === 'string'
    && kind.startsWith('require-')
    && kind !== 'require-factory'
    ? 'dynamic'
    : kind;
  if (!name || !ALIAS_KINDS.has(normalizedKind)) return false;
  const previous = aliases.get(name);
  const next = previous && previous !== normalizedKind ? 'dynamic' : normalizedKind;
  if (previous === next) return false;
  aliases.set(name, next);
  return true;
}

function assignPatternKind(pattern, kind, aliases) {
  if (!pattern || !kind) return false;
  if (pattern.type === 'Identifier') return setAlias(aliases, pattern.name, kind);
  if (pattern.type === 'AssignmentPattern') return assignPatternKind(pattern.left, kind, aliases);
  if (pattern.type === 'RestElement') {
    return assignPatternKind(pattern.argument, ALIAS_KINDS.has(kind) ? 'dynamic' : null, aliases);
  }
  if (pattern.type === 'ArrayPattern') {
    let changed = false;
    for (const element of pattern.elements) {
      changed = assignPatternKind(element, 'dynamic', aliases) || changed;
    }
    return changed;
  }
  if (pattern.type !== 'ObjectPattern') return false;
  let changed = false;
  for (const property of pattern.properties) {
    if (property.type === 'RestElement') {
      changed = assignPatternKind(property.argument, 'dynamic', aliases) || changed;
      continue;
    }
    const propertyKind = memberLoaderKind(kind, patternPropertyName(property));
    changed = assignPatternKind(property.value, propertyKind, aliases) || changed;
  }
  return changed;
}

function collectLoaderAliases(ast) {
  const aliases = new Map([
    ['require', 'require'],
    ['module', 'module'],
    ['globalThis', 'global'],
    ['global', 'global'],
    ['Module', 'loader'],
    ['Reflect', 'reflect'],
    ['Function', 'function'],
    ['process', 'process'],
  ]);
  const nodes = [];
  walkAst(ast, (node) => nodes.push(node));
  let changed;
  do {
    changed = false;
    for (const node of nodes) {
      if (node.type === 'ImportDeclaration' && isModuleBuiltinSpecifier(node.source)) {
        for (const specifier of node.specifiers) {
          let kind = 'loader';
          if (specifier.type === 'ImportSpecifier') {
            const imported = specifier.imported?.name ?? specifier.imported?.value;
            if (imported === 'createRequire') kind = 'require-factory';
            else if (imported === '_load') kind = 'require';
            else if (imported !== 'default' && imported !== 'Module') kind = null;
          }
          changed = setAlias(aliases, specifier.local?.name, kind) || changed;
        }
      } else if (node.type === 'VariableDeclarator') {
        changed = assignPatternKind(
          node.id,
          expressionLoaderKind(node.init, aliases),
          aliases,
        ) || changed;
      } else if (node.type === 'AssignmentExpression') {
        changed = assignPatternKind(
          node.left,
          expressionLoaderKind(node.right, aliases),
          aliases,
        ) || changed;
      } else if (node.type === 'AssignmentPattern') {
        changed = assignPatternKind(
          node.left,
          expressionLoaderKind(node.right, aliases),
          aliases,
        ) || changed;
      }
    }
  } while (changed);
  return aliases;
}

export function importSpecifiersFromSource(source, { sourceType = 'module' } = {}) {
  const ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType,
    allowAwaitOutsideFunction: true,
    allowHashBang: true,
    allowReturnOutsideFunction: true,
  });
  const aliases = collectLoaderAliases(ast);
  const edges = [];
  const add = (node, specifier) => edges.push({ start: node.start, specifier });
  walkAst(ast, (node) => {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') {
      if (node.source) add(node, literalSpecifier(node.source, 'import'));
    } else if (node.type === 'ImportExpression') {
      add(node, literalSpecifier(node.source, 'import'));
      if (isModuleBuiltinSpecifier(node.source)) add(node, '<dynamic:require>');
    } else if (node.type === 'CallExpression') {
      const requireKind = expressionLoaderKind(node.callee, aliases);
      const higherOrderSpecifier = higherOrderLoaderSpecifier(node, aliases, requireKind);
      if (higherOrderSpecifier !== undefined) {
        if (higherOrderSpecifier !== null) add(node, higherOrderSpecifier);
      } else if (requireKind === 'require') add(node, literalSpecifier(node.arguments[0], 'require'));
      else if (requireKind === 'require-call') add(node, literalSpecifier(node.arguments[1], 'require'));
      else if (requireKind === 'require-apply') add(node, '<dynamic:require>');
      else if (requireKind === 'builtin-module-factory'
        && staticStringValue(node.arguments[0]) === null) add(node, '<dynamic:require>');
      else if (requireKind === 'dynamic') add(node, '<dynamic:require>');
    }
  });
  return edges.sort((left, right) => left.start - right.start).map((edge) => edge.specifier);
}

export function importSpecifiers(absolute) {
  const source = readFileSync(absolute, 'utf8');
  const sourceType = absolute.endsWith('.cjs') ? 'script' : 'module';
  return importSpecifiersFromSource(source, { sourceType });
}
