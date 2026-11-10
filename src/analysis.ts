import * as path from 'node:path';

export interface AstNode {
  kind?: string;
  name?: string;
  id?: string;
  mangledName?: string;
  loc?: { line?: number; file?: string };
  range?: { begin?: { line?: number }; end?: { line?: number } };
  inner?: AstNode[];
  opcode?: string;
  value?: string | number;
  referencedDecl?: { id?: string; name?: string; kind?: string; mangledName?: string };
  [key: string]: unknown;
}

export type Growth = 'O(1)' | 'O(log n)' | 'O(log² n)' | 'O(n)' | 'O(n log n)' | 'O(n²)' | 'O(n³)' | 'O(2ⁿ)' | 'O(?)';
export interface FunctionResult {
  file: string;
  name: string;
  line: number;
  complexity: Growth;
  explanation: string;
  factors: number;
  /** Internal call-graph data used to include costs of functions defined in this workspace. */
  symbol?: string;
  localComplexity?: Growth;
  calls?: Array<{ name: string; symbol?: string; loopGrowth: Growth; recursive?: boolean; recursionStep?: 'linear' | 'logarithmic' | 'unknown' }>;
  hasBaseCase?: boolean;
}

const callableKinds = new Set(['FunctionDecl', 'CXXMethodDecl', 'CXXConstructorDecl', 'CXXDestructorDecl', 'CXXConversionDecl']);
const loopKinds = new Set(['ForStmt', 'WhileStmt', 'DoStmt', 'CXXForRangeStmt']);

/** Extract callable bodies from Clang's JSON AST and apply a deliberately small set of rules. */
export function analyzeAst(root: AstNode, file: string, sourcePath?: string, sourceDirectory = ''): FunctionResult[] {
  const results: FunctionResult[] = [];
  const visit = (node: AstNode, inheritedSource?: string): string | undefined => {
    const activeSource = node.loc?.file ? normalizePath(node.loc.file, sourceDirectory) : inheritedSource;
    const isCallable = !!node.kind && callableKinds.has(node.kind);
    if (isCallable && node.name && node.inner &&
        (!sourcePath || !activeSource || activeSource === normalizePath(sourcePath, sourceDirectory))) {
      const body = node.inner.find(child => child.kind === 'CompoundStmt');
      if (body) results.push(analyzeFunction(body, node, file, node.loc?.line ?? node.range?.begin?.line ?? 1));
    }
    // Locations inside a function can refer to header types; they must not change the file
    // inherited by the next top-level declaration.
    if (isCallable) return activeSource;
    // Clang omits repeated file names in JSON locations, so carry the last one through siblings.
    let currentSource = activeSource;
    for (const child of node.inner ?? []) currentSource = visit(child, currentSource);
    return currentSource;
  };
  visit(root);
  return results;
}

/** Include costs of calls that resolve to function definitions in the analyzed project. */
export function includeCallComplexity(results: FunctionResult[]): FunctionResult[] {
  const bySymbol = new Map<string, FunctionResult[]>();
  const byName = new Map<string, FunctionResult[]>();
  for (const result of results) {
    result.localComplexity ??= result.complexity;
    if (result.symbol) bySymbol.set(result.symbol, [...(bySymbol.get(result.symbol) ?? []), result]);
    byName.set(result.name, [...(byName.get(result.name) ?? []), result]);
  }

  const state = new Map<FunctionResult, 'visiting' | 'done'>();
  const calculated = new Map<FunctionResult, Growth>();
  const calculate = (result: FunctionResult, depth = 0): Growth => {
    // Keep very large call graphs from exhausting the Extension Host's JS stack.
    if (depth > 128) return 'O(?)';
    if (state.get(result) === 'visiting') return 'O(?)';
    if (state.get(result) === 'done') return calculated.get(result) ?? result.localComplexity ?? result.complexity;
    state.set(result, 'visiting');
    const costs: Growth[] = [result.localComplexity ?? result.complexity];
    const includedCalls: string[] = [];
    const recursiveCalls = (result.calls ?? []).filter(call => call.recursive);
    if (recursiveCalls.length) {
      const recursiveCost = estimateRecurrence(result, recursiveCalls);
      costs.push(recursiveCost);
      includedCalls.push(`recursive call(s) ${recursiveCost}`);
    }
    for (const call of result.calls ?? []) {
      if (call.recursive) continue;
      const targets = call.symbol ? bySymbol.get(call.symbol) : undefined;
      const candidates = targets?.length ? targets : byName.get(call.name);
      if (!candidates?.length) continue; // External/library function: outside this project's model.
      const callee = candidates.map(candidate => calculate(candidate, depth + 1)).sort((a, b) => growthRank(b) - growthRank(a))[0] ?? 'O(?)';
      const callCost = multiplyGrowth(call.loopGrowth, callee);
      costs.push(callCost);
      includedCalls.push(`${call.name}() ${callCost}`);
    }
    const final = costs.sort((a, b) => growthRank(b) - growthRank(a))[0] ?? 'O(1)';
    state.set(result, 'done');
    calculated.set(result, final);
    result.complexity = final;
    if (includedCalls.length) result.explanation += ` Calls included: ${[...new Set(includedCalls)].join(', ')}.`;
    return final;
  };
  for (const result of results) calculate(result);
  return results;
}

function multiplyGrowth(left: Growth, right: Growth): Growth {
  const a = growthFactors(left);
  const b = growthFactors(right);
  if (!a || !b) return 'O(?)';
  return growthFromFactors(a.n + b.n, a.log + b.log);
}

function growthFactors(value: Growth): { n: number; log: number } | undefined {
  switch (value) {
    case 'O(1)': return { n: 0, log: 0 };
    case 'O(log n)': return { n: 0, log: 1 };
    case 'O(log² n)': return { n: 0, log: 2 };
    case 'O(n)': return { n: 1, log: 0 };
    case 'O(n log n)': return { n: 1, log: 1 };
    case 'O(n²)': return { n: 2, log: 0 };
    case 'O(n³)': return { n: 3, log: 0 };
    case 'O(2ⁿ)': return undefined;
    case 'O(?)': return undefined;
  }
}

function growthFromFactors(n: number, log: number): Growth {
  if (n === 0 && log === 0) return 'O(1)';
  if (n === 0 && log === 1) return 'O(log n)';
  if (n === 0 && log === 2) return 'O(log² n)';
  if (n === 1 && log === 0) return 'O(n)';
  if (n === 1 && log === 1) return 'O(n log n)';
  if (n === 2 && log === 0) return 'O(n²)';
  if (n === 3 && log === 0) return 'O(n³)';
  return 'O(?)';
}

function estimateRecurrence(result: FunctionResult, calls: NonNullable<FunctionResult['calls']>): Growth {
  if (!result.calls || calls.some(call => call.recursionStep === 'unknown') || !hasRecursiveBaseCase(result)) return 'O(?)';
  const steps = new Set(calls.map(call => call.recursionStep));
  if (steps.size !== 1) return 'O(?)';
  const step = calls[0].recursionStep;
  const work = result.localComplexity ?? result.complexity;
  if (step === 'linear') {
    if (calls.length > 1) return calls.length === 2 ? 'O(2ⁿ)' : 'O(?)';
    switch (work) {
      case 'O(1)': return 'O(n)';
      case 'O(log n)': return 'O(n log n)';
      case 'O(n)': return 'O(n²)';
      case 'O(n²)': return 'O(n³)';
      default: return 'O(?)';
    }
  }
  if (step === 'logarithmic') {
    if (calls.length === 1) {
      if (work === 'O(1)') return 'O(log n)';
      if (work === 'O(log n)') return 'O(log² n)';
      return ['O(n)', 'O(n log n)', 'O(n²)', 'O(n³)'].includes(work) ? work : 'O(?)';
    }
    if (calls.length === 2) {
      if (work === 'O(1)' || work === 'O(log n)' || work === 'O(log² n)') return 'O(n)';
      if (work === 'O(n)') return 'O(n log n)';
      if (work === 'O(n²)' || work === 'O(n³)') return work;
    }
  }
  return 'O(?)';
}

function hasRecursiveBaseCase(result: FunctionResult): boolean {
  // A conditional return is a small but useful guard against classifying obvious infinite recursion.
  return result.hasBaseCase === true;
}

function normalizePath(value: string, base: string): string { return path.resolve(base || '.', value).replaceAll('\\', '/').toLowerCase(); }

type LoopGrowth = 'constant' | 'logarithmic' | 'linear' | 'unknown';

function analyzeFunction(body: AstNode, declaration: AstNode, file: string, line: number): FunctionResult {
  const name = declaration.name ?? '<anonymous>';
  const symbol = declaration.mangledName ?? declaration.name;
  const parameters = (declaration.inner ?? []).filter(child => child.kind === 'ParmVarDecl');
  let branchCount = 0;
  const loopLines: number[] = [];
  const loopPaths: LoopGrowth[][] = [];
  const explanations: string[] = [];
  const calls: NonNullable<FunctionResult['calls']> = [];
  const walk = (node: AstNode, parentPath: LoopGrowth[]): void => {
    const kind = node.kind ?? '';
    let nextPath = parentPath;
    if (loopKinds.has(kind)) {
      const estimate = classifyLoop(node);
      nextPath = [...parentPath, estimate.growth];
      loopPaths.push(nextPath);
      explanations.push(estimate.reason);
      const lineNo = node.loc?.line ?? node.range?.begin?.line;
      if (lineNo) loopLines.push(lineNo);
    }
    if (kind === 'IfStmt' || kind === 'ConditionalOperator' || kind === 'SwitchStmt') branchCount++;
    if (kind === 'CallExpr' || kind === 'CXXMemberCallExpr') {
      const target = findCallTarget(node);
      if (target) {
        const isRecursive = target.symbol && symbol ? target.symbol === symbol : target.name === name;
        calls.push({
          name: target.name,
          symbol: target.symbol,
          loopGrowth: combineLoopGrowth(nextPath),
          recursive: isRecursive,
          recursionStep: isRecursive ? classifyRecursionStep(target.arguments ?? [], parameters) : undefined
        });
      }
    }
    for (const child of node.inner ?? []) walk(child, nextPath);
  };
  walk(body, []);

  let complexity: Growth = 'O(1)';
  let factors = 0;
  let explanation: string;
  // Nested loops multiply their costs; separate loops contribute their maximum cost.
  complexity = loopPaths.map(combineLoopGrowth).sort((a, b) => growthRank(b) - growthRank(a))[0] ?? 'O(1)';
  factors = loopPaths.length ? Math.max(...loopPaths.map(path => path.filter(part => part === 'linear').length)) : 0;
  explanation = loopPaths.length
    ? `${[...new Set(explanations)].join(' ')}${linePhrase(loopLines)}.`
    : 'No loops found in the function body.';
  if (branchCount > 0) explanation += ` ${branchCount} conditional branch(es) found; branch costs are not compared.`;
  return {
    file, name, line, complexity, explanation, factors,
    symbol,
    localComplexity: complexity,
    calls,
    hasBaseCase: !!findMatching(body, node => node.kind === 'IfStmt' && !!findMatching(node, part => part.kind === 'ReturnStmt'))
  };
}

function findCallTarget(call: AstNode): { name: string; symbol?: string; arguments: AstNode[] } | undefined {
  // The first child is the callee expression. Searching only there avoids mistaking a
  // nested call in an argument (for example f(g())) for the outer call to f.
  const find = (node: AstNode | undefined): { name: string; symbol?: string } | undefined => {
    if (!node) return undefined;
    const referenced = node.referencedDecl;
    if (referenced?.name && ['FunctionDecl', 'CXXMethodDecl', 'CXXConstructorDecl', 'CXXConversionDecl'].includes(referenced.kind ?? ''))
      return { name: referenced.name, symbol: referenced.mangledName };
    // Clang represents some member-call targets as MemberExpr without referencedDecl details.
    if (node.kind === 'MemberExpr' && node.name) return { name: node.name };
    for (const child of node.inner ?? []) {
      const target = find(child);
      if (target) return target;
    }
    return undefined;
  };
  const target = find(call.inner?.[0]);
  return target ? { ...target, arguments: (call.inner ?? []).slice(1) } : undefined;
}

function classifyRecursionStep(arguments_: AstNode[], parameters: AstNode[]): 'linear' | 'logarithmic' | 'unknown' {
  for (const parameter of parameters) {
    const argument = arguments_.find(item => containsRef(item, parameter));
    if (!argument) continue;
    if (findMatching(argument, part => ['/', '>>'].includes(part.opcode ?? '') &&
      containsRef(part.inner?.[0], parameter) && isConstantExpression(part.inner?.[1] ?? {}))) return 'logarithmic';
    if (findMatching(argument, part => ['-', '+'].includes(part.opcode ?? '') &&
      containsRef(part.inner?.[0], parameter) && isConstantExpression(part.inner?.[1] ?? {}))) return 'linear';
    return 'unknown';
  }
  return 'unknown';
}

function classifyLoop(node: AstNode): { growth: LoopGrowth; reason: string } {
  if (node.kind === 'CXXForRangeStmt') return { growth: 'linear', reason: 'Range-based loop estimated O(n).' };
  const children = node.inner ?? [];
  if (node.kind === 'ForStmt') {
    // The counter may be declared before the loop (`int i; for (i = ...; ...)`)
    // or the initializer may be omitted (`for (; i < n; ++i)`).
    const variable = findFirst(node.inner?.[0], 'VarDecl') ?? findForCounter(node.inner?.[0], children[2]);
    const comparison = findComparison(children[2], variable);
    const step = classifyUpdate(children[3], variable);
    if (!comparison || !variable || step === 'unknown')
      return { growth: 'unknown', reason: 'Loop counter, condition, or step was not recognized; estimate is unknown.' };
    if (isConstantExpression(comparison.bound)) return { growth: 'constant', reason: 'Loop has a constant numeric bound (O(1)).' };
    if (step === 'logarithmic') return { growth: step, reason: 'Loop counter changes geometrically toward a variable bound (O(log n)).' };
    return { growth: 'linear', reason: 'Loop counter advances by a constant step toward a variable bound (O(n)).' };
  }

  const condition = node.kind === 'DoStmt' ? children.at(-1) : children[0];
  const body = node.kind === 'DoStmt' ? children[0] : children.at(-1);
  if (!findComparison(condition)) return { growth: 'unknown', reason: 'Loop condition is not a recognized comparison; estimate is unknown.' };
  const conditionRefs = collectRefs(condition);
  if (isHalvingLoop(body, conditionRefs))
    return { growth: 'logarithmic', reason: 'Loop appears to halve a value used by its condition (estimated O(log n)).' };
  if (conditionRefs.some(ref => hasLinearUpdate(body, ref)))
    return { growth: 'linear', reason: 'Loop advances a value used by its condition by a constant step (estimated O(n)).' };
  return { growth: 'unknown', reason: 'Could not connect a loop-counter update to its condition; estimate is unknown.' };
}

function findForCounter(initializer: AstNode | undefined, condition: AstNode | undefined): AstNode | undefined {
  if (initializer?.kind === 'BinaryOperator' && initializer.opcode === '=') {
    const assigned = findFirst(initializer.inner?.[0], 'DeclRefExpr');
    if (assigned) return assigned;
  }
  let counter: AstNode | undefined;
  const find = (node: AstNode | undefined): void => {
    if (!node || counter) return;
    if (node.kind === 'BinaryOperator' && ['<', '<=', '>', '>=', '!='].includes(node.opcode ?? '')) {
      counter = findFirst(node.inner?.[0], 'DeclRefExpr') ?? findFirst(node.inner?.[1], 'DeclRefExpr');
      return;
    }
    for (const child of node.inner ?? []) find(child);
  };
  find(condition);
  return counter;
}

function combineLoopGrowth(path: LoopGrowth[]): Growth {
  if (path.includes('unknown')) return 'O(?)';
  const linear = path.filter(item => item === 'linear').length;
  const logarithmic = path.filter(item => item === 'logarithmic').length;
  if (!linear && !logarithmic) return 'O(1)';
  if (!linear && logarithmic === 1) return 'O(log n)';
  if (!linear && logarithmic === 2) return 'O(log² n)';
  if (linear === 1 && !logarithmic) return 'O(n)';
  if (linear === 1 && logarithmic === 1) return 'O(n log n)';
  if (logarithmic) return 'O(?)';
  return linear === 2 ? 'O(n²)' : linear === 3 ? 'O(n³)' : 'O(?)';
}

function growthRank(growth: Growth): number {
  return ({ 'O(1)': 0, 'O(log n)': 1, 'O(log² n)': 2, 'O(n)': 3, 'O(n log n)': 4, 'O(n²)': 5, 'O(n³)': 6, 'O(2ⁿ)': 7, 'O(?)': 8 })[growth];
}

function findFirst(node: AstNode | undefined, kind: string): AstNode | undefined {
  if (!node) return undefined;
  if (node.kind === kind) return node;
  for (const child of node.inner ?? []) { const found = findFirst(child, kind); if (found) return found; }
  return undefined;
}

function findComparison(node: AstNode | undefined, variable?: AstNode): { bound: AstNode } | undefined {
  if (!node) return undefined;
  if (node.kind === 'BinaryOperator' && ['<', '<=', '>', '>=', '!='].includes(node.opcode ?? '')) {
    const [left, right] = node.inner ?? [];
    if (variable && containsRef(left, variable)) return right ? { bound: right } : undefined;
    if (variable && containsRef(right, variable)) return left ? { bound: left } : undefined;
    if (!variable && right) return { bound: right };
  }
  for (const child of node.inner ?? []) { const found = findComparison(child, variable); if (found) return found; }
  return undefined;
}

function isConstantExpression(node: AstNode): boolean {
  if (['IntegerLiteral', 'FloatingLiteral', 'CharacterLiteral', 'CXXBoolLiteralExpr'].includes(node.kind ?? '')) return true;
  if (['ImplicitCastExpr', 'CStyleCastExpr', 'CXXStaticCastExpr', 'ParenExpr', 'ConstantExpr', 'UnaryOperator'].includes(node.kind ?? ''))
    return !!node.inner?.length && node.inner.every(isConstantExpression);
  if (node.kind === 'BinaryOperator' && ['+', '-', '*', '/', '%', '<<', '>>'].includes(node.opcode ?? ''))
    return !!node.inner?.length && node.inner.every(isConstantExpression);
  return false;
}

function classifyUpdate(node: AstNode | undefined, variable: AstNode | undefined): LoopGrowth {
  if (!node || !variable) return 'unknown';
  let result: LoopGrowth = 'unknown';
  visit(node, part => {
    if (part.kind === 'UnaryOperator' && ['++', '--'].includes(part.opcode ?? '') && containsRef(part, variable)) result = 'linear';
    if (part.kind === 'CompoundAssignOperator' && containsRef(part.inner?.[0], variable)) {
      if (['*=', '/=', '<<=', '>>='].includes(part.opcode ?? '') && hasGeometricLiteral(part.inner?.[1], part.opcode)) result = 'logarithmic';
      else if (['+=', '-='].includes(part.opcode ?? '') && isConstantExpression(part.inner?.[1] ?? {})) result = 'linear';
    }
    if (part.kind === 'BinaryOperator' && part.opcode === '=' && containsRef(part.inner?.[0], variable)) {
      const rhs = part.inner?.[1];
      if (rhs && containsRef(rhs, variable) && hasGeometricUpdate(rhs, variable)) result = 'logarithmic';
      else if (rhs && containsRef(rhs, variable) && hasArithmetic(rhs)) result = 'linear';
    }
  });
  return result;
}

function hasGeometricUpdate(node: AstNode, variable: AstNode): boolean {
  return !!findMatching(node, part => ['*', '/', '<<', '>>'].includes(part.opcode ?? '') &&
    containsRef(part, variable) && hasGeometricLiteral(part, part.opcode));
}

function hasArithmetic(node: AstNode): boolean { return ['+', '-', '*', '/', '<<', '>>'].includes(node.opcode ?? ''); }

function hasGeometricLiteral(node: AstNode | undefined, opcode?: string): boolean {
  if (!node) return false;
  const minimum = ['<<', '>>', '<<=', '>>='].includes(opcode ?? '') ? 1 : 2;
  return !!findMatching(node, part => part.kind === 'IntegerLiteral' && Number(part.value) >= minimum);
}

function isHalvingLoop(body: AstNode | undefined, conditionRefs: AstNode[]): boolean {
  if (!body) return false;
  const ids = new Set(conditionRefs.map(ref => typeof ref.referencedDecl?.id === 'string' ? ref.referencedDecl.id : '').filter(Boolean));
  const halvedNames = new Set<string>();
  visit(body, part => {
    if (part.kind === 'VarDecl' && part.name && !!findMatching(part, item => item.opcode === '/' && hasGeometricLiteral(item))) halvedNames.add(part.name);
    if (part.kind === 'CompoundAssignOperator' && part.opcode === '/=' && hasGeometricLiteral(part.inner?.[1]) && intersectsRefs(part.inner?.[0], ids)) halvedNames.add('');
  });
  if (halvedNames.has('')) return true;
  if (!halvedNames.size) return false;
  return !!findMatching(body, part => part.kind === 'BinaryOperator' && part.opcode === '=' &&
    intersectsRefs(part.inner?.[0], ids) && [...halvedNames].some(name => collectRefs(part.inner?.[1]).some(ref => ref.referencedDecl?.name === name)));
}

function hasLinearUpdate(node: AstNode | undefined, variable: AstNode): boolean {
  if (!node) return false;
  return !!findMatching(node, part => {
    if (part.kind === 'UnaryOperator' && ['++', '--'].includes(part.opcode ?? '')) return containsRef(part, variable);
    if (part.kind === 'CompoundAssignOperator' && ['+=', '-='].includes(part.opcode ?? ''))
      return containsRef(part.inner?.[0], variable) && isConstantExpression(part.inner?.[1] ?? {});
    if (part.kind === 'BinaryOperator' && part.opcode === '=') {
      const [left, right] = part.inner ?? [];
      return containsRef(left, variable) && !!right && containsRef(right, variable) && hasArithmetic(right);
    }
    return false;
  });
}

function collectRefs(node: AstNode | undefined): AstNode[] {
  const refs: AstNode[] = [];
  if (node) visit(node, part => { if (part.kind === 'DeclRefExpr') refs.push(part); });
  return refs;
}

function containsRef(node: AstNode | undefined, variable: AstNode): boolean {
  if (!node) return false;
  const variableId = typeof variable.id === 'string' ? variable.id : variable.referencedDecl?.id;
  const variableName = variable.name ?? variable.referencedDecl?.name;
  return !!findMatching(node, part => part.kind === 'DeclRefExpr' &&
    (variableId ? part.referencedDecl?.id === variableId : part.referencedDecl?.name === variableName));
}

function intersectsRefs(node: AstNode | undefined, ids: Set<string>): boolean {
  return collectRefs(node).some(ref => typeof ref.referencedDecl?.id === 'string' && ids.has(ref.referencedDecl.id));
}

function findMatching(node: AstNode, predicate: (part: AstNode) => boolean): AstNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.inner ?? []) { const found = findMatching(child, predicate); if (found) return found; }
  return undefined;
}

function visit(node: AstNode, action: (part: AstNode) => void): void {
  action(node);
  for (const child of node.inner ?? []) visit(child, action);
}

function linePhrase(lines: number[]): string {
  const unique = [...new Set(lines)].sort((a, b) => a - b);
  return unique.length ? ` at line${unique.length > 1 ? 's' : ''} ${unique.join(', ')}` : '';
}

