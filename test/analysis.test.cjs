const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeAst, includeCallComplexity } = require('../dist/analysis.js');

const loc = line => ({ line });
const fn = (name, children, parameters = []) => ({
  kind: 'FunctionDecl', name, mangledName: `_${name}`, loc: loc(3), inner: [...parameters, { kind: 'CompoundStmt', inner: children }]
});
const ref = (name, id, kind = 'VarDecl') => ({
  kind: 'DeclRefExpr', referencedDecl: { name, id, kind }
});
const int = value => ({ kind: 'IntegerLiteral', value });
const block = (...inner) => ({ kind: 'CompoundStmt', inner });
const call = (name, ...args) => ({ kind: 'CallExpr', inner: [{ kind: 'ImplicitCastExpr', inner: [{
  kind: 'DeclRefExpr', referencedDecl: { kind: 'FunctionDecl', name, mangledName: `_${name}` }
}] }, ...args] });

function forLoop(line, { bound = ref('n', 'n-id', 'ParmVarDecl'), update, body = block(), variable = `i${line}` }) {
  const counter = { kind: 'VarDecl', name: variable, id: `${variable}-id`, inner: [int(0)] };
  return {
    kind: 'ForStmt', loc: loc(line), inner: [
      { kind: 'DeclStmt', inner: [counter] }, {},
      { kind: 'BinaryOperator', opcode: '<', inner: [ref(variable, counter.id), bound] },
      update(ref(variable, counter.id)), body
    ]
  };
}

const increment = counter => ({ kind: 'UnaryOperator', opcode: '++', inner: [counter] });
const multiplyByTwo = counter => ({ kind: 'CompoundAssignOperator', opcode: '*=', inner: [counter, int(2)] });

test('distinguishes constant, linear, and logarithmic for loops', () => {
  const externallyDeclaredCounter = forLoop(9, { update: increment });
  const counter = externallyDeclaredCounter.inner[0].inner[0];
  externallyDeclaredCounter.inner[0] = { kind: 'BinaryOperator', opcode: '=', inner: [ref(counter.name, counter.id), int(0)] };
  const results = analyzeAst({ kind: 'TranslationUnitDecl', inner: [
    fn('constant', [forLoop(4, { bound: int(10), update: increment })]),
    fn('linear', [forLoop(5, { update: increment })]),
    fn('logarithmic', [forLoop(8, { update: multiplyByTwo })]),
    fn('predeclared', [externallyDeclaredCounter])
  ] }, 'sample.cpp');
  assert.deepEqual(results.map(result => result.complexity), ['O(1)', 'O(n)', 'O(log n)', 'O(n)']);
  assert.match(results[1].explanation, /line 5/);
});

test('multiplies nested loops, keeps sequential loops at the maximum, and handles mixed growth', () => {
  const nested = forLoop(5, { update: increment, body: block(forLoop(6, { update: increment })) });
  const mixed = forLoop(9, { update: increment, body: block(forLoop(10, { update: multiplyByTwo })) });
  const sequential = [forLoop(13, { update: increment }), forLoop(15, { update: increment })];
  const results = analyzeAst({ kind: 'TranslationUnitDecl', inner: [
    fn('nested', [nested]), fn('mixed', [mixed]), fn('sequential', sequential)
  ] }, 'sample.cpp');
  assert.deepEqual(results.map(result => result.complexity), ['O(n²)', 'O(n log n)', 'O(n)']);
});

test('returns unknown for unrecognized loops and recursive calls', () => {
  const whileLoop = { kind: 'WhileStmt', loc: loc(5), inner: [
    { kind: 'BinaryOperator', opcode: '<', inner: [ref('x', 'x-id'), ref('n', 'n-id', 'ParmVarDecl')] },
    block({ kind: 'CallExpr', name: 'work' })
  ] };
  const results = analyzeAst({ kind: 'TranslationUnitDecl', inner: [
    fn('unrecognized', [whileLoop]), fn('recursive', [call('recursive')])
  ] }, 'sample.cpp');
  includeCallComplexity(results);
  assert.deepEqual(results.map(result => result.complexity), ['O(?)', 'O(?)']);
});

test('includes costs of project functions, including calls inside loops and across files', () => {
  const caller = analyzeAst({ kind: 'TranslationUnitDecl', inner: [
    fn('main', [call('validate'), forLoop(7, { update: increment, body: block(call('validate')) })])
  ] }, 'main.cpp');
  const callee = analyzeAst({ kind: 'TranslationUnitDecl', inner: [
    fn('validate', [forLoop(12, { update: increment })])
  ] }, 'validation.cpp');
  const results = includeCallComplexity([...caller, ...callee]);
  assert.equal(results.find(result => result.name === 'validate').complexity, 'O(n)');
  assert.equal(results.find(result => result.name === 'main').complexity, 'O(n²)');
  assert.match(results.find(result => result.name === 'main').explanation, /validate\(\) O\(n²\)/);
});

test('estimates common direct recursive patterns', () => {
  const parameter = { kind: 'ParmVarDecl', name: 'n', id: 'n-id' };
  const n = () => ref('n', 'n-id', 'ParmVarDecl');
  const decrement = () => ({ kind: 'BinaryOperator', opcode: '-', inner: [n(), int(1)] });
  const halve = () => ({ kind: 'BinaryOperator', opcode: '/', inner: [n(), int(2)] });
  const baseCase = { kind: 'IfStmt', inner: [
    { kind: 'BinaryOperator', opcode: '<=', inner: [n(), int(1)] }, block({ kind: 'ReturnStmt', inner: [int(1)] })
  ] };
  const recursion = analyzeAst({ kind: 'TranslationUnitDecl', inner: [
    fn('factorial', [baseCase, { kind: 'ReturnStmt', inner: [call('factorial', decrement())] }], [parameter]),
    fn('binarySearch', [baseCase, { kind: 'ReturnStmt', inner: [call('binarySearch', halve())] }], [parameter]),
    fn('fibonacci', [baseCase, { kind: 'ReturnStmt', inner: [call('fibonacci', decrement()), call('fibonacci', decrement())] }], [parameter]),
    fn('mergeSort', [baseCase, forLoop(20, { update: increment }), { kind: 'ReturnStmt', inner: [call('mergeSort', halve()), call('mergeSort', halve())] }], [parameter])
  ] }, 'recursive.cpp');
  includeCallComplexity(recursion);
  assert.deepEqual(recursion.map(result => result.complexity), ['O(n)', 'O(log n)', 'O(2ⁿ)', 'O(n log n)']);
});

test('filters function definitions from included headers', () => {
  const root = { kind: 'TranslationUnitDecl', inner: [
    { ...fn('headerFunction', []), loc: { line: 1, file: 'C:/project/include/api.hpp' } },
    { ...fn('sourceFunction', []), loc: { line: 3, file: 'C:/project/main.cpp' } }
  ] };
  const results = analyzeAst(root, 'main.cpp', 'C:/project/main.cpp', 'C:/project');
  assert.deepEqual(results.map(result => result.name), ['sourceFunction']);
});
