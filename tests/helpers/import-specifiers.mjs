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

function isCommonJsRequire(callee) {
  if (callee?.type === 'Identifier' && callee.name === 'require') return true;
  if (callee?.type !== 'MemberExpression' || callee.object?.type !== 'Identifier' || callee.object.name !== 'module') {
    return false;
  }
  if (!callee.computed) return callee.property?.type === 'Identifier' && callee.property.name === 'require';
  return callee.property?.type === 'Literal' && callee.property.value === 'require';
}

export function importSpecifiers(absolute) {
  const source = readFileSync(absolute, 'utf8');
  const sourceType = absolute.endsWith('.cjs') ? 'script' : 'module';
  const ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType,
    allowAwaitOutsideFunction: true,
    allowHashBang: true,
    allowReturnOutsideFunction: true,
  });
  const edges = [];
  const add = (node, specifier) => edges.push({ start: node.start, specifier });
  walkAst(ast, (node) => {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') {
      if (node.source) add(node, literalSpecifier(node.source, 'import'));
    } else if (node.type === 'ImportExpression') {
      add(node, literalSpecifier(node.source, 'import'));
    } else if (node.type === 'CallExpression' && isCommonJsRequire(node.callee)) {
      add(node, literalSpecifier(node.arguments[0], 'require'));
    }
  });
  return edges.sort((left, right) => left.start - right.start).map((edge) => edge.specifier);
}
