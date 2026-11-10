import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AstNode, FunctionResult, analyzeAst } from './analysis';

const execFileAsync = promisify(execFile);
export interface CompileCommand { directory: string; file: string; arguments?: string[]; command?: string }

/** Ask Clang for a real AST. Compilation database flags are preserved where practical. */
export async function analyzeFile(file: string, workspaceRoot: string, clangPath: string, standard: string): Promise<FunctionResult[]> {
  const args = await compileArguments(file, workspaceRoot, standard);
  args.push('-fsyntax-only', '-Xclang', '-ast-dump=json', file);
  const { stdout } = await execFileAsync(clangPath, args, { cwd: workspaceRoot, maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  const ast = JSON.parse(stdout) as AstNode;
  return analyzeAst(ast, path.relative(workspaceRoot, file).replaceAll('\\', '/'), file, workspaceRoot);
}

async function compileArguments(file: string, root: string, standard: string): Promise<string[]> {
  const dbPath = path.join(root, 'compile_commands.json');
  try {
    const commands = JSON.parse(await fs.readFile(dbPath, 'utf8')) as CompileCommand[];
    const entry = commands.find(item => path.resolve(item.directory, item.file) === path.resolve(file));
    if (entry) {
      const original = entry.arguments ?? splitCommand(entry.command ?? '');
      const flags: string[] = [];
      for (let i = 1; i < original.length; i++) {
        const arg = original[i];
        if (arg === '-c' || arg === '-o' || arg === entry.file || path.resolve(entry.directory, arg) === path.resolve(file)) {
          if (arg === '-o') i++;
          continue;
        }
        if (!arg.startsWith('-o')) flags.push(arg);
      }
      return flags;
    }
  } catch { /* no database: use a simple default command line */ }
  return [`-std=${standard}`];
}

// Enough for common generated compile_commands.json commands; quoted paths are supported.
function splitCommand(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(part => part.replace(/^(?:"|')|(?:"|')$/g, '')) ?? [];
}
