import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Parse the actual browser artifact, excluding strings containing example or
// viewer source code. Node builtins cannot be resolved by an embedded browser.
const file = new URL('../dist/index.js', import.meta.url);
const ast = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const failures = [];
// Pinned splat-transform contains Node-only WebP/worker branches. They are
// guarded by process.versions.node; browser workers are disabled by upstream
// main.ts. These dynamic imports are not eagerly resolved by the browser.
const guardedNodeImports = new Set(['module', 'node:worker_threads', 'node:os']);
const check = value => {
    if (!value.startsWith('./') && !value.startsWith('../') && !value.startsWith('/')) failures.push(value);
};
const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0]) && !guardedNodeImports.has(node.arguments[0].text)) check(node.arguments[0].text);
    ts.forEachChild(node, visit);
};
visit(ast);
if (failures.length) throw new Error(`Browser bundle contains unresolved modules: ${[...new Set(failures)].join(', ')}`);
console.log('FUNES browser bundle has no unresolved eager imports; only the three audited upstream Node-only dynamic branches remain.');
